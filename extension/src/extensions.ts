import * as vscode from "vscode";
import { registerCommands } from "./commands/registerCommands";
import { Logger } from "./logger";
import { RelayClient, type RelayConnectionErrorCode } from "./relay/relayClient";
import { RelayController, getConfiguredRelayUrl } from "./relay/relayController";
import { HostRelayCertificateStore } from "./relay/hostRelayCertificate";
import { SecretRelayAccessStore } from "./relay/secretRelayAccessStore";
import { EncryptionService } from "./encryption/encryptionService";
import { ContactTrustStore } from "./encryption/contactTrust";
import { ContactStore } from "./encryption/contactStore";
import { MessageAuthenticator } from "./encryption/messageAuthenticator";
import { SecureInbox } from "./messaging/secureInbox";

const SECURITY_ERROR_CODES = new Set<RelayConnectionErrorCode>([
	"INSECURE_URL",
	"CERTIFICATE_MISMATCH",
	"CERTIFICATE_UNTRUSTED",
	"AUTHENTICATION_FAILED",
	"INVITE_REQUIRED",
	"JOIN_RATE_LIMITED",
]);

let relayController: RelayController | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const logger = new Logger("VSCode Dev Chat");
	const relayUrl = getConfiguredRelayUrl(logger, true);
	logger.info("Activating extension.");

	try {
		const encryptionService = await EncryptionService.load(context);
		const relayClient = new RelayClient(relayUrl, logger);
		const certificates = new HostRelayCertificateStore(
			context.globalState,
			context.secrets,
			undefined,
			(message) => logger.error(message)
		);
		const trustStore = new ContactTrustStore(context.globalState);
		const contactStore = new ContactStore(context.globalState);
		const inbox = new SecureInbox(
			relayClient,
			new MessageAuthenticator(encryptionService, trustStore),
			trustStore,
			encryptionService.fingerprint,
			logger,
			() => void vscode.commands.executeCommand("devChat.openChat")
		);
		relayController = new RelayController(
			relayClient, encryptionService, logger, certificates, new SecretRelayAccessStore(context.secrets), trustStore
		);
		registerCommands(context, logger, relayClient, relayController, encryptionService, inbox, contactStore);

		const stopWatchingErrors = relayClient.onConnectionError((error) => {
			if (!SECURITY_ERROR_CODES.has(error.code)) return;
			if (relayController?.isJoining) return;
			if (error.code === "INVITE_REQUIRED") {
				void vscode.window.showWarningMessage(`Dev Chat refused to connect: ${error.message}`, "Join with Invite").then((choice) => {
					if (choice === "Join with Invite") void vscode.commands.executeCommand("devChat.joinRelayWithInvite");
				});
				return;
			}
			if (error.code === "AUTHENTICATION_FAILED" || error.code === "JOIN_RATE_LIMITED") {
				void vscode.window.showWarningMessage(`Dev Chat refused to connect: ${error.message}`);
				return;
			}
			void vscode.window.showWarningMessage(`Dev Chat refused to connect: ${error.message}`, "Open Settings").then((choice) => {
				if (choice === "Open Settings") {
					void vscode.commands.executeCommand("workbench.action.openSettings", "devChat.relayUrl");
				}
			});
		});

		context.subscriptions.push({
			dispose: () => {
				stopWatchingErrors();
				inbox.dispose();
				relayClient.close();
				logger.info("Disposing logger");
				logger.dispose();
			},
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error(`Failed to initialize Dev Chat: ${message}`);
		logger.dispose();
		void vscode.window.showErrorMessage(`Dev Chat could not initialize: ${message}`);
	}
}

export async function deactivate(): Promise<void> {
	const controller = relayController;
	relayController = undefined;
	await controller?.dispose();
}
