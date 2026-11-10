import type * as vscode from "vscode";
import sodium from "libsodium-wrappers";
import {
	createEncryptionKeyProof,
	decodeCanonicalBase64,
	relaySignatureBytes,
} from "../../../shared/relayAuthentication";
import type { RelayChallengeMessage } from "../../../shared/types";
import { identityFingerprint } from "./fingerprint";

export const PRIVATE_KEY_SECRET = "devChat.encryption.privateKey";
export const SIGNING_SEED_SECRET = "devChat.signing.privateKey";
export const IDENTITY_BUNDLE_SECRET = "devChat.identity.privateKeys";
export const IDENTITY_FORMAT_SECRET = "devChat.identity.storageFormat";
export const IDENTITY_FORMAT_VALUE = "bundle.v1";
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

export interface KeyCreationPolicy {
	encryption: boolean;
	signing: boolean;
}

export interface IdentityKeyBundle {
	version: 1;
	encryption: string;
	signing: string;
	resetId?: string;
}

export function isIdentityResetId(value: unknown): value is string {
	return typeof value === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function parseIdentityKeyBundle(value: string): IdentityKeyBundle | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const record = parsed as Record<string, unknown>;
	if (
		record.version !== 1 ||
		typeof record.encryption !== "string" ||
		typeof record.signing !== "string" ||
		(record.resetId !== undefined && !isIdentityResetId(record.resetId))
	) return undefined;
	const encryption = decodeCanonicalBase64(record.encryption, 32);
	const signing = decodeCanonicalBase64(record.signing, 32);
	if (!encryption || !signing) {
		encryption?.fill(0);
		signing?.fill(0);
		return undefined;
	}
	encryption.fill(0);
	signing.fill(0);
	return {
		version: 1,
		encryption: record.encryption,
		signing: record.signing,
		...(typeof record.resetId === "string" ? { resetId: record.resetId } : {}),
	};
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

	public static async load(
		context: Pick<vscode.ExtensionContext, "secrets">,
		creation: KeyCreationPolicy = { encryption: true, signing: true }
	): Promise<EncryptionService> {
		await sodium.ready;
		const storedBundle = await context.secrets.get(IDENTITY_BUNDLE_SECRET);
		const format = await context.secrets.get(IDENTITY_FORMAT_SECRET);
		if (format !== undefined && format !== IDENTITY_FORMAT_VALUE) {
			throw new Error("Stored Dev Chat identity format is invalid.");
		}
		if (storedBundle !== undefined) {
			const bundle = parseIdentityKeyBundle(storedBundle);
			if (!bundle) throw new Error("Stored Dev Chat identity keys are invalid.");
			return EncryptionService.fromKeyBundle(bundle);
		}
		if (format !== undefined) throw new Error("Stored Dev Chat identity keys are missing.");
		return EncryptionService.loadLegacy(context, creation);
	}

	public static fromKeyBundle(bundle: IdentityKeyBundle): EncryptionService {
		const privateKey = decodeCanonicalBase64(bundle.encryption, sodium.crypto_box_SECRETKEYBYTES);
		const seed = decodeCanonicalBase64(bundle.signing, sodium.crypto_sign_SEEDBYTES);
		if (!privateKey || !seed) {
			privateKey?.fill(0);
			seed?.fill(0);
			throw new Error("Stored Dev Chat identity keys are invalid.");
		}
		try {
			const signing = sodium.crypto_sign_seed_keypair(seed);
			return new EncryptionService(
				sodium.crypto_scalarmult_base(privateKey), privateKey, signing.publicKey, signing.privateKey
			);
		} catch (error) {
			sodium.memzero(privateKey);
			throw error;
		} finally {
			sodium.memzero(seed);
		}
	}

	private static async loadLegacy(
		context: Pick<vscode.ExtensionContext, "secrets">,
		creation: KeyCreationPolicy
	): Promise<EncryptionService> {
		await sodium.ready;
		const { publicKey, privateKey } = await loadEncryptionKeyPair(context.secrets, creation.encryption);
		try {
			const signing = await loadSigningKeyPair(context.secrets, creation.signing);
			return new EncryptionService(publicKey, privateKey, signing.publicKey, signing.privateKey);
		} catch (error) {
			sodium.memzero(privateKey);
			throw error;
		}
	}

	public static async storeIdentity(
		context: Pick<vscode.ExtensionContext, "secrets">,
		options: { encryption?: string; resetId?: string } = {}
	): Promise<EncryptionService> {
		await sodium.ready;
		const privateKey = options.encryption === undefined
			? sodium.crypto_box_keypair().privateKey
			: decodeCanonicalBase64(options.encryption, sodium.crypto_box_SECRETKEYBYTES);
		if (!privateKey) throw new Error("Stored Dev Chat private key is invalid.");
		const seed = sodium.randombytes_buf(sodium.crypto_sign_SEEDBYTES);
		const signing = sodium.crypto_sign_seed_keypair(seed);
		try {
			const bundle: IdentityKeyBundle = {
				version: 1,
				encryption: sodium.to_base64(privateKey, B64()),
				signing: sodium.to_base64(seed, B64()),
				...(options.resetId === undefined ? {} : { resetId: options.resetId }),
			};
			if (await context.secrets.get(IDENTITY_FORMAT_SECRET) !== IDENTITY_FORMAT_VALUE) {
				await context.secrets.store(IDENTITY_FORMAT_SECRET, IDENTITY_FORMAT_VALUE);
			}
			await context.secrets.store(IDENTITY_BUNDLE_SECRET, JSON.stringify(bundle));
			return new EncryptionService(
				sodium.crypto_scalarmult_base(privateKey), privateKey, signing.publicKey, signing.privateKey
			);
		} catch (error) {
			sodium.memzero(privateKey);
			sodium.memzero(signing.privateKey);
			throw error;
		} finally {
			sodium.memzero(seed);
		}
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

	/** Proves ownership of both identity keys without sending either private key to the relay. */
	public proveRelayChallenge(
		challenge: RelayChallengeMessage,
		joinCode: string
	): { proof: string; signature: string } {
		const ephemeralKey = decodeCanonicalBase64(challenge.ephemeralKey, sodium.crypto_scalarmult_BYTES);
		if (!ephemeralKey || !decodeCanonicalBase64(challenge.nonce, 32)) {
			throw new Error("Relay sent an invalid authentication challenge.");
		}

		const sharedSecret = sodium.crypto_scalarmult(this.privateKeyBytes, ephemeralKey);
		try {
			const proof = createEncryptionKeyProof(sharedSecret, challenge, this.publicKey, this.signingPublicKey, joinCode);
			const signature = sodium.to_base64(
				sodium.crypto_sign_detached(
					relaySignatureBytes(challenge, this.publicKey, this.signingPublicKey, joinCode, proof),
					this.signingPrivateKeyBytes
				),
				B64()
			);
			return { proof, signature };
		} finally {
			sharedSecret.fill(0);
		}
	}

	public signRelayInvitation(data: Uint8Array): string {
		return sodium.to_base64(sodium.crypto_sign_detached(data, this.signingPrivateKeyBytes), B64());
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

async function loadEncryptionKeyPair(
	secrets: vscode.SecretStorage,
	allowCreation: boolean
): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }> {
	const stored = await secrets.get(PRIVATE_KEY_SECRET);
	if (stored !== undefined) {
		const privateKey = decodeCanonicalBase64(stored, sodium.crypto_box_SECRETKEYBYTES);
		if (!privateKey) throw new Error("Stored Dev Chat private key is invalid.");
		return { publicKey: sodium.crypto_scalarmult_base(privateKey), privateKey };
	}
	if (!allowCreation) throw new Error("Stored Dev Chat private key is missing.");

	const keyPair = sodium.crypto_box_keypair();
	try {
		await secrets.store(PRIVATE_KEY_SECRET, sodium.to_base64(keyPair.privateKey, B64()));
	} catch (error) {
		sodium.memzero(keyPair.privateKey);
		throw error;
	}
	return keyPair;
}

async function loadSigningKeyPair(
	secrets: vscode.SecretStorage,
	allowCreation: boolean
): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }> {
	const stored = await secrets.get(SIGNING_SEED_SECRET);
	const seed = stored === undefined
		? undefined
		: decodeCanonicalBase64(stored, sodium.crypto_sign_SEEDBYTES);
	if (stored !== undefined && !seed) throw new Error("Stored Dev Chat signing key is invalid.");
	if (seed) {
		try {
			return sodium.crypto_sign_seed_keypair(seed);
		} finally {
			sodium.memzero(seed);
		}
	}
	if (!allowCreation) throw new Error("Stored Dev Chat signing key is missing.");

	const newSeed = sodium.randombytes_buf(sodium.crypto_sign_SEEDBYTES);
	try {
		await secrets.store(SIGNING_SEED_SECRET, sodium.to_base64(newSeed, B64()));
		return sodium.crypto_sign_seed_keypair(newSeed);
	} finally {
		sodium.memzero(newSeed);
	}
}
