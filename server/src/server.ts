import type { IncomingMessage } from "http";
import type { RawData, WebSocket } from "ws";
import { randomUUID } from "crypto";
import * as dotenv from "dotenv";
import {
	AckMessage,
	ClientToServerMessage,
	DirectMessage,
	ErrorMessage,
	ServerReadyMessage,
	isRelayMessage,
} from "../../shared/types";

dotenv.config();

const DEFAULT_PORT = 8787;
const { WebSocketServer, WebSocket: WsSocket } = require("ws") as typeof import("ws");

const identityToSocket = new Map<string, WebSocket>();
const socketToIdentity = new Map<WebSocket, string>();
const socketRateState = new Map<WebSocket, { windowStart: number; count: number }>();
const socketHeartbeatState = new Map<WebSocket, { lastSeenAt: number }>();
const socketMetadata = new Map<
	WebSocket,
	{ connectionId: string; remoteAddress: string }
>();

const DEFAULT_MAX_MESSAGE_BYTES = 8192;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 1000;
const DEFAULT_MAX_MESSAGES_PER_WINDOW = 20;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15000;
const DEFAULT_STALE_SOCKET_TIMEOUT_MS = 45000;
const DEFAULT_HEALTH_LOG_INTERVAL_MS = 30000;

const MAX_MESSAGE_BYTES = parsePositiveInt(
	process.env.MAX_MESSAGE_BYTES,
	DEFAULT_MAX_MESSAGE_BYTES
);
const RATE_LIMIT_WINDOW_MS = parsePositiveInt(
	process.env.RATE_LIMIT_WINDOW_MS,
	DEFAULT_RATE_LIMIT_WINDOW_MS
);
const MAX_MESSAGES_PER_WINDOW = parsePositiveInt(
	process.env.MAX_MESSAGES_PER_WINDOW,
	DEFAULT_MAX_MESSAGES_PER_WINDOW
);
const HEARTBEAT_INTERVAL_MS = parsePositiveInt(
	process.env.HEARTBEAT_INTERVAL_MS,
	DEFAULT_HEARTBEAT_INTERVAL_MS
);
const STALE_SOCKET_TIMEOUT_MS = Math.max(
	parsePositiveInt(
		process.env.STALE_SOCKET_TIMEOUT_MS,
		DEFAULT_STALE_SOCKET_TIMEOUT_MS
	),
	HEARTBEAT_INTERVAL_MS
);
const HEALTH_LOG_INTERVAL_MS = parsePositiveInt(
	process.env.HEALTH_LOG_INTERVAL_MS,
	DEFAULT_HEALTH_LOG_INTERVAL_MS
);

function logInfo(message: string): void {
	console.log(`[relay] ${message}`);
}

function logError(message: string): void {
	console.error(`[relay] ${message}`);
}

function parsePort(rawPort: string | undefined): number {
	if (!rawPort || rawPort.trim() === "") {
		logInfo(`No PORT specified; using default`);
		return DEFAULT_PORT;
	}

	const parsed = Number(rawPort);
	const isValidPort = Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535;
	if (!isValidPort) {
		throw new Error(
			`Invalid PORT value \"${rawPort}\". Expected an integer between 1 and 65535.`
		);
	}

	return parsed;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
	if (!raw || raw.trim() === "") {
		return fallback;
	}

	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		return fallback;
	}

	return parsed;
}

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

