import type { IncomingMessage } from "http";
import type { RawData, WebSocket } from "ws";
import * as dotenv from "dotenv";
import {
	AckMessage,
	ClientToServerMessage,
	ErrorMessage,
	ServerReadyMessage,
	isRelayMessage,
} from "../../shared/types";

dotenv.config();

const DEFAULT_PORT = 8787;

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
const { WebSocketServer } = require("ws") as typeof import("ws");



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

	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);

	server.on("error", (error: Error) => {
		logError(`Server error: ${error.message}`);
	});

	server.on("connection", (socket: WebSocket, req: IncomingMessage) => {
		logInfo(`Client connected from ${req.socket.remoteAddress ?? "unknown"}`);

		const ready: ServerReadyMessage = {
			type: "server_ready",
			message: "Relay connection established",
			timestamp: new Date().toISOString(),
		};

		socket.send(JSON.stringify(ready));

		socket.on("message", (rawData: RawData) => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(rawData.toString());
			} catch {
				const invalidJson: ErrorMessage = {
					type: "error",
					code: "INVALID_JSON",
					message: "Payload must be valid JSON.",
					timestamp: new Date().toISOString(),
				};

				socket.send(JSON.stringify(invalidJson));
				return;
			}

			if (!isRelayMessage(parsed)) {
				const invalidShape: ErrorMessage = {
					type: "error",
					code: "INVALID_SHAPE",
					message: "Payload does not match protocol shape.",
					timestamp: new Date().toISOString(),
				};

				socket.send(JSON.stringify(invalidShape));
				return;
			}

			const message = parsed as ClientToServerMessage;
			logInfo(`Received message type: ${message.type}`);

			if (message.type === "hello") {
				const ack: AckMessage = {
					type: "ack",
					messageId: `hello-${Date.now()}`,
					status: "accepted",
					timestamp: new Date().toISOString(),
				};

				socket.send(JSON.stringify(ack));
				return;
			}

			const unsupported: ErrorMessage = {
				type: "error",
				code: "UNSUPPORTED_MESSAGE",
				message: `Message type ${message.type} is not implemented yet.`,
				timestamp: new Date().toISOString(),
			};

			socket.send(JSON.stringify(unsupported));
		});

		socket.on("close", () => {
			logInfo("Client disconnected");
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
