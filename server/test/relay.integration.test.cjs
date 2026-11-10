const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const WebSocket = require("ws");
const authentication = require("../dist/shared/relayAuthentication.js");
const { createIdentity } = require("../../test-support/relay.cjs");

let relayProcess;
let relayUrl;
let dataDir;
let senderIdentity;
let joinCode;

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

async function connectAndRegister(identity, code) {
	const socket = new WebSocket(relayUrl);
	await new Promise((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	const requestId = randomUUID();
	const challengeReceived = onceMessage(socket, (message) =>
		message.type === "relay_challenge" && message.correlationId === requestId
	);
	socket.send(JSON.stringify({
		type: "hello",
		requestId,
		from: identity.publicKey,
		signingKey: identity.signingPublicKey,
		message: "integration test",
		timestamp: new Date().toISOString(),
	}));
	const challenge = await challengeReceived;
	const acknowledgement = onceMessage(socket, (message) =>
		message.type === "ack" && message.correlationId === requestId
	);
	socket.send(JSON.stringify({
		type: "relay_authenticate",
		requestId,
		challengeId: challenge.challengeId,
		...identity.proveRelayChallenge(challenge, code),
		joinCode: code,
		timestamp: new Date().toISOString(),
	}));
	const response = await acknowledgement;
	assert.equal(response.status, "accepted");
	return socket;
}

test.before(async () => {
	const port = await getFreePort();
	relayUrl = `ws://127.0.0.1:${port}`;
	dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devchat-relay-test-"));
	senderIdentity = createIdentity(authentication);
	joinCode = authentication.generateJoinCode();
	const serverPath = path.join(__dirname, "../dist/server/src/server.js");
	relayProcess = spawn(process.execPath, [serverPath], {
		env: {
			...process.env, PORT: String(port), HEALTH_LOG_INTERVAL_MS: "60000", TLS_DISABLED: "true",
			DATA_DIR: dataDir, RELAY_ACCESS_FILE: path.join(dataDir, "relay-access.json"),
			RELAY_ADMIN_PUBLIC_KEY: senderIdentity.publicKey, RELAY_JOIN_CODE: joinCode,
		},
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
	if (relayProcess && relayProcess.exitCode === null) {
		await new Promise((resolve) => {
			relayProcess.once("exit", resolve);
			relayProcess.kill();
			setTimeout(resolve, 1500).unref();
		});
	}
	if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test("routes a direct message and acknowledges delivery to the sender", async () => {
	const recipientIdentity = createIdentity(authentication);
	const sender = await connectAndRegister(senderIdentity, "");
	const recipient = await connectAndRegister(recipientIdentity, joinCode);
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
			from: senderIdentity.publicKey,
			to: recipientIdentity.publicKey,
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