function isRateLimited(socket: WebSocket): boolean {
	const now = Date.now();
	const current = socketRateState.get(socket);

	if (!current || now - current.windowStart >= RATE_LIMIT_WINDOW_MS) {
		socketRateState.set(socket, { windowStart: now, count: 1 });
		return false;
	}

	if (current.count >= MAX_MESSAGES_PER_WINDOW) {
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

function getSocketContext(socket: WebSocket): string {
	const identity = socketToIdentity.get(socket) ?? "anonymous";
	const metadata = socketMetadata.get(socket);
	const connectionId = metadata?.connectionId ?? "unknown";
	const remoteAddress = metadata?.remoteAddress ?? "unknown";

	return `conn=${connectionId} client=${identity} addr=${remoteAddress}`;
}

function main(): void {
	const port = parsePort(process.env.PORT);
	const server = new WebSocketServer({ port });
	let staleSocketsClosed = 0;

	const heartbeatTimer = setInterval(() => {
		const now = Date.now();
		for (const socket of server.clients) {
			const heartbeat = socketHeartbeatState.get(socket);
			const elapsedSinceLastSeen = now - (heartbeat?.lastSeenAt ?? now);

			if (elapsedSinceLastSeen > STALE_SOCKET_TIMEOUT_MS) {
				staleSocketsClosed += 1;
				logInfo(
					`Terminating stale client (${getSocketContext(socket)}) idleMs=${elapsedSinceLastSeen}`
				);
				socket.terminate();
				continue;
			}

			if (socket.readyState === WsSocket.OPEN) {
				try {
					socket.ping();
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					logError(`Failed to ping ${getSocketContext(socket)}: ${message}`);
				}
			}
		}
	}, HEARTBEAT_INTERVAL_MS);
	heartbeatTimer.unref?.();

	const healthSummaryTimer = setInterval(() => {
		const connectedClients = server.clients.size;
		const identifiedClients = identityToSocket.size;
		const anonymousClients = Math.max(connectedClients - identifiedClients, 0);

		logInfo(
			`Health summary: connections=${connectedClients} identified=${identifiedClients} anonymous=${anonymousClients} rateTracked=${socketRateState.size} staleClosed=${staleSocketsClosed}`
		);
	}, HEALTH_LOG_INTERVAL_MS);
	healthSummaryTimer.unref?.();

	const shutdown = (signal: NodeJS.Signals): void => {
		logInfo(`Received ${signal}; shutting down relay server.`);
		clearInterval(heartbeatTimer);
		clearInterval(healthSummaryTimer);
		server.close((error?: Error) => {
			if (error) {
				logError(`Shutdown failed: ${error.message}`);
				process.exit(1);
				return;
			}

			logInfo("Relay server stopped cleanly.");
			process.exit(0);
		});
	};

	function sendMessage(socket: WebSocket, message: AckMessage | ErrorMessage | ServerReadyMessage | DirectMessage): void {
		socket.send(JSON.stringify(message));
	}

	function sendError(
		socket: WebSocket,
		code: string,
		message: string,
		correlationId: string = newCorrelationId(),
		messageType: string = "unknown"
	): void {
		const errorResponse: ErrorMessage = {
			type: "error",
			correlationId,
			code,
			message,
			timestamp: new Date().toISOString(),
		};

		logError(
			`Protocol error code=${code} type=${messageType} correlationId=${correlationId} ${getSocketContext(socket)} message=${message}`
		);
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
			const mappedSocket = identityToSocket.get(identity);
			if (mappedSocket === socket) {
				identityToSocket.delete(identity);
			}
		}

		socketRateState.delete(socket);
		socketHeartbeatState.delete(socket);
		socketMetadata.delete(socket);
	}

	function getIdentityForSocket(socket: WebSocket): string | undefined {
		return socketToIdentity.get(socket);
	}

	function routeDirectMessage(senderSocket: WebSocket, message: DirectMessage): void {
		const correlationId = message.requestId;
		const senderIdentity = getIdentityForSocket(senderSocket);
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

		const routedMessage: DirectMessage = {
			...message,
			timestamp: new Date().toISOString(),
		};

		sendMessage(targetSocket, routedMessage);

		const deliveredAck: AckMessage = {
			type: "ack",
			messageId: `direct-${correlationId}`,
			correlationId,
			status: "delivered",
			timestamp: new Date().toISOString(),
		};

		sendMessage(senderSocket, deliveredAck);
	}

	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);

	server.on("error", (error: Error) => {
		logError(`Server error: ${error.message}`);
	});

	server.on("connection", (socket: WebSocket, req: IncomingMessage) => {
		const remoteAddress = req.socket.remoteAddress ?? "unknown";
		const connectionId = newCorrelationId().slice(0, 8);
		socketMetadata.set(socket, { connectionId, remoteAddress });
		touchSocket(socket);
		logInfo(`Client connected (${getSocketContext(socket)})`);

		const ready: ServerReadyMessage = {
			type: "server_ready",
			correlationId: newCorrelationId(),
			message: "Relay connection established",
			timestamp: new Date().toISOString(),
		};

		sendMessage(socket, ready);

		socket.on("pong", () => {
			touchSocket(socket);
		});

		socket.on("ping", () => {
			touchSocket(socket);
		});

		socket.on("message", (rawData: RawData) => {
			touchSocket(socket);

			if (isRateLimited(socket)) {
				sendError(
					socket,
					"RATE_LIMITED",
					`Rate limit exceeded: max ${MAX_MESSAGES_PER_WINDOW} messages per ${RATE_LIMIT_WINDOW_MS}ms window.`,
					newCorrelationId(),
					"unknown"
				);
				return;
			}

			const payloadBytes = getRawDataByteLength(rawData);
			if (payloadBytes > MAX_MESSAGE_BYTES) {
				sendError(
					socket,
					"PAYLOAD_TOO_LARGE",
					`Payload exceeds ${MAX_MESSAGE_BYTES} bytes.`,
					newCorrelationId(),
					"unknown"
				);
				return;
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(rawData.toString());
			} catch {
				sendError(
					socket,
					"INVALID_JSON",
					"Payload must be valid JSON.",
					newCorrelationId(),
					"unknown"
				);
				return;
			}

			if (!isRelayMessage(parsed)) {
				const correlationId = getRequestCorrelationId(parsed);
				const maybeMessageType =
					typeof parsed === "object" &&
					parsed !== null &&
					"type" in parsed &&
					typeof (parsed as { type?: unknown }).type === "string"
						? (parsed as { type: string }).type
						: "unknown";

				sendError(
					socket,
					"INVALID_SHAPE",
					"Payload does not match protocol shape.",
					correlationId,
					maybeMessageType
				);
				return;
			}

			const message = parsed as ClientToServerMessage;
			logInfo(
				`Received message type=${message.type} requestId=${message.requestId} ${getSocketContext(socket)}`
			);

			if (message.type === "hello") {
				registerIdentity(message.from, socket);
				logInfo(`Registered client identity: ${message.from}`);

				const ack: AckMessage = {
					type: "ack",
					messageId: `hello-${message.requestId}`,
					correlationId: message.requestId,
					status: "accepted",
					timestamp: new Date().toISOString(),
				};

				sendMessage(socket, ack);
				return;
			}

			if (message.type === "direct_message") {
				routeDirectMessage(socket, message);
				return;
			}
		});

		socket.on("close", () => {
			const socketContext = getSocketContext(socket);
			const identity = getIdentityForSocket(socket);
			unregisterSocket(socket);
			if (identity) {
				logInfo(`Client disconnected: ${identity} (${socketContext})`);
				return;
			}

			logInfo(`Client disconnected (${socketContext})`);
		});

		socket.on("error", (error: Error) => {
			logError(`Socket error ${getSocketContext(socket)}: ${error.message}`);
			unregisterSocket(socket);
		});
	});

	logInfo(`Dev Chat relay server listening on ws://127.0.0.1:${port}`);
}

try {
	main();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	logError(`Startup failed: ${message}`);
	process.exit(1);
}
