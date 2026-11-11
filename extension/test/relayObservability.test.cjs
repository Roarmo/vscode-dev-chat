const assert = require("node:assert/strict");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const test = require("node:test");
const WebSocket = require("ws");

const dist = path.join(__dirname, "..", "dist");
const { RelayClient } = require(path.join(dist, "extension", "src", "relay", "relayClient.js"));
const { startRelayServer } = require(path.join(dist, "shared", "relayServer.js"));
const authentication = require(path.join(dist, "shared", "relayAuthentication.js"));
const { generateRelayCertificate } = require(path.join(dist, "shared", "relayCertificate.js"));
const { createIdentity, accessOptions } = require(path.join(__dirname, "..", "..", "test-support", "relay.cjs"));

function requestHealth(port, secure = false, method = "GET", pathname = "/health") {
	const request = secure ? https.request : http.request;
	return new Promise((resolve, reject) => {
		const req = request({
			hostname: "127.0.0.1",
			port,
			path: pathname,
			method,
			...(secure ? { rejectUnauthorized: false } : {}),
		}, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk) => { body += chunk; });
			response.on("end", () => resolve({
				statusCode: response.statusCode,
				headers: response.headers,
				body,
			}));
		});
		req.on("error", reject);
		req.end();
	});
}

function openSocket(url) {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url);
		socket.once("open", () => resolve(socket));
		socket.once("error", reject);
		socket.once("unexpected-response", (_request, response) => {
			reject(new Error(`HTTP ${response.statusCode}`));
		});
	});
}

function waitForRawMessage(socket, predicate) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			socket.off("message", onMessage);
			reject(new Error("Timed out waiting for relay response."));
		}, 5000);
		const onMessage = (data) => {
			const message = JSON.parse(data.toString());
			if (!predicate(message)) return;
			clearTimeout(timeout);
			socket.off("message", onMessage);
			resolve(message);
		};
		socket.on("message", onMessage);
	});
}

function waitForState(client, expected) {
	if (client.state === expected) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			stop();
			reject(new Error(`Timed out waiting for ${expected}; got ${client.state}`));
		}, 5000);
		const stop = client.onStatusChange((state) => {
			if (state !== expected) return;
			clearTimeout(timeout);
			stop();
			resolve();
		});
	});
}

function waitForMessage(client, predicate) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			stop();
			reject(new Error("Timed out waiting for relay message."));
		}, 5000);
		const stop = client.onMessage((message) => {
			if (!predicate(message)) return;
			clearTimeout(timeout);
			stop();
			resolve(message);
		});
	});
}

async function waitFor(predicate) {
	const timeoutAt = Date.now() + 2000;
	while (Date.now() < timeoutAt) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail("Timed out waiting for relay metrics to update.");
}

