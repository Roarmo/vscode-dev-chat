const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const dist = path.join(__dirname, "../dist/extension/src/encryption");
const {
	EncryptionService,
	IDENTITY_BUNDLE_SECRET,
	IDENTITY_FORMAT_SECRET,
	IDENTITY_FORMAT_VALUE,
	PRIVATE_KEY_SECRET,
	SIGNING_SEED_SECRET,
} = require(path.join(dist, "encryptionService.js"));
const {
	IdentityLifecycle,
	IDENTITY_STATE_KEY,
	RESET_PENDING_KEY,
} = require(path.join(dist, "identityLifecycle.js"));

const decisions = {
	confirmNewIdentity: async () => true,
	confirmSigningKeyCreation: async () => true,
	confirmIdentityChange: async () => false,
};

function sharedStorage() {
	const values = new Map();
	const writes = [];
	const deletions = [];
	let failGet;
	let failStore;
	let failDelete;
	const secrets = {
		get: async (key) => {
			if (failGet) failGet(key);
			return values.get(key);
		},
		store: async (key, value) => {
			if (failStore) failStore(key, value);
			writes.push(key);
			values.set(key, value);
		},
		delete: async (key) => {
			if (failDelete) failDelete(key);
			deletions.push(key);
			values.delete(key);
		},
	};
	return {
		values, writes, deletions, secrets,
		setFailGet: (fn) => { failGet = fn; },
		setFailStore: (fn) => { failStore = fn; },
		setFailDelete: (fn) => { failDelete = fn; },
	};
}

function fixture(shared = sharedStorage()) {
	const state = new Map();
	let failStateUpdate;
	const context = {
		secrets: shared.secrets,
		globalState: {
			get: (key) => state.get(key),
			update: async (key, value) => {
				if (failStateUpdate) failStateUpdate(key, value);
				if (value === undefined) state.delete(key);
				else state.set(key, value);
			},
		},
	};
	return {
		context, shared, state,
		lifecycle: new IdentityLifecycle(context),
		setFailStateUpdate: (fn) => { failStateUpdate = fn; },
	};
}

function record(fingerprint) {
	return { version: 1, fingerprint };
}

async function scheduleReset(lifecycle) {
	await lifecycle.scheduleReset(await lifecycle.currentFingerprintForReset());
}

test("creates a complete identity only after confirmation and preserves it across loads", async () => {
	const f = fixture();
	await assert.rejects(
		f.lifecycle.load({ ...decisions, confirmNewIdentity: async () => false }),
		{ code: "SETUP_CANCELLED" }
	);
	assert.equal(f.shared.values.size, 0);
	assert.equal(f.state.has(IDENTITY_STATE_KEY), false);

	const first = await f.lifecycle.load(decisions);
	const stored = new Map(f.shared.values);
	const second = await f.lifecycle.load({
		confirmNewIdentity: async () => assert.fail("existing identity must not request creation"),
		confirmSigningKeyCreation: async () => assert.fail("existing signing key must be retained"),
		confirmIdentityChange: async () => assert.fail("unchanged identity must not require review"),
	});

	assert.equal(first.status, "created");
	assert.equal(second.status, "existing");
	assert.equal(second.identity.publicKey, first.identity.publicKey);
	assert.equal(second.identity.signingPublicKey, first.identity.signingPublicKey);
	assert.equal(second.identity.fingerprint, first.identity.fingerprint);
	assert.deepEqual(f.shared.values, stored);
	assert.deepEqual(f.shared.writes, [IDENTITY_FORMAT_SECRET, IDENTITY_BUNDLE_SECRET]);
	assert.deepEqual(f.state.get(IDENTITY_STATE_KEY), record(first.identity.fingerprint));
});

test("does not create new keys when a recorded identity bundle is missing", async () => {
	const f = fixture();
	const first = await f.lifecycle.load(decisions);
	f.shared.values.delete(IDENTITY_BUNDLE_SECRET);
	f.shared.writes.length = 0;
	await assert.rejects(f.lifecycle.load(decisions), { code: "IDENTITY_UNAVAILABLE" });
	assert.deepEqual([...f.shared.values.entries()], [[IDENTITY_FORMAT_SECRET, IDENTITY_FORMAT_VALUE]]);
	assert.deepEqual(f.shared.writes, []);
	assert.deepEqual(f.state.get(IDENTITY_STATE_KEY), record(first.identity.fingerprint));
});

