export const CONTACT_TRUST_STATE_KEY = "devChat.contactTrust";

/** What this device knows about a contact's identity. Contains public keys only. */
export interface ContactTrustRecord {
	signingKey: string;
	verified: boolean;
	firstSeen: number;
}

export type TrustEvaluation =
	| { status: "known"; record: ContactTrustRecord; isNew: boolean }
	| { status: "changed"; record: ContactTrustRecord };

export interface MementoLike {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): PromiseLike<void>;
}

/**
 * Remembers each contact's signing key the first time they message us (trust on first use),
 * flags any later change, and records whether the user verified the fingerprint out of band.
 */
export class ContactTrustStore {
	private readonly records = new Map<string, ContactTrustRecord>();
	private queue: Promise<void> = Promise.resolve();

	constructor(private readonly state: MementoLike, private readonly now: () => number = Date.now) {
		const stored = state.get<Record<string, unknown>>(CONTACT_TRUST_STATE_KEY);
		if (stored && typeof stored === "object") {
			for (const [publicKey, value] of Object.entries(stored)) {
				const record = value as Partial<ContactTrustRecord> | null;
				if (
					record &&
					typeof record.signingKey === "string" &&
					typeof record.verified === "boolean" &&
					typeof record.firstSeen === "number"
				) {
					this.records.set(publicKey, { signingKey: record.signingKey, verified: record.verified, firstSeen: record.firstSeen });
				}
			}
		}
	}

	public get(publicKey: string): ContactTrustRecord | undefined {
		const record = this.records.get(publicKey);
		return record ? { ...record } : undefined;
	}

	public list(): Array<{ publicKey: string; record: ContactTrustRecord }> {
		return [...this.records].map(([publicKey, record]) => ({ publicKey, record: { ...record } }));
	}

	/** Compares a sender's signing key with the stored one; stores it as unverified on first contact. */
	public async evaluate(publicKey: string, signingKey: string): Promise<TrustEvaluation> {
		return this.enqueue(async () => {
			const existing = this.records.get(publicKey);
			if (!existing) {
				const record: ContactTrustRecord = { signingKey, verified: false, firstSeen: this.now() };
				await this.saveRecord(publicKey, record);
				return { status: "known", record: { ...record }, isNew: true };
			}
			if (existing.signingKey === signingKey) {
				return { status: "known", record: { ...existing }, isNew: false };
			}
			return { status: "changed", record: { ...existing } };
		});
	}

	/** Accepts a new signing key for a contact. Verification is always reset. */
	public async replaceKey(publicKey: string, signingKey: string): Promise<void> {
		await this.enqueue(() => this.saveRecord(publicKey, { signingKey, verified: false, firstSeen: this.now() }));
	}

	public async setVerified(publicKey: string, verified: boolean): Promise<boolean> {
		return this.enqueue(async () => {
			const record = this.records.get(publicKey);
			if (!record) return false;
			await this.saveRecord(publicKey, { ...record, verified });
			return true;
		});
	}

	private async saveRecord(publicKey: string, record: ContactTrustRecord): Promise<void> {
		const next = new Map(this.records);
		next.set(publicKey, record);
		await this.state.update(CONTACT_TRUST_STATE_KEY, Object.fromEntries(next));
		this.records.set(publicKey, record);
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation);
		this.queue = result.then(() => undefined, () => undefined);
		return result;
	}
}