test("HTTP health reports readiness and privacy-safe counters", async (t) => {
	const identity = createIdentity(authentication);
	const logs = [];
	const relay = await startRelayServer({
		port: 0,
		host: "127.0.0.1",
		access: accessOptions(identity),
		logger: { info: (message) => logs.push(message), error: (message) => logs.push(message) },
	});
	t.after(() => relay.close());

	const initial = await requestHealth(relay.port, false, "GET", "/health?probe=ready");
	assert.equal(initial.statusCode, 200);
	assert.equal(initial.headers["cache-control"], "no-store");
	assert.equal(JSON.parse(initial.body).readiness, "ready");
	assert.deepEqual(relay.metrics(), {
		activeConnections: 0,
		presenceEntries: 0,
		messagesReceived: 0,
		messagesForwarded: 0,
		throttledMessages: 0,
		payloadRejections: 0,
		protocolErrors: 0,
		forwardingFailures: 0,
		rejectedNonLocalConnections: 0,
	});

	const head = await requestHealth(relay.port, false, "HEAD");
	assert.equal(head.statusCode, 200);
	assert.equal(head.body, "");
	assert.equal((await requestHealth(relay.port, false, "POST")).statusCode, 405);
	assert.equal((await requestHealth(relay.port, false, "GET", "/")).statusCode, 426);

	const raw = await openSocket(`ws://127.0.0.1:${relay.port}`);
	const closed = new Promise((resolve) => raw.once("close", resolve));
	try {
		assert.equal(JSON.parse((await requestHealth(relay.port)).body).activeConnections, 1);
		const malformed = waitForRawMessage(raw, (message) => message.type === "error");
		raw.send("PRIVATE_PAYLOAD_SENTINEL");
		assert.equal((await malformed).code, "INVALID_JSON");
		const health = JSON.parse((await requestHealth(relay.port)).body);
		assert.equal(health.activeConnections, 1);
		assert.equal(health.presenceEntries, 0);
		assert.equal(health.messagesReceived, 1);
		assert.equal(health.payloadRejections, 1);
		assert.equal(health.protocolErrors, 1);
		assert.ok(logs.some((entry) => JSON.parse(entry).event === "payload_drop"));
		assert.ok(logs.some((entry) => JSON.parse(entry).event === "protocol_error"));
		assert.equal(logs.join("\n").includes("PRIVATE_PAYLOAD_SENTINEL"), false);
		assert.equal(logs.join("\n").includes(identity.publicKey), false);

		const privateRequestId = "PRIVATE_REQUEST_ID_SENTINEL";
		const invalidShape = waitForRawMessage(raw, (message) => message.type === "error");
		raw.send(JSON.stringify({ type: "unknown", requestId: privateRequestId }));
		assert.equal((await invalidShape).correlationId, privateRequestId);
		const events = logs.map((entry) => JSON.parse(entry));
		const drop = events.find((entry) => entry.event === "payload_drop" && entry.code === "INVALID_SHAPE");
		const error = events.find((entry) => entry.event === "protocol_error" && entry.code === "INVALID_SHAPE");
		assert.match(drop.requestIdHash, /^[a-f0-9]{16}$/);
		assert.equal(drop.requestIdHash, error.requestIdHash);
		assert.equal(logs.join("\n").includes(privateRequestId), false);
	} finally {
		raw.close();
		await closed;
	}
	await waitFor(() => relay.metrics().activeConnections === 0);
	assert.equal(JSON.parse((await requestHealth(relay.port)).body).activeConnections, 0);
});

test("metrics count successful local forwarding without logging ciphertext", async (t) => {
	const admin = createIdentity(authentication);
	const recipient = createIdentity(authentication);
	const joinCode = authentication.generateJoinCode();
	const logs = [];
	const relay = await startRelayServer({
		port: 0,
		host: "127.0.0.1",
		access: { ...accessOptions(admin), initialJoinCode: joinCode },
		logger: { info: (message) => logs.push(message), error: (message) => logs.push(message) },
	});
	const clients = [];
	t.after(async () => {
		for (const client of clients) client.close();
		await relay.close();
	});

	const url = `ws://127.0.0.1:${relay.port}`;
	const sender = new RelayClient(url);
	const receiver = new RelayClient(url);
	clients.push(sender, receiver);
	receiver.setJoinCode(url, joinCode);
	const receiverReady = waitForState(receiver, "connected");
	receiver.connect(recipient);
	await receiverReady;
	const senderReady = waitForState(sender, "connected");
	sender.connect(admin);
	await senderReady;
	assert.equal(relay.metrics().activeConnections, 2);
	assert.equal(relay.metrics().presenceEntries, 2);

	const requestId = "PRIVATE_ROUTING_REQUEST_ID_SENTINEL";
	const opaqueCiphertext = "sealedbox.v1:CIPHERTEXT_SENTINEL";
	const delivery = waitForMessage(sender, (message) =>
		message.type === "ack" && message.correlationId === requestId
	);
	const received = waitForMessage(receiver, (message) =>
		message.type === "direct_message" && message.requestId === requestId
	);
	assert.equal(sender.sendDirectMessage(recipient.publicKey, opaqueCiphertext, requestId), true);
	assert.equal((await received).payload, opaqueCiphertext);
	assert.equal((await delivery).status, "delivered");

	assert.equal(relay.metrics().messagesForwarded, 1);
	assert.equal(relay.metrics().forwardingFailures, 0);
	assert.ok(relay.metrics().messagesReceived >= 5);
	const events = logs.map((entry) => JSON.parse(entry));
	assert.ok(events.some((entry) => entry.event === "connect"));
	assert.ok(events.some((entry) => entry.event === "register"));
	assert.match(events.find((entry) => entry.event === "route_local").requestIdHash, /^[a-f0-9]{16}$/);
	assert.equal(logs.join("\n").includes(opaqueCiphertext), false);
	assert.equal(logs.join("\n").includes(requestId), false);
	assert.equal(logs.join("\n").includes(admin.publicKey), false);
	assert.equal(logs.join("\n").includes(recipient.publicKey), false);
});

