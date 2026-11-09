const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const sodium = require("libsodium-wrappers");

const { EncryptionService } = require(path.join(
	__dirname,
	"../dist/extension/src/encryption/encryptionService.js"
));

function createContext() {
	const secrets = new Map();
	return {
		storedSecret: (key) => secrets.get(key),
		secrets: {
			get: async (key) => secrets.get(key),
			store: async (key, value) => secrets.set(key, value),
		},
	};
}

function route(sender, recipient, payload, requestId = "req-1") {
	return { from: sender.publicKey, to: recipient.publicKey, requestId, payload };
}

function replacePart(payload, index, value) {
	const parts = payload.split(":");
	parts[index] = value;
	return parts.join(":");
}

function flipBase64(value) {
	return (value[0] === "A" ? "B" : "A") + value.slice(1);
}

test("loads the same encryption and signing keys from secret storage", async () => {
	const context = createContext();
	const first = await EncryptionService.load(context);
	const second = await EncryptionService.load(context);

	assert.equal(second.publicKey, first.publicKey);
	assert.equal(second.signingPublicKey, first.signingPublicKey);
	assert.equal(second.fingerprint, first.fingerprint);
	assert.notEqual(first.signingPublicKey, first.publicKey);
	assert.equal(typeof context.storedSecret("devChat.encryption.privateKey"), "string");
	assert.equal(typeof context.storedSecret("devChat.signing.privateKey"), "string");
	assert.match(first.fingerprint, /^([0-9A-F]{4} ){9}[0-9A-F]{4}$/);
});

test("keeps the existing encryption key when adding a signing key", async () => {
	const context = createContext();
	const original = await EncryptionService.load(context);
	const secrets = new Map([["devChat.encryption.privateKey", context.storedSecret("devChat.encryption.privateKey")]]);
	const upgraded = await EncryptionService.load({
		secrets: { get: async (key) => secrets.get(key), store: async (key, value) => secrets.set(key, value) },
	});

	assert.equal(upgraded.publicKey, original.publicKey);
	assert.equal(typeof secrets.get("devChat.signing.privateKey"), "string");
});

test("signed messages verify and decrypt only for the recipient", async () => {
	const sender = await EncryptionService.load(createContext());
	const recipient = await EncryptionService.load(createContext());
	const text = "private relay test";
	const payload = sender.seal(text, recipient.publicKey, "req-1", 1_700_000_000_000);

	assert.match(payload, /^signed\.v1:/);
	assert.equal(payload.includes(text), false);
	assert.equal(payload.includes(sender.signingPublicKey), true);

	const envelope = recipient.verify(route(sender, recipient, payload));
	assert.equal(envelope.signingKey, sender.signingPublicKey);
	assert.equal(envelope.sentAt, 1_700_000_000_000);
	assert.equal(recipient.open(envelope), text);

	const outsider = await EncryptionService.load(createContext());
	assert.throws(() => outsider.verify(route(sender, recipient, payload)), { code: "WRONG_RECIPIENT" });
	assert.throws(() => outsider.verify({ ...route(sender, recipient, payload), to: outsider.publicKey }), {
		code: "INVALID_SIGNATURE",
	});
});

test("rejects tampered ciphertext, routing fields, send time and signatures", async () => {
	const sender = await EncryptionService.load(createContext());
	const recipient = await EncryptionService.load(createContext());
	const other = await EncryptionService.load(createContext());
	const payload = sender.seal("hello", recipient.publicKey, "req-1", 1_700_000_000_000);
	const routed = route(sender, recipient, payload);
	const [, , , signature, ciphertext] = payload.split(":");

	assert.throws(() => recipient.verify({ ...routed, payload: replacePart(payload, 4, flipBase64(ciphertext)) }), {
		code: "INVALID_SIGNATURE",
	});
	assert.throws(() => recipient.verify({ ...routed, payload: replacePart(payload, 3, flipBase64(signature)) }), {
		code: "INVALID_SIGNATURE",
	});
	assert.throws(() => recipient.verify({ ...routed, payload: replacePart(payload, 2, "1700000000001") }), {
		code: "INVALID_SIGNATURE",
	});
	assert.throws(() => recipient.verify({ ...routed, requestId: "req-2" }), { code: "INVALID_SIGNATURE" });
	assert.throws(() => recipient.verify({ ...routed, from: other.publicKey }), { code: "INVALID_SIGNATURE" });
	assert.throws(() => recipient.verify({ ...routed, to: other.publicKey }), { code: "WRONG_RECIPIENT" });
});

test("rejects captured ciphertext validly re-signed by someone else", async () => {
	await sodium.ready;
	const sender = await EncryptionService.load(createContext());
	const attacker = await EncryptionService.load(createContext());
	const recipient = await EncryptionService.load(createContext());
	const original = sender.seal("from sender", recipient.publicKey, "req-1", 1_700_000_000_000);
	const ciphertext = original.split(":")[4];

	const keyPair = sodium.crypto_sign_keypair();
	const signingKey = sodium.to_base64(keyPair.publicKey, sodium.base64_variants.ORIGINAL);
	const sentAt = 1_700_000_000_000;
	const signed = JSON.stringify([
		"devchat.direct-message.v1",
		attacker.publicKey,
		recipient.publicKey,
		"req-1",
		sentAt,
		signingKey,
		ciphertext,
	]);
	const signature = sodium.to_base64(
		sodium.crypto_sign_detached(sodium.from_string(signed), keyPair.privateKey),
		sodium.base64_variants.ORIGINAL
	);
	const resigned = ["signed.v1", signingKey, String(sentAt), signature, ciphertext].join(":");

	const envelope = recipient.verify(route(attacker, recipient, resigned));
	assert.throws(() => recipient.open(envelope), { code: "SENDER_MISMATCH" });
});

test("rejects unsigned, malformed and unsupported payloads and bad recipient keys", async () => {
	const encryption = await EncryptionService.load(createContext());
	const routed = { from: encryption.publicKey, to: encryption.publicKey, requestId: "1" };

	assert.throws(() => encryption.verify({ ...routed, payload: "plaintext message" }), { code: "UNSUPPORTED_PAYLOAD" });
	assert.throws(() => encryption.verify({ ...routed, payload: "sealedbox.v1:AAAA" }), { code: "UNSUPPORTED_PAYLOAD" });
	assert.throws(() => encryption.verify({ ...routed, payload: "signed.v1:a:b" }), { code: "MALFORMED_PAYLOAD" });
	assert.throws(() => encryption.verify({ ...routed, payload: "signed.v1:a:1:b:c" }), { code: "MALFORMED_PAYLOAD" });
	assert.throws(() => encryption.seal("text", "not-a-public-key", "1"), /valid Dev Chat public key/);
	assert.throws(() => encryption.seal("text", encryption.publicKey.slice(0, -4), "1"), /valid Dev Chat public key/);
});
