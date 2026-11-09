const {
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	sign,
} = require("node:crypto");

const X25519_PUBLIC_KEY_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

function createIdentity(authentication) {
	const encryption = generateKeyPairSync("x25519");
	const signing = generateKeyPairSync("ed25519");
	const rawPublicKey = (key) => key.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
	const identity = {
		publicKey: rawPublicKey(encryption.publicKey),
		signingPublicKey: rawPublicKey(signing.publicKey),
		proveRelayChallenge(challenge, joinCode) {
			const ephemeral = createPublicKey({
				key: Buffer.concat([X25519_PUBLIC_KEY_PREFIX, Buffer.from(challenge.ephemeralKey, "base64")]),
				format: "der",
				type: "spki",
			});
			const shared = diffieHellman({ privateKey: encryption.privateKey, publicKey: ephemeral });
			try {
				const proof = authentication.createEncryptionKeyProof(
					shared, challenge, identity.publicKey, identity.signingPublicKey, joinCode
				);
				const signature = sign(
					null,
					authentication.relaySignatureBytes(
						challenge, identity.publicKey, identity.signingPublicKey, joinCode, proof
					),
					signing.privateKey
				).toString("base64");
				return { proof, signature };
			} finally {
				shared.fill(0);
			}
		},
	};
	return identity;
}

function memoryStore() {
	let state;
	return {
		load: async () => state === undefined ? undefined : structuredClone(state),
		save: async (next) => { state = structuredClone(next); },
	};
}

function accessOptions(identity, initialJoinCode) {
	return {
		adminPublicKey: identity.publicKey,
		store: memoryStore(),
		...(initialJoinCode === undefined ? {} : { initialJoinCode }),
	};
}

module.exports = { createIdentity, memoryStore, accessOptions };
