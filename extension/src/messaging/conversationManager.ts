import type { ServerToClientMessage } from "../../../shared/types";
import type { ContactStore } from "../encryption/contactStore";
import type { EncryptionService } from "../encryption/encryptionService";
import type { InboxEvent, SecureInbox } from "./secureInbox";
import { EncryptedConversationHistory, type ConversationState } from "./conversationHistory";

export interface ConversationRelay {
	onMessage(listener: (message: ServerToClientMessage) => void): () => void;
	sendDirectMessage(to: string, payload: string, requestId: string): boolean;
}

export interface ConversationLogger {
	error(message: string): void;
}

export type ConversationManagerEvent =
	| { type: "changed"; state: ConversationState }
	| { type: "notice"; message: string };

export class ConversationManager {
	private readonly listeners = new Set<(event: ConversationManagerEvent) => void>();
	private readonly disposers: Array<() => void>;
	private queue: Promise<void> = Promise.resolve();
	private activePublicKey: string | null = null;

	constructor(
		private readonly relay: ConversationRelay,
		private readonly inbox: Pick<SecureInbox, "onEvent">,
		private readonly encryption: EncryptionService,
		private readonly contacts: ContactStore,
		private readonly history: EncryptedConversationHistory,
		private readonly logger: ConversationLogger
	) {
		this.disposers = [
			inbox.onEvent((event) => this.enqueue(() => this.handleInboxEvent(event))),
			relay.onMessage((message) => this.enqueue(() => this.handleRelayMessage(message))),
		];
	}

	public get state(): ConversationState {
		const conversations = this.history.list(this.contacts.list());
		const active = this.activePublicKey;
		return {
			conversations,
			activePublicKey: active,
			messages: active ? this.history.getMessages(active) : [],
		};
	}

	public onEvent(listener: (event: ConversationManagerEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	public async activate(publicKey: string): Promise<void> {
		if (!this.isKnownConversation(publicKey)) {
			throw new Error("Select a saved contact or a conversation with message history.");
		}
		const previousPublicKey = this.activePublicKey;
		this.activePublicKey = publicKey;
		try {
			await this.history.markRead(publicKey);
		} catch (error) {
			this.activePublicKey = previousPublicKey;
			throw error;
		}
		this.emit({ type: "changed", state: this.state });
	}

	public select(publicKey: string | null): Promise<void> {
		if (publicKey) return this.activate(publicKey);
		this.deactivate();
		this.emit({ type: "changed", state: this.state });
		return Promise.resolve();
	}

	public deactivate(): void {
		this.activePublicKey = null;
	}

	public notifyContactsChanged(): void {
		this.emit({ type: "changed", state: this.state });
	}

	public async send(publicKey: string, id: string, text: string): Promise<void> {
		if (
			typeof publicKey !== "string" ||
			publicKey !== this.activePublicKey ||
			typeof id !== "string" ||
			id.length === 0 ||
			id.length > 128 ||
			typeof text !== "string" ||
			text.trim().length === 0
		) {
			throw new Error("Select a conversation and enter a message before sending.");
		}

		const sentAt = Date.now();
		await this.history.addMessage(publicKey, {
			id,
			direction: "outgoing",
			text,
			sentAt,
			status: "pending",
		}, false);
		this.emit({ type: "changed", state: this.state });

		let payload: string;
		try {
			payload = this.encryption.seal(text, publicKey, id, sentAt);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			await this.history.updateStatus(id, "failed", reason);
			this.emit({ type: "changed", state: this.state });
			throw new Error(`Could not encrypt this message: ${reason}`);
		}

		if (!this.relay.sendDirectMessage(publicKey, payload, id)) {
			const reason = "Connect to the relay before sending.";
			await this.history.updateStatus(id, "failed", reason);
			this.emit({ type: "changed", state: this.state });
			throw new Error(reason);
		}
	}

	public dispose(): void {
		this.activePublicKey = null;
		for (const dispose of this.disposers) dispose();
		this.listeners.clear();
		this.history.dispose();
	}

	private isKnownConversation(publicKey: string): boolean {
		return this.contacts.list().some((contact) => contact.publicKey === publicKey) || this.history.hasConversation(publicKey);
	}

	private async handleInboxEvent(event: InboxEvent): Promise<void> {
		switch (event.type) {
			case "message": {
				const { message } = event;
				const publicKey = message.sender.publicKey;
				await this.history.addMessage(publicKey, {
					id: message.requestId,
					direction: "incoming",
					text: message.text,
					sentAt: message.sentAt,
					senderKey: message.sender.publicKey,
					fingerprint: message.sender.fingerprint,
					verified: message.sender.verified,
				}, publicKey !== this.activePublicKey);
				this.emit({ type: "changed", state: this.state });
				break;
			}
			case "trustChanged":
				await this.history.updateVerification(event.publicKey, event.verified);
				this.emit({ type: "changed", state: this.state });
				break;
			case "rejected":
				this.emit({ type: "notice", message: event.reason });
				break;
			case "held":
				this.emit({
					type: "notice",
					message: `Messages from ${event.publicKey.slice(0, 12)} are held because their identity key changed. Review the change before accepting them.`,
				});
				break;
		}
	}

	private async handleRelayMessage(message: ServerToClientMessage): Promise<void> {
		if (message.type === "ack" && message.status === "delivered") {
			const changed = await this.history.updateStatus(message.correlationId, "sent");
			if (changed) this.emit({ type: "changed", state: this.state });
		} else if (message.type === "error") {
			if (message.correlationId) {
				const status = message.code === "DELIVERY_UNKNOWN" || message.code === "FORWARD_FAILED"
					? "unknown"
					: "failed";
				const changed = await this.history.updateStatus(message.correlationId, status, message.message);
				if (changed) this.emit({ type: "changed", state: this.state });
			}
			this.emit({ type: "notice", message: message.message });
		}
	}

	private enqueue(operation: () => Promise<void>): void {
		this.queue = this.queue.then(operation).catch((error: unknown) => {
			const reason = error instanceof Error ? error.message : String(error);
			this.logger.error(`Failed to update encrypted conversation history: ${reason}`);
			this.emit({ type: "notice", message: `Could not update conversation history: ${reason}` });
		});
	}

	private emit(event: ConversationManagerEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}
