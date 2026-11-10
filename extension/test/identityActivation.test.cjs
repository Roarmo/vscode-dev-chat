const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

const dist = path.join(__dirname, "../dist/extension/src");
const { EncryptionService, IDENTITY_BUNDLE_SECRET } = require(path.join(dist, "encryption/encryptionService.js"));
const { IDENTITY_STATE_KEY } = require(path.join(dist, "encryption/identityLifecycle.js"));

function fixture(options = {}) {
	const handlers = new Map();
	const choices = [];
	const dialogs = [];
	const logs = [];
	const executed = [];
	const values = new Map();
	const state = new Map();
	const listeners = new Set();
	const calls = { relayDisposed: 0, controllerDisposed: 0, inboxDisposed: 0, conversationsDisposed: 0, panelDisposed: 0 };
	const secrets = {
		get: async (key) => values.get(key),
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
	const context = {
		secrets,
		globalState: {
			get: (key) => state.get(key),
			update: async (key, value) => {
				if (value === undefined) state.delete(key);
				else state.set(key, value);
			},
		},
		globalStorageUri: { fsPath: "unused" },
		subscriptions: [],
	};
	const vscode = {
		window: {
			showInformationMessage: async (...args) => { dialogs.push(args); return choices.shift(); },
			showWarningMessage: async (...args) => { dialogs.push(args); return choices.shift(); },
			showErrorMessage: async (...args) => { dialogs.push(args); return choices.shift(); },
		},
		commands: {
			registerCommand: (id, handler) => {
				handlers.set(id, handler);
				return { dispose: () => handlers.delete(id) };
			},
			executeCommand: async (...args) => { executed.push(args); },
		},
	};
	class Logger {
		info(message) { logs.push(message); }
		error(message) { logs.push(message); }
		dispose() {}
	}
	class RelayClient {
		onConnectionError() { return () => {}; }
		dispose() { calls.relayDisposed++; }
	}
	class RelayController {
		isJoining = false;
		async dispose() { calls.controllerDisposed++; }
	}
	class SecureInbox {
		dispose() { calls.inboxDisposed++; }
	}
	class ConversationManager {
		dispose() { calls.conversationsDisposed++; }
	}
	class DevChatUi {
		dispose() {}
	}
	class ChatPanel {}
	ChatPanel.currentPanel = { dispose: () => { calls.panelDisposed++; ChatPanel.currentPanel = undefined; } };
	const overrides = {
		"./commands/registerCommands": {
			registerCommands: (ctx) => {
				const command = vscode.commands.registerCommand("devChat.openChat", () => {});
				ctx.subscriptions.push(command);
				return command;
			},
		},
		"./logger": { Logger },
		"./relay/relayClient": { RelayClient },
		"./relay/relayController": { RelayController, getConfiguredRelayUrl: () => "ws://127.0.0.1:8787" },
		"./relay/hostRelayCertificate": { HostRelayCertificateStore: class {} },
		"./relay/secretRelayAccessStore": { SecretRelayAccessStore: class {} },
		"./encryption/contactTrust": { ContactTrustStore: class {} },
		"./encryption/contactStore": { ContactStore: class {} },
		"./encryption/messageAuthenticator": { MessageAuthenticator: class {} },
		"./messaging/secureInbox": { SecureInbox },
		"./messaging/conversationHistory": { EncryptedConversationHistory: { load: async () => ({}) } },
		"./messaging/conversationManager": { ConversationManager },
		"./ui/devChatUi": { DevChatUi },
		"./ui/ChatPanel": { ChatPanel },
		"./ui/openGettingStartedWalkthrough": { openGettingStartedWalkthrough: async () => {} },
	};
	if (options.invalidateDuringActivation) {
		overrides["./encryption/identityChangeMonitor"] = {
			IdentityChangeMonitor: class {
				constructor(_secrets, _fingerprint, invalidate) { this.invalidate = invalidate; }
				async check() {
					await Promise.resolve();
					this.invalidate();
					return true;
				}
				dispose() {}
			},
		};
	}
	const entryPath = path.join(dist, "extensions.js");
	const commandsPath = path.join(dist, "commands/identityCommands.js");
	delete require.cache[require.resolve(entryPath)];
	delete require.cache[require.resolve(commandsPath)];
	const originalLoad = Module._load;
	let extension;
	try {
		Module._load = function(request, parent, isMain) {
			if (request === "vscode") return vscode;
			if (parent?.filename === entryPath && overrides[request]) return overrides[request];
			return originalLoad.call(this, request, parent, isMain);
		};
		extension = require(entryPath);
	} finally {
		Module._load = originalLoad;
	}
	return { extension, context, handlers, choices, dialogs, logs, executed, values, state, secrets, listeners, calls };
}

async function waitFor(predicate) {
	for (let i = 0; i < 50; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.fail("identity shutdown was not observed");
}

test("the reset command remains available when identity initialization fails", async () => {
	const f = fixture();
	f.state.set(IDENTITY_STATE_KEY, { version: 1, fingerprint: Array(10).fill("ABCD").join(" ") });
	await f.extension.activate(f.context);
	assert.equal(f.handlers.has("devChat.resetIdentity"), true);
	assert.equal(f.handlers.has("devChat.openChat"), false);
	assert.match(JSON.stringify(f.dialogs), /identity keys are missing or incomplete/i);
	await f.handlers.get("devChat.resetIdentity")();
	assert.match(JSON.stringify(f.dialogs), /Reset your Dev Chat identity/i);
	assert.equal(f.values.size, 0);
});

test("an active window stops messaging and closes its panel when another profile resets", async () => {
	const f = fixture();
	f.choices.push("Create Identity");
	await f.extension.activate(f.context);
	assert.equal(f.handlers.has("devChat.openChat"), true);
	assert.equal(f.handlers.has("devChat.resetIdentity"), true);
	const oldKeys = JSON.parse(f.values.get(IDENTITY_BUNDLE_SECRET));

	await EncryptionService.storeIdentity({ secrets: f.secrets });
	const newKeys = JSON.parse(f.values.get(IDENTITY_BUNDLE_SECRET));
	await waitFor(() => f.calls.relayDisposed === 1);
	assert.equal(f.handlers.has("devChat.openChat"), false);
	assert.equal(f.handlers.has("devChat.resetIdentity"), true);
	assert.equal(f.calls.controllerDisposed, 1);
	assert.equal(f.calls.inboxDisposed, 1);
	assert.equal(f.calls.conversationsDisposed, 1);
	assert.equal(f.calls.panelDisposed, 1);
	assert.equal(f.listeners.size, 0);
	assert.match(JSON.stringify(f.dialogs), /identity changed or its keys became unavailable/i);
	const visible = JSON.stringify([f.dialogs, f.logs]);
	for (const secret of [oldKeys.encryption, oldKeys.signing, newKeys.encryption, newKeys.signing]) {
		assert.equal(visible.includes(secret), false);
	}
});

test("an identity change during activation never enables chat", async () => {
	const f = fixture({ invalidateDuringActivation: true });
	f.choices.push("Create Identity");
	await f.extension.activate(f.context);
	assert.equal(f.handlers.has("devChat.openChat"), false);
	assert.equal(f.handlers.has("devChat.resetIdentity"), true);
	assert.equal(f.calls.relayDisposed, 1);
	assert.match(JSON.stringify(f.dialogs), /identity changed or became unavailable during initialization/i);
});