test("never falls back to leftover legacy keys after a shared identity bundle is lost", async () => {
	const shared = sharedStorage();
	const originalProfile = fixture(shared);
	const newProfile = fixture(shared);
	await EncryptionService.load(originalProfile.context);
	await EncryptionService.storeIdentity(originalProfile.context);
	shared.values.delete(IDENTITY_BUNDLE_SECRET);
	const legacy = new Map(shared.values);
	shared.writes.length = 0;

	await assert.rejects(newProfile.lifecycle.load(decisions), { code: "IDENTITY_UNAVAILABLE" });
	assert.deepEqual(shared.values, legacy);
	assert.deepEqual(shared.writes, []);
});

for (const part of ["bundle", "encryption", "signing", "resetId"]) {
	test(`rejects a corrupt ${part} without replacing or exposing it`, async () => {
		const f = fixture();
		await f.lifecycle.load(decisions);
		const canary = "PRIVATE-KEY-CANARY-not-base64";
		const bundle = JSON.parse(f.shared.values.get(IDENTITY_BUNDLE_SECRET));
		if (part === "bundle") f.shared.values.set(IDENTITY_BUNDLE_SECRET, canary);
		else {
			bundle[part] = canary;
			f.shared.values.set(IDENTITY_BUNDLE_SECRET, JSON.stringify(bundle));
		}
		const stored = f.shared.values.get(IDENTITY_BUNDLE_SECRET);
		f.shared.writes.length = 0;

		await assert.rejects(f.lifecycle.load(decisions), (error) =>
			error.code === "IDENTITY_CORRUPT" && !error.message.includes(canary)
		);
		assert.equal(f.shared.values.get(IDENTITY_BUNDLE_SECRET), stored);
		assert.deepEqual(f.shared.writes, []);
	});
}

test("reports a corrupt shared storage marker instead of falling back to other keys", async () => {
	const f = fixture();
	await f.lifecycle.load(decisions);
	const canary = "PRIVATE-KEY-CANARY";
	f.shared.values.set(IDENTITY_FORMAT_SECRET, canary);
	f.shared.writes.length = 0;
	await assert.rejects(f.lifecycle.load(decisions), (error) =>
		error.code === "IDENTITY_CORRUPT" && !error.message.includes(canary)
	);
	assert.equal(f.shared.values.get(IDENTITY_FORMAT_SECRET), canary);
	assert.deepEqual(f.shared.writes, []);
});

test("rejects malformed public identity metadata without generating keys", async () => {
	const f = fixture();
	f.state.set(IDENTITY_STATE_KEY, { version: 1, fingerprint: "invalid" });
	await assert.rejects(f.lifecycle.load(decisions), { code: "METADATA_CORRUPT" });
	assert.equal(f.shared.values.size, 0);
});

test("a second profile shares existing keys without changing them", async () => {
	const shared = sharedStorage();
	const work = fixture(shared);
	const personal = fixture(shared);
	const original = await work.lifecycle.load(decisions);
	const before = new Map(shared.values);
	shared.writes.length = 0;

	const other = await personal.lifecycle.load({
		...decisions,
		confirmNewIdentity: async () => assert.fail("a shared identity already exists"),
	});
	assert.equal(other.status, "existing");
	assert.equal(other.identity.fingerprint, original.identity.fingerprint);
	assert.deepEqual(personal.state.get(IDENTITY_STATE_KEY), record(original.identity.fingerprint));
	assert.deepEqual(shared.values, before);
	assert.deepEqual(shared.writes, []);
});

test("a different current identity requires review and never rotates it again", async () => {
	const shared = sharedStorage();
	const work = fixture(shared);
	const personal = fixture(shared);
	const original = await work.lifecycle.load(decisions);
	await personal.lifecycle.load(decisions);
	await scheduleReset(work.lifecycle);
	const reset = await work.lifecycle.load(decisions);
	const currentBundle = shared.values.get(IDENTITY_BUNDLE_SECRET);
	const reviews = [];
	shared.writes.length = 0;

	await assert.rejects(personal.lifecycle.load({
		...decisions,
		confirmIdentityChange: async (previous, current) => {
			reviews.push([previous, current]);
			return false;
		},
	}), { code: "IDENTITY_MISMATCH" });
	assert.deepEqual(reviews, [[original.identity.fingerprint, reset.identity.fingerprint]]);
	assert.deepEqual(personal.state.get(IDENTITY_STATE_KEY), record(original.identity.fingerprint));
	assert.equal(shared.values.get(IDENTITY_BUNDLE_SECRET), currentBundle);

	const accepted = await personal.lifecycle.load({
		...decisions,
		confirmIdentityChange: async () => true,
	});
	assert.equal(accepted.status, "identity-changed");
	assert.equal(accepted.identity.fingerprint, reset.identity.fingerprint);
	assert.deepEqual(personal.state.get(IDENTITY_STATE_KEY), record(reset.identity.fingerprint));
	assert.equal(shared.values.get(IDENTITY_BUNDLE_SECRET), currentBundle);
	assert.deepEqual(shared.writes, []);
});

