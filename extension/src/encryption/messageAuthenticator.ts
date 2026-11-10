import type { ContactTrustStore } from "./contactTrust";
import { MessageVerificationError, type RoutedPayload, type VerifiedEnvelope } from "./encryptionService";
import { identityFingerprint } from "./fingerprint";

export interface MessageCrypto {
	verify(message: RoutedPayload): VerifiedEnvelope;
	open(envelope: VerifiedEnvelope): string;
}

export interface SenderIdentity {
	publicKey: string;
	signingKey: string;
	fingerprint: string;
	verified: boolean;
	/** True when this is the first message ever received from this identity. */
	isNew: boolean;
}

export interface AuthenticatedMessage {
	requestId: string;
	sentAt: number;
	text: string;
	sender: SenderIdentity;
}

export interface PendingKeyChange {
	publicKey: string;
	previousFingerprint: string;
	newFingerprint: string;
	previouslyVerified: boolean;
	heldCount: number;
}

export type RejectionCode =
	| MessageVerificationError["code"]
	| "STALE_MESSAGE"
	| "FUTURE_MESSAGE"
	| "REPLAYED_MESSAGE";

export type IncomingResult =
	| { kind: "accepted"; message: AuthenticatedMessage }
	| { kind: "held"; change: PendingKeyChange; firstHeld: boolean }
	| { kind: "rejected"; from: string; code: RejectionCode; reason: string };

export interface MessageAuthenticatorOptions {
	now?: () => number;
	maxClockSkewMs?: number;
	maxMessageAgeMs?: number;
	maxHeldPerContact?: number;
	maxReplayEntries?: number;
}

interface HeldMessages {
	signingKey: string;
	envelopes: VerifiedEnvelope[];
}

/**
 * Verifies every incoming direct message before it is decrypted or shown:
 * signature and routing fields, freshness, replay, and the sender's known signing key.
 * Messages signed with a changed key are held, still encrypted, until the user reviews the change.
 */
export class MessageAuthenticator {
	private readonly now: () => number;
	private readonly maxClockSkewMs: number;
	private readonly maxMessageAgeMs: number;
	private readonly maxHeldPerContact: number;
	private readonly maxReplayEntries: number;
	private readonly seen = new Map<string, number>();
	private readonly held = new Map<string, HeldMessages>();

	constructor(
		private readonly crypto: MessageCrypto,
		private readonly trust: ContactTrustStore,
		options: MessageAuthenticatorOptions = {}
	) {
		this.now = options.now ?? Date.now;
		this.maxClockSkewMs = options.maxClockSkewMs ?? 10 * 60 * 1000;
		this.maxMessageAgeMs = options.maxMessageAgeMs ?? 24 * 60 * 60 * 1000;
		this.maxHeldPerContact = options.maxHeldPerContact ?? 50;
		this.maxReplayEntries = options.maxReplayEntries ?? 10_000;
	}

	public async receive(message: RoutedPayload): Promise<IncomingResult> {
		let envelope: VerifiedEnvelope;
		try {
			envelope = this.crypto.verify(message);
		} catch (error) {
			return this.reject(message.from, error);
		}

		const now = this.now();
		if (envelope.sentAt > now + this.maxClockSkewMs) {
			return { kind: "rejected", from: envelope.from, code: "FUTURE_MESSAGE", reason: "Message send time is too far in the future." };
		}
		if (envelope.sentAt < now - this.maxMessageAgeMs) {
			return { kind: "rejected", from: envelope.from, code: "STALE_MESSAGE", reason: "Message is too old." };
		}
		if (!this.markSeen(envelope, now)) {
			return { kind: "rejected", from: envelope.from, code: "REPLAYED_MESSAGE", reason: "Message was already received." };
		}

		const evaluation = await this.trust.evaluate(envelope.from, envelope.signingKey);
		if (evaluation.status === "changed") {
			return this.hold(envelope, evaluation.record.signingKey, evaluation.record.verified);
		}

		try {
			const text = this.crypto.open(envelope);
			return {
				kind: "accepted",
				message: this.toMessage(envelope, text, evaluation.record.verified, evaluation.isNew),
			};
		} catch (error) {
			return this.reject(envelope.from, error);
		}
	}

