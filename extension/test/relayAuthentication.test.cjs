const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const dist = path.join(__dirname, "..", "dist");
const { EncryptionService } = require(path.join(dist, "extension", "src", "encryption", "encryptionService.js"));
const {
	createRelayChallenge,
	generateJoinCode,
	isIdentityPublicKey,
	isJoinCode,
	joinCodesMatch,
	verifyRelayProof,
} = require(path.join(dist, "shared", "relayAuthentication.js"));
const { loadRelayAccess } = require(path.join(dist, "shared", "relayAccess.js"));

function secrets(initial = new Map()) {
	return {
		values: initial,
		get: async (key) => initial.get(key),
		store: async (key, value) => initial.set(key, value),
	};
}

test("relay challenge requires the encryption key and a signature from the claimed signing key", async () => {
	const aliceSecrets = secrets();
	const alice = await EncryptionService.load({ secrets: aliceSecrets });
	const attacker = await EncryptionService.load({
		secrets: secrets(new Map([["devChat.signing.privateKey", aliceSecrets.values.get("devChat.signing.privateKey")]])),
	});
	const code = generateJoinCode();
	const pending = createRelayChallenge("request", alice.publicKey, "relay", 123456);
	const { proof, signature } = alice.proveRelayChallenge(pending.challenge, code);

	assert.equal(verifyRelayProof(pending, alice.publicKey, alice.signingPublicKey, code, proof, signature), true);
	assert.equal(verifyRelayProof(pending, alice.publicKey, alice.signingPublicKey, generateJoinCode(), proof, signature), false);
	assert.equal(verifyRelayProof(pending, attacker.publicKey, alice.signingPublicKey, code, proof, signature), false);
	assert.equal(verifyRelayProof(
		{ ...pending, challenge: { ...pending.challenge, sessionId: "another-session" } },
		alice.publicKey, alice.signingPublicKey, code, proof, signature
	), false);
	const attackerProof = attacker.proveRelayChallenge(pending.challenge, code);
	assert.equal(verifyRelayProof(
		pending, alice.publicKey, alice.signingPublicKey, code, attackerProof.proof, attackerProof.signature
	), false, "the signing private key alone cannot claim another encryption identity");
	assert.equal(verifyRelayProof(pending, alice.publicKey, alice.signingPublicKey, code, proof, "invalid"), false);
	pending.sharedSecret.fill(0);
});

test("join codes are high-entropy canonical values and comparisons reject malformed input", () => {
	const code = generateJoinCode();
	assert.equal(isJoinCode(code), true);
	assert.equal(joinCodesMatch(code, code), true);
	assert.equal(joinCodesMatch(code, generateJoinCode()), false);
	assert.equal(joinCodesMatch(code, ""), false);
	assert.equal(isJoinCode(`${code}=`), false);
	assert.equal(isIdentityPublicKey(Buffer.alloc(32).toString("base64")), true);
	assert.equal(isIdentityPublicKey(Buffer.alloc(31).toString("base64")), false);
});

test("access-store failures are explicit without exposing stored codes", async () => {
	const identity = await EncryptionService.load({ secrets: secrets() });
	const code = generateJoinCode();
	const brokenLoad = {
		load: async () => { throw new Error(`Failed to load ${code}`); },
		save: async () => {},
	};
	await assert.rejects(
		loadRelayAccess({ adminPublicKey: identity.publicKey, store: brokenLoad }),
		(error) => /could not read relay access/i.test(error.message) && !error.message.includes(code)
	);
	const brokenSave = {
		load: async () => undefined,
		save: async (state) => { throw new Error(`Failed to save ${state.joinCode}`); },
	};
	await assert.rejects(
		loadRelayAccess({ adminPublicKey: identity.publicKey, store: brokenSave, initialJoinCode: code }),
		(error) => /could not save relay access/i.test(error.message) && !error.message.includes(code)
	);
});
