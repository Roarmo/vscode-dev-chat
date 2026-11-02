const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");

const { EncryptionService } = require(path.join(
	__dirname,
	"../dist/extension/src/encryption/encryptionService.js"
));
const { RelayClient } = require(path.join(
	__dirname,
	"../dist/extension/src/relay/relayClient.js"
));

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
	const serverPath = path.join(__dirname, "../../server/dist/server/src/server.js");
	relayProcess = spawn(process.execPath, [serverPath], {
		env: { ...process.env, PORT: String(port), HEALTH_LOG_INTERVAL_MS: "60000" },
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
	if (!relayProcess || relayProcess.exitCode !== null) return;
	await new Promise((resolve) => {
		relayProcess.once("exit", resolve);
		relayProcess.kill();
		setTimeout(resolve, 1500).unref();
	});
});

test("encrypted message round trips through relay without exposing plaintext", async () => {
	const senderEncryption = await EncryptionService.load({ secrets: createSecrets() });
	const recipientEncryption = await EncryptionService.load({ secrets: createSecrets() });
	const sender = new RelayClient(relayUrl);
	const recipient = new RelayClient(relayUrl);
	const clients = [sender, recipient];
	try {
		const senderConnected = waitForState(sender, "connected");
		const recipientConnected = waitForState(recipient, "connected");
		sender.connect(senderEncryption.publicKey);
		recipient.connect(recipientEncryption.publicKey);
		await Promise.all([senderConnected, recipientConnected]);

		const requestId = randomUUID();
		const text = "secret integration message";
		const ciphertext = senderEncryption.encrypt(text, recipientEncryption.publicKey);
		const received = waitForMessage(recipient, (message) =>
			message.type === "direct_message" && message.requestId === requestId
		);
		const acknowledged = waitForMessage(sender, (message) =>
			message.type === "ack" && message.correlationId === requestId && message.status === "delivered"
		);

		assert.equal(ciphertext.includes(text), false);
		assert.equal(sender.sendDirectMessage(recipientEncryption.publicKey, ciphertext, requestId), true);

		const [incoming] = await Promise.all([received, acknowledged]);
		assert.equal(incoming.payload, ciphertext);
		assert.equal(incoming.payload.includes(text), false);
		assert.equal(recipientEncryption.decrypt(incoming.payload), text);
	} finally {
		for (const client of clients) client.close();
	}
});

function createSecrets() {
	const values = new Map();
	return {
		get: async (key) => values.get(key),
		store: async (key, value) => values.set(key, value),
	};
}