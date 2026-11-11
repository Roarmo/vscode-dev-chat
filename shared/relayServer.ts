import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { createServer as createHttpsServer } from "https";
import type { Duplex } from "stream";
import type { RawData, WebSocket } from "ws";
import { createHmac, randomBytes, randomUUID } from "crypto";
import {
	AckMessage,
	ClientToServerMessage,
	DirectMessage,
	ErrorMessage,
	RelayAdminMessage,
	RelayAdminResultMessage,
	RelayAuthenticateMessage,
	ServerToClientMessage,
	ServerReadyMessage,
	isClientToServerMessage,
} from "./types";
import { isLocalNetworkAddress, isLoopbackHost, normalizeRemoteAddress } from "./networkAddress";
import { getCertificateFingerprint, type RelayTlsCredentials } from "./relayCertificate";
import { loadRelayAccess, saveRelayAccess, type RelayAccessOptions, type RelayAccessState } from "./relayAccess";
import {
	createRelayChallenge,
	generateJoinCode,
	isIdentityPublicKey,
	joinCodesMatch,
	verifyRelayProof,
	type PendingRelayChallenge,
} from "./relayAuthentication";

const { WebSocketServer, WebSocket: WsSocket } = require("ws") as typeof import("ws");

export const DEFAULT_RELAY_PORT = 8787;

export interface RelayLogger {
	info(message: string): void;
	error(message: string): void;
}

export interface RelayLimits {
	maxMessageBytes: number;
	rateLimitWindowMs: number;
	maxMessagesPerWindow: number;
	heartbeatIntervalMs: number;
	staleSocketTimeoutMs: number;
	healthLogIntervalMs: number;
}

export const DEFAULT_RELAY_LIMITS: Readonly<RelayLimits> = Object.freeze({
	maxMessageBytes: 8192,
	rateLimitWindowMs: 1000,
	maxMessagesPerWindow: 20,
	heartbeatIntervalMs: 15000,
	staleSocketTimeoutMs: 45000,
	healthLogIntervalMs: 30000,
});

export interface RelayServerOptions {
	/** Persistent membership and the identity permitted to administer the relay. */
	access: RelayAccessOptions;
	/** Port to listen on. Use 0 for an ephemeral port. Defaults to 8787. */
	port?: number;
	/** Interface to bind. Defaults to all interfaces. */
	host?: string;
	limits?: Partial<RelayLimits>;
	logger?: RelayLogger;
	/**
	 * Decides whether a connecting remote address may use the relay.
	 * Defaults to accepting only loopback, private and link-local addresses.
	 */
	isRemoteAddressAllowed?: (remoteAddress: string) => boolean;
	/** Called whenever the number of connected clients changes. */
	onConnectionCountChange?: (count: number) => void;
	/** Serve wss:// with this certificate and key. Without it the relay serves plain ws://. */
	tls?: RelayTlsCredentials;
	/** Clock used for challenge expiry and join-attempt limits. */
	now?: () => number;
}

export interface RunningRelayServer {
	readonly port: number;
	connectionCount(): number;
	metrics(): RelayMetrics;
	/** Disconnects all clients and stops listening. Safe to call more than once. */
	close(): Promise<void>;
}

export interface RelayMetrics {
	activeConnections: number;
	presenceEntries: number;
	messagesReceived: number;
	messagesForwarded: number;
	throttledMessages: number;
	payloadRejections: number;
	protocolErrors: number;
	forwardingFailures: number;
	rejectedNonLocalConnections: number;
}

export class RelayPortInUseError extends Error {
	constructor(readonly port: number) {
		super(`Port ${port} is already in use. Stop the other program or choose a different port.`);
		this.name = "RelayPortInUseError";
	}
}

const CLOSE_GRACE_PERIOD_MS = 1000;
const JOIN_FAILURE_WINDOW_MS = 60_000;
const MAX_JOIN_FAILURES = 5;
const MAX_TRACKED_ADDRESSES = 10_000;
const MAX_WEBSOCKET_PAYLOAD_BYTES = 0x7fffffff;

const consoleLogger: RelayLogger = {
	info: (message) => console.log(`[relay] ${message}`),
	error: (message) => console.error(`[relay] ${message}`),
};

function newCorrelationId(): string {
	return randomUUID();
}

