import * as vscode from "vscode";
import WebSocket, { RawData } from "ws";
import * as dotenv from "dotenv";
import {
	HelloMessage,
	ServerToClientMessage,
	isRelayMessage,
} from "../../shared/types";

dotenv.config();

const RELAY_URL = String(process.env.RELAY_URL);

export function activate(context: vscode.ExtensionContext): void {
	const connectRelay = vscode.commands.registerCommand("devChat.connectRelay", () => {
		const socket = new WebSocket(RELAY_URL);

		socket.on("open", () => {
			const payload: HelloMessage = {
				type: "hello",
				from: "local-dev-client",
				message: "Hello from VS Code extension",
				timestamp: new Date().toISOString(),
			};

			socket.send(JSON.stringify(payload));
			void vscode.window.showInformationMessage("Connected to relay and sent a test message.");
		});

		socket.on("message", (data: RawData) => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(data.toString());
			} catch {
				void vscode.window.showErrorMessage("Relay response was not valid JSON.");
				socket.close();
				return;
			}

			if (!isRelayMessage(parsed)) {
				void vscode.window.showErrorMessage("Relay response did not match protocol format.");
				socket.close();
				return;
			}

			const message = parsed as ServerToClientMessage;
			if (message.type === "server_ready") {
				void vscode.window.showInformationMessage(`Relay ready: ${message.message}`);
			} else if (message.type === "ack") {
				void vscode.window.showInformationMessage(`Relay ack: ${message.status}`);
			} else {
				void vscode.window.showErrorMessage(`Relay error: ${message.message}`);
			}

			socket.close();
		});

		socket.on("error", (err: Error) => {
			void vscode.window.showErrorMessage(`Relay connection failed: ${err.message}`);
		});
	});

	context.subscriptions.push(connectRelay);
}

export function deactivate(): void {
	// Reserved for future cleanup hooks.
}
