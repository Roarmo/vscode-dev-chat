import * as vscode from "vscode";
import type { Logger } from "../logger";
import {
	IdentityLifecycle,
	IdentityLifecycleError,
	type LoadedIdentity,
} from "../encryption/identityLifecycle";

type IdentityLogger = Pick<Logger, "info" | "error">;

export async function confirmNewIdentity(): Promise<boolean> {
	const choice = await vscode.window.showInformationMessage(
		"Create a new Dev Chat identity?",
		{
			modal: true,
			detail:
				"Dev Chat stores its private encryption and signing keys in VS Code SecretStorage on this device. " +
				"Profiles using the same VS Code user-data directory share this identity; the keys are not synced to other devices. " +
				"If the keys are lost, Dev Chat cannot recover them. This creates a new identity, not a recovery of a previous identity. " +
				"Restore your original secrets instead if available, and close other VS Code windows sharing this user-data directory before creating an identity.",
		},
		"Create Identity"
	);
	return choice === "Create Identity";
}

export async function confirmSigningKeyCreation(): Promise<boolean> {
	const choice = await vscode.window.showWarningMessage(
		"Dev Chat found an encryption key but no signing key.",
		{
			modal: true,
			detail:
				"This can be an older installation or a lost signing key. Creating a signing key keeps your encryption key " +
				"but changes the identity fingerprint if you had a previous signing key. Contacts must compare and verify it again. " +
				"Restore your original SecretStorage if available instead of creating a replacement. " +
				"Close other VS Code windows sharing this user-data directory before continuing.",
		},
		"Create Signing Key"
	);
	return choice === "Create Signing Key";
}

export async function confirmIdentityChange(previousFingerprint: string, currentFingerprint: string): Promise<boolean> {
	const choice = await vscode.window.showWarningMessage(
		"Your shared Dev Chat identity has changed.",
		{
			modal: true,
			detail:
				`Previously recorded fingerprint: ${previousFingerprint}\nCurrent fingerprint: ${currentFingerprint}\n\n` +
				"This can happen after a reset in another VS Code profile or if SecretStorage was replaced. " +
				"Only use the current identity if you recognize the change; otherwise restore your original secrets or investigate first. " +
				"Accepting does not recover the old identity. Contacts must save the new public key and compare fingerprints again.",
		},
		"Use Current Identity"
	);
	return choice === "Use Current Identity";
}

export function registerIdentityResetCommand(lifecycle: IdentityLifecycle, logger: IdentityLogger): vscode.Disposable {
	let running = false;
	return vscode.commands.registerCommand("devChat.resetIdentity", async () => {
		if (running) {
			void vscode.window.showWarningMessage("Dev Chat identity reset is already being managed.");
			return;
		}
		running = true;
		try {
			let status: ReturnType<IdentityLifecycle["resetStatus"]> | "invalid";
			try {
				status = lifecycle.resetStatus();
			} catch (error) {
				if (!(error instanceof IdentityLifecycleError) || error.code !== "METADATA_CORRUPT") throw error;
				logger.error(error.message);
				status = "invalid";
			}

			if (status === "scheduled") {
				const choice = await vscode.window.showWarningMessage(
					"A Dev Chat identity reset is scheduled but has not started.",
					{
						modal: true,
						detail:
							"Close all other VS Code windows sharing this user-data directory, including other profiles. " +
							"Then reload this window to create the new shared identity, or cancel this reset.",
					},
					"Reload Window",
					"Cancel Reset"
				);
				if (choice === "Cancel Reset") {
					await lifecycle.cancelReset();
					void vscode.window.showInformationMessage("Dev Chat identity reset canceled in this window. No reset was performed here.");
				} else if (choice === "Reload Window") {
					await reloadWindow(logger, true);
				}
				return;
			}

			if (status === "in-progress") {
				const choice = await vscode.window.showWarningMessage(
					"The Dev Chat identity reset has started but did not finish.",
					{
						modal: true,
						detail: "The original keys may already have been replaced, so the reset cannot be safely canceled. Reload to retry.",
					},
					"Retry Reset"
				);
				if (choice === "Retry Reset") await reloadWindow(logger, false);
				return;
			}

			const expectedFingerprint = await lifecycle.currentFingerprintForReset();
			const choice = await vscode.window.showWarningMessage(
				"Reset your Dev Chat identity?",
				{
					modal: true,
					detail:
						(status === "invalid" ? "The saved reset state is invalid. " : "") +
						"After VS Code reloads, Dev Chat will replace both identity keys with new ones. " +
						"Messages encrypted for the old identity need the old private key and cannot be decrypted by the new identity. " +
						"Saved local history uses a separate key and is not deleted. Contacts must save your new public key and compare fingerprints again. " +
						"A new encryption key is treated as a new identity, not automatically flagged as a signing-key change. " +
						"You may need new relay invitations or administrator configuration; the old identity remains a relay member until removed. " +
						"This identity is shared by all profiles using the same VS Code user-data directory; they will need to review the change. " +
						"Close all other VS Code windows sharing that directory, including other profiles, before continuing. " +
						"A hosted relay and active connections in this window will stop on reload.",
				},
				"Reset Identity and Reload"
			);
			if (choice !== "Reset Identity and Reload") return;
			await lifecycle.scheduleReset(expectedFingerprint);
			await reloadWindow(logger, true);
		} catch (error) {
			const message = error instanceof IdentityLifecycleError
				? error.message
				: "Dev Chat could not manage the identity reset. Check VS Code storage and try again.";
			logger.error(`Identity reset failed: ${message}`);
			void vscode.window.showErrorMessage(message);
		} finally {
			running = false;
		}
	});
}

