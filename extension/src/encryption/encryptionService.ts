import type * as vscode from "vscode";
import sodium from "libsodium-wrappers";
import { identityFingerprint } from "./fingerprint";

const PRIVATE_KEY_SECRET = "devChat.encryption.privateKey";
const SIGNING_SEED_SECRET = "devChat.signing.privateKey";
const SIGNED_PAYLOAD_PREFIX = "signed.v1";
const SIGNATURE_CONTEXT = "devchat.direct-message.v1";
const INNER_VERSION = 1;
const B64 = () => sodium.base64_variants.ORIGINAL;

export type MessageVerificationErrorCode =
	| "UNSUPPORTED_PAYLOAD"
	| "MALFORMED_PAYLOAD"
	| "WRONG_RECIPIENT"
	| "INVALID_SIGNATURE"
	| "DECRYPTION_FAILED"
	| "SENDER_MISMATCH";

export class MessageVerificationError extends Error {
	constructor(public readonly code: MessageVerificationErrorCode, message: string) {
		super(message);
		this.name = "MessageVerificationError";
	}
}

/** Routing fields and payload of a direct message as delivered by the relay. */
export interface RoutedPayload {
	from: string;
	to: string;
	requestId: string;
	payload: string;
}

/** A direct message whose signature has been verified but which has not been decrypted yet. */
export interface VerifiedEnvelope {
	from: string;
	to: string;
	requestId: string;
	sentAt: number;
	signingKey: string;
	ciphertext: string;
}

/**
 * Holds the local identity: an X25519 sealed-box keypair for encryption and an Ed25519 keypair
 * for signing. Private keys only live in VS Code SecretStorage and in memory.
 */
export class EncryptionService {
	private constructor(
		private readonly publicKeyBytes: Uint8Array,
		private readonly privateKeyBytes: Uint8Array,
		private readonly signingPublicKeyBytes: Uint8Array,
		private readonly signingPrivateKeyBytes: Uint8Array
	) {}

	public static async load(context: Pick<vscode.ExtensionContext, "secrets">): Promise<EncryptionService> {
		await sodium.ready;
		const { publicKey, privateKey } = await loadEncryptionKeyPair(context.secrets);
		const signing = await loadSigningKeyPair(context.secrets);
		return new EncryptionService(publicKey, privateKey, signing.publicKey, signing.privateKey);
	}

	/** Encryption public key; this is the identity used for relay routing. */
	public get publicKey(): string {
		return sodium.to_base64(this.publicKeyBytes, B64());
	}

	public get signingPublicKey(): string {
		return sodium.to_base64(this.signingPublicKeyBytes, B64());
	}

	public get fingerprint(): string {
		return identityFingerprint(this.publicKey, this.signingPublicKey);
	}

	/**
	 * Encrypts `text` for the recipient and signs the ciphertext together with the routing fields.
	 * Returns the relay payload: `signed.v1:<signingKey>:<sentAt>:<signature>:<ciphertext>`.
	 */
	public seal(text: string, recipientPublicKey: string, requestId: string, sentAt: number = Date.now()): string {
		const recipientKeyBytes = decodeBase64(recipientPublicKey);
		if (
			!recipientKeyBytes ||
			recipientKeyBytes.length !== sodium.crypto_box_PUBLICKEYBYTES ||
			sodium.to_base64(recipientKeyBytes, B64()) !== recipientPublicKey
		) {
			throw new Error("Recipient public key must be a valid Dev Chat public key.");
		}
		if (!Number.isSafeInteger(sentAt) || sentAt < 0) {
			throw new Error("Message send time must be a non-negative integer.");
		}

		const inner = JSON.stringify({ v: INNER_VERSION, from: this.publicKey, signingKey: this.signingPublicKey, text });
		const ciphertext = sodium.to_base64(sodium.crypto_box_seal(sodium.from_string(inner), recipientKeyBytes), B64());
		const envelope = {
			from: this.publicKey,
			to: recipientPublicKey,
			requestId,
			sentAt,
			signingKey: this.signingPublicKey,
			ciphertext,
		};
		const signature = sodium.to_base64(
			sodium.crypto_sign_detached(signedBytes(envelope), this.signingPrivateKeyBytes),
			B64()
		);
		return [SIGNED_PAYLOAD_PREFIX, envelope.signingKey, String(sentAt), signature, ciphertext].join(":");
	}

