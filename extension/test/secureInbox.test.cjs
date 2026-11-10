const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

test("pending key-change summaries update when messages are held, accepted or discarded", async () => {
	const choices = [];
	const errors = [];
	const loggedErrors = [];
	const vscode = {
		window: {
			showWarningMessage: async () => choices.shift(),
			showInformationMessage: async () => undefined,
			showQuickPick: async () => undefined,
			showErrorMessage: async (message) => { errors.push(message); },
		},
	};
	const modulePath = path.join(__dirname, "../dist/extension/src/messaging/secureInbox.js");
	delete require.cache[require.resolve(modulePath)];
	const originalLoad = Module._load;
	let SecureInbox;
	try {
		Module._load = function(request, parent, isMain) {
			return request === "vscode" ? vscode : originalLoad.call(this, request, parent, isMain);
		};
		({ SecureInbox } = require(modulePath));
	} finally {
		Module._load = originalLoad;
	}

	let relayListener;
	const relay = { onMessage: (listener) => { relayListener = listener; return () => {}; } };
	const pending = new Map();
	const queued = [];
	let acceptFailure = false;
	const released = { requestId: "released", text: "accepted", sentAt: 1, sender: { publicKey: "bob" } };
	const authenticator = {
		receive: async () => {
			const change = queued.shift();
			pending.set(change.publicKey, change);
			return { kind: "held", change, firstHeld: change.firstHeld === true };
		},
		pendingKeyChanges: () => [...pending.values()],
		getPendingKeyChange: (publicKey) => pending.get(publicKey),
		acceptKeyChange: async (publicKey) => {
			if (acceptFailure) throw new Error("trust storage unavailable");
			pending.delete(publicKey);
			return [released];
		},
		rejectKeyChange: (publicKey) => {
			const count = pending.get(publicKey)?.heldCount ?? 0;
			pending.delete(publicKey);
			return count;
		},
	};
	let opened = 0;
	const inbox = new SecureInbox(relay, authenticator, {}, "own-fingerprint", {
		info() {}, error: (message) => loggedErrors.push(message),
	}, () => { opened++; });
	const events = [];
	inbox.onEvent((event) => events.push(event));
	const alice = { publicKey: "alice", previousFingerprint: "OLD", newFingerprint: "NEW", previouslyVerified: false, heldCount: 1 };
	const bob = { publicKey: "bob", previousFingerprint: "OLD", newFingerprint: "NEW", previouslyVerified: true, heldCount: 2 };
	try {
		queued.push(alice, bob);
		relayListener({ type: "direct_message", from: "alice", to: "self", requestId: "1", payload: "ciphertext" });
		relayListener({ type: "direct_message", from: "bob", to: "self", requestId: "2", payload: "ciphertext" });
		await inbox.idle();
		assert.deepEqual(inbox.pendingKeyChanges, { contacts: 2, messages: 3 });
		assert.deepEqual(events.filter((event) => event.type === "pendingKeyChanges").map((event) => event.summary), [
			{ contacts: 1, messages: 1 },
			{ contacts: 2, messages: 3 },
		]);

		choices.push(undefined);
		await inbox.reviewKeyChange("bob");
		assert.deepEqual(inbox.pendingKeyChanges, { contacts: 2, messages: 3 });

		acceptFailure = true;
		choices.push("Accept New Key");
		await assert.rejects(inbox.reviewKeyChange("bob"), /trust storage unavailable/);
		assert.deepEqual(inbox.pendingKeyChanges, { contacts: 2, messages: 3 });
		acceptFailure = false;

		choices.push("Accept New Key");
		await inbox.reviewKeyChange("bob");
		assert.deepEqual(inbox.pendingKeyChanges, { contacts: 1, messages: 1 });
		assert.ok(events.some((event) => event.type === "trustChanged" && event.publicKey === "bob" && event.verified === false));
		assert.ok(events.some((event) => event.type === "message" && event.message === released));
		assert.equal(opened, 1);

		choices.push("Discard Held Messages");
		await inbox.reviewKeyChange("alice");
		assert.deepEqual(inbox.pendingKeyChanges, { contacts: 0, messages: 0 });
		assert.deepEqual(events.filter((event) => event.type === "pendingKeyChanges").at(-1).summary, { contacts: 0, messages: 0 });

		acceptFailure = true;
		choices.push("Review", "Accept New Key");
		queued.push({ ...alice, publicKey: "charlie", firstHeld: true });
		relayListener({ type: "direct_message", from: "charlie", to: "self", requestId: "3", payload: "ciphertext" });
		await inbox.idle();
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(inbox.pendingKeyChanges, { contacts: 1, messages: 1 });
		assert.match(loggedErrors[0], /trust storage unavailable/);
		assert.match(errors[0], /could not review.*trust storage unavailable/i);
	} finally {
		inbox.dispose();
	}
});
