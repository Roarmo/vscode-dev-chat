import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import sodium from "libsodium-wrappers";
import { isIdentityPublicKey } from "../../../shared/relayAuthentication";
import type { Contact } from "../encryption/contactStore";

const HISTORY_KEY_SECRET = "devChat.conversationHistoryKey";
const HISTORY_FILE = "conversation-history.v1.enc";
const MAX_HISTORY_FILE_BYTES = 50 * 1024 * 1024;
const MAX_MESSAGE_LENGTH = 16_384;
const B64 = () => sodium.base64_variants.ORIGINAL;

export interface ConversationMessage {
	id: string;
	direction: "incoming" | "outgoing";
	text: string;
	sentAt: number;
	status?: "pending" | "sent" | "failed" | "unknown";
	reason?: string;
	senderKey?: string;
	fingerprint?: string;
	verified?: boolean;
}

export interface ConversationSummary {
	publicKey: string;
	name: string;
	preview: string;
	lastMessageAt: number;
	unreadCount: number;
}

export interface ConversationState {
	conversations: ConversationSummary[];
	activePublicKey: string | null;
	messages: ConversationMessage[];
}

export interface HistorySecretStorage {
	get(key: string): PromiseLike<string | undefined>;
	store(key: string, value: string): PromiseLike<void>;
}

interface ConversationRecord {
	messages: ConversationMessage[];
	unreadCount: number;
}

interface HistoryDocument {
	version: 1;
	conversations: Record<string, ConversationRecord>;
}

interface EncryptedHistoryEnvelope {
	version: 1;
	nonce: string;
	ciphertext: string;
}

export class EncryptedConversationHistory {
	private readonly conversations = new Map<string, ConversationRecord>();
	private queue: Promise<void> = Promise.resolve();
	private readonly filePath: string;
	private disposed = false;

	private constructor(private readonly directory: string, private readonly key: Uint8Array) {
		this.filePath = path.join(directory, HISTORY_FILE);
	}

	public static async load(directory: string, secrets: HistorySecretStorage): Promise<EncryptedConversationHistory> {
		await sodium.ready;
		const storedKey = await secrets.get(HISTORY_KEY_SECRET);
		let key: Uint8Array;
		if (storedKey === undefined) {
			key = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
			try {
				await secrets.store(HISTORY_KEY_SECRET, sodium.to_base64(key, B64()));
			} catch (error) {
				sodium.memzero(key);
				throw error;
			}
		} else {
			const decodedKey = decodeCanonicalBase64(storedKey, sodium.crypto_secretbox_KEYBYTES);
			if (!decodedKey) throw new Error("The conversation-history encryption key is invalid. History was left untouched.");
			key = decodedKey;
		}

		const history = new EncryptedConversationHistory(directory, key);
		try {
			await history.read();
			await history.markPendingUnknown();
			return history;
		} catch (error) {
			sodium.memzero(key);
			throw error;
		}
	}

	public list(contacts: Contact[]): ConversationSummary[] {
		const names = new Map(contacts.map((contact) => [contact.publicKey, contact.name]));
		const publicKeys = new Set([...names.keys(), ...this.conversations.keys()]);
		return [...publicKeys].map((publicKey) => {
			const record = this.conversations.get(publicKey);
			const lastMessage = record?.messages[record.messages.length - 1];
			return {
				publicKey,
				name: names.get(publicKey) ?? publicKey.slice(0, 12),
				preview: lastMessage?.text.slice(0, 120) ?? "",
				lastMessageAt: lastMessage?.sentAt ?? 0,
				unreadCount: record?.unreadCount ?? 0,
			};
		}).sort((a, b) => b.lastMessageAt - a.lastMessageAt || a.name.localeCompare(b.name));
	}

	public getMessages(publicKey: string): ConversationMessage[] {
		return (this.conversations.get(publicKey)?.messages ?? []).map((message) => ({ ...message }));
	}

	public hasConversation(publicKey: string): boolean {
		return this.conversations.has(publicKey);
	}

	public async addMessage(publicKey: string, message: ConversationMessage, incrementUnread: boolean): Promise<void> {
		await this.enqueue(async () => {
			this.validateMessage(publicKey, message);
			const current = this.conversations.get(publicKey) ?? { messages: [], unreadCount: 0 };
			const next = new Map(this.conversations);
			next.set(publicKey, {
				messages: [...current.messages, { ...message }],
				unreadCount: current.unreadCount + (incrementUnread ? 1 : 0),
			});
			await this.persist(next);
		});
	}