test("does not accept an identity that changes again during review", async () => {
	const shared = sharedStorage();
	const work = fixture(shared);
	const personal = fixture(shared);
	const original = await work.lifecycle.load(decisions);
	await personal.lifecycle.load(decisions);
	await scheduleReset(work.lifecycle);
	await work.lifecycle.load(decisions);

	await assert.rejects(personal.lifecycle.load({
		...decisions,
		confirmIdentityChange: async () => {
			await scheduleReset(work.lifecycle);
			await work.lifecycle.load(decisions);
			return true;
		},
	}), { code: "IDENTITY_MISMATCH" });
	assert.deepEqual(personal.state.get(IDENTITY_STATE_KEY), record(original.identity.fingerprint));
});

test("does not overwrite an identity created in another profile during confirmation", async () => {
	const shared = sharedStorage();
	const work = fixture(shared);
	const personal = fixture(shared);
	let created;
	await assert.rejects(work.lifecycle.load({
		...decisions,
		confirmNewIdentity: async () => {
			created = await personal.lifecycle.load(decisions);
			return true;
		},
	}), { code: "IDENTITY_MISMATCH" });
	const current = await work.lifecycle.load(decisions);
	assert.equal(current.identity.fingerprint, created.identity.fingerprint);
	assert.equal(shared.writes.filter((key) => key === IDENTITY_BUNDLE_SECRET).length, 1);
});

test("adopts both existing legacy keys without replacing or migrating them", async () => {
	const f = fixture();
	const existing = await EncryptionService.load(f.context);
	const stored = new Map(f.shared.values);
	f.shared.writes.length = 0;
	const result = await f.lifecycle.load({
		...decisions,
		confirmNewIdentity: async () => assert.fail("existing keys must not be treated as new"),
		confirmSigningKeyCreation: async () => assert.fail("existing signing key must be retained"),
	});

	assert.equal(result.status, "existing");
	assert.equal(result.identity.fingerprint, existing.fingerprint);
	assert.deepEqual(f.shared.values, stored);
	assert.deepEqual(f.shared.writes, []);
});

test("requires confirmation before replacing a missing legacy signing key", async () => {
	const f = fixture();
	const existing = await EncryptionService.load(f.context);
	f.shared.values.delete(SIGNING_SEED_SECRET);
	const encryptionSecret = f.shared.values.get(PRIVATE_KEY_SECRET);
	f.shared.writes.length = 0;

	await assert.rejects(
		f.lifecycle.load({ ...decisions, confirmSigningKeyCreation: async () => false }),
		{ code: "SETUP_CANCELLED" }
	);
	assert.equal(f.shared.values.get(PRIVATE_KEY_SECRET), encryptionSecret);
	assert.deepEqual(f.shared.writes, []);

	const result = await f.lifecycle.load(decisions);
	assert.equal(result.status, "signing-key-created");
	assert.equal(result.identity.publicKey, existing.publicKey);
	assert.notEqual(result.identity.signingPublicKey, existing.signingPublicKey);
	assert.equal(f.shared.values.has(PRIVATE_KEY_SECRET), false);
	assert.equal(f.shared.values.has(SIGNING_SEED_SECRET), false);
	assert.equal(JSON.parse(f.shared.values.get(IDENTITY_BUNDLE_SECRET)).encryption, encryptionSecret);
});

