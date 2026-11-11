import * as vscode from "vscode";
import { registerCommands } from "./commands/registerCommands";
import { Logger } from "./logger";
import { RelayClient, type RelayConnectionErrorCode } from "./relay/relayClient";
import { RelayController, getConfiguredRelayUrl } from "./relay/relayController";
import { HostRelayCertificateStore } from "./relay/hostRelayCertificate";
import { SecretRelayAccessStore } from "./relay/secretRelayAccessStore";
import { IdentityLifecycle, IdentityLifecycleError } from "./encryption/identityLifecycle";
import { IdentityChangeMonitor } from "./encryption/identityChangeMonitor";
import { ContactTrustStore } from "./encryption/contactTrust";
import { ContactStore } from "./encryption/contactStore";
import { MessageAuthenticator } from "./encryption/messageAuthenticator";
import { SecureInbox } from "./messaging/secureInbox";
import { EncryptedConversationHistory } from "./messaging/conversationHistory";
import { ConversationManager } from "./messaging/conversationManager";
import { DevChatUi } from "./ui/devChatUi";
import { ChatPanel } from "./ui/ChatPanel";
import { openGettingStartedWalkthrough } from "./ui/openGettingStartedWalkthrough";
import {
	confirmNewIdentity,
	confirmIdentityChange,
	confirmSigningKeyCreation,
	registerIdentityResetCommand,
	reportIdentityFailure,
	showIdentityNotice,
} from "./commands/identityCommands";

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
	const identityLifecycle = new IdentityLifecycle(context);
	context.subscriptions.push(registerIdentityResetCommand(identityLifecycle, logger));
	let disposeActive: (() => void) | undefined;

	try {
		const loadedIdentity = await identityLifecycle.load({
			confirmNewIdentity, confirmSigningKeyCreation, confirmIdentityChange,
		});
		const encryptionService = loadedIdentity.identity;
		const relayClient = new RelayClient(relayUrl, logger);
		const certificates = new HostRelayCertificateStore(
			context.globalState,
			context.secrets,
			undefined,
			(message) => logger.error(message)
		);
		const trustStore = new ContactTrustStore(context.globalState);
		const contactStore = new ContactStore(context.globalState);
		const conversationHistory = await EncryptedConversationHistory.load(context.globalStorageUri.fsPath, context.secrets);
		const inbox = new SecureInbox(
			relayClient,
			new MessageAuthenticator(encryptionService, trustStore),
			trustStore,
			encryptionService.fingerprint,
			logger,
			() => void vscode.commands.executeCommand("devChat.openChat")
		);
		const conversations = new ConversationManager(
			relayClient,
			inbox,
			encryptionService,
			contactStore,
			conversationHistory,
			logger
		);
		const controller = new RelayController(
			relayClient, encryptionService, logger, certificates, new SecretRelayAccessStore(context.secrets), trustStore
		);
		relayController = controller;

		let commands: vscode.Disposable | undefined;
		let ui: vscode.Disposable | undefined;
		let stopWatchingErrors: (() => void) | undefined;
		let monitor: IdentityChangeMonitor | undefined;
		let active = false;
		let disposed = false;
		let identityInvalidated = false;
		disposeActive = () => {
			if (disposed) return;
			disposed = true;
			monitor?.dispose();
			commands?.dispose();
			ui?.dispose();
			ChatPanel.currentPanel?.dispose();
			stopWatchingErrors?.();
			conversations.dispose();
			inbox.dispose();
			relayClient.dispose();
			if (relayController === controller) relayController = undefined;
			void controller.dispose().catch(() => {
				logger.error("Could not stop the Dev Chat hosted relay after shutting down identity services.");
				void vscode.window.showErrorMessage("Dev Chat could not stop its hosted relay. Close this VS Code window.");
			});
		};
		context.subscriptions.push({ dispose: disposeActive });
		const suspendForIdentityChange = () => {
			disposeActive?.();
			logger.error("The shared Dev Chat identity changed or became unavailable. Messaging was stopped in this window.");
			void Promise.resolve(vscode.window.showErrorMessage(
				"Your shared Dev Chat identity changed or its keys became unavailable. Messaging was stopped in this window. Reload to review the current identity; if the change is unexpected, restore your original secrets.",
				"Reload Window"
			)).then((choice) => {
				if (choice === "Reload Window") return vscode.commands.executeCommand("workbench.action.reloadWindow");
				return undefined;
			}).catch(() => logger.error("Could not display the identity-change warning or reload VS Code."));
		};
		monitor = new IdentityChangeMonitor(context.secrets, encryptionService.fingerprint, () => {
			identityInvalidated = true;
			if (active) suspendForIdentityChange();
		});
		if (!await monitor.check() || identityInvalidated) {
			throw new IdentityLifecycleError(
				"IDENTITY_MISMATCH",
				"Dev Chat's identity changed or became unavailable during initialization. Reload to review the current identity or restore the original secrets."
			);
		}

		commands = registerCommands(context, logger, relayClient, controller, encryptionService, inbox, contactStore, conversations);
		ui = new DevChatUi(relayClient, controller, inbox, logger);
		context.subscriptions.push(ui);
		stopWatchingErrors = relayClient.onConnectionError((error) => {
			if (!SECURITY_ERROR_CODES.has(error.code)) return;
			if (controller.isJoining) return;
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

		active = true;
		if (identityInvalidated) {
			suspendForIdentityChange();
			return;
		}
		void showIdentityNotice(loadedIdentity, logger);
		await openGettingStartedWalkthrough(context, logger);
	} catch (error) {
		disposeActive?.();
		if (error instanceof IdentityLifecycleError) {
			reportIdentityFailure(error, logger);
		} else {
			const message = error instanceof Error ? error.message : String(error);
			logger.error(`Failed to initialize Dev Chat: ${message}`);
			void vscode.window.showErrorMessage(`Dev Chat could not initialize: ${message}`);
		}
	} finally {
		context.subscriptions.push(logger);
	}
}

export async function deactivate(): Promise<void> {
	const controller = relayController;
	relayController = undefined;
	await controller?.dispose();
}
