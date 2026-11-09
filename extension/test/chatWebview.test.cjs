const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

class MockElement {
	constructor(id = "") {
		this.id = id;
		this.dataset = {};
		this.children = [];
		this.listeners = new Map();
		this.value = "";
	this.textContent = "";
		this.className = "";
		this.scrollHeight = 0;
		this.scrollTop = 0;
	}

	set innerHTML(value) {
		this._innerHTML = value;
		this.children = [];
		const status = value.match(/class="msg-status" data-status="([^"]+)"/);
		if (status) {
			const indicator = new MockElement();
			indicator.className = "msg-status";
			indicator.dataset.status = status[1];
			this.children.push(indicator);
		}
	}

	get innerHTML() {
		return this._innerHTML;
	}

	addEventListener(type, listener) {
		this.listeners.set(type, listener);
	}

	dispatch(type, event = {}) {
		this.listeners.get(type)?.({ preventDefault() {}, ...event });
	}

	appendChild(child) {
		this.children.push(child);
		return child;
	}

	querySelector(selector) {
		const match = selector.match(/^\[data-id="([^"]+)"\] \.msg-status$/);
		if (!match) return null;
		const message = this.children.find((child) => child.dataset.id === match[1]);
		return message?.children.flatMap((child) => child.children).find((child) => child.className === "msg-status") ?? null;
	}
}

function loadWebview() {
	const elements = new Map([
		["messages", new MockElement("messages")],
		["recipient", new MockElement("recipient")],
		["contact-select", new MockElement("contact-select")],
		["contact-name", new MockElement("contact-name")],
		["contact-public-key", new MockElement("contact-public-key")],
		["contact-fingerprint-row", new MockElement("contact-fingerprint-row")],
		["contact-fingerprint", new MockElement("contact-fingerprint")],
		["save-contact", new MockElement("save-contact")],
		["remove-contact", new MockElement("remove-contact")],
		["input", new MockElement("input")],
		["send", new MockElement("send")],
		["connection-status", new MockElement("connection-status")],
		["empty-state", new MockElement("empty-state")],
		["copy-key", new MockElement("copy-key")],
		["connection-notice", new MockElement("connection-notice")],
		["connection-notice-text", new MockElement("connection-notice-text")],
		["retry-connection", new MockElement("retry-connection")],
		["error-notice", new MockElement("error-notice")],
		["error-notice-text", new MockElement("error-notice-text")],
		["dismiss-error", new MockElement("dismiss-error")],
	]);
	const windowListeners = new Map();
	const postedMessages = [];
	const document = {
		getElementById: (id) => elements.get(id) ?? null,
		createElement: (tagName) => new MockElement(tagName),
	};
	const window = { addEventListener: (type, listener) => windowListeners.set(type, listener) };
	const vscode = { postMessage: (message) => postedMessages.push(message) };
	const script = fs.readFileSync(path.join(__dirname, "../media/chat.js"), "utf8");

	vm.runInNewContext(script, {
		acquireVsCodeApi: () => vscode,
		document,
		window,
		Date,
		setTimeout: () => {},
	});
	assert.equal(postedMessages.shift().command, "webviewReady");

	return { elements, windowListeners, postedMessages };
}

test("sends composer messages to the extension with recipient and updates ack state", () => {
	const { elements, postedMessages, windowListeners } = loadWebview();
	const recipient = elements.get("recipient");
	const input = elements.get("input");
	const messages = elements.get("messages");
	recipient.value = "recipient-public-key";
	input.value = "hello from the webview";

	elements.get("send").dispatch("click");

	assert.equal(postedMessages.length, 1);
	assert.equal(postedMessages[0].command, "sendMessage");
	assert.equal(postedMessages[0].to, "recipient-public-key");
	assert.equal(postedMessages[0].text, "hello from the webview");
	assert.equal(messages.children.length, 1);
	assert.equal(elements.get("empty-state").hidden, true);
	assert.equal(messages.children[0].children[1].textContent, "hello from the webview");

	windowListeners.get("message")({ data: {
		command: "messageAck",
		id: postedMessages[0].id,
		status: "sent",
	} });
	assert.equal(messages.querySelector(`[data-id="${postedMessages[0].id}"] .msg-status`).dataset.status, "sent");
	windowListeners.get("message")({ data: {
		command: "receiveMessage",
		message: { id: "incoming-1", author: "sender-key", text: "reply", time: "12:00" },
	} });
	assert.equal(messages.querySelector(`[data-id="${postedMessages[0].id}"] .msg-status`).dataset.status, "sent");
});

