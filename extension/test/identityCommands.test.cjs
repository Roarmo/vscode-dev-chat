const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

function fixture() {
	const handlers = new Map();
	const choices = [];
	const dialogs = [];
	const executed = [];
	const logged = [];
	let status = "none";
	let scheduled = 0;
	let canceled = 0;
	let failure;
	let reloadFailure;
	let expectedFingerprint;
	const lifecycle = {
		resetStatus: () => status,
		currentFingerprintForReset: async () => "PUBLIC FINGERPRINT",
		scheduleReset: async (fingerprint) => {
			if (failure) throw failure;
			expectedFingerprint = fingerprint;
			scheduled++;
			status = "scheduled";
		},
		cancelReset: async () => {
			if (failure) throw failure;
			canceled++;
			status = "none";
		},
	};
	const vscode = {
		window: {
			showWarningMessage: async (...args) => { dialogs.push(args); return choices.shift(); },
			showInformationMessage: async (...args) => { dialogs.push(args); return choices.shift(); },
			showErrorMessage: async (...args) => { dialogs.push(args); return choices.shift(); },
		},
		commands: {
			registerCommand: (id, handler) => {
				handlers.set(id, handler);
				return { dispose() {} };
			},
			executeCommand: async (...args) => {
				executed.push(args);
				if (reloadFailure) throw reloadFailure;
			},
		},
	};
	const modulePath = path.join(__dirname, "../dist/extension/src/commands/identityCommands.js");
	delete require.cache[require.resolve(modulePath)];
	const originalLoad = Module._load;
	let commands;
	try {
		Module._load = function(request, parent, isMain) {
			return request === "vscode" ? vscode : originalLoad.call(this, request, parent, isMain);
		};
		commands = require(modulePath);
	} finally {
		Module._load = originalLoad;
	}
	const logger = { info: (message) => logged.push(message), error: (message) => logged.push(message) };
	commands.registerIdentityResetCommand(lifecycle, logger);
	return {
		commands, handlers, choices, dialogs, executed, logged,
		setStatus: (value) => { status = value; },
		setFailure: (value) => { failure = value; },
		setReloadFailure: (value) => { reloadFailure = value; },
		getStatus: () => status,
		getScheduled: () => scheduled,
		getCanceled: () => canceled,
		getExpectedFingerprint: () => expectedFingerprint,
	};
}

test("first-time and legacy signing-key creation require explicit confirmation", async () => {
	const f = fixture();
	assert.equal(await f.commands.confirmNewIdentity(), false);
	f.choices.push("Create Identity");
	assert.equal(await f.commands.confirmNewIdentity(), true);
	f.choices.push("Create Signing Key");
	assert.equal(await f.commands.confirmSigningKeyCreation(), true);
	const text = JSON.stringify(f.dialogs);
	assert.match(text, /SecretStorage/i);
	assert.match(text, /previous identity/i);
	assert.match(text, /signing key/i);
	assert.match(text, /fingerprint/i);
	assert.match(text, /profiles.*same VS Code user-data directory/i);
	assert.match(text, /not synced to other devices/i);
});

test("reviewing a shared identity shows both fingerprints and requires explicit acceptance", async () => {
	const f = fixture();
	assert.equal(await f.commands.confirmIdentityChange("OLD PUBLIC", "NEW PUBLIC"), false);
	f.choices.push("Use Current Identity");
	assert.equal(await f.commands.confirmIdentityChange("OLD PUBLIC", "NEW PUBLIC"), true);
	const text = JSON.stringify(f.dialogs);
	assert.match(text, /OLD PUBLIC/);
	assert.match(text, /NEW PUBLIC/);
	assert.match(text, /only use the current identity if you recognize the change/i);
	assert.match(text, /does not recover the old identity/i);
});

