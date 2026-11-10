import sodium from "libsodium-wrappers";
import { isIdentityPublicKey } from "../../../shared/relayAuthentication";

export const CONTACTS_STATE_KEY = "devChat.contacts";
const MAX_CONTACT_NAME_LENGTH = 80;

export interface Contact {
	name: string;
	publicKey: string;
}

export interface ContactStateLike {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): PromiseLike<void>;
}

export class ContactStore {
	private contacts = new Map<string, string>();
	private queue: Promise<void> = Promise.resolve();

	constructor(private readonly state: ContactStateLike) {
		const stored = state.get<unknown>(CONTACTS_STATE_KEY);
		if (stored === undefined) return;
		if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
			throw new Error("Saved contacts are invalid. The data was not changed; restore it from a backup.");
		}

		for (const [publicKey, name] of Object.entries(stored)) {
			if (!isIdentityPublicKey(publicKey) || !isContactName(name)) {
				throw new Error("Saved contacts are invalid. The data was not changed; restore it from a backup.");
			}
			this.contacts.set(publicKey, name.trim());
		}
	}

	public list(): Contact[] {
		return [...this.contacts].map(([publicKey, name]) => ({ name, publicKey }));
	}

	public async save(name: string, publicKey: string, currentPublicKey: string | undefined): Promise<void> {
		await this.enqueue(async () => {
			const normalizedName = validateName(name);
			if (!isIdentityPublicKey(publicKey) || !(await isUsableEncryptionKey(publicKey))) {
				throw new Error("Enter a valid Dev Chat public key.");
			}
			if (currentPublicKey !== undefined && !this.contacts.has(currentPublicKey)) {
				throw new Error("This contact no longer exists. Refresh the contact list and try again.");
			}
			if (this.contacts.has(publicKey) && publicKey !== currentPublicKey) {
				throw new Error("That public key is already saved as a contact.");
			}

			const next = new Map(this.contacts);
			if (currentPublicKey !== undefined) next.delete(currentPublicKey);
			next.set(publicKey, normalizedName);
			await this.persist(next);
		});
	}

	public async remove(publicKey: string): Promise<void> {
		await this.enqueue(async () => {
			if (!this.contacts.has(publicKey)) {
				throw new Error("This contact no longer exists. Refresh the contact list and try again.");
			}
			const next = new Map(this.contacts);
			next.delete(publicKey);
			await this.persist(next);
		});
	}

	private async persist(next: Map<string, string>): Promise<void> {
		await this.state.update(CONTACTS_STATE_KEY, Object.fromEntries(next));
		this.contacts = next;
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation);
		this.queue = result.then(() => undefined, () => undefined);
		return result;
	}
}

async function isUsableEncryptionKey(publicKey: string): Promise<boolean> {
	await sodium.ready;
	const scalar = sodium.randombytes_buf(sodium.crypto_scalarmult_SCALARBYTES);
	try {
		const sharedSecret = sodium.crypto_scalarmult(scalar, Buffer.from(publicKey, "base64"));
		sodium.memzero(sharedSecret);
		return true;
	} catch (error) {
		if (error instanceof Error && error.message === "weak public key") return false;
		throw error;
	} finally {
		sodium.memzero(scalar);
	}
}

function isContactName(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.trim().length <= MAX_CONTACT_NAME_LENGTH;
}

function validateName(value: string): string {
	const name = typeof value === "string" ? value.trim() : "";
	if (!name || name.length > MAX_CONTACT_NAME_LENGTH) {
		throw new Error(`Contact name must be between 1 and ${MAX_CONTACT_NAME_LENGTH} characters.`);
	}
	return name;
}
