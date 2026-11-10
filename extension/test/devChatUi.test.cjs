const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

function createFixture(options = {}) {
	const contexts = new Map();
	const providers = new Map();
	const errors = [];
	const loggedErrors = [];
	const statusBar = {
		show() { this.visible = true; },
		dispose() { this.disposed = true; },
	};
	let failContext = Boolean(options.failContext);
	class Disposable {
		constructor(dispose) { this.dispose = dispose; }
	}
	class EventEmitter {
		constructor() {
			this.listeners = new Set();
			this.event = (listener) => {
				this.listeners.add(listener);
				return new Disposable(() => this.listeners.delete(listener));
			};
		}
		fire(value) { for (const listener of this.listeners) listener(value); }
		dispose() { this.listeners.clear(); }
	}
	const vscode = {
		Disposable,
		EventEmitter,
		TreeItemCollapsibleState: { None: 0, Expanded: 2 },
		TreeItem: class {
			constructor(label, collapsibleState) {
				this.label = label;
				this.collapsibleState = collapsibleState;
			}
		},
		ThemeIcon: class { constructor(id) { this.id = id; } },
		StatusBarAlignment: { Left: 1 },
		window: {
			createStatusBarItem: () => statusBar,
			registerTreeDataProvider: (id, provider) => {
				providers.set(id, provider);
				return new Disposable(() => providers.delete(id));
			},
			showErrorMessage: async (message) => { errors.push(message); },
		},
		commands: {
			executeCommand: async (command, key, value) => {
				assert.equal(command, "setContext");
				if (failContext) {
					failContext = false;
					throw new Error("context unavailable");
				}
				contexts.set(key, value);
			},
		},
	};
	const statusListeners = new Set();
	const urlListeners = new Set();
	const relay = {
		state: "disconnected",
		url: "ws://127.0.0.1:8787",
		onStatusChange: (listener) => { statusListeners.add(listener); return () => statusListeners.delete(listener); },
		onUrlChange: (listener) => { urlListeners.add(listener); return () => urlListeners.delete(listener); },
		setState(state) { this.state = state; for (const listener of statusListeners) listener(state); },
		setUrl(url) { this.url = url; for (const listener of urlListeners) listener(url); },
	};
	const controllerListeners = new Set();
	const controller = {
		isHosting: false,
		isJoining: false,
		isChangingHosting: false,
		onStateChange: (listener) => { controllerListeners.add(listener); return () => controllerListeners.delete(listener); },
		setState(hosting, joining, changingHosting = false) {
			this.isHosting = hosting;
			this.isJoining = joining;
			this.isChangingHosting = changingHosting;
			for (const listener of controllerListeners) listener();
		},
	};
	const inboxListeners = new Set();
	const inbox = {
		pendingKeyChanges: { contacts: 0, messages: 0 },
		onEvent: (listener) => { inboxListeners.add(listener); return () => inboxListeners.delete(listener); },
		setPending(summary) {
			this.pendingKeyChanges = summary;
			for (const listener of inboxListeners) listener({ type: "pendingKeyChanges", summary });
		},
	};
	const logger = { error: (message) => loggedErrors.push(message) };
	const modulePath = path.join(__dirname, "../dist/extension/src/ui/devChatUi.js");
	delete require.cache[require.resolve(modulePath)];
	const originalLoad = Module._load;
	let DevChatUi;
	try {
		Module._load = function(request, parent, isMain) {
			return request === "vscode" ? vscode : originalLoad.call(this, request, parent, isMain);
		};
		({ DevChatUi } = require(modulePath));
	} finally {
		Module._load = originalLoad;
	}
	const ui = new DevChatUi(relay, controller, inbox, logger);
	return { contexts, controller, errors, inbox, loggedErrors, providers, relay, statusBar, ui };
}

function items(ui) {
	return ui.getChildren().flatMap((group) => ui.getChildren(group).map((node) => node.item));
}

