const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

test("panel bridges conversation state, contact management, retry and sends", async () => {
	const posted = [];
	const executedCommands = [];
	let failAction = false;
	let receiveWebviewMessage;
	const panel = {
		webview: {
			cspSource: "test-source",
			asWebviewUri: () => "test-resource",
			onDidReceiveMessage: (listener) => { receiveWebviewMessage = listener; },
			postMessage: (message) => { posted.push(message); return Promise.resolve(true); },
		},
		onDidDispose: () => {},
		dispose: () => {},
	};
	const vscode = {
		window: {
			createWebviewPanel: () => panel,
			showErrorMessage: () => Promise.resolve(),
			showWarningMessage: () => Promise.resolve("Remove"),
		},
		ViewColumn: { One: 1 },
		Uri: { joinPath: () => "resource" },
		Disposable: class { constructor(dispose) { this.dispose = dispose; } },
		commands: { executeCommand: async (command) => {
			executedCommands.push(command);
			if (failAction) throw new Error("action failed");
		} },
	};
	const originalLoad = Module._load;
	let ChatPanel;
	try {
		Module._load = function(request, parent, isMain) {
			return request === "vscode" ? vscode : originalLoad.call(this, request, parent, isMain);
		};
		({ ChatPanel } = require(path.join(__dirname, "../dist/extension/src/ui/ChatPanel.js")));
	} finally {
		Module._load = originalLoad;
	}

	let connectionStatusListener;
	const relay = {
		state: "error",
		onStatusChange: (listener) => { connectionStatusListener = listener; return () => {}; },
		onMessage: () => () => {},
		connect: (identity) => { relay.connectedIdentity = identity; },
		sendDirectMessage: () => false,
	};
	const encryption = {
		publicKey: "public-key",
		fingerprint: "AAAA BBBB",
		seal: () => "signed-payload",
	};
	let inboxListener;
	const inbox = {
		pendingKeyChanges: { contacts: 0, messages: 0 },
		onEvent: (listener) => { inboxListener = listener; return () => {}; },
	};
	const stored = new Map();
	const { ContactStore } = require(path.join(__dirname, "../dist/extension/src/encryption/contactStore.js"));
	const { recipientKeyFingerprint } = require(path.join(__dirname, "../dist/extension/src/encryption/fingerprint.js"));
	const contactStore = new ContactStore({
		get: (key) => stored.get(key),
		update: async (key, value) => stored.set(key, value),
	});

	let managerListener;
	let managerState = { conversations: [], activePublicKey: null, messages: [] };
	const conversations = {
		get state() { return managerState; },
		onEvent: (listener) => { managerListener = listener; return () => {}; },
		notifyContactsChanged: () => {
			managerState = {
				...managerState,
				conversations: contactStore.list().map((contact) => ({
					...contact,
					preview: "",
					lastMessageAt: 0,
					unreadCount: 0,
				})),
			};
			managerListener({ type: "changed", state: managerState });
		},
		select: async (publicKey) => {
			managerState = {
				...managerState,
				activePublicKey: publicKey,
				messages: [],
			};
			managerListener({ type: "changed", state: managerState });
		},
		send: async (publicKey, id, text) => {
			conversations.lastSend = { publicKey, id, text };
			throw new Error("Connect to the relay before sending.");
		},
		deactivate: () => {},
	};

	ChatPanel.createOrShow({ extensionUri: "extension" }, relay, encryption, contactStore, conversations, inbox);
	try {
		assert.match(panel.webview.html, /id="own-key-fingerprint"/);
		assert.ok(panel.webview.html.includes(recipientKeyFingerprint(encryption.publicKey)));
		assert.match(panel.webview.html, /id="conversation-list"/);
		assert.match(panel.webview.html, /id="unread-total"/);
		assert.match(panel.webview.html, /aria-label="Show my identity fingerprint"/);
		assert.match(panel.webview.html, /id="review-key-changes"/);
		assert.match(panel.webview.html, /aria-label="Review contact identity key changes"/);

		receiveWebviewMessage({ command: "webviewReady" });
		assert.deepEqual(posted.map((message) => message.command), [
			"connectionState",
			"contactsUpdated",
			"conversationState",
			"pendingKeyChanges",
		]);
		assert.deepEqual(posted[2].state, managerState);
		assert.deepEqual(posted[3].summary, { contacts: 0, messages: 0 });

		inbox.pendingKeyChanges = { contacts: 1, messages: 2 };
		inboxListener({ type: "pendingKeyChanges", summary: inbox.pendingKeyChanges });
		assert.deepEqual(posted.at(-1), {
			command: "pendingKeyChanges",
			summary: { contacts: 1, messages: 2 },
		});
		for (const command of ["showMyFingerprint", "verifyContact", "openInstructions", "reviewKeyChanges"]) {
			receiveWebviewMessage({ command });
		}
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(executedCommands, [
			"devChat.showMyFingerprint",
			"devChat.verifyContact",
			"devChat.openInstructions",
			"devChat.reviewKeyChanges",
		]);
		failAction = true;
		receiveWebviewMessage({ command: "reviewKeyChanges" });
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(posted.at(-1), {
			command: "errorNotice",
			message: "Could not run Dev Chat action: action failed",
		});
		failAction = false;

		relay.state = "connected";
		connectionStatusListener("connected");
		assert.deepEqual(posted.pop(), { command: "connectionState", state: "connected" });
		receiveWebviewMessage({ command: "retryConnection" });
		assert.equal(relay.connectedIdentity, encryption);

		const recipientPublicKey = Buffer.alloc(32, 1).toString("base64");
		receiveWebviewMessage({
			command: "saveContact",
			name: "Invalid",
			publicKey: "not-a-public-key",
			currentPublicKey: null,
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.match(posted.at(-1).message, /Could not save contact: Enter a valid Dev Chat public key/);

		receiveWebviewMessage({
			command: "saveContact",
			name: "Alice",
			publicKey: recipientPublicKey,
			currentPublicKey: null,
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(posted.at(-2).command, "contactsUpdated");
		assert.equal(posted.at(-2).contacts[0].name, "Alice");
		assert.equal(posted.at(-2).contacts[0].publicKey, recipientPublicKey);
		assert.match(posted.at(-2).contacts[0].fingerprint, /^([0-9A-F]{4} ){9}[0-9A-F]{4}$/);
		assert.equal(managerState.activePublicKey, recipientPublicKey);

		receiveWebviewMessage({
			command: "sendMessage",
			id: "1",
			to: recipientPublicKey,
			text: "hello",
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(conversations.lastSend, {
			publicKey: recipientPublicKey,
			id: "1",
			text: "hello",
		});
		assert.deepEqual(posted.at(-1), {
			command: "errorNotice",
			message: "Connect to the relay before sending.",
		});

		const incomingState = {
			conversations: [{
				publicKey: recipientPublicKey,
				name: "Alice",
				preview: "Hello",
				lastMessageAt: 1,
				unreadCount: 1,
			}],
			activePublicKey: recipientPublicKey,
			messages: [{ id: "in-1", direction: "incoming", text: "Hello", sentAt: 1 }],
		};
		managerState = incomingState;
		managerListener({ type: "changed", state: incomingState });
		assert.deepEqual(posted.at(-1), { command: "conversationState", state: incomingState });

		receiveWebviewMessage({ command: "removeContact", publicKey: recipientPublicKey });
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(contactStore.list(), []);
		assert.equal(managerState.activePublicKey, null);
		assert.deepEqual(posted.at(-1), {
			command: "contactsUpdated",
			contacts: [],
			selectedPublicKey: null,
		});
	} finally {
		ChatPanel.currentPanel.dispose();
	}
});
