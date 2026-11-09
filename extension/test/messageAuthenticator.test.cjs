const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

const dist = path.join(__dirname, "../dist/extension/src/encryption");
const { EncryptionService } = require(path.join(dist, "encryptionService.js"));
const { ContactTrustStore, CONTACT_TRUST_STATE_KEY } = require(path.join(dist, "contactTrust.js"));
const { MessageAuthenticator } = require(path.join(dist, "messageAuthenticator.js"));

const NOW = 1_700_000_000_000;

function createSecrets(initial = []) {
	const secrets = new Map(initial);
	return { values: secrets, secrets: { get: async (key) => secrets.get(key), store: async (key, value) => secrets.set(key, value) } };
}

function createMemento(initial = {}) {
	const values = new Map(Object.entries(initial));
	return {
		values,
		get: (key) => values.get(key),
		update: async (key, value) => { values.set(key, JSON.parse(JSON.stringify(value))); },
	};
}

async function setup(options = {}) {
	const senderSecrets = createSecrets();
	const sender = await EncryptionService.load(senderSecrets);
	const recipient = await EncryptionService.load(createSecrets());
	// Same encryption key, new signing key: e.g. a reinstall or an impersonation attempt.
	const withChangedSigningKey = () =>
		EncryptionService.load(createSecrets([["devChat.encryption.privateKey", senderSecrets.values.get("devChat.encryption.privateKey")]]));
	const memento = options.memento ?? createMemento();
	const trust = new ContactTrustStore(memento, () => NOW);
	const authenticator = new MessageAuthenticator(recipient, trust, { now: () => NOW, ...options.authenticator });
	let counter = 0;
	const send = (from, text, overrides = {}) => {
		const requestId = overrides.requestId ?? `req-${++counter}`;
		return {
			from: from.publicKey,
			to: recipient.publicKey,
			requestId,
			payload: from.seal(text, recipient.publicKey, requestId, overrides.sentAt ?? NOW),
		};
	};
	return { sender, recipient, memento, trust, authenticator, send, withChangedSigningKey };
}

test("accepts a valid signed message and remembers the sender as unverified", async () => {
	const { sender, authenticator, memento, send } = await setup();

	const first = await authenticator.receive(send(sender, "hello"));
	assert.equal(first.kind, "accepted");
	assert.equal(first.message.text, "hello");
	assert.equal(first.message.sender.publicKey, sender.publicKey);
	assert.equal(first.message.sender.fingerprint, sender.fingerprint);
	assert.equal(first.message.sender.verified, false);
	assert.equal(first.message.sender.isNew, true);

	const second = await authenticator.receive(send(sender, "again"));
	assert.equal(second.kind, "accepted");
	assert.equal(second.message.sender.isNew, false);

	const stored = memento.values.get(CONTACT_TRUST_STATE_KEY)[sender.publicKey];
	assert.deepEqual(stored, { signingKey: sender.signingPublicKey, verified: false, firstSeen: NOW });
	assert.equal(JSON.stringify(memento.values.get(CONTACT_TRUST_STATE_KEY)).includes("private"), false);
});

test("verified status persists across restarts", async () => {
	const { sender, recipient, trust, memento, send } = await setup();
	await new MessageAuthenticator(recipient, trust, { now: () => NOW }).receive(send(sender, "hi"));
	assert.equal(await trust.setVerified(sender.publicKey, true), true);

	const restarted = new MessageAuthenticator(recipient, new ContactTrustStore(memento, () => NOW), { now: () => NOW });
	const result = await restarted.receive(send(sender, "after restart"));
	assert.equal(result.kind, "accepted");
	assert.equal(result.message.sender.verified, true);
});

test("rejects tampered messages before display", async () => {
	const { sender, authenticator, send } = await setup();
	const message = send(sender, "hello");
	const parts = message.payload.split(":");
	parts[4] = (parts[4][0] === "A" ? "B" : "A") + parts[4].slice(1);

	const result = await authenticator.receive({ ...message, payload: parts.join(":") });
	assert.equal(result.kind, "rejected");
	assert.equal(result.code, "INVALID_SIGNATURE");

	const unsigned = await authenticator.receive({ ...message, requestId: "x", payload: "sealedbox.v1:AAAA" });
	assert.equal(unsigned.code, "UNSUPPORTED_PAYLOAD");
});

test("rejects replayed, stale and future messages", async () => {
	const { sender, authenticator, send } = await setup();
	const message = send(sender, "once");

	assert.equal((await authenticator.receive(message)).kind, "accepted");
	assert.equal((await authenticator.receive(message)).code, "REPLAYED_MESSAGE");
	assert.equal((await authenticator.receive(send(sender, "old", { sentAt: NOW - 25 * 60 * 60 * 1000 }))).code, "STALE_MESSAGE");
	assert.equal((await authenticator.receive(send(sender, "future", { sentAt: NOW + 11 * 60 * 1000 }))).code, "FUTURE_MESSAGE");
	assert.equal((await authenticator.receive(send(sender, "skewed", { sentAt: NOW + 60 * 1000 }))).kind, "accepted");
});

