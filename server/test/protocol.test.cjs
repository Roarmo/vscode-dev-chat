const assert = require("node:assert/strict");
const test = require("node:test");
const { isRelayMessage } = require("../dist/shared/types.js");

test("accepts valid client and server protocol envelopes", () => {
	assert.equal(isRelayMessage({
		type: "hello",
		requestId: "request-1",
		from: "client-key",
		message: "hello",
		timestamp: new Date().toISOString(),
	}), true);

	assert.equal(isRelayMessage({
		type: "direct_message",
		requestId: "request-2",
		from: "sender-key",
		to: "recipient-key",
		payload: "sealedbox.v1:ciphertext",
		timestamp: new Date().toISOString(),
	}), true);
});

test("rejects incomplete or malformed protocol envelopes", () => {
	assert.equal(isRelayMessage({ type: "hello", requestId: "missing-fields" }), false);
	assert.equal(isRelayMessage({
		type: "direct_message",
		requestId: "request-3",
		from: "sender-key",
		to: "recipient-key",
		payload: 42,
		timestamp: new Date().toISOString(),
	}), false);
	assert.equal(isRelayMessage(null), false);
});