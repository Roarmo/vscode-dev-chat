const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WebSocketServer } = require("ws");

const { EncryptionService } = require(path.join(
	__dirname,
	"../dist/extension/src/encryption/encryptionService.js"
));
const { ContactStore } = require(path.join(
	__dirname,
	"../dist/extension/src/encryption/contactStore.js"
));
const { RelayClient } = require(path.join(
	__dirname,
	"../dist/extension/src/relay/relayClient.js"
));
const authentication = require(path.join(__dirname, "../dist/shared/relayAuthentication.js"));

let relayProcess;
let relayUrl;
let dataDir;
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

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForRelay() {
	const deadline = Date.now() + 5000;
	let output = "";
	while (Date.now() < deadline) {
		if (relayProcess.exitCode !== null) {
			throw new Error(`Relay exited during startup. ${output}`);
		}
		try {
			const WebSocket = require("ws");
			await new Promise((resolve, reject) => {
				const socket = new WebSocket(relayUrl);
				const timeout = setTimeout(() => {
					socket.terminate();
					reject(new Error("Relay startup timed out"));
				}, 300);
				socket.once("open", () => {
					clearTimeout(timeout);
					socket.close();
					resolve();
				});
				socket.once("error", (error) => {
					clearTimeout(timeout);
					reject(error);
				});
			});
			return;
		} catch {
			await delay(50);
		}
	}
	throw new Error(`Relay did not start in time. ${output}`);
}

function waitForState(client, expectedState) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			dispose();
			reject(new Error(`Timed out waiting for relay state: ${expectedState}`));
		}, 5000);
		const dispose = client.onStatusChange((state) => {
			if (state === expectedState) {
				clearTimeout(timeout);
				dispose();
				resolve();
			} else if (state === "error") {
				clearTimeout(timeout);
				dispose();
				reject(new Error("Relay client entered error state"));
			}
		});
	});
}

function waitForMessage(client, predicate) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			dispose();
			reject(new Error("Timed out waiting for relay message"));
		}, 5000);
		const dispose = client.onMessage((message) => {
			if (!predicate(message)) return;
			clearTimeout(timeout);
			dispose();
			resolve(message);
		});
	});
}

