const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { CONTACTS_STATE_KEY, ContactStore } = require(path.join(
	__dirname,
	"../dist/extension/src/encryption/contactStore.js"
));
const { recipientKeyFingerprint } = require(path.join(
	__dirname,
	"../dist/extension/src/encryption/fingerprint.js"
));

function createMemento(initial) {
	const values = new Map(initial ? [[CONTACTS_STATE_KEY, initial]] : []);
	return {
		values,
		get: (key) => values.get(key),
		update: async (key, value) => values.set(key, value),
	};
}

function publicKey(byte) {
	return Buffer.alloc(32, byte).toString("base64");
}

test("persists public-key contacts separately and reloads them after restart", async () => {
	const memento = createMemento();
	const contacts = new ContactStore(memento);
	const aliceKey = publicKey(1);
	await contacts.save(" Alice ", aliceKey, undefined);

	assert.deepEqual(contacts.list(), [{ name: "Alice", publicKey: aliceKey }]);
	assert.deepEqual(memento.values.get(CONTACTS_STATE_KEY), { [aliceKey]: "Alice" });

	const restarted = new ContactStore(memento);
	assert.deepEqual(restarted.list(), [{ name: "Alice", publicKey: aliceKey }]);
	assert.match(recipientKeyFingerprint(aliceKey), /^([0-9A-F]{4} ){9}[0-9A-F]{4}$/);
	assert.equal(recipientKeyFingerprint(aliceKey), recipientKeyFingerprint(aliceKey));
	assert.notEqual(recipientKeyFingerprint(aliceKey), recipientKeyFingerprint(publicKey(2)));
});

test("updates a contact key and removes the saved entry", async () => {
	const memento = createMemento();
	const contacts = new ContactStore(memento);
	const oldKey = publicKey(1);
	const newKey = publicKey(2);
	await contacts.save("Alice", oldKey, undefined);
	await contacts.save("Alice Work", newKey, oldKey);

	assert.deepEqual(contacts.list(), [{ name: "Alice Work", publicKey: newKey }]);
	await contacts.remove(newKey);
	assert.deepEqual(contacts.list(), []);
	assert.deepEqual(memento.values.get(CONTACTS_STATE_KEY), {});
});

test("rejects malformed keys, empty names and duplicate recipient keys", async () => {
	const contacts = new ContactStore(createMemento());
	const aliceKey = publicKey(1);
	await assert.rejects(contacts.save("Alice", "not-a-public-key", undefined), /valid Dev Chat public key/);
	await assert.rejects(contacts.save("Alice", publicKey(0), undefined), /valid Dev Chat public key/);
	const lowOrderKey = Buffer.concat([Buffer.from([1]), Buffer.alloc(31)]).toString("base64");
	await assert.rejects(contacts.save("Alice", lowOrderKey, undefined), /valid Dev Chat public key/);
	await assert.rejects(contacts.save(" ", aliceKey, undefined), /Contact name/);
	await contacts.save("Alice", aliceKey, undefined);
	await assert.rejects(contacts.save("Alice copy", aliceKey, undefined), /already saved/);
	assert.deepEqual(contacts.list(), [{ name: "Alice", publicKey: aliceKey }]);
});

test("serializes concurrent saves without losing a contact", async () => {
	const values = new Map();
	let firstStarted;
	let releaseFirst;
	const started = new Promise((resolve) => { firstStarted = resolve; });
	const release = new Promise((resolve) => { releaseFirst = resolve; });
	let writes = 0;
	const contacts = new ContactStore({
		get: (key) => values.get(key),
		update: async (key, value) => {
			if (++writes === 1) {
				firstStarted();
				await release;
			}
			values.set(key, value);
		},
	});

	const first = contacts.save("Alice", publicKey(1), undefined);
	await started;
	const second = contacts.save("Bob", publicKey(2), undefined);
	releaseFirst();
	await Promise.all([first, second]);

	assert.deepEqual(contacts.list(), [
		{ name: "Alice", publicKey: publicKey(1) },
		{ name: "Bob", publicKey: publicKey(2) },
	]);
	assert.deepEqual(values.get(CONTACTS_STATE_KEY), { [publicKey(1)]: "Alice", [publicKey(2)]: "Bob" });
});

test("reports invalid stored contact data without overwriting it", () => {
	const stored = { [publicKey(1)]: "Alice", "invalid-key": "Bob" };
	const memento = createMemento(stored);

	assert.throws(() => new ContactStore(memento), /Saved contacts are invalid/);
	assert.equal(memento.values.get(CONTACTS_STATE_KEY), stored);
});

test("does not change in-memory contacts when persistence fails", async () => {
	const memento = {
		get: () => undefined,
		update: async () => { throw new Error("Storage unavailable."); },
	};
	const contacts = new ContactStore(memento);

	await assert.rejects(contacts.save("Alice", publicKey(1), undefined), /Storage unavailable/);
	assert.deepEqual(contacts.list(), []);
});

test("preserves an existing contact after a failed update and allows retry", async () => {
	const memento = createMemento();
	const update = memento.update;
	let fail = false;
	memento.update = async (key, value) => {
		if (fail) {
			fail = false;
			throw new Error("Storage unavailable.");
		}
		await update(key, value);
	};
	const contacts = new ContactStore(memento);
	const oldKey = publicKey(1);
	const newKey = publicKey(2);
	await contacts.save("Alice", oldKey, undefined);
	fail = true;
	await assert.rejects(contacts.save("Alice", newKey, oldKey), /Storage unavailable/);
	assert.deepEqual(contacts.list(), [{ name: "Alice", publicKey: oldKey }]);
	assert.deepEqual(memento.values.get(CONTACTS_STATE_KEY), { [oldKey]: "Alice" });

	await contacts.save("Alice", newKey, oldKey);
	assert.deepEqual(contacts.list(), [{ name: "Alice", publicKey: newKey }]);
});