test("tracks throttling and rejected non-local upgrade attempts", async (t) => {
	const identity = createIdentity(authentication);
	const logs = [];
	const relay = await startRelayServer({
		port: 0,
		host: "127.0.0.1",
		access: accessOptions(identity),
		limits: { maxMessagesPerWindow: 1, rateLimitWindowMs: 60_000 },
		logger: { info: (message) => logs.push(message), error: (message) => logs.push(message) },
	});
	t.after(() => relay.close());

	const raw = await openSocket(`ws://127.0.0.1:${relay.port}`);
	try {
		const firstError = waitForRawMessage(raw, (message) => message.type === "error");
		raw.send("malformed");
		assert.equal((await firstError).code, "INVALID_JSON");
		const throttled = waitForRawMessage(raw, (message) => message.type === "error");
		raw.send("another malformed payload");
		assert.equal((await throttled).code, "RATE_LIMITED");
	} finally {
		raw.close();
	}

	const rejectedRelay = await startRelayServer({
		port: 0,
		host: "127.0.0.1",
		access: accessOptions(createIdentity(authentication)),
		isRemoteAddressAllowed: () => false,
		logger: { info: (message) => logs.push(message), error: (message) => logs.push(message) },
	});
	t.after(() => rejectedRelay.close());
	await assert.rejects(openSocket(`ws://127.0.0.1:${rejectedRelay.port}`), /HTTP 403/);
	assert.equal((await requestHealth(rejectedRelay.port)).statusCode, 403);
	assert.equal(rejectedRelay.metrics().rejectedNonLocalConnections, 2);
	assert.ok(logs.some((entry) => JSON.parse(entry).event === "throttle"));
	assert.ok(logs.some((entry) => {
		const event = JSON.parse(entry);
		return event.event === "rejected_non_local_source" && event.transport === "http";
	}));
	assert.equal(relay.metrics().throttledMessages, 1);
	assert.equal(relay.metrics().payloadRejections, 1);
	assert.equal(relay.metrics().protocolErrors, 2);
});

test("rate-limited messages retain their correlation without exposing it in logs", async (t) => {
	const identity = createIdentity(authentication);
	const logs = [];
	const relay = await startRelayServer({
		port: 0,
		host: "127.0.0.1",
		access: accessOptions(identity),
		limits: { maxMessagesPerWindow: 2, rateLimitWindowMs: 60_000 },
		logger: { info: (message) => logs.push(message), error: (message) => logs.push(message) },
	});
	const client = new RelayClient(`ws://127.0.0.1:${relay.port}`);
	t.after(async () => {
		client.close();
		await relay.close();
	});
	const ready = waitForState(client, "connected");
	client.connect(identity);
	await ready;

	const requestId = "PRIVATE_THROTTLED_REQUEST_ID";
	const rejected = waitForMessage(client, (message) =>
		message.type === "error" && message.correlationId === requestId
	);
	assert.equal(client.sendDirectMessage(identity.publicKey, "opaque", requestId), true);
	assert.equal((await rejected).code, "RATE_LIMITED");
	assert.equal(client.pendingMessages.has(requestId), false);

	const oversizedRequestId = "PRIVATE_RATE_LIMITED_OVERSIZED_ID";
	const oversized = waitForMessage(client, (message) =>
		message.type === "error" && message.correlationId === oversizedRequestId
	);
	assert.equal(client.sendDirectMessage(identity.publicKey, "x".repeat(9000), oversizedRequestId), true);
	assert.equal((await oversized).code, "RATE_LIMITED");
	assert.equal(client.pendingMessages.has(oversizedRequestId), false);

	const throttled = logs.map((entry) => JSON.parse(entry)).find((entry) => entry.event === "throttle");
	assert.equal(throttled.messageType, "direct_message");
	assert.match(throttled.requestIdHash, /^[a-f0-9]{16}$/);
	assert.equal(logs.join("\n").includes(requestId), false);
	assert.equal(logs.join("\n").includes(oversizedRequestId), false);
});

