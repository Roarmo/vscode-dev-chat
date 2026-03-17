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

console.log("SRV CWD:", process.cwd())

const PORT = Number(process.env.PORT);

const { WebSocketServer } = require("ws") as typeof import("ws");



function main(): void {
	const server = new WebSocketServer({ port: PORT });

	server.on("connection", (socket: WebSocket, req: IncomingMessage) => {
		console.log(`Client connected from ${req.socket.remoteAddress ?? "unknown"}`);

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
			console.log(`Received message type: ${message.type}`);

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
			console.log("Client disconnected");
		});
	});

	console.log(`Dev Chat relay server listening on ws://127.0.0.1:${PORT}`);
}

main();