function commands(ui) {
	return items(ui).map((item) => item.command?.command).filter(Boolean);
}

function flush() {
	return new Promise((resolve) => setImmediate(resolve));
}

test("sidebar and status bar follow connection, hosting, URL and key-review state", async () => {
	const fixture = createFixture();
	try {
		await flush();
		assert.ok(fixture.providers.has("devChat.actions"));
		assert.deepEqual(fixture.providers.get("devChat.welcome").getChildren(), []);
		assert.equal(fixture.statusBar.visible, true);
		assert.equal(fixture.statusBar.command, "devChat.connectRelay");
		assert.match(fixture.statusBar.accessibilityInformation.label, /Disconnected.*Connect/);
		assert.equal(fixture.contexts.get("devChat.canConnect"), true);
		assert.equal(fixture.contexts.get("devChat.canHost"), true);
		assert.equal(fixture.contexts.get("devChat.needsSetup"), true);
		assert.ok(commands(fixture.ui).includes("devChat.hostRelay"));
		assert.ok(commands(fixture.ui).includes("devChat.joinRelayWithInvite"));
		assert.ok(commands(fixture.ui).includes("devChat.openInstructions"));
		assert.ok(commands(fixture.ui).includes("devChat.resetIdentity"));
		assert.equal(commands(fixture.ui).includes("devChat.stopHostingRelay"), false);
		assert.equal(commands(fixture.ui).includes("devChat.reviewKeyChanges"), false);

		fixture.controller.setState(false, false, true);
		await flush();
		assert.equal(fixture.contexts.get("devChat.canConnect"), false);
		assert.equal(fixture.contexts.get("devChat.canHost"), false);
		assert.equal(fixture.contexts.get("devChat.canStopHosting"), false);
		assert.equal(commands(fixture.ui).includes("devChat.hostRelay"), false);
		assert.equal(commands(fixture.ui).includes("devChat.joinRelayWithInvite"), false);
		assert.equal(commands(fixture.ui).includes("devChat.regenerateHostRelayCertificate"), false);
		fixture.controller.setState(false, false);

		fixture.relay.setState("connecting");
		await flush();
		assert.equal(fixture.contexts.get("devChat.canConnect"), false);
		assert.equal(fixture.contexts.get("devChat.canHost"), false);
		assert.equal(fixture.contexts.get("devChat.needsSetup"), false);
		assert.equal(fixture.statusBar.command, "devChat.openChat");
		assert.equal(commands(fixture.ui).includes("devChat.joinRelayWithInvite"), false);

		fixture.relay.setUrl("wss://relay.example:8787/private?token=example");
		fixture.relay.setState("connected");
		await flush();
		const relayItem = items(fixture.ui).find((item) => item.id === "devChat.info.relay-address");
		assert.equal(relayItem.label, "Relay: wss://relay.example:8787");
		assert.equal(relayItem.label.includes("token"), false);
		for (const command of ["devChat.copyRelayAddress", "devChat.copyRelayInvite", "devChat.manageRelayMembers", "devChat.changeRelayJoinCode"]) {
			assert.ok(commands(fixture.ui).includes(command), `${command} is available when connected`);
		}

		fixture.controller.setState(true, false);
		await flush();
		assert.equal(fixture.contexts.get("devChat.isHosting"), true);
		assert.equal(fixture.contexts.get("devChat.canStopHosting"), true);
		assert.ok(commands(fixture.ui).includes("devChat.stopHostingRelay"));
		assert.equal(commands(fixture.ui).includes("devChat.hostRelay"), false);
		assert.equal(commands(fixture.ui).includes("devChat.joinRelayWithInvite"), false);

		fixture.controller.setState(true, false, true);
		await flush();
		assert.equal(fixture.contexts.get("devChat.isHosting"), true);
		assert.equal(fixture.contexts.get("devChat.canStopHosting"), false);
		assert.equal(commands(fixture.ui).includes("devChat.stopHostingRelay"), false);
		fixture.controller.setState(true, false);

		fixture.inbox.setPending({ contacts: 2, messages: 3 });
		await flush();
		assert.equal(fixture.contexts.get("devChat.hasPendingKeyChanges"), true);
		assert.ok(commands(fixture.ui).includes("devChat.reviewKeyChanges"));
		const pending = items(fixture.ui).find((item) => item.id === "devChat.info.pending-changes");
		assert.equal(pending.label, "Pending key changes: 2");
		assert.equal(pending.tooltip, "3 held messages");
		fixture.inbox.setPending({ contacts: 0, messages: 0 });
		await flush();
		assert.equal(fixture.contexts.get("devChat.hasPendingKeyChanges"), false);
		assert.equal(commands(fixture.ui).includes("devChat.reviewKeyChanges"), false);

		fixture.relay.setState("disconnected");
		fixture.controller.setState(false, true);
		await flush();
		assert.equal(fixture.contexts.get("devChat.canConnect"), false);
		assert.equal(fixture.contexts.get("devChat.canHost"), false);
		assert.equal(fixture.statusBar.command, "devChat.openChat");
		assert.equal(commands(fixture.ui).includes("devChat.joinRelayWithInvite"), false);
		assert.deepEqual(fixture.errors, []);
		assert.deepEqual(fixture.loggedErrors, []);

		fixture.controller.setState(false, false);
		fixture.relay.setUrl("not a relay address?token=example");
		fixture.relay.setState("error");
		await flush();
		assert.equal(items(fixture.ui).find((item) => item.id === "devChat.info.relay-address").label, "Relay: Invalid relay address");
		assert.ok(items(fixture.ui).some((item) => item.label === "Retry Connection"));
		assert.equal(fixture.statusBar.command, "devChat.connectRelay");
		assert.match(fixture.statusBar.accessibilityInformation.label, /Connection error.*Connect/);
	} finally {
		fixture.ui.dispose();
	}
	assert.equal(fixture.statusBar.disposed, true);
	assert.equal(fixture.providers.size, 0);
});

