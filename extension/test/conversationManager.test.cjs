const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sodium = require("libsodium-wrappers");

const extensionPath = path.join(__dirname, "../dist/extension/src/messaging");
const { EncryptedConversationHistory } = require(path.join(extensionPath, "conversationHistory.js"));
const { ConversationManager } = require(path.join(extensionPath, "conversationManager.js"));

async function createFixture() {
	await sodium.ready;
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "devchat-manager-test-"));
	const secrets = new Map();
	const secretStorage = {
		get: async (key) => secrets.get(key),
		store: async (key, value) => secrets.set(key, value),
	};
	const alice = sodium.to_base64(sodium.crypto_box_keypair().publicKey, sodium.base64_variants.ORIGINAL);
	const bob = sodium.to_base64(sodium.crypto_box_keypair().publicKey, sodium.base64_variants.ORIGINAL);
	const history = await EncryptedConversationHistory.load(directory, secretStorage);
	let relayListener;
	let inboxListener;
	const sent = [];
	const relay = {
		onMessage: (listener) => { relayListener = listener; return () => {}; },
		sendDirectMessage: (to, payload, requestId) => {
			sent.push({ to, payload, requestId });
			return true;
		},
	};
	const inbox = { onEvent: (listener) => { inboxListener = listener; return () => {}; } };
	const contacts = {
		list: () => [
			{ name: "Alice", publicKey: alice },
			{ name: "Bob", publicKey: bob },
		],
	};
	const encryption = {
		seal: (text, to, requestId, sentAt) => JSON.stringify({ text, to, requestId, sentAt }),
	};
	const errors = [];
	const manager = new ConversationManager(relay, inbox, encryption, contacts, history, {
		error: (message) => errors.push(message),
	});

	return {
		alice,
		bob,
		directory,
		errors,
		history,
		inboxListener: (event) => inboxListener(event),
		manager,
		relayListener: (message) => relayListener(message),
		secretStorage,
		sent,
	};
}

function waitForChanged(manager) {
	return new Promise((resolve) => {
		let dispose;
		dispose = manager.onEvent((event) => {
			if (event.type !== "changed") return;
			dispose();
			resolve(event.state);
		});
	});
}

