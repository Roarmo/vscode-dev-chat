const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

test("panel bridges retry, connection state and failed sends", () => {
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
	const encryption = { publicKey: "public-key", encrypt: () => "ciphertext" };
	ChatPanel.createOrShow({ extensionUri: "extension" }, relay, encryption);
	try {
		receiveWebviewMessage({ command: "webviewReady" });
		assert.deepEqual(posted.pop(), { command: "connectionState", state: "error" });
		receiveWebviewMessage({ command: "retryConnection" });
		assert.equal(connectedIdentity, "public-key");
		receiveWebviewMessage({ command: "sendMessage", id: "1", to: "recipient", text: "hello" });
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