	public async updateStatus(id: string, status: "sent" | "failed", reason?: string): Promise<boolean> {
		return this.enqueue(async () => {
			const next = new Map(this.conversations);
			let changed = false;
			for (const [publicKey, record] of this.conversations) {
				const messageIndex = record.messages.findIndex((message) => message.id === id && message.direction === "outgoing");
				if (messageIndex < 0) continue;
				const messages = record.messages.map((message, index) => {
					if (index !== messageIndex) return message;
					const updated: ConversationMessage = { ...message, status };
					if (reason !== undefined) updated.reason = reason;
					else delete updated.reason;
					return updated;
				});
				next.set(publicKey, { ...record, messages });
				changed = true;
			}
			if (changed) await this.persist(next);
			return changed;
		});
	}

	public async updateVerification(publicKey: string, verified: boolean): Promise<void> {
		await this.enqueue(async () => {
			const record = this.conversations.get(publicKey);
			if (!record) return;
			const next = new Map(this.conversations);
			next.set(publicKey, {
				...record,
				messages: record.messages.map((message) =>
					message.direction === "incoming" ? { ...message, verified } : message
				),
			});
			await this.persist(next);
		});
	}

	public async markRead(publicKey: string): Promise<void> {
		await this.enqueue(async () => {
			const record = this.conversations.get(publicKey);
			if (!record || record.unreadCount === 0) return;
			const next = new Map(this.conversations);
			next.set(publicKey, { ...record, unreadCount: 0 });
			await this.persist(next);
		});
	}