export async function showIdentityNotice(result: LoadedIdentity, logger: Pick<Logger, "error">): Promise<void> {
	if (result.status === "existing") return;
	const fingerprint = result.identity.fingerprint;
	const message = result.status === "reset"
		? `Dev Chat reset its shared identity. New public fingerprint: ${fingerprint}. Share your new public key and compare fingerprints with contacts; old encrypted messages require the old private key.`
		: result.status === "signing-key-created"
			? `Dev Chat created a signing key. Public identity fingerprint: ${fingerprint}. Compare and verify it with contacts again.`
			: result.status === "identity-changed"
				? `Dev Chat is using the reviewed shared identity. Public fingerprint: ${fingerprint}. Contacts must save your current public key and compare fingerprints again.`
				: `Dev Chat created a new identity. Public fingerprint: ${fingerprint}. This is not a previous identity; losing VS Code SecretStorage loses these private keys.`;
	try {
		await vscode.window.showInformationMessage(message);
	} catch {
		logger.error("Could not display the Dev Chat identity notice.");
	}
}

export function reportIdentityFailure(error: IdentityLifecycleError, logger: IdentityLogger): void {
	if (error.code === "SETUP_CANCELLED") {
		logger.info(error.message);
		void Promise.resolve(vscode.window.showInformationMessage(error.message, "Reload Window"))
			.then((choice) => choice === "Reload Window" ? vscode.commands.executeCommand("workbench.action.reloadWindow") : undefined)
			.catch(() => logger.error("Could not display the identity setup guidance or reload VS Code."));
		return;
	}

	logger.error(`Failed to initialize Dev Chat identity: ${error.message}`);
	const review = error.code === "IDENTITY_MISMATCH" || error.code === "RESET_CONFLICT";
	const actions = review ? ["Review Current Identity", "Reset Identity"] : ["Reset Identity", "Reload Window"];
	void Promise.resolve(vscode.window.showErrorMessage(`Dev Chat could not initialize: ${error.message}`, ...actions))
		.then((choice) => {
			if (choice === "Reset Identity") return vscode.commands.executeCommand("devChat.resetIdentity");
			if (choice === "Reload Window" || choice === "Review Current Identity") {
				return vscode.commands.executeCommand("workbench.action.reloadWindow");
			}
			return undefined;
		})
		.catch(() => logger.error("Could not display the identity recovery guidance or run the selected action."));
}

async function reloadWindow(logger: Pick<Logger, "error">, canCancel: boolean): Promise<void> {
	try {
		await vscode.commands.executeCommand("workbench.action.reloadWindow");
	} catch {
		logger.error("Dev Chat identity reset is pending, but VS Code could not reload.");
		const guidance = canCancel
			? "The reset is scheduled. Reload VS Code to complete it, or run Dev Chat: Reset Identity to cancel it."
			: "The reset has started. Reload VS Code to retry it.";
		void vscode.window.showErrorMessage(guidance);
	}
}