	public pendingKeyChanges(): PendingKeyChange[] {
		return [...this.held.keys()]
			.map((publicKey) => this.describeChange(publicKey))
			.filter((change): change is PendingKeyChange => !!change);
	}

	public getPendingKeyChange(publicKey: string): PendingKeyChange | undefined {
		return this.describeChange(publicKey);
	}

	/** Trusts the new key (as unverified) and returns the held messages that decrypt correctly. */
	public async acceptKeyChange(publicKey: string): Promise<AuthenticatedMessage[]> {
		const entry = this.held.get(publicKey);
		if (!entry) return [];
		await this.trust.replaceKey(publicKey, entry.signingKey);
		if (this.held.get(publicKey) === entry) this.held.delete(publicKey);

		const accepted: AuthenticatedMessage[] = [];
		for (const envelope of entry.envelopes) {
			try {
				accepted.push(this.toMessage(envelope, this.crypto.open(envelope), false, false));
			} catch {
				// A held message that fails to decrypt is dropped.
			}
		}
		return accepted;
	}

	/** Discards held messages and keeps the previously known key. Returns how many were discarded. */
	public rejectKeyChange(publicKey: string): number {
		const entry = this.held.get(publicKey);
		this.held.delete(publicKey);
		return entry?.envelopes.length ?? 0;
	}

	private hold(envelope: VerifiedEnvelope, knownSigningKey: string, previouslyVerified: boolean): IncomingResult {
		let entry = this.held.get(envelope.from);
		let firstHeld = false;
		if (!entry || entry.signingKey !== envelope.signingKey) {
			entry = { signingKey: envelope.signingKey, envelopes: [] };
			this.held.set(envelope.from, entry);
			firstHeld = true;
		}
		entry.envelopes.push(envelope);
		if (entry.envelopes.length > this.maxHeldPerContact) {
			entry.envelopes.shift();
		}
		return {
			kind: "held",
			firstHeld,
			change: {
				publicKey: envelope.from,
				previousFingerprint: identityFingerprint(envelope.from, knownSigningKey),
				newFingerprint: identityFingerprint(envelope.from, envelope.signingKey),
				previouslyVerified,
				heldCount: entry.envelopes.length,
			},
		};
	}

	private describeChange(publicKey: string): PendingKeyChange | undefined {
		const entry = this.held.get(publicKey);
		const known = this.trust.get(publicKey);
		if (!entry || !known) return undefined;
		return {
			publicKey,
			previousFingerprint: identityFingerprint(publicKey, known.signingKey),
			newFingerprint: identityFingerprint(publicKey, entry.signingKey),
			previouslyVerified: known.verified,
			heldCount: entry.envelopes.length,
		};
	}

	private markSeen(envelope: VerifiedEnvelope, now: number): boolean {
		for (const [key, sentAt] of this.seen) {
			if (sentAt >= now - this.maxMessageAgeMs && this.seen.size < this.maxReplayEntries) break;
			this.seen.delete(key);
		}
		const key = JSON.stringify([envelope.from, envelope.requestId]);
		if (this.seen.has(key)) return false;
		this.seen.set(key, envelope.sentAt);
		return true;
	}

	private toMessage(envelope: VerifiedEnvelope, text: string, verified: boolean, isNew: boolean): AuthenticatedMessage {
		return {
			requestId: envelope.requestId,
			sentAt: envelope.sentAt,
			text,
			sender: {
				publicKey: envelope.from,
				signingKey: envelope.signingKey,
				fingerprint: identityFingerprint(envelope.from, envelope.signingKey),
				verified,
				isNew,
			},
		};
	}

	private reject(from: string, error: unknown): IncomingResult {
		if (error instanceof MessageVerificationError) {
			return { kind: "rejected", from, code: error.code, reason: error.message };
		}
		return { kind: "rejected", from, code: "MALFORMED_PAYLOAD", reason: error instanceof Error ? error.message : String(error) };
	}
}