	/** Checks the signature over the payload and routing fields. Does not decrypt. */
	public verify(message: RoutedPayload): VerifiedEnvelope {
		const parts = message.payload.split(":");
		if (parts[0] !== SIGNED_PAYLOAD_PREFIX) {
			throw new MessageVerificationError("UNSUPPORTED_PAYLOAD", "Message is not a signed Dev Chat message.");
		}
		if (parts.length !== 5) {
			throw new MessageVerificationError("MALFORMED_PAYLOAD", "Signed message has an invalid format.");
		}
		if (message.to !== this.publicKey) {
			throw new MessageVerificationError("WRONG_RECIPIENT", "Message is addressed to a different public key.");
		}

		const [, signingKey = "", sentAtText = "", signatureText = "", ciphertext = ""] = parts;
		const fromBytes = decodeBase64(message.from);
		const signingKeyBytes = decodeBase64(signingKey);
		const signatureBytes = decodeBase64(signatureText);
		if (
			fromBytes?.length !== sodium.crypto_box_PUBLICKEYBYTES ||
			signingKeyBytes?.length !== sodium.crypto_sign_PUBLICKEYBYTES ||
			signatureBytes?.length !== sodium.crypto_sign_BYTES ||
			!decodeBase64(ciphertext) ||
			!/^\d{1,15}$/.test(sentAtText)
		) {
			throw new MessageVerificationError("MALFORMED_PAYLOAD", "Signed message has an invalid format.");
		}

		const envelope: VerifiedEnvelope = {
			from: message.from,
			to: message.to,
			requestId: message.requestId,
			sentAt: Number(sentAtText),
			signingKey,
			ciphertext,
		};
		if (!sodium.crypto_sign_verify_detached(signatureBytes, signedBytes(envelope), signingKeyBytes)) {
			throw new MessageVerificationError("INVALID_SIGNATURE", "Message signature is invalid.");
		}
		return envelope;
	}

	/** Decrypts a verified envelope and checks that the encrypted content names the same sender. */
	public open(envelope: VerifiedEnvelope): string {
		let inner: unknown;
		try {
			const plaintext = sodium.crypto_box_seal_open(
				sodium.from_base64(envelope.ciphertext, B64()),
				this.publicKeyBytes,
				this.privateKeyBytes
			);
			inner = JSON.parse(sodium.to_string(plaintext));
		} catch {
			throw new MessageVerificationError("DECRYPTION_FAILED", "Message could not be decrypted.");
		}

		const candidate = inner as Record<string, unknown> | null;
		if (
			!candidate ||
			typeof candidate !== "object" ||
			candidate.v !== INNER_VERSION ||
			typeof candidate.text !== "string"
		) {
			throw new MessageVerificationError("MALFORMED_PAYLOAD", "Decrypted message has an invalid format.");
		}
		if (candidate.from !== envelope.from || candidate.signingKey !== envelope.signingKey) {
			throw new MessageVerificationError("SENDER_MISMATCH", "Encrypted sender does not match the message signer.");
		}
		return candidate.text;
	}
}

function signedBytes(envelope: VerifiedEnvelope): Uint8Array {
	return sodium.from_string(
		JSON.stringify([
			SIGNATURE_CONTEXT,
			envelope.from,
			envelope.to,
			envelope.requestId,
			envelope.sentAt,
			envelope.signingKey,
			envelope.ciphertext,
		])
	);
}

function decodeBase64(value: string): Uint8Array | undefined {
	if (!value) return undefined;
	try {
		return sodium.from_base64(value, B64());
	} catch {
		return undefined;
	}
}

async function loadEncryptionKeyPair(secrets: vscode.SecretStorage): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }> {
	const stored = await secrets.get(PRIVATE_KEY_SECRET);
	if (stored) {
		const privateKey = sodium.from_base64(stored, B64());
		if (privateKey.length !== sodium.crypto_box_SECRETKEYBYTES) {
			throw new Error("Stored Dev Chat private key has an invalid length.");
		}
		return { publicKey: sodium.crypto_scalarmult_base(privateKey), privateKey };
	}

	const keyPair = sodium.crypto_box_keypair();
	await secrets.store(PRIVATE_KEY_SECRET, sodium.to_base64(keyPair.privateKey, B64()));
	return keyPair;
}

async function loadSigningKeyPair(secrets: vscode.SecretStorage): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }> {
	const stored = await secrets.get(SIGNING_SEED_SECRET);
	if (stored) {
		const seed = sodium.from_base64(stored, B64());
		if (seed.length !== sodium.crypto_sign_SEEDBYTES) {
			throw new Error("Stored Dev Chat signing key has an invalid length.");
		}
		return sodium.crypto_sign_seed_keypair(seed);
	}

	const seed = sodium.randombytes_buf(sodium.crypto_sign_SEEDBYTES);
	await secrets.store(SIGNING_SEED_SECRET, sodium.to_base64(seed, B64()));
	return sodium.crypto_sign_seed_keypair(seed);
}
