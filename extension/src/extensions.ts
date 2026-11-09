import * as vscode from "vscode";
import { registerCommands } from "./commands/registerCommands";
import { Logger } from "./logger";
import { RelayClient } from "./relay/relayClient";
import { RelayController, getConfiguredRelayUrl } from "./relay/relayController";
import { EncryptionService } from "./encryption/encryptionService";

let relayController: RelayController | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const logger = new Logger("VSCode Dev Chat");
	const relayUrl = getConfiguredRelayUrl(logger, true);
	logger.info(`Activating extension. Relay URL: ${relayUrl}`);

	try {
		const encryptionService = await EncryptionService.load(context);
		const relayClient = new RelayClient(relayUrl, logger);
		relayController = new RelayController(relayClient, encryptionService.publicKey, logger);
		registerCommands(context, logger, relayClient, relayController, encryptionService);

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

export async function deactivate(): Promise<void> {
	const controller = relayController;
	relayController = undefined;
	await controller?.dispose();
}
