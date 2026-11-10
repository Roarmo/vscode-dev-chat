import * as vscode from "vscode";
import type { ServerToClientMessage } from "../../../shared/types";
import type { ContactTrustStore } from "../encryption/contactTrust";
import { identityFingerprint, shortKeyLabel } from "../encryption/fingerprint";
import type { AuthenticatedMessage, MessageAuthenticator, PendingKeyChange } from "../encryption/messageAuthenticator";

export interface PendingKeyChangeSummary {
	contacts: number;
	messages: number;
}

export type InboxEvent =
	| { type: "message"; message: AuthenticatedMessage }
	| { type: "rejected"; from: string; reason: string }
	| { type: "held"; publicKey: string; heldCount: number }
	| { type: "pendingKeyChanges"; summary: PendingKeyChangeSummary }
	| { type: "trustChanged"; publicKey: string; verified: boolean };

export interface InboxRelay {
	onMessage(listener: (message: ServerToClientMessage) => void): () => void;
}

export interface InboxLogger {
	info(message: string): void;
	error(message: string): void;
}

const ACCEPT_KEY = "Accept New Key";
const DISCARD_HELD = "Discard Held Messages";

/**
 * Authenticates incoming direct messages in arrival order and drives the identity review UI:
 * key-change reviews, contact fingerprint verification and showing the user's own fingerprint.
 */
export class SecureInbox implements vscode.Disposable {
	private readonly listeners = new Set<(event: InboxEvent) => void>();
	private readonly stopListening: () => void;
	private queue: Promise<void> = Promise.resolve();

	constructor(
		relay: InboxRelay,
		private readonly authenticator: MessageAuthenticator,
		private readonly trust: ContactTrustStore,
		private readonly ownFingerprint: string,
		private readonly logger: InboxLogger,
		private readonly openChat: () => void
	) {
		this.stopListening = relay.onMessage((message) => {
			if (message.type !== "direct_message") return;
			this.queue = this.queue
				.then(() => this.handle(message))
				.catch((error: unknown) => {
					this.logger.error(`Failed to process incoming message: ${error instanceof Error ? error.message : String(error)}`);
				});
		});
	}

