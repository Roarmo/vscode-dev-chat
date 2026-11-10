import { createHash } from "crypto";

const FINGERPRINT_CONTEXT = "devchat.identity.v1";
const FINGERPRINT_HEX_LENGTH = 40;

/**
 * Stable, human-comparable fingerprint of a Dev Chat identity (encryption key + signing key).
 * Both keys are fixed-length 32-byte keys, so concatenating them is unambiguous.
 */
export function identityFingerprint(publicKey: string, signingPublicKey: string): string {
	const hex = createHash("sha256")
		.update(FINGERPRINT_CONTEXT)
		.update(Buffer.from(publicKey, "base64"))
		.update(Buffer.from(signingPublicKey, "base64"))
		.digest("hex")
		.slice(0, FINGERPRINT_HEX_LENGTH)
		.toUpperCase();
	return (hex.match(/.{4}/g) ?? []).join(" ");
}

/** Stable fingerprint for a saved encryption key when its signing key is not yet known. */
export function recipientKeyFingerprint(publicKey: string): string {
	const hex = createHash("sha256")
		.update("devchat.recipient-key.v1")
		.update(Buffer.from(publicKey, "base64"))
		.digest("hex")
		.slice(0, FINGERPRINT_HEX_LENGTH)
		.toUpperCase();
	return (hex.match(/.{4}/g) ?? []).join(" ");
}

/** Short label for a public key when no contact name is available. */
export function shortKeyLabel(publicKey: string): string {
	return publicKey.slice(0, 12);
}