function getRawDataByteLength(rawData: RawData): number {
	if (typeof rawData === "string") {
		return Buffer.byteLength(rawData);
	}

	if (Buffer.isBuffer(rawData)) {
		return rawData.byteLength;
	}

	if (rawData instanceof ArrayBuffer) {
		return rawData.byteLength;
	}

	if (Array.isArray(rawData)) {
		return rawData.reduce((total, chunk) => total + chunk.byteLength, 0);
	}

	return 0;
}

function getRequestCorrelationId(value: unknown): string {
	if (
		value &&
		typeof value === "object" &&
		"requestId" in value &&
		typeof (value as { requestId?: unknown }).requestId === "string"
	) {
		return (value as { requestId: string }).requestId;
	}

	return newCorrelationId();
}

function getCandidateMessageType(value: unknown): string {
	if (!value || typeof value !== "object" || !("type" in value)) return "unknown";
	const candidate = (value as { type?: unknown }).type;
	return typeof candidate === "string" &&
		["hello", "relay_authenticate", "relay_admin", "direct_message"].includes(candidate)
		? candidate
		: "unknown";
}

function getRawRequestContext(rawData: RawData): { requestId: string; messageType: string } {
	let candidate: unknown;
	try {
		candidate = JSON.parse(rawData.toString());
	} catch {
		return { requestId: newCorrelationId(), messageType: "unknown" };
	}
	return {
		requestId: getRequestCorrelationId(candidate),
		messageType: getCandidateMessageType(candidate),
	};
}

