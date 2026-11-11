const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dist = path.join(__dirname, "..", "dist");
const { RelayClient } = require(path.join(dist, "extension", "src", "relay", "relayClient.js"));
const { HostedRelay } = require(path.join(dist, "extension", "src", "relay", "hostedRelay.js"));
const { formatPinnedRelayUrl } = require(path.join(dist, "extension", "src", "relay", "relaySettings.js"));
const { startRelayServer } = require(path.join(dist, "shared", "relayServer.js"));
const { generateRelayCertificate } = require(path.join(dist, "shared", "relayCertificate.js"));
const authentication = require(path.join(dist, "shared", "relayAuthentication.js"));
const { createIdentity, accessOptions } = require(path.join(__dirname, "..", "..", "test-support", "relay.cjs"));

const silentLogger = { info() {}, error() {} };

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForState(client, expected) {
	if (client.state === expected) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			stop();
			reject(new Error(`Timed out waiting for ${expected}; got ${client.state}`));
		}, 20_000);
		const stop = client.onStatusChange((state) => {
			if (state !== expected && state !== "error") return;
			clearTimeout(timeout);
			stop();
			if (state === expected) resolve();
			else reject(new Error(`Client connection failed: ${client.lastError?.message}`));
		});
	});
}

function waitForUnavailable(client) {
	if (client.state === "disconnected" || client.state === "error") return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			stop();
			reject(new Error(`Client did not disconnect; got ${client.state}`));
		}, 10_000);
		const stop = client.onStatusChange((state) => {
			if (state !== "disconnected" && state !== "error") return;
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
			reject(new Error("Timed out waiting for a relay message."));
		}, 10_000);
		const stop = client.onMessage((message) => {
			if (!predicate(message)) return;
			clearTimeout(timeout);
			stop();
			resolve(message);
		});
	});
}

async function unusedPort() {
	const listener = net.createServer();
	await new Promise((resolve, reject) => {
		listener.once("error", reject);
		listener.listen(0, "127.0.0.1", resolve);
	});
	const port = listener.address().port;
	await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
	return port;
}

async function createResponseGate(port) {
	let droppingResponses = false;
	const sockets = new Set();
	const listener = net.createServer((client) => {
		const upstream = net.createConnection(port, "127.0.0.1");
		sockets.add(client);
		sockets.add(upstream);
		client.pipe(upstream);
		upstream.on("data", (chunk) => {
			if (!droppingResponses && !client.destroyed) client.write(chunk);
		});
		upstream.on("end", () => client.end());
		upstream.on("error", () => client.destroy());
		client.on("error", () => upstream.destroy());
		upstream.on("close", () => {
			sockets.delete(upstream);
			client.destroy();
		});
		client.on("close", () => {
			sockets.delete(client);
			upstream.destroy();
		});
	});
	await new Promise((resolve, reject) => {
		listener.once("error", reject);
		listener.listen(0, "127.0.0.1", resolve);
	});
	return {
		port: listener.address().port,
		dropResponses: (drop) => { droppingResponses = drop; },
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
		},
	};
}

function requestReadiness(port) {
	return new Promise((resolve, reject) => {
		const request = https.get({
			hostname: "127.0.0.1",
			port,
			path: "/health",
			rejectUnauthorized: false,
			timeout: 1000,
		}, (response) => {
			let body = "";
			response.on("data", (chunk) => { body += chunk; });
			response.on("end", () => {
				try {
					resolve(response.statusCode === 200 && JSON.parse(body).readiness === "ready");
				} catch (error) {
					reject(error);
				}
			});
		});
		request.on("timeout", () => request.destroy(new Error("Health check timed out.")));
		request.on("error", reject);
	});
}

async function hostedFixture(t, admin, joinCode, certificate) {
	const access = accessOptions(admin, joinCode);
	const hosted = new HostedRelay(
		silentLogger,
		(options) => startRelayServer({ ...options, host: "127.0.0.1" }),
		() => []
	);
	const info = await hosted.start(0, certificate, access);
	t.after(() => hosted.stop());
	return {
		port: info.port,
		start: () => hosted.start(info.port, certificate, access),
		stop: () => hosted.stop(),
		count: () => hosted.connectionCount,
	};
}

