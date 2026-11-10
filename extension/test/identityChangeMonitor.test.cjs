const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const dist = path.join(__dirname, "../dist/extension/src/encryption");
const { EncryptionService, IDENTITY_BUNDLE_SECRET } = require(path.join(dist, "encryptionService.js"));
const { IdentityChangeMonitor } = require(path.join(dist, "identityChangeMonitor.js"));

function fixture() {
	const values = new Map();
	const listeners = new Set();
	let onGet;
	const secrets = {
		get: async (key) => onGet ? onGet(key, values.get(key)) : values.get(key),
		store: async (key, value) => {
			values.set(key, value);
			for (const listener of listeners) listener({ key });
		},
		delete: async (key) => {
			values.delete(key);
			for (const listener of listeners) listener({ key });
		},
		onDidChange: (listener) => {
			listeners.add(listener);
			return { dispose: () => listeners.delete(listener) };
		},
	};
	return { values, secrets, listeners, setOnGet: (fn) => { onGet = fn; } };
}

async function waitFor(predicate) {
	for (let i = 0; i < 50; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.fail("identity change was not observed");
}

test("ignores unrelated secret changes and stops once when the shared identity changes", async () => {
	const f = fixture();
	const original = await EncryptionService.storeIdentity({ secrets: f.secrets });
	let stopped = 0;
	const monitor = new IdentityChangeMonitor(f.secrets, original.fingerprint, () => { stopped++; });
	try {
		assert.equal(await monitor.check(), true);
		await f.secrets.store("unrelated", "value");
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(stopped, 0);

		await EncryptionService.storeIdentity({ secrets: f.secrets });
		await waitFor(() => stopped === 1);
		assert.equal(await monitor.check(), false);
		await f.secrets.delete(IDENTITY_BUNDLE_SECRET);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(stopped, 1);
	} finally {
		monitor.dispose();
	}
	assert.equal(f.listeners.size, 0);
});

test("fails closed when identity keys become unavailable or secret storage fails", async () => {
	const f = fixture();
	const original = await EncryptionService.storeIdentity({ secrets: f.secrets });
	let stopped = 0;
	const monitor = new IdentityChangeMonitor(f.secrets, original.fingerprint, () => { stopped++; });
	f.setOnGet(() => { throw new Error("storage unavailable"); });
	try {
		assert.equal(await monitor.check(), false);
		assert.equal(stopped, 1);
	} finally {
		monitor.dispose();
	}
});

test("rechecks a change that arrives while an earlier key read is in progress", async () => {
	const f = fixture();
	const original = await EncryptionService.storeIdentity({ secrets: f.secrets });
	let releaseRead;
	let notifyRead;
	const readStarted = new Promise((resolve) => { notifyRead = resolve; });
	const gate = new Promise((resolve) => { releaseRead = resolve; });
	let delayed = false;
	f.setOnGet(async (key, value) => {
		if (key === IDENTITY_BUNDLE_SECRET && !delayed) {
			delayed = true;
			notifyRead();
			await gate;
		}
		return value;
	});

	let stopped = 0;
	const monitor = new IdentityChangeMonitor(f.secrets, original.fingerprint, () => { stopped++; });
	try {
		const checking = monitor.check();
		await readStarted;
		await EncryptionService.storeIdentity({ secrets: f.secrets });
		releaseRead();
		assert.equal(await checking, false);
		assert.equal(stopped, 1);
	} finally {
		releaseRead();
		monitor.dispose();
	}
});