test("isolates histories, tracks unread messages, and persists delivery state", async () => {
	const fixture = await createFixture();
	let disposed = false;
	try {
		assert.deepEqual(
			fixture.manager.state.conversations.map(({ name }) => name).sort(),
			["Alice", "Bob"]
		);
		await assert.rejects(
			fixture.manager.send(fixture.alice, "unselected", "message"),
			/Select a conversation/
		);

		await fixture.manager.select(fixture.alice);
		await fixture.manager.send(fixture.alice, "out-1", "message for Alice");
		assert.equal(fixture.sent.length, 1);
		assert.equal(fixture.sent[0].to, fixture.alice);
		assert.equal(fixture.manager.state.messages[0].status, "pending");

		const ackState = waitForChanged(fixture.manager);
		fixture.relayListener({ type: "ack", status: "delivered", correlationId: "out-1" });
		await ackState;
		assert.equal(fixture.manager.state.messages[0].status, "sent");

		const originalMarkRead = fixture.history.markRead.bind(fixture.history);
		let releaseMarkRead;
		fixture.history.markRead = async (publicKey) => {
			if (publicKey === fixture.bob) await new Promise((resolve) => { releaseMarkRead = resolve; });
			await originalMarkRead(publicKey);
		};
		const selectingBob = fixture.manager.select(fixture.bob);
		assert.equal(fixture.manager.state.activePublicKey, fixture.bob);
		const aliceIncomingState = waitForChanged(fixture.manager);
		fixture.inboxListener({
			type: "message",
			message: {
				requestId: "alice-in-1",
				text: "Alice replied",
				sentAt: 1_700_000_000_001,
				sender: {
					publicKey: fixture.alice,
					fingerprint: "AAAA BBBB",
					verified: true,
				},
			},
		});
		await aliceIncomingState;
		assert.equal(fixture.manager.state.activePublicKey, fixture.bob);
		assert.deepEqual(fixture.manager.state.messages, []);
		assert.equal(fixture.manager.state.conversations.find(({ publicKey }) => publicKey === fixture.alice).unreadCount, 1);
		releaseMarkRead();
		await selectingBob;
		fixture.history.markRead = originalMarkRead;

		fixture.manager.deactivate();
		const bobIncomingState = waitForChanged(fixture.manager);
		fixture.inboxListener({
			type: "message",
			message: {
				requestId: "bob-in-1",
				text: "Bob replied",
				sentAt: 1_700_000_000_002,
				sender: {
					publicKey: fixture.bob,
					fingerprint: "CCCC DDDD",
					verified: false,
				},
			},
		});
		await bobIncomingState;
		assert.equal(fixture.manager.state.conversations.find(({ publicKey }) => publicKey === fixture.bob).unreadCount, 1);

		await fixture.manager.select(fixture.alice);
		assert.equal(fixture.manager.state.conversations.find(({ publicKey }) => publicKey === fixture.alice).unreadCount, 0);
		assert.deepEqual(fixture.manager.state.messages.map(({ text }) => text), ["message for Alice", "Alice replied"]);
		assert.equal(fixture.manager.state.messages[0].status, "sent");
		assert.equal(fixture.manager.state.messages[1].verified, true);

		await fixture.manager.select(fixture.bob);
		assert.deepEqual(fixture.manager.state.messages.map(({ text }) => text), ["Bob replied"]);
		assert.equal(fixture.manager.state.conversations.find(({ publicKey }) => publicKey === fixture.bob).unreadCount, 0);
		assert.deepEqual(fixture.errors, []);

		fixture.manager.dispose();
		disposed = true;
		const encrypted = await fs.readFile(path.join(fixture.directory, "conversation-history.v1.enc"), "utf8");
		assert.equal(encrypted.includes("message for Alice"), false);
		assert.equal(encrypted.includes("Alice replied"), false);
		const reloaded = await EncryptedConversationHistory.load(fixture.directory, fixture.secretStorage);
		try {
			assert.deepEqual(reloaded.getMessages(fixture.alice).map(({ text, status }) => ({ text, status })), [
				{ text: "message for Alice", status: "sent" },
				{ text: "Alice replied", status: undefined },
			]);
			assert.deepEqual(reloaded.getMessages(fixture.bob).map(({ text }) => text), ["Bob replied"]);
			assert.equal(reloaded.list([]).find(({ publicKey }) => publicKey === fixture.alice).unreadCount, 0);
			assert.equal(reloaded.list([]).find(({ publicKey }) => publicKey === fixture.bob).unreadCount, 0);
		} finally {
			reloaded.dispose();
		}
	} finally {
		if (!disposed) fixture.manager.dispose();
		await fs.rm(fixture.directory, { recursive: true, force: true });
	}
});

test("persists unconfirmed delivery as unknown and definite rejections as failed", async () => {
	const fixture = await createFixture();
	let disposed = false;
	try {
		await fixture.manager.select(fixture.alice);
		for (const [id, code, expected] of [
			["disconnect", "DELIVERY_UNKNOWN", "unknown"],
			["forwarding", "FORWARD_FAILED", "unknown"],
			["offline", "RECIPIENT_OFFLINE", "failed"],
		]) {
			await fixture.manager.send(fixture.alice, id, `message ${id}`);
			const changed = waitForChanged(fixture.manager);
			fixture.relayListener({
				type: "error", correlationId: id, code, message: `result ${id}`, timestamp: new Date().toISOString(),
			});
			await changed;
			assert.equal(fixture.manager.state.messages.find((message) => message.id === id).status, expected);
		}
		assert.deepEqual(fixture.errors, []);
		fixture.manager.dispose();
		disposed = true;
		const reloaded = await EncryptedConversationHistory.load(fixture.directory, fixture.secretStorage);
		try {
			assert.deepEqual(reloaded.getMessages(fixture.alice).map(({ id, status }) => ({ id, status })), [
				{ id: "disconnect", status: "unknown" },
				{ id: "forwarding", status: "unknown" },
				{ id: "offline", status: "failed" },
			]);
		} finally {
			reloaded.dispose();
		}
	} finally {
		if (!disposed) fixture.manager.dispose();
		await fs.rm(fixture.directory, { recursive: true, force: true });
	}
});
