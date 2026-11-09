const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");
const WebSocket = require("ws");

let relayProcess;
let relayUrl;

async function getFreePort() {
	const server = net.createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	return address.port;
}

function onceMessage(socket, predicate) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			socket.off("message", onMessage);
			reject(new Error("Timed out waiting for relay response"));
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

async function connectAndRegister(identity) {
	const socket = new WebSocket(relayUrl);
	await new Promise((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	const requestId = randomUUID();
	const acknowledgement = onceMessage(socket, (message) =>
		message.type === "ack" && message.correlationId === requestId
	);
	socket.send(JSON.stringify({
		type: "hello",
		requestId,
		from: identity,
		message: "integration test",
		timestamp: new Date().toISOString(),
	}));
	const response = await acknowledgement;
	assert.equal(response.status, "accepted");
	return socket;
}

test.before(async () => {
	const port = await getFreePort();
	relayUrl = `ws://127.0.0.1:${port}`;
	const serverPath = path.join(__dirname, "../dist/server/src/server.js");
	relayProcess = spawn(process.execPath, [serverPath], {
		env: { ...process.env, PORT: String(port), HEALTH_LOG_INTERVAL_MS: "60000", TLS_DISABLED: "true" },
		stdio: "ignore",
	});
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		try {
			const probe = new WebSocket(relayUrl);
			await new Promise((resolve, reject) => {
				probe.once("open", resolve);
				probe.once("error", reject);
			});
			probe.close();
			return;
		} catch {
			if (relayProcess.exitCode !== null) throw new Error("Relay server exited before listening");
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	throw new Error("Relay server did not start in time");
});

test.after(async () => {
	if (!relayProcess || relayProcess.exitCode !== null) return;
	await new Promise((resolve) => {
		relayProcess.once("exit", resolve);
		relayProcess.kill();
		setTimeout(resolve, 1500).unref();
	});
});

test("routes a direct message and acknowledges delivery to the sender", async () => {
	const senderIdentity = `sender-${randomUUID()}`;
	const recipientIdentity = `recipient-${randomUUID()}`;
	const sender = await connectAndRegister(senderIdentity);
	const recipient = await connectAndRegister(recipientIdentity);
	try {
		const requestId = randomUUID();
		const incoming = onceMessage(recipient, (message) =>
			message.type === "direct_message" && message.requestId === requestId
		);
		const delivered = onceMessage(sender, (message) =>
			message.type === "ack" && message.correlationId === requestId
		);
		sender.send(JSON.stringify({
			type: "direct_message",
			requestId,
			from: senderIdentity,
			to: recipientIdentity,
			payload: "sealedbox.v1:opaque-test-payload",
			timestamp: new Date().toISOString(),
		}));

		const [routedMessage, acknowledgement] = await Promise.all([incoming, delivered]);
		assert.equal(routedMessage.payload, "sealedbox.v1:opaque-test-payload");
		assert.equal(acknowledgement.status, "delivered");
	} finally {
		sender.close();
		recipient.close();
	}
});