	public onEvent(listener: (event: InboxEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	public get pendingKeyChanges(): PendingKeyChangeSummary {
		const changes = this.authenticator.pendingKeyChanges();
		return {
			contacts: changes.length,
			messages: changes.reduce((total, change) => total + change.heldCount, 0),
		};
	}

	/** Resolves once every message received so far has been processed. */
	public idle(): Promise<void> {
		return this.queue;
	}

	public async reviewKeyChange(publicKey?: string): Promise<void> {
		const change = publicKey ? this.authenticator.getPendingKeyChange(publicKey) : await this.pickKeyChange();
		if (!change) return;

		const label = shortKeyLabel(change.publicKey);
		const choice = await vscode.window.showWarningMessage(
			`The identity key of contact ${label} changed. ${describeCount(change.heldCount)} held and not shown.`,
			{
				modal: true,
				detail:
					`Previous fingerprint: ${change.previousFingerprint}\nNew fingerprint: ${change.newFingerprint}\n\n` +
					"This happens when a contact reinstalls Dev Chat or moves to a new device, but it can also mean someone is impersonating them. " +
					"Confirm the new fingerprint with them over a trusted channel, such as in person or on a video call, before accepting." +
					(change.previouslyVerified ? "\n\nYou had verified their previous key. The new key will start as not verified." : ""),
			},
			ACCEPT_KEY,
			DISCARD_HELD
		);

		if (choice === ACCEPT_KEY) {
			const released = await this.authenticator.acceptKeyChange(change.publicKey);
			this.logger.info(`Accepted new identity key for ${label}; released ${released.length} held message(s).`);
			this.emitPendingKeyChanges();
			this.emit({ type: "trustChanged", publicKey: change.publicKey, verified: false });
			if (released.length > 0) {
				this.openChat();
				for (const message of released) this.emit({ type: "message", message });
			}
		} else if (choice === DISCARD_HELD) {
			const discarded = this.authenticator.rejectKeyChange(change.publicKey);
			this.logger.info(`Kept the previous identity key for ${label}; discarded ${discarded} held message(s).`);
			this.emitPendingKeyChanges();
			void vscode.window.showInformationMessage(
				`Discarded ${describeCount(discarded)} from ${label}. Their previous key is still trusted.`
			);
		}
	}

	public async verifyContact(): Promise<void> {
		const contacts = this.trust.list();
		if (contacts.length === 0) {
			void vscode.window.showInformationMessage("No contacts to verify yet. A contact appears here after they send you a message.");
			return;
		}

		const picked = await vscode.window.showQuickPick(
			contacts.map(({ publicKey, record }) => ({
				label: shortKeyLabel(publicKey),
				description: identityFingerprint(publicKey, record.signingKey),
				detail: record.verified ? "Verified" : "Not verified",
				publicKey,
			})),
			{ title: "Verify a contact's fingerprint", placeHolder: "Select a contact" }
		);
		if (!picked) return;

		const record = this.trust.get(picked.publicKey);
		if (!record) return;
		const action = record.verified ? "Mark as Not Verified" : "Mark as Verified";
		const choice = await vscode.window.showInformationMessage(
			`Compare fingerprints with contact ${picked.label}`,
			{
				modal: true,
				detail:
					`Their fingerprint: ${identityFingerprint(picked.publicKey, record.signingKey)}\nYour fingerprint: ${this.ownFingerprint}\n\n` +
					"Ask them to read their fingerprint to you over a trusted channel, such as in person or on a video call. " +
					"Only mark them as verified if every character matches.",
			},
			action
		);
		if (choice !== action) return;

		const verified = !record.verified;
		await this.trust.setVerified(picked.publicKey, verified);
		this.emit({ type: "trustChanged", publicKey: picked.publicKey, verified });
		void vscode.window.showInformationMessage(`Contact ${picked.label} is now ${verified ? "verified" : "not verified"}.`);
	}

	public async showMyFingerprint(): Promise<void> {
		const choice = await vscode.window.showInformationMessage(
			`Your Dev Chat fingerprint: ${this.ownFingerprint}. Contacts can compare it to verify your identity.`,
			"Copy"
		);
		if (choice === "Copy") {
			await vscode.env.clipboard.writeText(this.ownFingerprint);
		}
	}

	public dispose(): void {
		this.stopListening();
		this.listeners.clear();
	}

	private async handle(message: { from: string; to: string; requestId: string; payload: string }): Promise<void> {
		const result = await this.authenticator.receive(message);
		const label = shortKeyLabel(message.from);
		switch (result.kind) {
			case "accepted":
				this.emit({ type: "message", message: result.message });
				break;
			case "rejected":
				this.logger.error(`Rejected message ${message.requestId} from ${label}: ${result.code}`);
				this.emit({ type: "rejected", from: message.from, reason: `Rejected a message from ${label}: ${result.reason}` });
				break;
			case "held":
				this.logger.info(`Holding message ${message.requestId} from ${label}: identity key changed.`);
				this.emit({ type: "held", publicKey: result.change.publicKey, heldCount: result.change.heldCount });
				this.emitPendingKeyChanges();
				if (result.firstHeld) this.promptKeyChange(result.change);
				break;
		}
	}

	private promptKeyChange(change: PendingKeyChange): void {
		void Promise.resolve(
			vscode.window.showWarningMessage(
				`Dev Chat: the identity key of contact ${shortKeyLabel(change.publicKey)} changed. Their messages are held until you review the change.`,
				"Review"
			)
		)
			.then((choice) => (choice === "Review" ? this.reviewKeyChange(change.publicKey) : undefined))
			.catch((error: unknown) => {
				const reason = error instanceof Error ? error.message : String(error);
				this.logger.error(`Failed to review identity key change: ${reason}`);
				void vscode.window.showErrorMessage(`Dev Chat could not review the identity key change: ${reason}`);
			});
	}

	private async pickKeyChange(): Promise<PendingKeyChange | undefined> {
		const changes = this.authenticator.pendingKeyChanges();
		if (changes.length === 0) {
			void vscode.window.showInformationMessage("There are no contact key changes to review.");
			return undefined;
		}
		if (changes.length === 1) return changes[0];
		const picked = await vscode.window.showQuickPick(
			changes.map((change) => ({
				label: shortKeyLabel(change.publicKey),
				description: `${describeCount(change.heldCount)} held`,
				change,
			})),
			{ title: "Review contact key changes", placeHolder: "Select a contact" }
		);
		return picked?.change;
	}

	private emit(event: InboxEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}

	private emitPendingKeyChanges(): void {
		this.emit({ type: "pendingKeyChanges", summary: this.pendingKeyChanges });
	}
}

function describeCount(count: number): string {
	return `${count} message${count === 1 ? "" : "s"}`;
}