test.before(async () => {
	const port = await getFreePort();
	relayUrl = `ws://127.0.0.1:${port}`;
	dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devchat-relay-test-"));
	joinCode = authentication.generateJoinCode();
	const administrator = await EncryptionService.load({ secrets: createSecrets() });
	const serverPath = path.join(__dirname, "../../server/dist/server/src/server.js");
	relayProcess = spawn(process.execPath, [serverPath], {
		env: {
			...process.env, PORT: String(port), HEALTH_LOG_INTERVAL_MS: "60000", TLS_DISABLED: "true",
			DATA_DIR: dataDir, RELAY_ACCESS_FILE: path.join(dataDir, "relay-access.json"),
			RELAY_ADMIN_PUBLIC_KEY: administrator.publicKey, RELAY_JOIN_CODE: joinCode,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	relayProcess.stdout.on("data", (chunk) => { output += chunk.toString(); });
	relayProcess.stderr.on("data", (chunk) => { output += chunk.toString(); });
	try {
		await waitForRelay();
	} catch (error) {
		throw new Error(`${error.message}\n${output}`);
	}
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

test("signed encrypted message to a saved contact round trips through relay and verifies", async () => {
	const senderEncryption = await EncryptionService.load({ secrets: createSecrets() });
	const recipientEncryption = await EncryptionService.load({ secrets: createSecrets() });
	const stored = new Map();
	const state = {
		get: (key) => stored.get(key),
		update: async (key, value) => stored.set(key, value),
	};
	await new ContactStore(state).save("Recipient", recipientEncryption.publicKey, undefined);
	const selectedRecipient = new ContactStore(state).list()[0].publicKey;
	assert.equal(selectedRecipient, recipientEncryption.publicKey);
	const sender = new RelayClient(relayUrl);
	const recipient = new RelayClient(relayUrl);
	const clients = [sender, recipient];
	try {
		const senderConnected = waitForState(sender, "connected");
		const recipientConnected = waitForState(recipient, "connected");
		sender.setJoinCode(relayUrl, joinCode);
		recipient.setJoinCode(relayUrl, joinCode);
		sender.connect(senderEncryption);
		recipient.connect(recipientEncryption);
		await Promise.all([senderConnected, recipientConnected]);

		const requestId = randomUUID();
		const text = "secret integration message";
		const ciphertext = senderEncryption.seal(text, selectedRecipient, requestId);
		const received = waitForMessage(recipient, (message) =>
			message.type === "direct_message" && message.requestId === requestId
		);
		const acknowledged = waitForMessage(sender, (message) =>
			message.type === "ack" && message.correlationId === requestId && message.status === "delivered"
		);

		assert.equal(ciphertext.includes(text), false);
		assert.equal(sender.sendDirectMessage(selectedRecipient, ciphertext, requestId), true);

		const [incoming] = await Promise.all([received, acknowledged]);
		assert.equal(incoming.payload, ciphertext);
		assert.equal(incoming.payload.includes(text), false);
		const envelope = recipientEncryption.verify(incoming);
		assert.equal(envelope.signingKey, senderEncryption.signingPublicKey);
		assert.equal(recipientEncryption.open(envelope), text);
	} finally {
		for (const client of clients) client.close();
	}
});

test("retries after a protocol error and fails pending sends on disconnect", async () => {
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await new Promise((resolve) => server.once("listening", resolve));
	const client = new RelayClient(`ws://127.0.0.1:${server.address().port}`);
	const identity = await EncryptionService.load({ secrets: createSecrets() });
	let currentSocket;
	server.on("connection", (socket) => {
		currentSocket = socket;
		let pending;
		let hello;
		socket.on("message", (data) => {
			const message = JSON.parse(data.toString());
			if (message.type === "hello") {
				hello = message;
				pending = authentication.createRelayChallenge(message.requestId, message.from, "loopback:test");
				socket.send(JSON.stringify(pending.challenge));
			} else if (message.type === "relay_authenticate") {
				assert.equal(authentication.verifyRelayProof(
					pending, hello.from, hello.signingKey, message.joinCode, message.proof, message.signature
				), true);
				pending.sharedSecret.fill(0);
				socket.send(JSON.stringify({
					type: "ack",
					messageId: "hello",
					correlationId: message.requestId,
					status: "accepted",
					timestamp: new Date().toISOString(),
				}));
			} else if (message.type === "direct_message" && message.payload !== "unconfirmed") {
				socket.terminate();
			}
		});
	});
	try {
		const connected = waitForState(client, "connected");
		client.connect(identity);
		await connected;

		const errored = waitForState(client, "error");
		currentSocket.send("not valid JSON");
		await errored;
		const reconnected = waitForState(client, "connected");
		client.connect(identity);
		await reconnected;

		const unconfirmedId = randomUUID();
		const unconfirmed = waitForMessage(client, (message) =>
			message.type === "error" && message.correlationId === unconfirmedId
		);
		const originalSetTimeout = global.setTimeout;
		let acknowledgementTimeout;
		try {
			global.setTimeout = (callback, milliseconds, ...args) => {
				if (milliseconds === 15000) acknowledgementTimeout = callback;
				return originalSetTimeout(callback, milliseconds, ...args);
			};
			assert.equal(client.sendDirectMessage("recipient", "unconfirmed", unconfirmedId), true);
		} finally {
			global.setTimeout = originalSetTimeout;
		}
		assert.equal(typeof acknowledgementTimeout, "function");
		acknowledgementTimeout();
		assert.match((await unconfirmed).message, /could not be confirmed/i);

		const requestId = randomUUID();
		const failed = waitForMessage(client, (message) =>
			message.type === "error" && message.correlationId === requestId
		);
		assert.equal(client.sendDirectMessage("recipient", "ciphertext", requestId), true);
		assert.match((await failed).message, /Connection lost/);
	} finally {
		client.close();
		for (const socket of server.clients) socket.terminate();
		await new Promise((resolve) => server.close(resolve));
	}
});

test("reports invalid relay URLs as connection errors", async () => {
	const client = new RelayClient("invalid relay url");
	const identity = await EncryptionService.load({ secrets: createSecrets() });
	const states = [];
	client.onStatusChange((state) => states.push(state));
	assert.doesNotThrow(() => client.connect(identity));
	assert.deepEqual(states, ["connecting", "error"]);
	client.close();
});

function createSecrets() {
	const values = new Map();
	return {
		get: async (key) => values.get(key),
		store: async (key, value) => values.set(key, value),
	};
}