async function standaloneFixture(t, admin, joinCode, certificate) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "devchat-recovery-"));
	const certFile = path.join(directory, "test-cert.pem");
	const keyFile = path.join(directory, "test-key.pem");
	await fs.writeFile(certFile, certificate.cert);
	await fs.writeFile(keyFile, certificate.key, { mode: 0o600 });
	const port = await unusedPort();
	const serverPath = path.join(__dirname, "..", "..", "server", "dist", "server", "src", "server.js");
	let child;
	let output = "";

	async function stop() {
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		const current = child;
		const exited = new Promise((resolve) => current.once("exit", resolve));
		if (!current.kill("SIGTERM")) throw new Error("Could not stop the standalone test relay.");
		let timer;
		try {
			await Promise.race([
				exited,
				new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error("Standalone relay did not stop.")), 10_000);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	async function start() {
		output = "";
		child = spawn(process.execPath, [serverPath], {
			cwd: directory,
			env: {
				...process.env,
				PORT: String(port),
				HOST: "127.0.0.1",
				DATA_DIR: path.join(directory, "data"),
				RELAY_ACCESS_FILE: path.join(directory, "data", "relay-access.json"),
				RELAY_ADMIN_PUBLIC_KEY: admin.publicKey,
				RELAY_JOIN_CODE: joinCode,
				TLS_DISABLED: "false",
				TLS_CERT_FILE: certFile,
				TLS_KEY_FILE: keyFile,
				ALLOW_NON_LOCAL_CONNECTIONS: "false",
				HEALTH_LOG_INTERVAL_MS: "60000",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout.on("data", (chunk) => { output += chunk.toString(); });
		child.stderr.on("data", (chunk) => { output += chunk.toString(); });
		const deadline = Date.now() + 20_000;
		let lastError;
		while (Date.now() < deadline) {
			if (child.exitCode !== null || child.signalCode !== null) {
				throw new Error(`Standalone relay exited during startup: ${output}`);
			}
			try {
				if (await requestReadiness(port)) return;
			} catch (error) {
				lastError = error;
			}
			await delay(50);
		}
		throw new Error(`Standalone relay did not become ready: ${lastError?.message}\n${output}`);
	}

	t.after(async () => {
		try {
			await stop();
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
	await start();
	return { port, start, stop };
}

for (const mode of ["hosted", "standalone"]) {
	test(`${mode} relay recovers after shutdown during active client traffic`, { timeout: 60_000 }, async (t) => {
		const admin = createIdentity(authentication);
		const recipient = createIdentity(authentication);
		const joinCode = authentication.generateJoinCode();
		const certificate = await generateRelayCertificate();
		const relay = mode === "hosted"
			? await hostedFixture(t, admin, joinCode, certificate)
			: await standaloneFixture(t, admin, joinCode, certificate);
		const gate = await createResponseGate(relay.port);
		t.after(() => gate.close());
		const senderUrl = formatPinnedRelayUrl("127.0.0.1", gate.port, certificate.fingerprint);
		const recipientUrl = formatPinnedRelayUrl("127.0.0.1", relay.port, certificate.fingerprint);
		const sender = new RelayClient(senderUrl);
		const receiver = new RelayClient(recipientUrl);
		t.after(() => {
			sender.close();
			receiver.close();
		});

		receiver.setJoinCode(recipientUrl, joinCode);
		const senderReady = waitForState(sender, "connected");
		const receiverReady = waitForState(receiver, "connected");
		sender.connect(admin);
		receiver.connect(recipient);
		await Promise.all([senderReady, receiverReady]);
		if (relay.count) assert.equal(relay.count(), 2);

		gate.dropResponses(true);
		const requestId = randomUUID();
		const received = waitForMessage(receiver, (message) =>
			message.type === "direct_message" && message.requestId === requestId
		);
		const unconfirmed = waitForMessage(sender, (message) =>
			message.type === "error" && message.correlationId === requestId
		);
		const senderDown = waitForUnavailable(sender);
		const receiverDown = waitForUnavailable(receiver);
		assert.equal(sender.sendDirectMessage(recipient.publicKey, "opaque-before-shutdown", requestId), true);
		assert.equal((await received).payload, "opaque-before-shutdown");
		await relay.stop();
		const pending = await unconfirmed;
		assert.equal(pending.code, "DELIVERY_UNKNOWN");
		assert.match(pending.message, /may still receive/i);
		await Promise.all([senderDown, receiverDown]);
		if (relay.count) assert.equal(relay.count(), 0);

		await relay.start();
		await delay(200);
		assert.notEqual(sender.state, "connected");
		assert.notEqual(receiver.state, "connected");
		gate.dropResponses(false);
		const senderReconnected = waitForState(sender, "connected");
		const receiverReconnected = waitForState(receiver, "connected");
		sender.connect(admin);
		receiver.connect(recipient);
		await Promise.all([senderReconnected, receiverReconnected]);
		if (relay.count) assert.equal(relay.count(), 2);

		const recoveredId = randomUUID();
		const delivered = waitForMessage(receiver, (message) =>
			message.type === "direct_message" && message.requestId === recoveredId
		);
		const acknowledged = waitForMessage(sender, (message) =>
			message.type === "ack" && message.correlationId === recoveredId
		);
		assert.equal(sender.sendDirectMessage(recipient.publicKey, "opaque-after-restart", recoveredId), true);
		assert.equal((await delivered).payload, "opaque-after-restart");
		assert.equal((await acknowledged).status, "delivered");
	});
}
