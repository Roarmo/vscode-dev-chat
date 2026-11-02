import * as vscode from "vscode";
import * as dotenv from "dotenv";
import { registerCommands } from "./commands/registerCommands";
import { Logger } from "./logger";
import { RelayClient } from "./relay/relayClient";
import { EncryptionService } from "./encryption/encryptionService";

dotenv.config();

const URL = String(process.env.RELAY_URL || "ws://127.0.0.1:8787");

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const logger = new Logger("VSCode Dev Chat");
	logger.info(`Activating extension. Relay URL: ${URL}`);

	try {
		const encryptionService = await EncryptionService.load(context);
		const relayClient = new RelayClient(URL, logger);
		registerCommands(context, logger, relayClient, encryptionService);

		context.subscriptions.push({
			dispose: () => {
				relayClient.close();
				logger.info("Disposing logger");
				logger.dispose();
			},
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error(`Failed to initialize encryption: ${message}`);
		logger.dispose();
		void vscode.window.showErrorMessage(`Dev Chat could not initialize encryption: ${message}`);
	}
}

export function deactivate(): void {
	// cleanup handled by disposables
}
