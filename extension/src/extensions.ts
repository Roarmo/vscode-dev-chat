import * as vscode from "vscode";
import { registerCommands } from "./commands/registerCommands";
import { Logger } from "./logger";
import { RelayClient, type RelayConnectionErrorCode } from "./relay/relayClient";
import { RelayController, getConfiguredRelayUrl } from "./relay/relayController";
import { HostRelayCertificateStore } from "./relay/hostRelayCertificate";
import { EncryptionService } from "./encryption/encryptionService";

const SECURITY_ERROR_CODES = new Set<RelayConnectionErrorCode>([
	"INSECURE_URL",
	"CERTIFICATE_MISMATCH",
	"CERTIFICATE_UNTRUSTED",
]);

let relayController: RelayController | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const logger = new Logger("VSCode Dev Chat");
	const relayUrl = getConfiguredRelayUrl(logger, true);
	logger.info(`Activating extension. Relay URL: ${relayUrl}`);

	try {
		const encryptionService = await EncryptionService.load(context);
		const relayClient = new RelayClient(relayUrl, logger);
		const certificates = new HostRelayCertificateStore(
			context.globalState,
			context.secrets,
			undefined,
			(message) => logger.error(message)
		);
		relayController = new RelayController(relayClient, encryptionService.publicKey, logger, certificates);
		registerCommands(context, logger, relayClient, relayController, encryptionService);

		const stopWatchingErrors = relayClient.onConnectionError((error) => {
			if (!SECURITY_ERROR_CODES.has(error.code)) return;
			void vscode.window.showWarningMessage(`Dev Chat refused to connect: ${error.message}`, "Open Settings").then((choice) => {
				if (choice === "Open Settings") {
					void vscode.commands.executeCommand("workbench.action.openSettings", "devChat.relayUrl");
				}
			});
		});

		context.subscriptions.push({
			dispose: () => {
				stopWatchingErrors();
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