test("holds messages from a changed key until the change is accepted, and resets verification", async () => {
	const { sender, trust, authenticator, send, withChangedSigningKey } = await setup();
	await authenticator.receive(send(sender, "original key"));
	await trust.setVerified(sender.publicKey, true);

	const changedSender = await withChangedSigningKey();
	assert.equal(changedSender.publicKey, sender.publicKey);
	const first = await authenticator.receive(send(changedSender, "new key 1"));
	assert.equal(first.kind, "held");
	assert.equal(first.firstHeld, true);
	assert.equal(first.change.previouslyVerified, true);
	assert.equal(first.change.previousFingerprint, sender.fingerprint);
	assert.equal(first.change.newFingerprint, changedSender.fingerprint);
	assert.notEqual(first.change.newFingerprint, first.change.previousFingerprint);

	const second = await authenticator.receive(send(changedSender, "new key 2"));
	assert.equal(second.kind, "held");
	assert.equal(second.firstHeld, false);
	assert.equal(second.change.heldCount, 2);
	assert.equal(trust.get(sender.publicKey).verified, true, "verified status of the old key is kept until review");

	// Messages signed with the previously known key still go through.
	assert.equal((await authenticator.receive(send(sender, "old key still ok"))).kind, "accepted");

	const released = await authenticator.acceptKeyChange(sender.publicKey);
	assert.deepEqual(released.map((message) => message.text), ["new key 1", "new key 2"]);
	assert.equal(released[0].sender.verified, false);
	assert.equal(trust.get(sender.publicKey).signingKey, changedSender.signingPublicKey);
	assert.equal(trust.get(sender.publicKey).verified, false);
	assert.deepEqual(authenticator.pendingKeyChanges(), []);

	const after = await authenticator.receive(send(changedSender, "accepted key"));
	assert.equal(after.kind, "accepted");
	assert.equal(after.message.sender.verified, false);
});

test("discarding a key change drops held messages and keeps the old key", async () => {
	const { sender, trust, authenticator, send, withChangedSigningKey } = await setup({ authenticator: { maxHeldPerContact: 2 } });
	await authenticator.receive(send(sender, "original"));
	const changedSender = await withChangedSigningKey();

	await authenticator.receive(send(changedSender, "1"));
	await authenticator.receive(send(changedSender, "2"));
	const third = await authenticator.receive(send(changedSender, "3"));
	assert.equal(third.change.heldCount, 2);
	assert.equal(authenticator.pendingKeyChanges().length, 1);

	assert.equal(authenticator.rejectKeyChange(sender.publicKey), 2);
	assert.deepEqual(authenticator.pendingKeyChanges(), []);
	assert.equal(trust.get(sender.publicKey).signingKey, sender.signingPublicKey);
	assert.deepEqual(await authenticator.acceptKeyChange(sender.publicKey), []);
	assert.equal((await authenticator.receive(send(changedSender, "4"))).kind, "held");
});

test("ignores malformed stored trust records", async () => {
	const memento = createMemento({ [CONTACT_TRUST_STATE_KEY]: { good: { signingKey: "k", verified: true, firstSeen: 1 }, bad: { verified: "yes" } } });
	const trust = new ContactTrustStore(memento);
	assert.deepEqual(trust.list().map((entry) => entry.publicKey), ["good"]);
	assert.equal(await trust.setVerified("missing", true), false);
});

test("failed contact storage leaves the previously saved trust state unchanged", async () => {
	const memento = createMemento();
	const update = memento.update;
	let fail = false;
	memento.update = async (...args) => {
		if (fail) {
			fail = false;
			throw new Error("Storage unavailable");
		}
		await update(...args);
	};
	const trust = new ContactTrustStore(memento, () => NOW);
	fail = true;
	await assert.rejects(trust.evaluate("new", "signing"), /Storage unavailable/);
	assert.equal(trust.get("new"), undefined);

	await trust.evaluate("known", "old");
	await trust.setVerified("known", true);
	fail = true;
	await assert.rejects(trust.replaceKey("known", "new"), /Storage unavailable/);
	assert.deepEqual(trust.get("known"), { signingKey: "old", verified: true, firstSeen: NOW });
	fail = true;
	await assert.rejects(trust.setVerified("known", false), /Storage unavailable/);
	assert.equal(trust.get("known").verified, true);
	assert.deepEqual(memento.values.get(CONTACT_TRUST_STATE_KEY).known, trust.get("known"));

	await trust.replaceKey("known", "new");
	assert.equal(trust.get("known").verified, false);
});

test("serializes concurrent contact updates without losing a saved contact", async () => {
	const memento = createMemento();
	const update = memento.update;
	let release;
	let entered;
	const blocked = new Promise((resolve) => { release = resolve; });
	const started = new Promise((resolve) => { entered = resolve; });
	let first = true;
	memento.update = async (...args) => {
		if (first) {
			first = false;
			entered();
			await blocked;
		}
		await update(...args);
	};
	const trust = new ContactTrustStore(memento, () => NOW);
	const one = trust.evaluate("one", "first-key");
	await started;
	const two = trust.evaluate("two", "second-key");
	release();
	await Promise.all([one, two]);
	assert.deepEqual(Object.keys(memento.values.get(CONTACT_TRUST_STATE_KEY)).sort(), ["one", "two"]);
	assert.deepEqual(trust.list().map((entry) => entry.publicKey).sort(), ["one", "two"]);
});

test("a failed key-review save keeps held messages available for another attempt", async () => {
	const memento = createMemento();
	const update = memento.update;
	let fail = false;
	memento.update = async (...args) => {
		if (fail) {
			fail = false;
			throw new Error("Storage unavailable");
		}
		await update(...args);
	};
	const { sender, trust, authenticator, send, withChangedSigningKey } = await setup({ memento });
	await authenticator.receive(send(sender, "original"));
	const changed = await withChangedSigningKey();
	assert.equal((await authenticator.receive(send(changed, "held"))).kind, "held");

	fail = true;
	await assert.rejects(authenticator.acceptKeyChange(sender.publicKey), /Storage unavailable/);
	assert.equal(trust.get(sender.publicKey).signingKey, sender.signingPublicKey);
	assert.equal(authenticator.getPendingKeyChange(sender.publicKey).heldCount, 1);
	assert.deepEqual((await authenticator.acceptKeyChange(sender.publicKey)).map((message) => message.text), ["held"]);
});
