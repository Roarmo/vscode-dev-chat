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
		const existing = this.records.get(publicKey);
		if (!existing) {
			const record: ContactTrustRecord = { signingKey, verified: false, firstSeen: this.now() };
			this.records.set(publicKey, record);
			await this.persist();
			return { status: "known", record: { ...record }, isNew: true };
		}
		if (existing.signingKey === signingKey) {
			return { status: "known", record: { ...existing }, isNew: false };
		}
		return { status: "changed", record: { ...existing } };
	}

	/** Accepts a new signing key for a contact. Verification is always reset. */
	public async replaceKey(publicKey: string, signingKey: string): Promise<void> {
		this.records.set(publicKey, { signingKey, verified: false, firstSeen: this.now() });
		await this.persist();
	}

	public async setVerified(publicKey: string, verified: boolean): Promise<boolean> {
		const record = this.records.get(publicKey);
		if (!record) return false;
		record.verified = verified;
		await this.persist();
		return true;
	}

	private persist(): PromiseLike<void> {
		return this.state.update(CONTACT_TRUST_STATE_KEY, Object.fromEntries(this.records));
	}
}
