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
		["input", new MockElement("input")],
		["send", new MockElement("send")],
		["connection-status", new MockElement("connection-status")],
		["empty-state", new MockElement("empty-state")],
		["copy-key", new MockElement("copy-key")],
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