function rejectUpgrade(socket: Duplex, statusCode: number, statusText: string): void {
	try {
		socket.write(
			`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
		);
	} finally {
		socket.destroy();
	}
}

function listen(httpServer: Server, port: number, host: string | undefined): Promise<number> {
	return new Promise((resolve, reject) => {
		const onError = (error: NodeJS.ErrnoException): void => {
			httpServer.off("listening", onListening);
			reject(error.code === "EADDRINUSE" ? new RelayPortInUseError(port) : error);
		};
		const onListening = (): void => {
			httpServer.off("error", onError);
			const address = httpServer.address();
			resolve(typeof address === "object" && address ? address.port : port);
		};

		httpServer.once("error", onError);
		httpServer.once("listening", onListening);
		if (host === undefined) {
			httpServer.listen(port);
		} else {
			httpServer.listen(port, host);
		}
	});
}

export async function startRelayServer(options: RelayServerOptions): Promise<RunningRelayServer> {
	const logger = options.logger ?? consoleLogger;
	const limits: RelayLimits = { ...DEFAULT_RELAY_LIMITS, ...options.limits };
	if (!Number.isSafeInteger(limits.maxMessageBytes) || limits.maxMessageBytes < 1 ||
		limits.maxMessageBytes > MAX_WEBSOCKET_PAYLOAD_BYTES) {
		throw new Error(`maxMessageBytes must be an integer between 1 and ${MAX_WEBSOCKET_PAYLOAD_BYTES}.`);
	}
	limits.staleSocketTimeoutMs = Math.max(limits.staleSocketTimeoutMs, limits.heartbeatIntervalMs);
	const isRemoteAddressAllowed = options.isRemoteAddressAllowed ?? isLocalNetworkAddress;
	const requestedPort = options.port ?? DEFAULT_RELAY_PORT;
	const now = options.now ?? Date.now;
	const logCorrelationKey = randomBytes(32);
	let accessState = await loadRelayAccess(options.access);
	const relayId = options.tls ? getCertificateFingerprint(options.tls.cert) : `loopback:${randomUUID()}`;

	const identityToSocket = new Map<string, WebSocket>();
	const socketToIdentity = new Map<WebSocket, string>();
	const socketRateState = new Map<WebSocket, { windowStart: number; count: number }>();
	const socketHeartbeatState = new Map<WebSocket, { lastSeenAt: number }>();
	const socketMetadata = new WeakMap<WebSocket, { connectionId: string; remoteAddress: string }>();
	const pendingChallenges = new Map<WebSocket, PendingRelayChallenge & { encryptionKey: string; signingKey: string }>();
	const authenticatingSockets = new Set<WebSocket>();
	const joinFailures = new Map<string, { startedAt: number; count: number }>();
	const counters = {
		messagesReceived: 0,
		messagesForwarded: 0,
		throttledMessages: 0,
		payloadRejections: 0,
		protocolErrors: 0,
		forwardingFailures: 0,
		rejectedNonLocalConnections: 0,
	};
	let accessQueue: Promise<void> = Promise.resolve();
	let staleSocketsClosed = 0;
	let ready = false;
	let closing = false;

	const getMetrics = (): RelayMetrics => ({
		activeConnections: wss.clients.size,
		presenceEntries: identityToSocket.size,
		...counters,
	});

	function logEvent(level: "info" | "error", event: string, fields: Record<string, string | number | boolean>): void {
		logger[level](JSON.stringify({ event, timestamp: new Date().toISOString(), ...fields }));
	}

	function requestIdHash(requestId: string): string {
		return createHmac("sha256", logCorrelationKey).update(requestId).digest("hex").slice(0, 16);
	}

	function sourceRejectionReason(remoteAddress: string): string | undefined {
		if (!isRemoteAddressAllowed(remoteAddress)) return "non_local";
		if (!options.tls && !isLoopbackHost(remoteAddress)) return "unencrypted_non_loopback";
		return undefined;
	}

	function logRejectedSource(remoteAddress: string, reason: string, transport: "http" | "websocket"): void {
		counters.rejectedNonLocalConnections += 1;
		logEvent("info", "rejected_non_local_source", {
			connectionId: newCorrelationId().slice(0, 8),
			remoteAddress: normalizeRemoteAddress(remoteAddress) || "unknown",
			reason,
			transport,
		});
	}

	const handleHttpRequest = (req: IncomingMessage, res: ServerResponse): void => {
		const remoteAddress = req.socket.remoteAddress ?? "";
		const rejection = sourceRejectionReason(remoteAddress);
		if (rejection) {
			logRejectedSource(remoteAddress, rejection, "http");
			res.writeHead(403, { "Connection": "close", "Content-Length": "0" });
			res.end();
			return;
		}
		if (req.url?.split("?", 1)[0] === "/health") {
			if (req.method !== "GET" && req.method !== "HEAD") {
				res.writeHead(405, { "Allow": "GET, HEAD", "Content-Length": "0" });
				res.end();
				return;
			}
			const isReady = ready && !closing;
			const body = JSON.stringify({
				status: isReady ? "ok" : closing ? "stopping" : "starting",
				readiness: isReady ? "ready" : "not_ready",
				acceptsConnections: isReady,
				canRouteMessages: isReady,
				...getMetrics(),
			});
			res.writeHead(isReady ? 200 : 503, {
				"Cache-Control": "no-store",
				"Content-Type": "application/json; charset=utf-8",
			});
			res.end(req.method === "HEAD" ? undefined : body);
			return;
		}
		res.writeHead(426, { "Content-Type": "text/plain" });
		res.end("Dev Chat relay: connect with a WebSocket client.\n");
	};
	const httpServer: Server = options.tls
		? createHttpsServer({ cert: options.tls.cert, key: options.tls.key, minVersion: "TLSv1.2" }, handleHttpRequest)
		: createServer(handleHttpRequest);
	if (options.tls) {
		httpServer.on("tlsClientError", (error: Error) => {
			logEvent("info", "tls_handshake_error", { errorName: error.name });
		});
	}
	const wss = new WebSocketServer({
		noServer: true,
		maxPayload: Math.min(limits.maxMessageBytes * 2, MAX_WEBSOCKET_PAYLOAD_BYTES),
	});

	const notifyConnectionCount = (): void => {
		options.onConnectionCountChange?.(wss.clients.size);
	};

	httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		const remoteAddress = req.socket.remoteAddress ?? "";
		const rejection = sourceRejectionReason(remoteAddress);
		if (rejection) {
			logRejectedSource(remoteAddress, rejection, "websocket");
			rejectUpgrade(socket, 403, "Forbidden");
			return;
		}

		wss.handleUpgrade(req, socket, head, (webSocket) => {
			wss.emit("connection", webSocket, req);
		});
	});

	function isRateLimited(socket: WebSocket): boolean {
		const now = Date.now();
		const current = socketRateState.get(socket);

		if (!current || now - current.windowStart >= limits.rateLimitWindowMs) {
			socketRateState.set(socket, { windowStart: now, count: 1 });
			return false;
		}

		if (current.count >= limits.maxMessagesPerWindow) {
			return true;
		}

		current.count += 1;
		return false;
	}

	function touchSocket(socket: WebSocket): void {
		const current = socketHeartbeatState.get(socket);
		if (current) {
			current.lastSeenAt = Date.now();
			return;
		}

		socketHeartbeatState.set(socket, { lastSeenAt: Date.now() });
	}

	function getSocketContext(socket: WebSocket): { connectionId: string; remoteAddress: string } {
		const metadata = socketMetadata.get(socket);
		return {
			connectionId: metadata?.connectionId ?? "unknown",
			remoteAddress: metadata?.remoteAddress ?? "unknown",
		};
	}

	function sendMessage(
		socket: WebSocket,
		message: ServerToClientMessage,
		onComplete?: (error?: Error) => void
	): void {
		const complete = (error?: Error): void => {
			if (error) {
				logEvent("error", "send_error", {
					...getSocketContext(socket),
					messageType: message.type,
					requestIdHash: requestIdHash(
						message.type === "direct_message" ? message.requestId : message.correlationId
					),
					errorName: error.name,
				});
			}
			onComplete?.(error);
		};
		try {
			socket.send(JSON.stringify(message), complete);
		} catch (error) {
			complete(error instanceof Error ? error : new Error("WebSocket send failed."));
		}
	}

	function sendError(
		socket: WebSocket,
		code: string,
		message: string,
		correlationId: string = newCorrelationId(),
		messageType: string = "unknown"
	): void {
		const eventFields = {
			...getSocketContext(socket),
			requestIdHash: requestIdHash(correlationId),
			messageType,
			code,
		};
		counters.protocolErrors += 1;
		if (code === "RATE_LIMITED" || code === "JOIN_RATE_LIMITED") {
			counters.throttledMessages += 1;
			logEvent("info", "throttle", eventFields);
		}
		if (code === "PAYLOAD_TOO_LARGE" || code === "INVALID_JSON" || code === "INVALID_SHAPE") {
			counters.payloadRejections += 1;
			logEvent("info", "payload_drop", eventFields);
		}
		const errorResponse: ErrorMessage = {
			type: "error",
			correlationId,
			code,
			message,
			timestamp: new Date().toISOString(),
		};

		logEvent("error", "protocol_error", eventFields);
		sendMessage(socket, errorResponse);
	}

	function registerIdentity(identity: string, socket: WebSocket): void {
		const previousSocket = identityToSocket.get(identity);
		if (previousSocket && previousSocket !== socket) {
			socketToIdentity.delete(previousSocket);
			try {
				previousSocket.close(4001, "Replaced by a newer session");
			} catch {
				// Ignore close race conditions for sockets already closing.
			}
		}

		identityToSocket.set(identity, socket);
		socketToIdentity.set(socket, identity);
	}

	function unregisterSocket(socket: WebSocket): void {
		const identity = socketToIdentity.get(socket);
		if (identity) {
			socketToIdentity.delete(socket);
			if (identityToSocket.get(identity) === socket) {
				identityToSocket.delete(identity);
			}
		}

		socketRateState.delete(socket);
		socketHeartbeatState.delete(socket);
		const pending = pendingChallenges.get(socket);
		pending?.sharedSecret.fill(0);
		pendingChallenges.delete(socket);
		authenticatingSockets.delete(socket);
	}

	function enqueueAccess<T>(operation: () => Promise<T>): Promise<T> {
		const result = accessQueue.then(operation);
		accessQueue = result.then(() => undefined, () => undefined);
		return result;
	}

	async function saveAccess(next: RelayAccessState): Promise<void> {
		await saveRelayAccess(options.access.store, next);
		accessState = next;
	}

	function nextRevision(): number {
		if (accessState.revision === Number.MAX_SAFE_INTEGER) {
			throw new Error("Relay access revision limit reached.");
		}
		return accessState.revision + 1;
	}

	function failAccess(socket: WebSocket, code: string, message: string, requestId: string, type: string): void {
		if (socket.readyState !== WsSocket.OPEN) return;
		sendError(socket, code, message, requestId, type);
		socket.close(4003, "Relay access denied");
	}

	function pruneJoinFailures(now: number): void {
		for (const [address, failure] of joinFailures) {
			if (now - failure.startedAt >= JOIN_FAILURE_WINDOW_MS) joinFailures.delete(address);
		}
	}

	function joinRateLimited(address: string, now: number): boolean {
		pruneJoinFailures(now);
		const failure = joinFailures.get(address);
		return failure ? failure.count >= MAX_JOIN_FAILURES : joinFailures.size >= MAX_TRACKED_ADDRESSES;
	}

	function recordJoinFailure(address: string, now: number): void {
		const failure = joinFailures.get(address);
		if (failure) {
			failure.count += 1;
		} else if (joinFailures.size < MAX_TRACKED_ADDRESSES) {
			joinFailures.set(address, { startedAt: now, count: 1 });
		}
	}

	function disconnectMember(identity: string): void {
		const socket = identityToSocket.get(identity);
		if (!socket) return;
		identityToSocket.delete(identity);
		socketToIdentity.delete(socket);
		if (socket.readyState === WsSocket.OPEN) socket.close(4003, "Relay membership removed");
	}

	function beginAuthentication(socket: WebSocket, message: Extract<ClientToServerMessage, { type: "hello" }>): void {
		if (socketToIdentity.has(socket) || pendingChallenges.has(socket) || authenticatingSockets.has(socket)) {
			failAccess(socket, "INVALID_AUTH_STATE", "A relay authentication is already active.", message.requestId, message.type);
			return;
		}
		if (
			!/^[A-Za-z0-9._:-]{1,128}$/.test(message.requestId) ||
			!isIdentityPublicKey(message.from) ||
			!isIdentityPublicKey(message.signingKey)
		) {
			failAccess(socket, "INVALID_IDENTITY", "The relay identity is invalid.", message.requestId, message.type);
			return;
		}

		try {
			const pending = {
				...createRelayChallenge(message.requestId, message.from, relayId, now()),
				encryptionKey: message.from,
				signingKey: message.signingKey,
			};
			pendingChallenges.set(socket, pending);
			sendMessage(socket, pending.challenge);
		} catch {
			failAccess(socket, "INVALID_IDENTITY", "The relay identity cannot be used for authentication.", message.requestId, message.type);
		}
	}

	async function finishAuthentication(socket: WebSocket, message: RelayAuthenticateMessage): Promise<void> {
		const pending = pendingChallenges.get(socket);
		pendingChallenges.delete(socket);
		if (!pending) {
			failAccess(socket, "INVALID_CHALLENGE", "No unused authentication challenge exists for this session.", message.requestId, message.type);
			return;
		}

		let proofValid = false;
		try {
			proofValid =
				message.requestId === pending.challenge.correlationId &&
				message.challengeId === pending.challenge.challengeId &&
				now() <= pending.challenge.expiresAt &&
				verifyRelayProof(
					pending,
					pending.encryptionKey,
					pending.signingKey,
					message.joinCode,
					message.proof,
					message.signature
				);
		} finally {
			pending.sharedSecret.fill(0);
		}
		if (!proofValid) {
			failAccess(
				socket,
				now() > pending.challenge.expiresAt ? "CHALLENGE_EXPIRED" : "AUTHENTICATION_FAILED",
				"Relay authentication failed. Reconnect and try again.",
				pending.challenge.correlationId,
				message.type
			);
			return;
		}

		authenticatingSockets.add(socket);
		try {
			await enqueueAccess(async () => {
				if (socket.readyState !== WsSocket.OPEN) return;
				if (now() > pending.challenge.expiresAt) {
					failAccess(socket, "CHALLENGE_EXPIRED", "Relay authentication expired. Reconnect and try again.", message.requestId, message.type);
					return;
				}

				const member = accessState.members.find((entry) => entry.publicKey === pending.encryptionKey);
				const isAdministrator = pending.encryptionKey === options.access.adminPublicKey;
				const needsInvitation = !member && !isAdministrator;
				const address = socketMetadata.get(socket)?.remoteAddress ?? "unknown";
				const currentTime = now();
				if (needsInvitation && joinRateLimited(address, currentTime)) {
					failAccess(socket, "JOIN_RATE_LIMITED", "Too many failed join attempts. Try again later.", message.requestId, message.type);
					return;
				}
				if (needsInvitation || message.joinCode !== "") {
					if (!joinCodesMatch(accessState.joinCode, message.joinCode)) {
						if (needsInvitation) recordJoinFailure(address, currentTime);
						failAccess(socket, "INVALID_JOIN_CODE", "A valid relay invitation is required.", message.requestId, message.type);
						return;
					}
					if (needsInvitation) joinFailures.delete(address);
				}

				if (!member || member.signingKey !== pending.signingKey) {
					const members = accessState.members.filter((entry) => entry.publicKey !== pending.encryptionKey);
					members.push({ publicKey: pending.encryptionKey, signingKey: pending.signingKey });
					await saveAccess({ ...accessState, revision: nextRevision(), members });
				}
				if (socket.readyState !== WsSocket.OPEN) return;
				registerIdentity(pending.encryptionKey, socket);
				logEvent("info", "register", {
					...getSocketContext(socket),
					requestIdHash: requestIdHash(pending.challenge.correlationId),
				});
				sendMessage(socket, {
					type: "ack",
					messageId: `hello-${message.requestId}`,
					correlationId: message.requestId,
					status: "accepted",
					timestamp: new Date().toISOString(),
				});
			});
		} finally {
			authenticatingSockets.delete(socket);
		}
	}

	async function handleAdmin(socket: WebSocket, message: RelayAdminMessage): Promise<void> {
		await enqueueAccess(async () => {
			if (socket.readyState !== WsSocket.OPEN) return;
			if (socketToIdentity.get(socket) !== options.access.adminPublicKey) {
				sendError(socket, "ADMIN_REQUIRED", "Only the relay administrator can manage access.", message.requestId, message.type);
				return;
			}

			const result: RelayAdminResultMessage = {
				type: "relay_admin_result",
				correlationId: message.requestId,
				action: message.action,
				revision: accessState.revision,
				timestamp: new Date().toISOString(),
			};

			switch (message.action) {
				case "list_members":
					result.members = accessState.members.map((member) => ({ ...member }));
					break;
				case "get_join_code":
					result.joinCode = accessState.joinCode;
					break;
				case "rotate_code": {
					if (message.removeMembers && message.expectedRevision !== accessState.revision) {
						sendError(socket, "MEMBERS_CHANGED", "The member list changed. Review it before trying again.", message.requestId, message.type);
						return;
					}
					const removed = message.removeMembers
						? accessState.members.filter((member) => member.publicKey !== options.access.adminPublicKey)
						: [];
					const members = message.removeMembers
						? accessState.members.filter((member) => member.publicKey === options.access.adminPublicKey)
						: accessState.members;
					await saveAccess({
						...accessState,
						joinCode: generateJoinCode(),
						revision: nextRevision(),
						members,
					});
					for (const member of removed) disconnectMember(member.publicKey);
					result.joinCode = accessState.joinCode;
					result.revision = accessState.revision;
					break;
				}
				case "remove_member": {
					const publicKey = message.publicKey;
					if (!publicKey) {
						sendError(socket, "INVALID_SHAPE", "A member identity is required.", message.requestId, message.type);
						return;
					}
					if (publicKey === options.access.adminPublicKey) {
						sendError(socket, "ADMIN_PROTECTED", "The relay administrator cannot be removed.", message.requestId, message.type);
						return;
					}
					if (!accessState.members.some((member) => member.publicKey === publicKey)) {
						sendError(socket, "MEMBER_NOT_FOUND", "That relay member no longer exists.", message.requestId, message.type);
						return;
					}
					await saveAccess({
						...accessState,
						revision: nextRevision(),
						members: accessState.members.filter((member) => member.publicKey !== publicKey),
					});
					disconnectMember(publicKey);
					result.revision = accessState.revision;
					break;
				}
			}

			if (socket.readyState === WsSocket.OPEN) sendMessage(socket, result);
		});
	}

	function routeDirectMessage(senderSocket: WebSocket, message: DirectMessage): void {
		const correlationId = message.requestId;
		const senderIdentity = socketToIdentity.get(senderSocket);
		if (!senderIdentity) {
			sendError(
				senderSocket,
				"NOT_REGISTERED",
				"Send a hello message first to register your identity.",
				correlationId,
				message.type
			);
			return;
		}

		if (senderIdentity !== message.from) {
			sendError(
				senderSocket,
				"IDENTITY_MISMATCH",
				"Message sender does not match the registered session identity.",
				correlationId,
				message.type
			);
			return;
		}

		if (!isIdentityPublicKey(message.to)) {
			sendError(senderSocket, "INVALID_RECIPIENT", "The recipient identity is invalid.", correlationId, message.type);
			return;
		}

		const targetSocket = identityToSocket.get(message.to);
		if (!targetSocket) {
			sendError(
				senderSocket,
				"RECIPIENT_OFFLINE",
				`Recipient ${message.to} is not connected.`,
				correlationId,
				message.type
			);
			return;
		}

		const deliveredAck: AckMessage = {
			type: "ack",
			messageId: `direct-${correlationId}`,
			correlationId,
			status: "delivered",
			timestamp: new Date().toISOString(),
		};

		sendMessage(targetSocket, { ...message, timestamp: new Date().toISOString() }, (error) => {
			if (error) {
				counters.forwardingFailures += 1;
				sendError(
					senderSocket,
					"FORWARD_FAILED",
					"The relay could not confirm forwarding. The recipient may still receive the message.",
					correlationId,
					message.type
				);
				return;
			}
			counters.messagesForwarded += 1;
			logEvent("info", "route_local", {
				...getSocketContext(senderSocket),
				requestIdHash: requestIdHash(correlationId),
				messageType: message.type,
			});
			sendMessage(senderSocket, deliveredAck);
		});
	}

	function handleMessage(socket: WebSocket, rawData: RawData): void {
		counters.messagesReceived += 1;
		touchSocket(socket);
		const messageBytes = getRawDataByteLength(rawData);

		if (isRateLimited(socket)) {
			const { requestId, messageType } = getRawRequestContext(rawData);
			sendError(
				socket,
				"RATE_LIMITED",
				`Rate limit exceeded: max ${limits.maxMessagesPerWindow} messages per ${limits.rateLimitWindowMs}ms window.`,
				requestId,
				messageType
			);
			return;
		}

		if (messageBytes > limits.maxMessageBytes) {
			const { requestId, messageType } = getRawRequestContext(rawData);
			sendError(
				socket,
				"PAYLOAD_TOO_LARGE",
				`Payload exceeds ${limits.maxMessageBytes} bytes.`,
				requestId,
				messageType
			);
			return;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(rawData.toString());
		} catch {
			sendError(socket, "INVALID_JSON", "Payload must be valid JSON.");
			return;
		}

		if (!isClientToServerMessage(parsed)) {
			sendError(
				socket,
				"INVALID_SHAPE",
				"Payload does not match protocol shape.",
				getRequestCorrelationId(parsed),
				getCandidateMessageType(parsed)
			);
			return;
		}

		const message = parsed;
		if (message.type === "hello") {
			beginAuthentication(socket, message);
			return;
		}

		if (message.type === "relay_authenticate") {
			void finishAuthentication(socket, message).catch((error: unknown) => {
				logEvent("error", "authentication_error", {
					...getSocketContext(socket),
					requestIdHash: requestIdHash(message.requestId),
					errorName: error instanceof Error ? error.name : "UnknownError",
				});
				failAccess(socket, "ACCESS_STORAGE_FAILED", "The relay could not save access state.", message.requestId, message.type);
			});
			return;
		}

		if (message.type === "relay_admin") {
			void handleAdmin(socket, message).catch((error: unknown) => {
				logEvent("error", "administration_error", {
					...getSocketContext(socket),
					requestIdHash: requestIdHash(message.requestId),
					errorName: error instanceof Error ? error.name : "UnknownError",
				});
				if (socket.readyState === WsSocket.OPEN) {
					sendError(socket, "ACCESS_STORAGE_FAILED", "The relay could not save access state.", message.requestId, message.type);
				}
			});
			return;
		}

		if (message.type === "direct_message") {
			routeDirectMessage(socket, message);
		}
	}

	wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
		const remoteAddress = normalizeRemoteAddress(req.socket.remoteAddress ?? "unknown");
		const connectionId = newCorrelationId().slice(0, 8);
		socketMetadata.set(socket, { connectionId, remoteAddress });
		touchSocket(socket);
		logEvent("info", "connect", getSocketContext(socket));
		notifyConnectionCount();

		const ready: ServerReadyMessage = {
			type: "server_ready",
			correlationId: newCorrelationId(),
			message: "Relay connection established",
			timestamp: new Date().toISOString(),
		};

		sendMessage(socket, ready);

		socket.on("pong", () => touchSocket(socket));
		socket.on("ping", () => touchSocket(socket));
		socket.on("message", (rawData: RawData) => handleMessage(socket, rawData));

		socket.on("close", () => {
			const socketContext = getSocketContext(socket);
			unregisterSocket(socket);
			socketMetadata.delete(socket);
			logEvent("info", "disconnect", socketContext);
			notifyConnectionCount();
		});

		socket.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code?.startsWith("WS_ERR_")) {
				const oversized = error.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH" ||
					error.code === "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH";
				const fields = {
					...getSocketContext(socket),
					requestIdHash: requestIdHash(newCorrelationId()),
					messageType: "unknown",
					code: oversized ? "PAYLOAD_TOO_LARGE" : "INVALID_FRAME",
				};
				counters.payloadRejections += 1;
				counters.protocolErrors += 1;
				logEvent("info", "payload_drop", fields);
				logEvent("error", "protocol_error", fields);
			} else {
				logEvent("error", "send_error", {
					...getSocketContext(socket),
					errorName: error.name,
					source: "socket",
				});
			}
			unregisterSocket(socket);
		});
	});

	wss.on("error", (error: Error) => {
		logEvent("error", "server_error", { errorName: error.name });
	});

	const port = await listen(httpServer, requestedPort, options.host);
	ready = true;

	httpServer.on("error", (error: Error) => {
		logEvent("error", "server_error", { errorName: error.name });
	});

	const heartbeatTimer = setInterval(() => {
		const now = Date.now();
		for (const socket of wss.clients) {
			const heartbeat = socketHeartbeatState.get(socket);
			const elapsedSinceLastSeen = now - (heartbeat?.lastSeenAt ?? now);

			if (elapsedSinceLastSeen > limits.staleSocketTimeoutMs) {
				staleSocketsClosed += 1;
				logEvent("info", "disconnect", {
					...getSocketContext(socket),
					reason: "heartbeat_timeout",
					idleMs: elapsedSinceLastSeen,
				});
				socket.terminate();
				continue;
			}

			if (socket.readyState === WsSocket.OPEN) {
				try {
					socket.ping();
				} catch (error) {
					logEvent("error", "send_error", {
						...getSocketContext(socket),
						errorName: error instanceof Error ? error.name : "UnknownError",
						source: "heartbeat",
					});
				}
			}
		}
	}, limits.heartbeatIntervalMs);
	heartbeatTimer.unref?.();

	const healthSummaryTimer = setInterval(() => {
		const connectedClients = wss.clients.size;
		const identifiedClients = identityToSocket.size;
		const anonymousClients = Math.max(connectedClients - identifiedClients, 0);

		logEvent("info", "health_summary", {
			...getMetrics(),
			anonymousConnections: anonymousClients,
			rateTrackedConnections: socketRateState.size,
			staleConnectionsClosed: staleSocketsClosed,
		});
	}, limits.healthLogIntervalMs);
	healthSummaryTimer.unref?.();

	let closePromise: Promise<void> | undefined;

	const close = (): Promise<void> => {
		closePromise ??= (async () => {
			closing = true;
			clearInterval(heartbeatTimer);
			clearInterval(healthSummaryTimer);

			const httpClosed = new Promise<void>((resolve) => httpServer.close(() => resolve()));

			for (const socket of wss.clients) {
				try {
					socket.close(1001, "Relay shutting down");
				} catch {
					// Socket may already be closing.
				}
			}

			const deadline = Date.now() + CLOSE_GRACE_PERIOD_MS;
			while (wss.clients.size > 0 && Date.now() < deadline) {
				await new Promise<void>((resolve) => setTimeout(resolve, 25));
			}

			for (const socket of wss.clients) {
				socket.terminate();
			}

			await accessQueue;
			await new Promise<void>((resolve) => wss.close(() => resolve()));
			httpServer.closeAllConnections?.();
			await httpClosed;
			logEvent("info", "server_stopped", { ...getMetrics() });
		})();

		return closePromise;
	};

	return {
		port,
		connectionCount: () => wss.clients.size,
		metrics: getMetrics,
		close,
	};
}