for (const missing of [PRIVATE_KEY_SECRET, SIGNING_SEED_SECRET]) {
	test(`does not replace a recorded legacy identity when ${missing} is missing`, async () => {
		const f = fixture();
		const existing = await EncryptionService.load(f.context);
		f.state.set(IDENTITY_STATE_KEY, record(existing.fingerprint));
		f.shared.values.delete(missing);
		const remaining = new Map(f.shared.values);
		f.shared.writes.length = 0;
		await assert.rejects(f.lifecycle.load(decisions), { code: "IDENTITY_UNAVAILABLE" });
		assert.deepEqual(f.shared.values, remaining);
		assert.deepEqual(f.shared.writes, []);
	});
}

test("does not generate an encryption key when only a signing key remains", async () => {
	const f = fixture();
	await EncryptionService.load(f.context);
	f.shared.values.delete(PRIVATE_KEY_SECRET);
	f.shared.writes.length = 0;
	await assert.rejects(f.lifecycle.load(decisions), { code: "IDENTITY_UNAVAILABLE" });
	assert.deepEqual(f.shared.writes, []);
});

test("a confirmed reset replaces both keys in one write and leaves history and contacts alone", async () => {
	const f = fixture();
	const first = await f.lifecycle.load(decisions);
	const oldBundle = f.shared.values.get(IDENTITY_BUNDLE_SECRET);
	f.shared.values.set("devChat.conversationHistoryKey", "separate-history-key");
	f.shared.values.set("devChat.hostRelay.access", "separate-relay-state");
	f.state.set("devChat.contacts", { example: "Contact" });
	f.shared.writes.length = 0;

	await scheduleReset(f.lifecycle);
	assert.equal(f.lifecycle.resetStatus(), "scheduled");
	assert.equal(f.shared.values.get(IDENTITY_BUNDLE_SECRET), oldBundle);
	assert.deepEqual(f.shared.writes, []);

	const result = await f.lifecycle.load(decisions);
	assert.equal(result.status, "reset");
	assert.notEqual(result.identity.publicKey, first.identity.publicKey);
	assert.notEqual(result.identity.signingPublicKey, first.identity.signingPublicKey);
	assert.notEqual(result.identity.fingerprint, first.identity.fingerprint);
	assert.deepEqual(f.shared.writes, [IDENTITY_BUNDLE_SECRET]);
	assert.equal(f.lifecycle.isResetPending(), false);
	assert.deepEqual(f.state.get(IDENTITY_STATE_KEY), record(result.identity.fingerprint));
	assert.equal(f.shared.values.get("devChat.conversationHistoryKey"), "separate-history-key");
	assert.equal(f.shared.values.get("devChat.hostRelay.access"), "separate-relay-state");
	assert.deepEqual(f.state.get("devChat.contacts"), { example: "Contact" });

	const sender = await EncryptionService.load(fixture().context);
	const payload = sender.seal("old identity message", first.identity.publicKey, "old-message");
	const routed = { from: sender.publicKey, to: first.identity.publicKey, requestId: "old-message", payload };
	assert.equal(first.identity.open(first.identity.verify(routed)), "old identity message");
	assert.throws(() => result.identity.verify(routed), { code: "WRONG_RECIPIENT" });
});

test("cancelling a scheduled reset preserves the existing identity", async () => {
	const f = fixture();
	const first = await f.lifecycle.load(decisions);
	const stored = new Map(f.shared.values);
	await scheduleReset(f.lifecycle);
	await f.lifecycle.cancelReset();
	const result = await f.lifecycle.load(decisions);
	assert.equal(result.status, "existing");
	assert.equal(result.identity.fingerprint, first.identity.fingerprint);
	assert.deepEqual(f.shared.values, stored);
});

test("an interrupted reset retries the same complete key pair without exposing it", async () => {
	const f = fixture();
	await f.lifecycle.load(decisions);
	await scheduleReset(f.lifecycle);
	let leakedValue;
	f.shared.setFailStore((key, value) => {
		if (key === IDENTITY_BUNDLE_SECRET) {
			leakedValue = value;
			f.shared.values.set(key, value);
			throw new Error(`storage failure after writing ${value}`);
		}
	});

	await assert.rejects(f.lifecycle.load(decisions), (error) =>
		error.code === "RESET_INCOMPLETE" && !error.message.includes(leakedValue)
	);
	assert.equal(f.lifecycle.resetStatus(), "in-progress");
	const pendingBundle = f.shared.values.get(IDENTITY_BUNDLE_SECRET);
	f.shared.setFailStore(undefined);
	f.shared.writes.length = 0;
	const result = await f.lifecycle.load(decisions);
	assert.equal(result.status, "reset");
	assert.equal(f.shared.values.get(IDENTITY_BUNDLE_SECRET), pendingBundle);
	assert.deepEqual(f.shared.writes, []);
	assert.equal((await f.lifecycle.load(decisions)).identity.fingerprint, result.identity.fingerprint);
});

