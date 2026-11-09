const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sodium = require("libsodium-wrappers");

const { EncryptedConversationHistory } = require(path.join(
	__dirname,
	"../dist/extension/src/messaging/conversationHistory.js"
));

async function createFixture() {
	await sodium.ready;
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "devchat-history-test-"));
	const secrets = new Map();
	const secretStorage = {
		get: async (key) => secrets.get(key),
		store: async (key, value) => secrets.set(key, value),
	};
	const keyPair = sodium.crypto_box_keypair();
	const publicKey = sodium.to_base64(keyPair.publicKey, sodium.base64_variants.ORIGINAL);
	return { directory, secrets, secretStorage, publicKey };
}

async function removeFixture(directory) {
	await fs.rm(directory, { recursive: true, force: true });
}

test("persists conversation history as authenticated ciphertext and reloads it", async () => {
	const fixture = await createFixture();
	let history;
	try {
		history = await EncryptedConversationHistory.load(fixture.directory, fixture.secretStorage);
		await history.addMessage(fixture.publicKey, {
			id: "incoming-1",
			direction: "incoming",
			text: "secret conversation history",
			sentAt: 1_700_000_000_000,
			senderKey: fixture.publicKey,
			fingerprint: "AAAA BBBB",
			verified: false,
		}, true);
		await history.addMessage(fixture.publicKey, {
			id: "outgoing-1",
			direction: "outgoing",
			text: "outgoing text",
			sentAt: 1_700_000_000_001,
			status: "pending",
		}, false);

		const filePath = path.join(fixture.directory, "conversation-history.v1.enc");
		const ciphertext = await fs.readFile(filePath, "utf8");
		assert.equal(ciphertext.includes("secret conversation history"), false);
		assert.equal(ciphertext.includes(fixture.publicKey), false);
		assert.equal(typeof fixture.secrets.get("devChat.conversationHistoryKey"), "string");

		history.dispose();
		history = await EncryptedConversationHistory.load(fixture.directory, fixture.secretStorage);
		assert.deepEqual(history.list([{ name: "Alice", publicKey: fixture.publicKey }]), [{
			publicKey: fixture.publicKey,
			name: "Alice",
			preview: "outgoing text",
			lastMessageAt: 1_700_000_000_001,
			unreadCount: 1,
		}]);
		assert.deepEqual(history.getMessages(fixture.publicKey), [
			{
				id: "incoming-1",
				direction: "incoming",
				text: "secret conversation history",
				sentAt: 1_700_000_000_000,
				senderKey: fixture.publicKey,
				fingerprint: "AAAA BBBB",
				verified: false,
			},
			{
				id: "outgoing-1",
				direction: "outgoing",
				text: "outgoing text",
				sentAt: 1_700_000_000_001,
				status: "unknown",
				reason: "Delivery could not be confirmed before the extension restarted.",
			},
		]);

		await history.updateStatus("outgoing-1", "sent");
		await history.updateVerification(fixture.publicKey, true);
		await history.markRead(fixture.publicKey);
		assert.equal(history.getMessages(fixture.publicKey)[0].verified, true);
		assert.equal(history.getMessages(fixture.publicKey)[1].status, "sent");
		assert.equal(history.list([])[0].unreadCount, 0);
	} finally {
		history?.dispose();
		await removeFixture(fixture.directory);
	}
});

test("serializes concurrent message writes without losing either conversation", async () => {
	const fixture = await createFixture();
	let history;
	try {
		history = await EncryptedConversationHistory.load(fixture.directory, fixture.secretStorage);
		const otherKeys = sodium.crypto_box_keypair();
		const otherPublicKey = sodium.to_base64(otherKeys.publicKey, sodium.base64_variants.ORIGINAL);
		await Promise.all([
			history.addMessage(fixture.publicKey, {
				id: "one",
				direction: "incoming",
				text: "first",
				sentAt: 1,
			}, true),
			history.addMessage(otherPublicKey, {
				id: "two",
				direction: "incoming",
				text: "second",
				sentAt: 2,
			}, true),
		]);
		assert.equal(history.getMessages(fixture.publicKey)[0].text, "first");
		assert.equal(history.getMessages(otherPublicKey)[0].text, "second");
		assert.equal(history.list([]).length, 2);
	} finally {
		history?.dispose();
		await removeFixture(fixture.directory);
	}
});

test("rejects tampered encrypted history without modifying it", async () => {
	const fixture = await createFixture();
	let history;
	try {
		history = await EncryptedConversationHistory.load(fixture.directory, fixture.secretStorage);
		await history.addMessage(fixture.publicKey, {
			id: "one",
			direction: "incoming",
			text: "do not lose this",
			sentAt: 1,
		}, true);
		history.dispose();
		history = undefined;

		const filePath = path.join(fixture.directory, "conversation-history.v1.enc");
		const original = await fs.readFile(filePath);
		const envelope = JSON.parse(original.toString("utf8"));
		const ciphertext = Buffer.from(envelope.ciphertext, "base64");
		ciphertext[ciphertext.length - 1] ^= 1;
		envelope.ciphertext = ciphertext.toString("base64");
		const tampered = Buffer.from(JSON.stringify(envelope));
		await fs.writeFile(filePath, tampered);

		await assert.rejects(EncryptedConversationHistory.load(fixture.directory, fixture.secretStorage), /Could not read encrypted conversation history/);
		assert.deepEqual(await fs.readFile(filePath), tampered);
	} finally {
		history?.dispose();
		await removeFixture(fixture.directory);
	}
});

test("fails explicitly when the stored history key is malformed or unavailable", async () => {
	const fixture = await createFixture();
	let history;
	try {
		fixture.secrets.set("devChat.conversationHistoryKey", "not-a-key");
		await assert.rejects(EncryptedConversationHistory.load(fixture.directory, fixture.secretStorage), /encryption key is invalid/);

		const unavailable = {
			get: async () => undefined,
			store: async () => { throw new Error("SecretStorage unavailable."); },
		};
		await assert.rejects(EncryptedConversationHistory.load(fixture.directory, unavailable), /SecretStorage unavailable/);
	} finally {
		history?.dispose();
		await removeFixture(fixture.directory);
	}
});