test("requests the public key from the extension clipboard and shows confirmation", () => {
	const { elements, postedMessages, windowListeners } = loadWebview();
	elements.get("copy-key").dispatch("click");
	assert.equal(postedMessages[0].command, "copyPublicKey");
	windowListeners.get("message")({ data: { command: "publicKeyCopied" } });
	assert.equal(elements.get("copy-key").textContent, "Copied");
});

test("renders inbound messages and updates relay connection state", () => {
	const { elements, windowListeners } = loadWebview();
	const receive = windowListeners.get("message");
	receive({ data: {
		command: "receiveMessage",
		message: { id: "incoming-1", author: "sender-key", text: "reply", time: "12:00" },
	} });
	assert.equal(elements.get("messages").children.length, 1);
	assert.equal(elements.get("messages").children[0].children[1].textContent, "reply");

	receive({ data: { command: "connectionState", state: "connected" } });
	assert.equal(elements.get("connection-status").textContent, "connected");
	assert.equal(elements.get("connection-status").dataset.state, "connected");
});

test("offers retry when connection fails and hides the notice when connected", () => {
	const { elements, postedMessages, windowListeners } = loadWebview();
	const receive = windowListeners.get("message");
	receive({ data: { command: "connectionState", state: "error" } });
	assert.equal(elements.get("connection-notice").hidden, false);
	assert.equal(elements.get("retry-connection").textContent, "Retry");
	elements.get("retry-connection").dispatch("click");
	assert.equal(postedMessages[0].command, "retryConnection");
	receive({ data: { command: "connectionState", state: "connected" } });
	assert.equal(elements.get("connection-notice").hidden, true);
});

test("shows and dismisses a failed message reason", () => {
	const { elements, postedMessages, windowListeners } = loadWebview();
	elements.get("recipient").value = "recipient-public-key";
	elements.get("input").value = "hello";
	elements.get("send").dispatch("click");
	windowListeners.get("message")({ data: {
		command: "messageAck",
		id: postedMessages[0].id,
		status: "failed",
		reason: "Recipient is offline.",
	} });
	const indicator = elements.get("messages").querySelector(`[data-id="${postedMessages[0].id}"] .msg-status`);
	assert.equal(indicator.textContent, "Failed");
	assert.equal(indicator.title, "Recipient is offline.");
	assert.equal(elements.get("error-notice-text").textContent, "Recipient is offline.");
	assert.equal(elements.get("error-notice").hidden, false);
	elements.get("dismiss-error").dispatch("click");
	assert.equal(elements.get("error-notice").hidden, true);
});

test("shows an error when sending without a recipient", () => {
	const { elements, postedMessages } = loadWebview();
	elements.get("input").value = "hello";
	elements.get("send").dispatch("click");
	assert.equal(postedMessages.length, 0);
	assert.equal(elements.get("error-notice").hidden, false);
	assert.match(elements.get("error-notice-text").textContent, /recipient/i);
});

test("assigns different IDs to consecutive sends", () => {
	const { elements, postedMessages } = loadWebview();
	elements.get("recipient").value = "recipient-public-key";
	elements.get("input").value = "first";
	elements.get("send").dispatch("click");
	elements.get("input").value = "second";
	elements.get("send").dispatch("click");
	assert.notEqual(postedMessages[0].id, postedMessages[1].id);
});