test("a legacy reset interrupted after setting the format marker can be retried", async () => {
	const f = fixture();
	await EncryptionService.load(f.context);
	await f.lifecycle.load(decisions);
	await scheduleReset(f.lifecycle);
	f.shared.setFailStore((key) => {
		if (key === IDENTITY_BUNDLE_SECRET) throw new Error("storage failure");
	});

	await assert.rejects(f.lifecycle.load(decisions), { code: "RESET_INCOMPLETE" });
	assert.equal(f.shared.values.get(IDENTITY_FORMAT_SECRET), IDENTITY_FORMAT_VALUE);
	assert.equal(f.shared.values.has(IDENTITY_BUNDLE_SECRET), false);
	f.shared.setFailStore(undefined);
	const result = await f.lifecycle.load(decisions);
	assert.equal(result.status, "reset");
	assert.equal(f.shared.values.has(PRIVATE_KEY_SECRET), false);
	assert.equal(f.shared.values.has(SIGNING_SEED_SECRET), false);
});

test("a reset can retry after repairing a corrupt marker but before replacing the bundle", async () => {
	const f = fixture();
	const first = await f.lifecycle.load(decisions);
	f.shared.values.set(IDENTITY_FORMAT_SECRET, "invalid-marker");
	await scheduleReset(f.lifecycle);
	f.shared.setFailStore((key) => {
		if (key === IDENTITY_BUNDLE_SECRET) throw new Error("storage failure");
	});

	await assert.rejects(f.lifecycle.load(decisions), { code: "RESET_INCOMPLETE" });
	assert.equal(f.shared.values.get(IDENTITY_FORMAT_SECRET), IDENTITY_FORMAT_VALUE);
	f.shared.setFailStore(undefined);
	const result = await f.lifecycle.load(decisions);
	assert.equal(result.status, "reset");
	assert.notEqual(result.identity.fingerprint, first.identity.fingerprint);
});

test("an interrupted reset repairs its own marker without rotating the stored keys again", async () => {
	const f = fixture();
	await f.lifecycle.load(decisions);
	await scheduleReset(f.lifecycle);
	f.shared.setFailStore((key, value) => {
		if (key === IDENTITY_BUNDLE_SECRET) {
			f.shared.values.set(key, value);
			throw new Error("storage failure after writing");
		}
	});
	await assert.rejects(f.lifecycle.load(decisions), { code: "RESET_INCOMPLETE" });
	const pendingBundle = f.shared.values.get(IDENTITY_BUNDLE_SECRET);
	f.shared.values.set(IDENTITY_FORMAT_SECRET, "invalid-marker");
	f.shared.setFailStore(undefined);
	f.shared.writes.length = 0;
	const result = await f.lifecycle.load(decisions);
	assert.equal(result.status, "reset");
	assert.equal(f.shared.values.get(IDENTITY_BUNDLE_SECRET), pendingBundle);
	assert.deepEqual(f.shared.writes, [IDENTITY_FORMAT_SECRET]);
});

test("legacy-key cleanup failures are retried without another identity rotation", async () => {
	const shared = sharedStorage();
	const work = fixture(shared);
	const personal = fixture(shared);
	const original = await EncryptionService.load(work.context);
	await work.lifecycle.load(decisions);
	await personal.lifecycle.load(decisions);
	await scheduleReset(work.lifecycle);
	shared.setFailDelete((key) => {
		if (key === SIGNING_SEED_SECRET) throw new Error("storage failure");
	});
	await assert.rejects(work.lifecycle.load(decisions), { code: "RESET_INCOMPLETE" });
	const pendingBundle = shared.values.get(IDENTITY_BUNDLE_SECRET);
	assert.notEqual((await EncryptionService.load(work.context)).fingerprint, original.fingerprint);
	shared.setFailDelete(undefined);
	const reviewed = await personal.lifecycle.load({ ...decisions, confirmIdentityChange: async () => true });
	shared.writes.length = 0;
	const retried = await work.lifecycle.load(decisions);
	assert.equal(retried.identity.fingerprint, reviewed.identity.fingerprint);
	assert.equal(shared.values.get(IDENTITY_BUNDLE_SECRET), pendingBundle);
	assert.equal(shared.values.has(PRIVATE_KEY_SECRET), false);
	assert.equal(shared.values.has(SIGNING_SEED_SECRET), false);
	assert.deepEqual(shared.writes, []);
});

