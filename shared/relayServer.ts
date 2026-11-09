import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { createServer as createHttpsServer } from "https";
import type { Duplex } from "stream";
import type { RawData, WebSocket } from "ws";
import { randomUUID } from "crypto";
import {
	AckMessage,
	ClientToServerMessage,
	DirectMessage,
	ErrorMessage,
	ServerReadyMessage,
	isRelayMessage,
} from "./types";
import { isLocalNetworkAddress, normalizeRemoteAddress } from "./networkAddress";
import type { RelayTlsCredentials } from "./relayCertificate";

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
}

export interface RunningRelayServer {
	readonly port: number;
	connectionCount(): number;
	/** Disconnects all clients and stops listening. Safe to call more than once. */
	close(): Promise<void>;
}

export class RelayPortInUseError extends Error {
	constructor(readonly port: number) {
		super(`Port ${port} is already in use. Stop the other program or choose a different port.`);
		this.name = "RelayPortInUseError";
	}
}

const CLOSE_GRACE_PERIOD_MS = 1000;

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

export async function startRelayServer(options: RelayServerOptions = {}): Promise<RunningRelayServer> {
	const logger = options.logger ?? consoleLogger;
	const limits: RelayLimits = { ...DEFAULT_RELAY_LIMITS, ...options.limits };
	limits.staleSocketTimeoutMs = Math.max(limits.staleSocketTimeoutMs, limits.heartbeatIntervalMs);
	const isRemoteAddressAllowed = options.isRemoteAddressAllowed ?? isLocalNetworkAddress;
	const requestedPort = options.port ?? DEFAULT_RELAY_PORT;

	const identityToSocket = new Map<string, WebSocket>();
	const socketToIdentity = new Map<WebSocket, string>();
	const socketRateState = new Map<WebSocket, { windowStart: number; count: number }>();
	const socketHeartbeatState = new Map<WebSocket, { lastSeenAt: number }>();
	const socketMetadata = new Map<WebSocket, { connectionId: string; remoteAddress: string }>();
	let staleSocketsClosed = 0;
	let rejectedConnections = 0;

	const handleHttpRequest = (_req: IncomingMessage, res: ServerResponse): void => {
		res.writeHead(426, { "Content-Type": "text/plain" });
		res.end("Dev Chat relay: connect with a WebSocket client.\n");
	};
	const httpServer: Server = options.tls
		? createHttpsServer({ cert: options.tls.cert, key: options.tls.key, minVersion: "TLSv1.2" }, handleHttpRequest)
		: createServer(handleHttpRequest);
	if (options.tls) {
		httpServer.on("tlsClientError", (error: Error) => {
			logger.info(`TLS handshake failed: ${error.message}`);
		});
	}
	const wss = new WebSocketServer({ noServer: true });

	const notifyConnectionCount = (): void => {
		options.onConnectionCountChange?.(wss.clients.size);
	};

	httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		const remoteAddress = req.socket.remoteAddress ?? "";
		if (!isRemoteAddressAllowed(remoteAddress)) {
			rejectedConnections += 1;
			logger.info(
				`Rejected connection from non-local address ${normalizeRemoteAddress(remoteAddress) || "unknown"}`
			);
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

	function getSocketContext(socket: WebSocket): string {
		const identity = socketToIdentity.get(socket) ?? "anonymous";
		const metadata = socketMetadata.get(socket);
		const connectionId = metadata?.connectionId ?? "unknown";
		const remoteAddress = metadata?.remoteAddress ?? "unknown";

		return `conn=${connectionId} client=${identity} addr=${remoteAddress}`;
	}

	function sendMessage(
		socket: WebSocket,
		message: AckMessage | ErrorMessage | ServerReadyMessage | DirectMessage
	): void {
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

		logger.error(
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
			if (identityToSocket.get(identity) === socket) {
				identityToSocket.delete(identity);
			}
		}

		socketRateState.delete(socket);
		socketHeartbeatState.delete(socket);
		socketMetadata.delete(socket);
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

		sendMessage(targetSocket, { ...message, timestamp: new Date().toISOString() });

		const deliveredAck: AckMessage = {
			type: "ack",
			messageId: `direct-${correlationId}`,
			correlationId,
			status: "delivered",
			timestamp: new Date().toISOString(),
		};

		sendMessage(senderSocket, deliveredAck);
	}

	function handleMessage(socket: WebSocket, rawData: RawData): void {
		touchSocket(socket);

		if (isRateLimited(socket)) {
			sendError(
				socket,
				"RATE_LIMITED",
				`Rate limit exceeded: max ${limits.maxMessagesPerWindow} messages per ${limits.rateLimitWindowMs}ms window.`
			);
			return;
		}

		if (getRawDataByteLength(rawData) > limits.maxMessageBytes) {
			sendError(socket, "PAYLOAD_TOO_LARGE", `Payload exceeds ${limits.maxMessageBytes} bytes.`);
			return;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(rawData.toString());
		} catch {
			sendError(socket, "INVALID_JSON", "Payload must be valid JSON.");
			return;
		}

		if (!isRelayMessage(parsed)) {
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
				getRequestCorrelationId(parsed),
				maybeMessageType
			);
			return;
		}

		const message = parsed as ClientToServerMessage;
		logger.info(
			`Received message type=${message.type} requestId=${message.requestId} ${getSocketContext(socket)}`
		);

		if (message.type === "hello") {
			registerIdentity(message.from, socket);
			logger.info(`Registered client identity: ${message.from}`);

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
		}
	}

	wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
		const remoteAddress = normalizeRemoteAddress(req.socket.remoteAddress ?? "unknown");
		const connectionId = newCorrelationId().slice(0, 8);
		socketMetadata.set(socket, { connectionId, remoteAddress });
		touchSocket(socket);
		logger.info(`Client connected (${getSocketContext(socket)})`);
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
			const identity = socketToIdentity.get(socket);
			unregisterSocket(socket);
			logger.info(
				identity
					? `Client disconnected: ${identity} (${socketContext})`
					: `Client disconnected (${socketContext})`
			);
			notifyConnectionCount();
		});

		socket.on("error", (error: Error) => {
			logger.error(`Socket error ${getSocketContext(socket)}: ${error.message}`);
			unregisterSocket(socket);
		});
	});

	wss.on("error", (error: Error) => {
		logger.error(`Server error: ${error.message}`);
	});

	const port = await listen(httpServer, requestedPort, options.host);

	httpServer.on("error", (error: Error) => {
		logger.error(`Server error: ${error.message}`);
	});

	const heartbeatTimer = setInterval(() => {
		const now = Date.now();
		for (const socket of wss.clients) {
			const heartbeat = socketHeartbeatState.get(socket);
			const elapsedSinceLastSeen = now - (heartbeat?.lastSeenAt ?? now);

			if (elapsedSinceLastSeen > limits.staleSocketTimeoutMs) {
				staleSocketsClosed += 1;
				logger.info(
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
					logger.error(`Failed to ping ${getSocketContext(socket)}: ${message}`);
				}
			}
		}
	}, limits.heartbeatIntervalMs);
	heartbeatTimer.unref?.();

	const healthSummaryTimer = setInterval(() => {
		const connectedClients = wss.clients.size;
		const identifiedClients = identityToSocket.size;
		const anonymousClients = Math.max(connectedClients - identifiedClients, 0);

		logger.info(
			`Health summary: connections=${connectedClients} identified=${identifiedClients} anonymous=${anonymousClients} rateTracked=${socketRateState.size} staleClosed=${staleSocketsClosed} rejected=${rejectedConnections}`
		);
	}, limits.healthLogIntervalMs);
	healthSummaryTimer.unref?.();

	let closePromise: Promise<void> | undefined;

	const close = (): Promise<void> => {
		closePromise ??= (async () => {
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

			await new Promise<void>((resolve) => wss.close(() => resolve()));
			httpServer.closeAllConnections?.();
			await httpClosed;
			logger.info("Relay server stopped.");
		})();

		return closePromise;
	};

	return {
		port,
		connectionCount: () => wss.clients.size,
		close,
	};
}