test("an oversized message is correlated and rejected without disconnecting the sender", async (t) => {
	const identity = createIdentity(authentication);
	const logs = [];
	const relay = await startRelayServer({
		port: 0,
		host: "127.0.0.1",
		access: accessOptions(identity),
		logger: { info: (message) => logs.push(message), error: (message) => logs.push(message) },
	});
	const client = new RelayClient(`ws://127.0.0.1:${relay.port}`);
	t.after(async () => {
		client.close();
		await relay.close();
	});
	const ready = waitForState(client, "connected");
	client.connect(identity);
	await ready;

	const requestId = "PRIVATE_OVERSIZED_REQUEST_ID";
	const rejected = waitForMessage(client, (message) =>
		message.type === "error" && message.correlationId === requestId
	);
	assert.equal(client.sendDirectMessage(identity.publicKey, "x".repeat(9000), requestId), true);
	assert.equal((await rejected).code, "PAYLOAD_TOO_LARGE");
	assert.equal(client.pendingMessages.has(requestId), false);
	assert.equal(client.state, "connected");
	assert.equal(relay.metrics().payloadRejections, 1);
	assert.equal(logs.join("\n").includes(requestId), false);

	const retryId = "shorter-message";
	const received = waitForMessage(client, (message) =>
		message.type === "direct_message" && message.requestId === retryId
	);
	const acknowledged = waitForMessage(client, (message) =>
		message.type === "ack" && message.correlationId === retryId
	);
	assert.equal(client.sendDirectMessage(identity.publicKey, "short", retryId), true);
	assert.equal((await received).payload, "short");
	assert.equal((await acknowledged).status, "delivered");
});

test("health endpoint is available through the standalone relay TLS listener", async (t) => {
	const relay = await startRelayServer({
		port: 0,
		host: "127.0.0.1",
		tls: await generateRelayCertificate(),
		access: accessOptions(createIdentity(authentication)),
		logger: { info() {}, error() {} },
	});
	t.after(() => relay.close());

	const response = await requestHealth(relay.port, true);
	assert.equal(response.statusCode, 200);
	assert.equal(JSON.parse(response.body).canRouteMessages, true);
});

test("forwarding failures are reported without a false delivery acknowledgement", async (t) => {
	const admin = createIdentity(authentication);
	const recipient = createIdentity(authentication);
	const joinCode = authentication.generateJoinCode();
	const logs = [];
	const relay = await startRelayServer({
		port: 0,
		host: "127.0.0.1",
		access: { ...accessOptions(admin), initialJoinCode: joinCode },
		logger: { info: (message) => logs.push(message), error: (message) => logs.push(message) },
	});
	const sender = new RelayClient(`ws://127.0.0.1:${relay.port}`);
	const receiver = new RelayClient(sender.url);
	t.after(async () => {
		sender.close();
		receiver.close();
		await relay.close();
	});
	receiver.setJoinCode(receiver.url, joinCode);
	const senderReady = waitForState(sender, "connected");
	const receiverReady = waitForState(receiver, "connected");
	sender.connect(admin);
	receiver.connect(recipient);
	await Promise.all([senderReady, receiverReady]);

	const acknowledgements = [];
	const stopListening = sender.onMessage((message) => {
		if (message.type === "ack" && message.status === "delivered") acknowledgements.push(message.correlationId);
	});
	const originalSend = WebSocket.prototype.send;
	let failureMode = "callback";
	WebSocket.prototype.send = function(data, ...args) {
		if (this._isServer && typeof data === "string" && JSON.parse(data).type === "direct_message") {
			const error = new Error("Synthetic forwarding failure");
			if (failureMode === "throw") throw error;
			const callback = args[args.length - 1];
			queueMicrotask(() => callback(error));
			return;
		}
		return originalSend.call(this, data, ...args);
	};
	try {
		for (failureMode of ["callback", "throw"]) {
			const requestId = `PRIVATE_FAILURE_${failureMode}`;
			const failed = waitForMessage(sender, (message) =>
				message.type === "error" && message.correlationId === requestId
			);
			assert.equal(sender.sendDirectMessage(recipient.publicKey, "PRIVATE_CIPHERTEXT_SENTINEL", requestId), true);
			const response = await failed;
			assert.equal(response.code, "FORWARD_FAILED");
			assert.match(response.message, /may still receive/i);
		}
		assert.equal(relay.metrics().forwardingFailures, 2);
		assert.equal(relay.metrics().messagesForwarded, 0);
		assert.deepEqual(acknowledgements, []);
		const events = logs.map((entry) => JSON.parse(entry));
		const sendErrors = events.filter((entry) => entry.event === "send_error" && entry.messageType === "direct_message");
		const protocolErrors = events.filter((entry) => entry.event === "protocol_error" && entry.code === "FORWARD_FAILED");
		assert.equal(sendErrors.length, 2);
		assert.equal(protocolErrors.length, 2);
		assert.deepEqual(
			sendErrors.map((entry) => entry.requestIdHash),
			protocolErrors.map((entry) => entry.requestIdHash)
		);
		assert.equal(logs.join("\n").includes("PRIVATE_FAILURE_"), false);
		assert.equal(logs.join("\n").includes("PRIVATE_CIPHERTEXT_SENTINEL"), false);
	} finally {
		WebSocket.prototype.send = originalSend;
		stopListening();
	}
});

