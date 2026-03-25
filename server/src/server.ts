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

function newCorrelationId(): string {
	return randomUUID();
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
			let parsed: unknown;
			try {
				parsed = JSON.parse(rawData.toString());
			} catch {
				const invalidJson: ErrorMessage = {
					type: "error",
					correlationId: newCorrelationId(),
					code: "INVALID_JSON",
					message: "Payload must be valid JSON.",
					timestamp: new Date().toISOString(),
				};

				sendMessage(socket, invalidJson);
				return;
			}

			if (!isRelayMessage(parsed)) {
				const invalidShape: ErrorMessage = {
					type: "error",
					correlationId: newCorrelationId(),
					code: "INVALID_SHAPE",
					message: "Payload does not match protocol shape.",
					timestamp: new Date().toISOString(),
				};

				sendMessage(socket, invalidShape);
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
			const identity = getIdentityForSocket(socket);
			unregisterSocket(socket);
			if (identity) {
				logInfo(`Client disconnected: ${identity}`);
				return;
			}

			logInfo("Client disconnected");
		});

		socket.on("error", () => {
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