test("reset does nothing without confirmation and explains the consequences", async () => {
	const f = fixture();
	await f.handlers.get("devChat.resetIdentity")();
	assert.equal(f.getScheduled(), 0);
	assert.deepEqual(f.executed, []);
	const text = JSON.stringify(f.dialogs);
	assert.match(text, /old private key/i);
	assert.match(text, /contacts/i);
	assert.match(text, /relay/i);
	assert.match(text, /history/i);
	assert.match(text, /new encryption key.*not automatically flagged/i);
	assert.match(text, /other VS Code windows/i);
	assert.match(text, /all profiles.*same VS Code user-data directory/i);
	assert.match(text, /including other profiles/i);
});

test("confirmed reset schedules the change before reloading", async () => {
	const f = fixture();
	f.choices.push("Reset Identity and Reload");
	await f.handlers.get("devChat.resetIdentity")();
	assert.equal(f.getScheduled(), 1);
	assert.equal(f.getExpectedFingerprint(), "PUBLIC FINGERPRINT");
	assert.equal(f.getStatus(), "scheduled");
	assert.deepEqual(f.executed, [["workbench.action.reloadWindow"]]);
});

test("a scheduled reset can be canceled, but an interrupted reset can only be retried", async () => {
	const f = fixture();
	f.setStatus("scheduled");
	f.choices.push("Cancel Reset");
	await f.handlers.get("devChat.resetIdentity")();
	assert.equal(f.getCanceled(), 1);
	assert.equal(f.getStatus(), "none");
	assert.deepEqual(f.executed, []);

	f.setStatus("in-progress");
	f.choices.push("Retry Reset");
	await f.handlers.get("devChat.resetIdentity")();
	assert.deepEqual(f.executed, [["workbench.action.reloadWindow"]]);
	assert.equal(JSON.stringify(f.dialogs.at(-1)).includes("Cancel Reset"), false);
});

test("reset and reload failures do not expose private values in UI or logs", async () => {
	const f = fixture();
	const canary = "PRIVATE-KEY-CANARY";
	f.setFailure(new Error(`storage failure containing ${canary}`));
	f.choices.push("Reset Identity and Reload");
	await f.handlers.get("devChat.resetIdentity")();
	assert.equal(JSON.stringify(f.dialogs).includes(canary), false);
	assert.equal(JSON.stringify(f.logged).includes(canary), false);
	assert.match(JSON.stringify(f.dialogs), /could not/i);

	f.setFailure(undefined);
	f.setReloadFailure(new Error(`reload failure containing ${canary}`));
	f.choices.push("Reset Identity and Reload");
	await f.handlers.get("devChat.resetIdentity")();
	assert.equal(f.getStatus(), "scheduled");
	assert.equal(JSON.stringify(f.dialogs).includes(canary), false);
	assert.equal(JSON.stringify(f.logged).includes(canary), false);
	assert.match(JSON.stringify(f.dialogs), /scheduled/i);
});

test("new and reset identities show only the public fingerprint and loss guidance", async () => {
	const f = fixture();
	const identity = { fingerprint: "ABCD EFGH PUBLIC" };
	await f.commands.showIdentityNotice({ identity, status: "created" }, { error: (message) => f.logged.push(message) });
	await f.commands.showIdentityNotice({ identity, status: "reset" }, { error: (message) => f.logged.push(message) });
	const text = JSON.stringify(f.dialogs);
	assert.match(text, /ABCD EFGH PUBLIC/);
	assert.match(text, /SecretStorage/i);
	assert.match(text, /new public key/i);
});

test("identity mismatch recovery offers review without resetting", async () => {
	const f = fixture();
	const { IdentityLifecycleError } = require(path.join(
		__dirname, "../dist/extension/src/encryption/identityLifecycle.js"
	));
	f.choices.push("Review Current Identity");
	f.commands.reportIdentityFailure(new IdentityLifecycleError("IDENTITY_MISMATCH", "Review the public identity."), {
		info: (message) => f.logged.push(message),
		error: (message) => f.logged.push(message),
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.match(JSON.stringify(f.dialogs), /Review Current Identity/);
	assert.deepEqual(f.executed, [["workbench.action.reloadWindow"]]);
	assert.equal(f.getScheduled(), 0);
});
