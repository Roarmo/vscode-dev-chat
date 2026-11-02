import * as vscode from "vscode";
import sodium from "libsodium-wrappers";

const PRIVATE_KEY_SECRET = "devChat.encryption.privateKey";
const CIPHERTEXT_PREFIX = "sealedbox.v1:";

export class EncryptionService {
	private constructor(
		private readonly publicKeyBytes: Uint8Array,
		private readonly privateKeyBytes: Uint8Array
	) {}

	public static async load(context: vscode.ExtensionContext): Promise<EncryptionService> {
		await sodium.ready;

		const storedPrivateKey = await context.secrets.get(PRIVATE_KEY_SECRET);
		if (storedPrivateKey) {
			const privateKeyBytes = sodium.from_base64(storedPrivateKey, sodium.base64_variants.ORIGINAL);
			if (privateKeyBytes.length !== sodium.crypto_box_SECRETKEYBYTES) {
				throw new Error("Stored Dev Chat private key has an invalid length.");
			}
			return new EncryptionService(sodium.crypto_scalarmult_base(privateKeyBytes), privateKeyBytes);
		}

		const keyPair = sodium.crypto_box_keypair();
		await context.secrets.store(
			PRIVATE_KEY_SECRET,
			sodium.to_base64(keyPair.privateKey, sodium.base64_variants.ORIGINAL)
		);
		return new EncryptionService(keyPair.publicKey, keyPair.privateKey);
	}

	public get publicKey(): string {
		return sodium.to_base64(this.publicKeyBytes, sodium.base64_variants.ORIGINAL);
	}

	public encrypt(plaintext: string, recipientPublicKey: string): string {
		const recipientKeyBytes = sodium.from_base64(recipientPublicKey, sodium.base64_variants.ORIGINAL);
		if (recipientKeyBytes.length !== sodium.crypto_box_PUBLICKEYBYTES) {
			throw new Error("Recipient public key must be a valid Dev Chat public key.");
		}

		const ciphertext = sodium.crypto_box_seal(sodium.from_string(plaintext), recipientKeyBytes);
		return CIPHERTEXT_PREFIX + sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL);
	}

	public decrypt(payload: string): string {
		if (!payload.startsWith(CIPHERTEXT_PREFIX)) {
			throw new Error("Relay message is not a supported encrypted payload.");
		}

		const ciphertext = sodium.from_base64(
			payload.slice(CIPHERTEXT_PREFIX.length),
			sodium.base64_variants.ORIGINAL
		);
		const plaintext = sodium.crypto_box_seal_open(ciphertext, this.publicKeyBytes, this.privateKeyBytes);
		return sodium.to_string(plaintext);
	}
}