test("selects a saved contact for sending and exposes its fingerprint and management actions", () => {
	const { elements, postedMessages, windowListeners } = loadWebview();
	const publicKey = Buffer.alloc(32, 1).toString("base64");
	const receive = windowListeners.get("message");
	receive({ data: {
		command: "contactsUpdated",
		contacts: [{ name: "Alice <dev>", publicKey, fingerprint: "ABCD 1234" }],
		selectedPublicKey: null,
	} });
	assert.match(elements.get("contact-select").innerHTML, /Alice &lt;dev&gt;/);

	elements.get("contact-select").value = publicKey;
	elements.get("contact-select").dispatch("change");
	assert.equal(elements.get("recipient").value, publicKey);
	assert.equal(elements.get("recipient").readOnly, true);
	assert.equal(elements.get("contact-name").value, "Alice <dev>");
	assert.equal(elements.get("contact-public-key").value, publicKey);
	assert.equal(elements.get("contact-fingerprint").textContent, "ABCD 1234");
	assert.equal(elements.get("contact-fingerprint-row").hidden, false);

	elements.get("input").value = "hello Alice";
	elements.get("send").dispatch("click");
	assert.equal(postedMessages.at(-1).command, "sendMessage");
	assert.equal(postedMessages.at(-1).to, publicKey);

	elements.get("contact-name").value = "Alice";
	elements.get("save-contact").dispatch("click");
	assert.equal(JSON.stringify(postedMessages.at(-1)), JSON.stringify({
		command: "saveContact",
		name: "Alice",
		publicKey,
		currentPublicKey: publicKey,
	}));

	elements.get("remove-contact").dispatch("click");
	assert.equal(JSON.stringify(postedMessages.at(-1)), JSON.stringify({ command: "removeContact", publicKey }));

	receive({ data: { command: "contactsUpdated", contacts: [], selectedPublicKey: null } });
	assert.equal(elements.get("recipient").value, "");
	assert.equal(elements.get("recipient").readOnly, false);
	assert.equal(elements.get("remove-contact").disabled, true);
	assert.equal(elements.get("contact-fingerprint-row").hidden, true);
});

test("requires a name and key before saving a contact", () => {
	const { elements, postedMessages } = loadWebview();
	elements.get("save-contact").dispatch("click");
	assert.equal(postedMessages.length, 0);
	assert.match(elements.get("error-notice-text").textContent, /contact name and public key/i);
});

test("uses a contact's updated key and prevents sending to a removed contact", () => {
	const { elements, postedMessages, windowListeners } = loadWebview();
	const receive = windowListeners.get("message");
	const oldKey = Buffer.alloc(32, 1).toString("base64");
	const newKey = Buffer.alloc(32, 2).toString("base64");
	receive({ data: {
		command: "contactsUpdated",
		contacts: [{ name: "Alice", publicKey: oldKey, fingerprint: "OLD" }],
		selectedPublicKey: oldKey,
	} });
	receive({ data: {
		command: "contactsUpdated",
		contacts: [{ name: "Alice", publicKey: newKey, fingerprint: "NEW" }],
		selectedPublicKey: newKey,
	} });
	assert.equal(elements.get("recipient").value, newKey);
	assert.equal(elements.get("contact-fingerprint").textContent, "NEW");

	elements.get("input").value = "message to updated key";
	elements.get("send").dispatch("click");
	assert.equal(postedMessages.at(-1).to, newKey);

	receive({ data: { command: "contactsUpdated", contacts: [], selectedPublicKey: null } });
	elements.get("input").value = "message after removal";
	elements.get("send").dispatch("click");
	assert.equal(postedMessages.length, 1);
	assert.match(elements.get("error-notice-text").textContent, /recipient/i);
});

test("shows a trust badge on incoming messages and updates it when verification changes", () => {
	const { elements, windowListeners } = loadWebview();
	const receive = windowListeners.get("message");
	receive({ data: {
		command: "receiveMessage",
		message: { id: "in-1", author: "sender", senderKey: "sender-key", fingerprint: "1111 2222", verified: false, text: "<b>hi</b>", time: "12:00" },
	} });
	const meta = () => elements.get("messages").children[0].children[0].innerHTML;
	assert.match(meta(), /class="trust" data-verified="false"/);
	assert.match(meta(), /Not verified/);
	assert.match(meta(), /Fingerprint: 1111 2222/);
	assert.equal(elements.get("messages").children[0].children[1].textContent, "<b>hi</b>");

	receive({ data: { command: "senderTrust", senderKey: "other-key", verified: true } });
	assert.match(meta(), /data-verified="false"/);
	receive({ data: { command: "senderTrust", senderKey: "sender-key", verified: true } });
	assert.match(meta(), /data-verified="true"[^>]*>Verified</);
});