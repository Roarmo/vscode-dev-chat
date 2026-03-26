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
const { WebSocketServer } = require("ws") as typeof import("ws");

const identityToSocket = new Map<string, WebSocket>();
const socketToIdentity = new Map<WebSocket, string>();
const socketRateState = new Map<WebSocket, { windowStart: number; count: number }>();

const DEFAULT_MAX_MESSAGE_BYTES = 8192;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 1000;
const DEFAULT_MAX_MESSAGES_PER_WINDOW = 20;

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

function main(): void {
	const port = parsePort(process.env.PORT);
	const server = new WebSocketServer({ port });
	const shutdown = (signal: NodeJS.Signals): void => {
		logInfo(`Received ${signal}; shutting down relay server.`);
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
		correlationId: string = newCorrelationId()
	): void {
		const errorResponse: ErrorMessage = {
			type: "error",
			correlationId,
			code,
			message,
			timestamp: new Date().toISOString(),
		};

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
		if (!identity) {
			return;
		}

		socketToIdentity.delete(socket);
		const mappedSocket = identityToSocket.get(identity);
		if (mappedSocket === socket) {
			identityToSocket.delete(identity);
		}
	}

	function getIdentityForSocket(socket: WebSocket): string | undefined {
		return socketToIdentity.get(socket);
	}

	function routeDirectMessage(senderSocket: WebSocket, message: DirectMessage): void {
		const correlationId = message.requestId;
		const senderIdentity = getIdentityForSocket(senderSocket);
		if (!senderIdentity) {
			const notRegistered: ErrorMessage = {
				type: "error",
				correlationId,
				code: "NOT_REGISTERED",
				message: "Send a hello message first to register your identity.",
				timestamp: new Date().toISOString(),
			};

			sendMessage(senderSocket, notRegistered);
			return;
		}

		if (senderIdentity !== message.from) {
			const identityMismatch: ErrorMessage = {
				type: "error",
				correlationId,
				code: "IDENTITY_MISMATCH",
				message: "Message sender does not match the registered session identity.",
				timestamp: new Date().toISOString(),
			};

			sendMessage(senderSocket, identityMismatch);
			return;
		}

		const targetSocket = identityToSocket.get(message.to);
		if (!targetSocket) {
			const recipientOffline: ErrorMessage = {
				type: "error",
				correlationId,
				code: "RECIPIENT_OFFLINE",
				message: `Recipient ${message.to} is not connected.`,
				timestamp: new Date().toISOString(),
			};

			sendMessage(senderSocket, recipientOffline);
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
		logInfo(`Client connected from ${req.socket.remoteAddress ?? "unknown"}`);

		const ready: ServerReadyMessage = {
			type: "server_ready",
			correlationId: newCorrelationId(),
			message: "Relay connection established",
			timestamp: new Date().toISOString(),
		};

		sendMessage(socket, ready);

		socket.on("message", (rawData: RawData) => {
			if (isRateLimited(socket)) {
				sendError(
					socket,
					"RATE_LIMITED",
					`Rate limit exceeded: max ${MAX_MESSAGES_PER_WINDOW} messages per ${RATE_LIMIT_WINDOW_MS}ms window.`
				);
				return;
			}

			const payloadBytes = getRawDataByteLength(rawData);
			if (payloadBytes > MAX_MESSAGE_BYTES) {
				sendError(
					socket,
					"PAYLOAD_TOO_LARGE",
					`Payload exceeds ${MAX_MESSAGE_BYTES} bytes.`
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

			if (!isRelayMessage(parsed)) {
				sendError(
					socket,
					"INVALID_SHAPE",
					"Payload does not match protocol shape.",
					getRequestCorrelationId(parsed)
				);
				return;
			}

			const message = parsed as ClientToServerMessage;
			logInfo(`Received message type: ${message.type}`);

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
			socketRateState.delete(socket);
			const identity = getIdentityForSocket(socket);
			unregisterSocket(socket);
			if (identity) {
				logInfo(`Client disconnected: ${identity}`);
				return;
			}

			logInfo("Client disconnected");
		});

		socket.on("error", () => {
			socketRateState.delete(socket);
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
