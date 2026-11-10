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
		this.attributes = {};
		this.value = "";
		this.textContent = "";
		this.className = "";
		this.scrollHeight = 0;
		this.scrollTop = 0;
		this.hidden = false;
		this.disabled = false;
	}

	set innerHTML(value) {
		this._innerHTML = value;
		this.children = [];
	}

	get innerHTML() {
		return this._innerHTML ?? "";
	}

	addEventListener(type, listener) {
		this.listeners.set(type, listener);
	}

	setAttribute(name, value) {
		this.attributes[name] = value;
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
		if (match) {
			const message = this.children.find((child) => child.dataset.id === match[1]);
			return message?.children.flatMap((child) => child.children).find((child) => child.className === "msg-status") ?? null;
		}
		const className = selector.startsWith(".") ? selector.slice(1) : null;
		if (!className) return null;
		return this.children.find((child) => child.className === className) ??
			this.children.map((child) => child.querySelector(selector)).find(Boolean) ??
			null;
	}
}

function loadWebview() {
	const emptyState = new MockElement("empty-state");
	emptyState.appendChild(Object.assign(new MockElement(), { className: "empty-title" }));
	emptyState.appendChild(Object.assign(new MockElement(), { className: "empty-subtitle" }));
	const elements = new Map([
		["conversation-list", new MockElement("conversation-list")],
		["conversation-list-empty", new MockElement("conversation-list-empty")],
		["unread-total", new MockElement("unread-total")],
		["conversation-title", new MockElement("conversation-title")],
		["conversation-key-label", new MockElement("conversation-key-label")],
		["messages", new MockElement("messages")],
		["input", new MockElement("input")],
		["send", new MockElement("send")],
		["connection-status", new MockElement("connection-status")],
		["empty-state", emptyState],
		["copy-key", new MockElement("copy-key")],
		["show-fingerprint", new MockElement("show-fingerprint")],
		["verify-contact", new MockElement("verify-contact")],
		["open-instructions", new MockElement("open-instructions")],
		["key-change-notice", new MockElement("key-change-notice")],
		["key-change-notice-text", new MockElement("key-change-notice-text")],
		["review-key-changes", new MockElement("review-key-changes")],
		["contact-select", new MockElement("contact-select")],
		["contact-name", new MockElement("contact-name")],
		["contact-public-key", new MockElement("contact-public-key")],
		["contact-fingerprint-row", new MockElement("contact-fingerprint-row")],
		["contact-fingerprint", new MockElement("contact-fingerprint")],
		["save-contact", new MockElement("save-contact")],
		["remove-contact", new MockElement("remove-contact")],
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

function conversationState(activePublicKey, conversations, messages = []) {
	return { activePublicKey, conversations, messages };
}

test("renders isolated conversations, unread counts, and sends to the selected conversation", () => {
	const { elements, postedMessages, windowListeners } = loadWebview();
	const receive = windowListeners.get("message");
	const aliceKey = "alice-public-key";
	const bobKey = "bob-public-key";
	receive({ data: {
		command: "conversationState",
		state: conversationState(aliceKey, [
			{ publicKey: aliceKey, name: "Alice", preview: "Alice preview", unreadCount: 2 },
			{ publicKey: bobKey, name: "Bob", preview: "Bob preview", unreadCount: 1 },
		], [
			{ id: "alice-1", direction: "incoming", text: "Alice message", sentAt: 1 },
		]),
	} });

	assert.equal(elements.get("conversation-title").textContent, "Alice");
	assert.equal(elements.get("conversation-key-label").textContent, aliceKey);
	assert.equal(elements.get("messages").children.length, 1);
	assert.equal(elements.get("messages").children[0].querySelector(".body").textContent, "Alice message");
	assert.equal(elements.get("unread-total").textContent, "3 unread");
	assert.equal(elements.get("conversation-list").children[0].attributes["aria-current"], "true");
	assert.equal(elements.get("conversation-list").children[1].querySelector(".conversation-item-name").textContent, "Bob");

	elements.get("conversation-list").children[1].dispatch("click");
	assert.equal(JSON.stringify(postedMessages.pop()), JSON.stringify({ command: "selectConversation", publicKey: bobKey }));

	receive({ data: {
		command: "conversationState",
		state: conversationState(bobKey, [
			{ publicKey: aliceKey, name: "Alice", preview: "Alice preview", unreadCount: 2 },
			{ publicKey: bobKey, name: "Bob", preview: "Bob preview", unreadCount: 0 },
		], [
			{ id: "bob-1", direction: "incoming", text: "Bob message", sentAt: 2 },
		]),
	} });
	assert.equal(elements.get("messages").children.length, 1);
	assert.equal(elements.get("messages").children[0].querySelector(".body").textContent, "Bob message");
	assert.equal(elements.get("unread-total").textContent, "2 unread");

	elements.get("input").value = "Reply to Bob";
	elements.get("send").dispatch("click");
	assert.equal(postedMessages[0].command, "sendMessage");
	assert.equal(postedMessages[0].to, bobKey);
	assert.equal(postedMessages[0].text, "Reply to Bob");
});

test("renders delivery status from conversation updates and keeps message text as text", () => {
	const { elements, windowListeners } = loadWebview();
	const receive = windowListeners.get("message");
	const state = (status) => conversationState("alice-key", [
		{ publicKey: "alice-key", name: "Alice", preview: "<img>", unreadCount: 0 },
	], [
		{ id: "sent-1", direction: "outgoing", text: "<img src=x>", sentAt: 1, status },
	]);
	receive({ data: { command: "conversationState", state: state("pending") } });

	const body = elements.get("messages").children[0].querySelector(".body");
	assert.equal(body.textContent, "<img src=x>");
	assert.equal(elements.get("messages").children[0].querySelector(".msg-status").textContent, "Sending");

	receive({ data: { command: "conversationState", state: state("sent") } });
	assert.equal(elements.get("messages").children[0].querySelector(".msg-status").dataset.status, "sent");
	assert.equal(elements.get("messages").children[0].querySelector(".msg-status").textContent, "Sent");
});

test("disables sending until a conversation is selected and displays the empty state", () => {
	const { elements, windowListeners, postedMessages } = loadWebview();
	assert.equal(elements.get("input").disabled, true);
	assert.equal(elements.get("send").disabled, true);
	assert.equal(elements.get("empty-state").hidden, false);
	elements.get("input").value = "hello";
	elements.get("send").dispatch("click");
	assert.equal(postedMessages.length, 0);
	assert.match(elements.get("error-notice-text").textContent, /select a conversation/i);
	assert.equal(elements.get("empty-state").querySelector(".empty-title").textContent, "Select a conversation to view messages");

	windowListeners.get("message")({ data: {
		command: "conversationState",
		state: conversationState(null, [], []),
	} });
	assert.equal(elements.get("conversation-list-empty").hidden, false);
});

test("selecting a contact for editing does not change the active conversation", () => {
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
	assert.equal(elements.get("contact-name").value, "Alice <dev>");
	assert.equal(elements.get("contact-public-key").value, publicKey);
	assert.equal(elements.get("contact-fingerprint").textContent, "ABCD 1234");
	assert.equal(elements.get("contact-fingerprint-row").hidden, false);
	assert.equal(postedMessages.length, 0);

	elements.get("contact-name").value = "Alice Updated";
	elements.get("save-contact").dispatch("click");
	assert.equal(JSON.stringify(postedMessages.pop()), JSON.stringify({
		command: "saveContact",
		name: "Alice Updated",
		publicKey,
		currentPublicKey: publicKey,
	}));
	elements.get("remove-contact").dispatch("click");
	assert.equal(JSON.stringify(postedMessages.pop()), JSON.stringify({ command: "removeContact", publicKey }));

	receive({ data: { command: "contactsUpdated", contacts: [], selectedPublicKey: null } });
	assert.equal(elements.get("remove-contact").disabled, true);
	assert.equal(elements.get("contact-fingerprint-row").hidden, true);
});

test("copies the public key and updates relay and error notices", () => {
	const { elements, postedMessages, windowListeners } = loadWebview();
	elements.get("copy-key").dispatch("click");
	assert.equal(postedMessages.pop().command, "copyPublicKey");
	windowListeners.get("message")({ data: { command: "publicKeyCopied" } });
	assert.equal(elements.get("copy-key").textContent, "Copied");

	const receive = windowListeners.get("message");
	receive({ data: { command: "connectionState", state: "error" } });
	assert.equal(elements.get("connection-status").dataset.state, "error");
	assert.equal(elements.get("connection-notice").hidden, false);
	assert.equal(elements.get("retry-connection").textContent, "Retry");
	elements.get("retry-connection").dispatch("click");
	assert.equal(postedMessages.pop().command, "retryConnection");
	receive({ data: { command: "connectionState", state: "connected" } });
	assert.equal(elements.get("connection-notice").hidden, true);

	receive({ data: { command: "errorNotice", message: "Could not save contact." } });
	assert.equal(elements.get("error-notice-text").textContent, "Could not save contact.");
	assert.equal(elements.get("error-notice").hidden, false);
	elements.get("dismiss-error").dispatch("click");
	assert.equal(elements.get("error-notice").hidden, true);
});

test("sends identity and help actions and updates the key-change review banner", () => {
	const { elements, postedMessages, windowListeners } = loadWebview();
	for (const id of ["show-fingerprint", "verify-contact", "open-instructions", "review-key-changes"]) {
		elements.get(id).dispatch("click");
	}
	assert.deepEqual(postedMessages.map((message) => message.command), [
		"showMyFingerprint",
		"verifyContact",
		"openInstructions",
		"reviewKeyChanges",
	]);

	const receive = windowListeners.get("message");
	receive({ data: { command: "pendingKeyChanges", summary: { contacts: 1, messages: 2 } } });
	assert.equal(elements.get("key-change-notice").hidden, false);
	assert.match(elements.get("key-change-notice-text").textContent, /1 contact has.*2 messages are held/);

	receive({ data: { command: "pendingKeyChanges", summary: { contacts: 2, messages: 1 } } });
	assert.match(elements.get("key-change-notice-text").textContent, /2 contacts have.*1 message is held/);
	receive({ data: { command: "pendingKeyChanges", summary: { contacts: 0, messages: 0 } } });
	assert.equal(elements.get("key-change-notice").hidden, true);
});
