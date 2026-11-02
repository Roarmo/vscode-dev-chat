const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

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

test("loads the same keypair from secret storage", async () => {
	const context = createContext();
	const first = await EncryptionService.load(context);
	const second = await EncryptionService.load(context);

	assert.equal(second.publicKey, first.publicKey);
	assert.equal(typeof context.storedSecret("devChat.encryption.privateKey"), "string");
});

test("encrypts for the recipient and decrypts only with the recipient key", async () => {
	const sender = await EncryptionService.load(createContext());
	const recipient = await EncryptionService.load(createContext());
	const text = "private relay test";
	const payload = sender.encrypt(text, recipient.publicKey);

	assert.match(payload, /^sealedbox\.v1:/);
	assert.equal(payload.includes(text), false);
	assert.equal(recipient.decrypt(payload), text);
	assert.throws(() => sender.decrypt(payload));
});

test("rejects plaintext and malformed recipient keys", async () => {
	const encryption = await EncryptionService.load(createContext());

	assert.throws(() => encryption.decrypt("plaintext message"), /not a supported encrypted payload/);
	assert.throws(() => encryption.encrypt("text", "not-a-public-key"));
});