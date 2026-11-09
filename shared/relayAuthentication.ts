import {
	createHash,
	createHmac,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	hkdfSync,
	randomBytes,
	randomUUID,
	timingSafeEqual,
	verify,
} from "crypto";
import type { RelayChallengeMessage } from "./types";

const X25519_PUBLIC_KEY_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const ED25519_PUBLIC_KEY_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const CHALLENGE_LIFETIME_MS = 30_000;
const PROOF_CONTEXT = "devchat.relay-proof.v1";
const SIGNATURE_CONTEXT = "devchat.relay-signature.v1";
const KEY_CONTEXT = "devchat.relay-session-key.v1";

export function decodeCanonicalBase64(value: string, length: number): Buffer | undefined {
	if (!value || value.length > Math.ceil(length / 3) * 4) return undefined;
	const decoded = Buffer.from(value, "base64");
	return decoded.length === length && decoded.toString("base64") === value ? decoded : undefined;
}

export function isIdentityPublicKey(value: unknown): value is string {
	return typeof value === "string" && decodeCanonicalBase64(value, 32) !== undefined;
}

export function generateJoinCode(): string {
	return randomBytes(32).toString("base64url");
}

export function isJoinCode(value: unknown): value is string {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
	const decoded = Buffer.from(value, "base64url");
	return decoded.length === 32 && decoded.toString("base64url") === value;
}

/** Hashing both inputs gives timingSafeEqual fixed-length operands, including for invalid codes. */
export function joinCodesMatch(expected: string, supplied: string): boolean {
	const expectedHash = createHash("sha256").update(expected).digest();
	const suppliedHash = createHash("sha256").update(supplied).digest();
	return timingSafeEqual(expectedHash, suppliedHash) && isJoinCode(supplied);
}

function publicKey(value: string, prefix: Buffer) {
	const raw = decodeCanonicalBase64(value, 32);
	if (!raw) throw new Error("Invalid identity public key.");
	return createPublicKey({ key: Buffer.concat([prefix, raw]), format: "der", type: "spki" });
}

export interface PendingRelayChallenge {
	challenge: RelayChallengeMessage;
	sharedSecret: Buffer;
}

/**
 * The ephemeral X25519 exchange proves possession of the encryption private key.
 * The client also signs the resulting proof with its independent Ed25519 key.
 */
export function createRelayChallenge(
	requestId: string,
	encryptionKey: string,
	relayId: string,
	now: number = Date.now()
): PendingRelayChallenge {
	const ephemeral = generateKeyPairSync("x25519");
	const encoded = ephemeral.publicKey.export({ format: "der", type: "spki" });
	const ephemeralKey = encoded.subarray(encoded.length - 32).toString("base64");
	const sharedSecret = diffieHellman({
		privateKey: ephemeral.privateKey,
		publicKey: publicKey(encryptionKey, X25519_PUBLIC_KEY_PREFIX),
	});

	return {
		challenge: {
			type: "relay_challenge",
			correlationId: requestId,
			challengeId: randomUUID(),
			relayId,
			sessionId: randomUUID(),
			nonce: randomBytes(32).toString("base64"),
			ephemeralKey,
			issuedAt: now,
			expiresAt: now + CHALLENGE_LIFETIME_MS,
			timestamp: new Date(now).toISOString(),
		},
		sharedSecret,
	};
}

function proofTranscript(
	challenge: RelayChallengeMessage,
	encryptionKey: string,
	signingKey: string,
	joinCode: string
): Buffer {
	return Buffer.from(JSON.stringify([
		PROOF_CONTEXT,
		challenge.correlationId,
		challenge.challengeId,
		challenge.relayId,
		challenge.sessionId,
		challenge.nonce,
		challenge.ephemeralKey,
		challenge.issuedAt,
		challenge.expiresAt,
		encryptionKey,
		signingKey,
		joinCode,
	]), "utf8");
}

export function createEncryptionKeyProof(
	sharedSecret: Uint8Array,
	challenge: RelayChallengeMessage,
	encryptionKey: string,
	signingKey: string,
	joinCode: string
): string {
	const nonce = decodeCanonicalBase64(challenge.nonce, 32);
	if (!nonce || sharedSecret.length !== 32) throw new Error("Invalid relay challenge.");
	const key = Buffer.from(hkdfSync("sha256", sharedSecret, nonce, KEY_CONTEXT, 32));
	try {
		return createHmac("sha256", key)
			.update(proofTranscript(challenge, encryptionKey, signingKey, joinCode))
			.digest("base64");
	} finally {
		key.fill(0);
	}
}

export function relaySignatureBytes(
	challenge: RelayChallengeMessage,
	encryptionKey: string,
	signingKey: string,
	joinCode: string,
	proof: string
): Buffer {
	return Buffer.from(JSON.stringify([
		SIGNATURE_CONTEXT,
		proofTranscript(challenge, encryptionKey, signingKey, joinCode).toString("utf8"),
		proof,
	]), "utf8");
}

export function verifyIdentitySignature(signingKey: string, data: Uint8Array, signature: string): boolean {
	const signatureBytes = decodeCanonicalBase64(signature, 64);
	if (!signatureBytes || !isIdentityPublicKey(signingKey)) return false;
	try {
		return verify(null, data, publicKey(signingKey, ED25519_PUBLIC_KEY_PREFIX), signatureBytes);
	} catch {
		return false;
	}
}

export function verifyRelayProof(
	pending: PendingRelayChallenge,
	encryptionKey: string,
	signingKey: string,
	joinCode: string,
	proof: string,
	signature: string
): boolean {
	const receivedProof = decodeCanonicalBase64(proof, 32);
	if (!receivedProof) return false;

	const expected = Buffer.from(
		createEncryptionKeyProof(pending.sharedSecret, pending.challenge, encryptionKey, signingKey, joinCode),
		"base64"
	);
	if (!timingSafeEqual(expected, receivedProof)) return false;

	return verifyIdentitySignature(
		signingKey,
		relaySignatureBytes(pending.challenge, encryptionKey, signingKey, joinCode, proof),
		signature
	);
}