	public async markPendingUnknown(): Promise<void> {
		await this.enqueue(async () => {
			let changed = false;
			const next = new Map<string, ConversationRecord>();
			for (const [publicKey, record] of this.conversations) {
				const messages = record.messages.map((message) => {
					if (message.direction !== "outgoing" || message.status !== "pending") return message;
					changed = true;
					return {
						...message,
						status: "unknown" as const,
						reason: "Delivery could not be confirmed before the extension restarted.",
					};
				});
				next.set(publicKey, { ...record, messages });
			}
			if (changed) await this.persist(next);
		});
	}

	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		void this.queue.then(() => sodium.memzero(this.key));
	}

	private async read(): Promise<void> {
		let contents: Buffer;
		try {
			const details = await fs.stat(this.filePath);
			if (details.size > MAX_HISTORY_FILE_BYTES) {
				throw new Error("Encrypted conversation history is larger than the supported size; it was not changed.");
			}
			contents = await fs.readFile(this.filePath);
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return;
			throw error;
		}

		try {
			const envelope: unknown = JSON.parse(contents.toString("utf8"));
			if (!isEncryptedHistoryEnvelope(envelope)) throw new Error("Invalid encrypted history envelope.");
			const nonce = decodeCanonicalBase64(envelope.nonce, sodium.crypto_secretbox_NONCEBYTES);
			const ciphertext = decodeCanonicalBase64(envelope.ciphertext);
			if (!nonce || !ciphertext || ciphertext.length < sodium.crypto_secretbox_MACBYTES) {
				throw new Error("Invalid encrypted history data.");
			}
			const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, this.key);
			if (!plaintext) throw new Error("Conversation history could not be authenticated.");
			try {
				const document: unknown = JSON.parse(sodium.to_string(plaintext));
				if (!isHistoryDocument(document)) throw new Error("Invalid conversation history contents.");
				for (const [publicKey, record] of Object.entries(document.conversations)) {
					if (!isIdentityPublicKey(publicKey) || !isConversationRecord(record)) {
						throw new Error("Invalid conversation history contents.");
					}
					this.conversations.set(publicKey, {
						messages: record.messages.map((message) => ({ ...message })),
						unreadCount: record.unreadCount,
					});
				}
			} finally {
				sodium.memzero(plaintext);
			}
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`Could not read encrypted conversation history. It was not changed: ${reason}`);
		}
	}

	private validateMessage(publicKey: string, message: ConversationMessage): void {
		if (
			!isIdentityPublicKey(publicKey) ||
			typeof message.id !== "string" ||
			message.id.length === 0 ||
			message.id.length > 128 ||
			(message.direction !== "incoming" && message.direction !== "outgoing") ||
			typeof message.text !== "string" ||
			message.text.length === 0 ||
			message.text.length > MAX_MESSAGE_LENGTH ||
			!Number.isSafeInteger(message.sentAt) ||
			message.sentAt < 0
		) {
			throw new Error("Cannot save the conversation message because its data is invalid.");
		}
	}

	private async persist(next: Map<string, ConversationRecord>): Promise<void> {
		const document: HistoryDocument = {
			version: 1,
			conversations: Object.fromEntries(next),
		};
		const plaintext = sodium.from_string(JSON.stringify(document));
		const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
		try {
			const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, this.key);
			const envelope: EncryptedHistoryEnvelope = {
				version: 1,
				nonce: sodium.to_base64(nonce, B64()),
				ciphertext: sodium.to_base64(ciphertext, B64()),
			};
			const serialized = JSON.stringify(envelope);
			if (Buffer.byteLength(serialized, "utf8") > MAX_HISTORY_FILE_BYTES) {
				throw new Error("Encrypted conversation history reached the 50 MB limit. No messages were discarded.");
			}
			await this.writeAtomically(serialized);
			this.conversations.clear();
			for (const [publicKey, record] of next) {
				this.conversations.set(publicKey, {
					messages: record.messages.map((message) => ({ ...message })),
					unreadCount: record.unreadCount,
				});
			}
		} finally {
			sodium.memzero(plaintext);
			sodium.memzero(nonce);
		}
	}

	private async writeAtomically(contents: string): Promise<void> {
		await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
		const temporaryPath = `${this.filePath}.${randomBytes(12).toString("hex")}.tmp`;
		let temporaryCreated = false;
		try {
			const handle = await fs.open(temporaryPath, "wx", 0o600);
			temporaryCreated = true;
			try {
				await handle.writeFile(contents, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await fs.rename(temporaryPath, this.filePath);
			temporaryCreated = false;
		} catch (error) {
			if (temporaryCreated) {
				try {
					await fs.rm(temporaryPath, { force: true });
				} catch (cleanupError) {
					throw new Error(
						`Failed to write conversation history and clean up its temporary file. Write error: ${error instanceof Error ? error.message : String(error)}. Cleanup error: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
					);
				}
			}
			throw error;
		}
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		if (this.disposed) return Promise.reject(new Error("Conversation history is closed."));
		const result = this.queue.then(operation);
		this.queue = result.then(() => undefined, () => undefined);
		return result;
	}
}

function decodeCanonicalBase64(value: string, expectedLength?: number): Uint8Array | undefined {
	if (!value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return undefined;
	const decoded = Buffer.from(value, "base64");
	if (decoded.toString("base64") !== value || (expectedLength !== undefined && decoded.length !== expectedLength)) {
		return undefined;
	}
	return decoded;
}

function isEncryptedHistoryEnvelope(value: unknown): value is EncryptedHistoryEnvelope {
	if (!value || typeof value !== "object") return false;
	const envelope = value as Partial<EncryptedHistoryEnvelope>;
	return envelope.version === 1 && typeof envelope.nonce === "string" && typeof envelope.ciphertext === "string";
}

function isHistoryDocument(value: unknown): value is HistoryDocument {
	if (!value || typeof value !== "object") return false;
	const document = value as Partial<HistoryDocument>;
	return document.version === 1 && Boolean(document.conversations) && typeof document.conversations === "object" && !Array.isArray(document.conversations);
}

function isConversationRecord(value: unknown): value is ConversationRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<ConversationRecord>;
	return Number.isSafeInteger(record.unreadCount) &&
		(record.unreadCount as number) >= 0 &&
		Array.isArray(record.messages) &&
		record.messages.every(isConversationMessage);
}

function isConversationMessage(value: unknown): value is ConversationMessage {
	if (!value || typeof value !== "object") return false;
	const message = value as Partial<ConversationMessage>;
	return typeof message.id === "string" &&
		message.id.length > 0 &&
		message.id.length <= 128 &&
		(message.direction === "incoming" || message.direction === "outgoing") &&
		typeof message.text === "string" &&
		message.text.length > 0 &&
		message.text.length <= MAX_MESSAGE_LENGTH &&
		Number.isSafeInteger(message.sentAt) &&
		(message.sentAt as number) >= 0 &&
		(message.status === undefined || message.status === "pending" || message.status === "sent" || message.status === "failed" || message.status === "unknown") &&
		(message.reason === undefined || typeof message.reason === "string") &&
		(message.senderKey === undefined || isIdentityPublicKey(message.senderKey)) &&
		(message.fingerprint === undefined || typeof message.fingerprint === "string") &&
		(message.verified === undefined || typeof message.verified === "boolean");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
