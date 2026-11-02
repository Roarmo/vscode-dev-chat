import * as vscode from "vscode";
import * as dotenv from "dotenv";
import { randomUUID } from "crypto";
import { registerCommands } from "./commands/registerCommands";
import { Logger } from "./logger";
import { RelayClient } from "./relay/relayClient";

dotenv.config();

const URL = String(process.env.RELAY_URL || "ws://127.0.0.1:8787");

export function activate(context: vscode.ExtensionContext): void {
	const logger = new Logger("VSCode Dev Chat");
	logger.info(`Activating extension. Relay URL: ${URL}`);

	const identity = context.globalState.get<string>("devChat.identity") ?? randomUUID();
	if (!context.globalState.get<string>("devChat.identity")) {
		void context.globalState.update("devChat.identity", identity);
	}
	const relayClient = new RelayClient(URL, logger);
	registerCommands(context, logger, relayClient, identity);

	context.subscriptions.push({
		dispose: () => {
			relayClient.close();
			logger.info("Disposing logger");
			logger.dispose();
		},
	});
}

export function deactivate(): void {
	// cleanup handled by disposables
}