test("reports context update failures and retries on the next state change", async () => {
	const fixture = createFixture({ failContext: true });
	try {
		await flush();
		assert.match(fixture.loggedErrors[0], /context unavailable/);
		assert.match(fixture.errors[0], /could not update its UI state/i);
		fixture.relay.setState("connected");
		await flush();
		assert.equal(fixture.contexts.get("devChat.canConnect"), false);
		assert.equal(fixture.contexts.get("devChat.needsSetup"), false);
	} finally {
		fixture.ui.dispose();
	}
});

test("sidebar welcome links and title actions refer to contributed commands", () => {
	const manifest = require("../package.json");
	const contributed = new Map(manifest.contributes.commands.map((command) => [command.command, command]));
	assert.equal(manifest.contributes.viewsContainers.activitybar[0].icon, "media/dev-chat.svg");
	assert.ok(manifest.contributes.views.devChat.some((view) => view.id === "devChat.actions"));
	assert.ok(manifest.contributes.views.devChat.some((view) => view.id === "devChat.welcome" && view.when === "devChat.needsSetup"));
	for (const view of manifest.contributes.views.devChat) {
		assert.equal(typeof view.icon, "string", `${view.id} has an icon`);
		assert.ok(fs.statSync(path.resolve(__dirname, "..", view.icon)).isFile(), `${view.id} icon is a file`);
	}
	for (const welcome of manifest.contributes.viewsWelcome) {
		for (const match of welcome.contents.matchAll(/\(command:([^)]+)\)/g)) {
			assert.ok(contributed.has(match[1]), `${match[1]} is contributed`);
		}
	}
	for (const menu of manifest.contributes.menus["view/title"]) {
		assert.ok(contributed.get(menu.command)?.icon, `${menu.command} has a title icon`);
		assert.match(menu.when, /view == devChat\.actions/);
	}
});