test("does not schedule a reset if another profile changed the identity during confirmation", async () => {
	const shared = sharedStorage();
	const work = fixture(shared);
	const personal = fixture(shared);
	await work.lifecycle.load(decisions);
	await personal.lifecycle.load(decisions);
	const beforeConfirmation = await work.lifecycle.currentFingerprintForReset();
	await scheduleReset(personal.lifecycle);
	const reset = await personal.lifecycle.load(decisions);
	const currentBundle = shared.values.get(IDENTITY_BUNDLE_SECRET);

	await assert.rejects(work.lifecycle.scheduleReset(beforeConfirmation), { code: "RESET_CONFLICT" });
	assert.equal(work.lifecycle.resetStatus(), "none");
	assert.equal(shared.values.get(IDENTITY_BUNDLE_SECRET), currentBundle);
	const reviewed = await work.lifecycle.load({ ...decisions, confirmIdentityChange: async () => true });
	assert.equal(reviewed.identity.fingerprint, reset.identity.fingerprint);
});

test("does not overwrite a reset already scheduled in the same profile", async () => {
	const f = fixture();
	await f.lifecycle.load(decisions);
	await scheduleReset(f.lifecycle);
	const pending = f.state.get(RESET_PENDING_KEY);
	await assert.rejects(scheduleReset(f.lifecycle), { code: "RESET_ALREADY_SCHEDULED" });
	assert.deepEqual(f.state.get(RESET_PENDING_KEY), pending);
});

test("a conflicting reset stops rather than replacing another profile's current identity", async () => {
	const shared = sharedStorage();
	const work = fixture(shared);
	const personal = fixture(shared);
	await work.lifecycle.load(decisions);
	await personal.lifecycle.load(decisions);
	await scheduleReset(work.lifecycle);
	await scheduleReset(personal.lifecycle);
	const changed = await personal.lifecycle.load(decisions);
	const currentBundle = shared.values.get(IDENTITY_BUNDLE_SECRET);
	shared.writes.length = 0;

	await assert.rejects(work.lifecycle.load(decisions), { code: "RESET_CONFLICT" });
	assert.equal(work.lifecycle.isResetPending(), false);
	assert.equal(shared.values.get(IDENTITY_BUNDLE_SECRET), currentBundle);
	assert.deepEqual(shared.writes, []);
	const reviewed = await work.lifecycle.load({ ...decisions, confirmIdentityChange: async () => true });
	assert.equal(reviewed.identity.fingerprint, changed.identity.fingerprint);
	assert.equal(shared.values.get(IDENTITY_BUNDLE_SECRET), currentBundle);
});

test("a confirmed reset can recover from corrupt keys and metadata", async () => {
	const f = fixture();
	await f.lifecycle.load(decisions);
	f.shared.values.set(IDENTITY_BUNDLE_SECRET, "invalid-private-key");
	f.state.set(IDENTITY_STATE_KEY, { version: 99 });
	f.state.set(RESET_PENDING_KEY, "invalid");
	await scheduleReset(f.lifecycle);
	const result = await f.lifecycle.load(decisions);
	assert.equal(result.status, "reset");
	assert.deepEqual(f.state.get(IDENTITY_STATE_KEY), record(result.identity.fingerprint));
	assert.equal(f.lifecycle.resetStatus(), "none");
});

test("sanitizes secret-storage and profile-state failures", async () => {
	const f = fixture();
	const canary = "PRIVATE-KEY-CANARY";
	f.shared.setFailGet(() => { throw new Error(`cannot read ${canary}`); });
	await assert.rejects(f.lifecycle.load(decisions), (error) =>
		error.code === "SECRET_STORAGE_ERROR" && !error.message.includes(canary)
	);
	f.shared.setFailGet(undefined);
	f.setFailStateUpdate(() => { throw new Error(`cannot persist ${canary}`); });
	await assert.rejects(scheduleReset(f.lifecycle), (error) =>
		error.code === "IDENTITY_STATE_ERROR" && !error.message.includes(canary)
	);
});
