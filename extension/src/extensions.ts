import * as vscode from "vscode";
import * as dotenv from "dotenv";
import { registerCommands } from "./commands/registerCommands";
import { Logger } from "./logger";

dotenv.config();

const URL = String(process.env.RELAY_URL || "");

export function activate(context: vscode.ExtensionContext): void {
	const logger = new Logger("VSCode Dev Chat");
	logger.info(`Activating extension. Relay URL: ${URL}`);

	registerCommands(context, URL, logger);

	context.subscriptions.push({
		dispose: () => {
			logger.info("Disposing logger");
			logger.dispose();
		},
	});
}

export function deactivate(): void {
	// cleanup handled by disposables
}