for (const [mode, relayModule] of [
	["hosted", path.join(dist, "shared", "relayServer.js")],
	["standalone", path.join(__dirname, "..", "..", "server", "dist", "shared", "relayServer.js")],
]) {
	test(`${mode} relay bounds oversized WebSocket messages and remains responsive`, async (t) => {
		const { startRelayServer: startServer } = require(relayModule);
		const logs = [];
		const relay = await startServer({
			port: 0,
			host: "127.0.0.1",
			access: accessOptions(createIdentity(authentication)),
			logger: { info: (message) => logs.push(message), error: (message) => logs.push(message) },
		});
		const normal = await openSocket(`ws://127.0.0.1:${relay.port}`);
		const oversized = await openSocket(`ws://127.0.0.1:${relay.port}`);
		t.after(async () => {
			normal.terminate();
			oversized.terminate();
			await relay.close();
		});

		const rejected = waitForRawMessage(normal, (message) => message.type === "error");
		normal.send("x".repeat(8193));
		assert.equal((await rejected).code, "PAYLOAD_TOO_LARGE");

		const closed = new Promise((resolve) => oversized.once("close", resolve));
		oversized.send("x".repeat(16385));
		assert.equal(await closed, 1009);
		await waitFor(() => relay.metrics().payloadRejections === 2);
		assert.equal(relay.metrics().protocolErrors, 2);

		const dropped = logs.map((entry) => JSON.parse(entry))
			.filter((entry) => entry.event === "payload_drop" && entry.code === "PAYLOAD_TOO_LARGE");
		assert.equal(dropped.length, 2);
		await waitFor(() => logs.some((entry) => {
			const event = JSON.parse(entry);
			return event.event === "disconnect" && event.connectionId === dropped[1].connectionId;
		}));
		const stillResponsive = waitForRawMessage(normal, (message) => message.type === "error");
		normal.send("{}");
		assert.equal((await stillResponsive).code, "INVALID_SHAPE");
	});
}

test("the extension client explains a transport-size disconnect and marks its send uncertain", async (t) => {
	const identity = createIdentity(authentication);
	const relay = await startRelayServer({
		port: 0,
		host: "127.0.0.1",
		access: accessOptions(identity),
		logger: { info() {}, error() {} },
	});
	const client = new RelayClient(`ws://127.0.0.1:${relay.port}`);
	t.after(async () => {
		client.close();
		await relay.close();
	});
	const ready = waitForState(client, "connected");
	client.connect(identity);
	await ready;

	const requestId = "oversized-client-message";
	const pending = waitForMessage(client, (message) =>
		message.type === "error" && message.correlationId === requestId
	);
	const disconnected = waitForState(client, "error");
	assert.equal(client.sendDirectMessage(identity.publicKey, "x".repeat(17000), requestId), true);
	assert.equal((await pending).code, "DELIVERY_UNKNOWN");
	await disconnected;
	assert.match(client.lastError.message, /too large.*shorter message/i);
});
