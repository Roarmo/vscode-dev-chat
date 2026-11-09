const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

test("panel bridges inbox events, retry, connection state and signed sends", () => {
	const posted = [];
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
		window: { createWebviewPanel: () => panel, showErrorMessage: () => Promise.resolve() },
		ViewColumn: { One: 1 },
		Uri: { joinPath: () => "resource" },
		Disposable: class { constructor(dispose) { this.dispose = dispose; } },
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
	let connectedIdentity;
	const relay = {
		state: "error",
		onStatusChange: () => () => {},
		onMessage: () => () => {},
		connect: (identity) => { connectedIdentity = identity; },
		sendDirectMessage: () => false,
	};
	let sealed;
	const encryption = {
		publicKey: "public-key",
		fingerprint: "AAAA BBBB",
		seal: (text, to, requestId) => { sealed = { text, to, requestId }; return "signed-payload"; },
	};
	let emitInboxEvent;
	const inbox = { onEvent: (listener) => { emitInboxEvent = listener; return () => {}; } };
	ChatPanel.createOrShow({ extensionUri: "extension" }, relay, encryption, inbox);
	try {
		emitInboxEvent({
			type: "message",
			message: {
				requestId: "in-1",
				sentAt: Date.UTC(2026, 0, 1, 12, 0),
				text: "hi",
				sender: { publicKey: "sender-public-key", signingKey: "s", fingerprint: "1111 2222", verified: false, isNew: true },
			},
		});
		assert.equal(posted.length, 0, "posts are buffered until the webview is ready");

		receiveWebviewMessage({ command: "webviewReady" });
		assert.deepEqual(posted.pop(), { command: "connectionState", state: "error" });
		const received = posted.pop();
		assert.equal(received.command, "receiveMessage");
		assert.equal(received.message.id, "in-1");
		assert.equal(received.message.text, "hi");
		assert.equal(received.message.author, "sender-publi");
		assert.equal(received.message.senderKey, "sender-public-key");
		assert.equal(received.message.fingerprint, "1111 2222");
		assert.equal(received.message.verified, false);

		emitInboxEvent({ type: "trustChanged", publicKey: "sender-public-key", verified: true });
		assert.deepEqual(posted.pop(), { command: "senderTrust", senderKey: "sender-public-key", verified: true });
		emitInboxEvent({ type: "held", publicKey: "sender-public-key", heldCount: 1 });
		assert.match(posted.pop().message, /held because their identity key changed/);
		emitInboxEvent({ type: "rejected", from: "x", reason: "Rejected a message from x: Message signature is invalid." });
		assert.deepEqual(posted.pop(), { command: "errorNotice", message: "Rejected a message from x: Message signature is invalid." });

		receiveWebviewMessage({ command: "retryConnection" });
		assert.equal(connectedIdentity, encryption);
		receiveWebviewMessage({ command: "sendMessage", id: "1", to: " recipient ", text: "hello" });
		assert.deepEqual(sealed, { text: "hello", to: "recipient", requestId: "1" });
		assert.deepEqual(posted.pop(), {
			command: "messageAck",
			id: "1",
			status: "failed",
			reason: "Connect to the relay before sending.",
		});
	} finally {
		ChatPanel.currentPanel.dispose();
	}
});