const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createHash, X509Certificate } = require("node:crypto");
const fs = require("node:fs");
const { createServer: createHttpsServer } = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WebSocketServer } = require("ws");
const { generate } = require("selfsigned");

const dist = path.join(__dirname, "..", "dist");
const { RelayClient } = require(path.join(dist, "extension/src/relay/relayClient.js"));
const { HostRelayCertificateStore, HOST_RELAY_CERTIFICATE_STATE_KEY, HOST_RELAY_PRIVATE_KEY_SECRET_KEY } =
	require(path.join(dist, "extension/src/relay/hostRelayCertificate.js"));
const { startRelayServer } = require(path.join(dist, "shared/relayServer.js"));
const { isLoopbackHost } = require(path.join(dist, "shared/networkAddress.js"));
const {
	generateRelayCertificate,
	getCertificateFingerprint,
	normalizeFingerprint,
	fingerprintsMatch,
	assertValidRelayCredentials,
} = require(path.join(dist, "shared/relayCertificate.js"));

const serverPath = path.join(__dirname, "../../server/dist/server/src/server.js");
const silentLogger = { info() {}, error() {} };

let certificate;
let otherCertificate;
test.before(async () => {
	[certificate, otherCertificate] = await Promise.all([generateRelayCertificate(), generateRelayCertificate()]);
});

function waitForState(client, state) {
	if (client.state === state) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${state} (state ${client.state})`)), 5000);
		const stop = client.onStatusChange((next) => {
			if (next !== state) return;
			clearTimeout(timeout);
			stop();
			resolve();
		});
	});
}

async function connectAndWait(url, expected, options) {
	const client = new RelayClient(url, undefined, options);
	const errors = [];
	client.onConnectionError((error) => errors.push(error));
	const reached = waitForState(client, expected);
	client.connect(`identity-${Math.random()}`);
	await reached;
	return { client, errors };
}

function pinnedUrl(port, fingerprint) {
	return `wss://127.0.0.1:${port}#sha256=${fingerprint}`;
}

test("computes and compares SHA-256 certificate fingerprints", () => {
	const der = new X509Certificate(certificate.cert).raw;
	const expected = createHash("sha256").update(der).digest("hex").toUpperCase().match(/../g).join(":");
	assert.equal(certificate.fingerprint, expected);
	assert.equal(getCertificateFingerprint(certificate.cert), expected);

	assert.equal(normalizeFingerprint(expected.replace(/:/g, "").toLowerCase()), expected);
	assert.equal(normalizeFingerprint(` ${expected.replace(/:/g, " ")} `), expected);
	assert.equal(normalizeFingerprint("AB:CD"), undefined);
	assert.equal(normalizeFingerprint(`${expected.slice(0, -2)}ZZ`), undefined);

	assert.equal(fingerprintsMatch(expected, expected.replace(/:/g, "").toLowerCase()), true);
	assert.equal(fingerprintsMatch(expected, otherCertificate.fingerprint), false);
	assert.equal(fingerprintsMatch("not a fingerprint", "not a fingerprint"), false);
});

test("validates that a certificate and private key belong together", () => {
	assert.doesNotThrow(() => assertValidRelayCredentials(certificate));
	assert.throws(
		() => assertValidRelayCredentials({ cert: certificate.cert, key: otherCertificate.key }),
		/does not match/
	);
});

test("classifies loopback hosts", () => {
	for (const host of ["localhost", "LocalHost.", "127.0.0.1", "127.255.0.9", "::1", "[::1]", "::ffff:127.0.0.1", "[::ffff:7f00:1]"]) {
		assert.equal(isLoopbackHost(host), true, host);
	}
	for (const host of ["192.168.1.20", "10.0.0.1", "::ffff:192.168.1.20", "fe80::1", "::", "0.0.0.0", "example.com", "localhost.example.com", ""]) {
		assert.equal(isLoopbackHost(host), false, host);
	}
});

test("connects over wss:// when the pinned fingerprint matches", async () => {
	const relay = await startRelayServer({ port: 0, host: "127.0.0.1", logger: silentLogger, tls: certificate });
	try {
		const { client, errors } = await connectAndWait(pinnedUrl(relay.port, certificate.fingerprint), "connected");
		assert.deepEqual(errors, []);
		assert.equal(relay.connectionCount(), 1);
		client.close();
	} finally {
		await relay.close();
	}
});

test("refuses a relay whose certificate does not match the pin, before sending anything", async () => {
	const received = [];
	const httpsServer = createHttpsServer({ cert: otherCertificate.cert, key: otherCertificate.key });
	const wss = new WebSocketServer({ server: httpsServer });
	wss.on("connection", (socket) => socket.on("message", (data) => received.push(data.toString())));
	await new Promise((resolve) => httpsServer.listen(0, "127.0.0.1", resolve));
	const port = httpsServer.address().port;
	try {
		const { client, errors } = await connectAndWait(pinnedUrl(port, certificate.fingerprint), "error");
		assert.equal(errors.length, 1);
		assert.equal(errors[0].code, "CERTIFICATE_MISMATCH");
		assert.match(errors[0].message, new RegExp(otherCertificate.fingerprint));
		assert.equal(client.lastError.code, "CERTIFICATE_MISMATCH");

		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.deepEqual(received, [], "no data may reach a relay with the wrong certificate");
		client.close();
	} finally {
		for (const socket of wss.clients) socket.terminate();
		await new Promise((resolve) => wss.close(resolve));
		await new Promise((resolve) => httpsServer.close(resolve));
	}
});

test("refuses an untrusted self-signed certificate when no fingerprint is pinned", async () => {
	const relay = await startRelayServer({ port: 0, host: "127.0.0.1", logger: silentLogger, tls: certificate });
	try {
		const { client, errors } = await connectAndWait(`wss://127.0.0.1:${relay.port}`, "error");
		assert.equal(errors[0].code, "CERTIFICATE_UNTRUSTED");
		assert.match(errors[0].message, /#sha256=/);
		assert.equal(relay.connectionCount(), 0);
		client.close();
	} finally {
		await relay.close();
	}
});

test("connects to a CA-signed relay without a pin when the CA is trusted", async () => {
	const ca = await generate([{ name: "commonName", value: "Dev Chat Test CA" }], {
		keyType: "ec",
		algorithm: "sha256",
		extensions: [
			{ name: "basicConstraints", cA: true, critical: true },
			{ name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
		],
	});
	const leaf = await generate([{ name: "commonName", value: "127.0.0.1" }], {
		keyType: "ec",
		algorithm: "sha256",
		ca: { key: ca.private, cert: ca.cert },
		extensions: [
			{ name: "basicConstraints", cA: false },
			{ name: "keyUsage", digitalSignature: true, critical: true },
			{ name: "extKeyUsage", serverAuth: true },
			{ name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
		],
	});

	const relay = await startRelayServer({
		port: 0,
		host: "127.0.0.1",
		logger: silentLogger,
		tls: { cert: leaf.cert, key: leaf.private },
	});
	try {
		const trusted = await connectAndWait(`wss://127.0.0.1:${relay.port}`, "connected", { ca: ca.cert });
		assert.deepEqual(trusted.errors, []);
		trusted.client.close();

		const untrusted = await connectAndWait(`wss://127.0.0.1:${relay.port}`, "error");
		assert.equal(untrusted.errors[0].code, "CERTIFICATE_UNTRUSTED");
		untrusted.client.close();
	} finally {
		await relay.close();
	}
});

test("connects to a loopback relay over plain ws://", async () => {
	const relay = await startRelayServer({ port: 0, host: "127.0.0.1", logger: silentLogger });
	try {
		const { client } = await connectAndWait(`ws://127.0.0.1:${relay.port}`, "connected");
		client.close();
	} finally {
		await relay.close();
	}
});

function getFreePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

async function startStandaloneRelay(dataDir, extraArgs = [], env = {}) {
	const port = await getFreePort();
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [serverPath, ...extraArgs], {
			env: { ...process.env, PORT: String(port), HEALTH_LOG_INTERVAL_MS: "60000", DATA_DIR: dataDir, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		const timeout = setTimeout(() => {
			child.kill();
			reject(new Error(`Relay did not start:\n${output}`));
		}, 15000);
		const onData = (chunk) => {
			output += chunk.toString();
			const match = /This machine:\s+(wss:\/\/127\.0\.0\.1:(\d+)#sha256=([0-9A-F:]+))/.exec(output);
			if (!match) return;
			clearTimeout(timeout);
			resolve({ child, url: match[1], port: Number(match[2]), fingerprint: match[3], output: () => output });
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.once("exit", (code) => {
			clearTimeout(timeout);
			reject(new Error(`Relay exited with code ${code}:\n${output}`));
		});
	});
}

function stopStandaloneRelay(relay) {
	if (relay.child.exitCode !== null) return Promise.resolve();
	return new Promise((resolve) => {
		relay.child.removeAllListeners("exit");
		relay.child.once("exit", resolve);
		relay.child.kill();
		setTimeout(resolve, 2000).unref();
	});
}

test("standalone relay keeps its certificate across restarts and regenerates it on request", async () => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devchat-relay-"));
	try {
		const first = await startStandaloneRelay(dataDir);
		try {
			const { client } = await connectAndWait(first.url, "connected");
			client.close();
		} finally {
			await stopStandaloneRelay(first);
		}

		const keyPath = path.join(dataDir, "relay-key.pem");
		assert.ok(fs.existsSync(path.join(dataDir, "relay-cert.pem")));
		assert.ok(fs.existsSync(keyPath));
		if (process.platform !== "win32") {
			assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
		}

		const restarted = await startStandaloneRelay(dataDir);
		try {
			assert.equal(restarted.fingerprint, first.fingerprint, "fingerprint must survive a restart");
			const { client } = await connectAndWait(pinnedUrl(restarted.port, first.fingerprint), "connected");
			client.close();
		} finally {
			await stopStandaloneRelay(restarted);
		}

		const regenerated = await startStandaloneRelay(dataDir, ["--regenerate-certificate"]);
		try {
			assert.notEqual(regenerated.fingerprint, first.fingerprint);
			const stale = await connectAndWait(pinnedUrl(regenerated.port, first.fingerprint), "error");
			assert.equal(stale.errors[0].code, "CERTIFICATE_MISMATCH");
			stale.client.close();

			const { client } = await connectAndWait(regenerated.url, "connected");
			client.close();
		} finally {
			await stopStandaloneRelay(regenerated);
		}
	} finally {
		fs.rmSync(dataDir, { recursive: true, force: true });
	}
});

test("standalone relay serves a certificate supplied with TLS_CERT_FILE and TLS_KEY_FILE", async () => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devchat-relay-"));
	try {
		const certFile = path.join(dataDir, "provided-cert.pem");
		const keyFile = path.join(dataDir, "provided-key.pem");
		fs.writeFileSync(certFile, otherCertificate.cert);
		fs.writeFileSync(keyFile, otherCertificate.key);

		const relay = await startStandaloneRelay(dataDir, [], { TLS_CERT_FILE: certFile, TLS_KEY_FILE: keyFile });
		try {
			assert.equal(relay.fingerprint, otherCertificate.fingerprint);
			assert.equal(fs.existsSync(path.join(dataDir, "relay-key.pem")), false);
			const { client } = await connectAndWait(relay.url, "connected");
			client.close();
		} finally {
			await stopStandaloneRelay(relay);
		}
	} finally {
		fs.rmSync(dataDir, { recursive: true, force: true });
	}
});

function createStorage() {
	const state = new Map();
	const secrets = new Map();
	return {
		state,
		secrets,
		stateStorage: { get: (key) => state.get(key), update: async (key, value) => void state.set(key, value) },
		secretStorage: { get: async (key) => secrets.get(key), store: async (key, value) => void secrets.set(key, value) },
	};
}

test("host relay certificate store persists, reloads and regenerates the certificate", async () => {
	const storage = createStorage();
	const warnings = [];
	const store = new HostRelayCertificateStore(storage.stateStorage, storage.secretStorage, undefined, (w) => warnings.push(w));

	const created = await store.load();
	assert.equal(storage.state.get(HOST_RELAY_CERTIFICATE_STATE_KEY), created.cert);
	assert.equal(storage.secrets.get(HOST_RELAY_PRIVATE_KEY_SECRET_KEY), created.key);
	assert.equal(created.cert.includes("PRIVATE KEY"), false, "the private key must not be stored with the certificate");

	const reloaded = await new HostRelayCertificateStore(storage.stateStorage, storage.secretStorage).load();
	assert.deepEqual(reloaded, created);

	const regenerated = await store.regenerate();
	assert.notEqual(getCertificateFingerprint(regenerated.cert), getCertificateFingerprint(created.cert));
	assert.equal(storage.state.get(HOST_RELAY_CERTIFICATE_STATE_KEY), regenerated.cert);

	storage.secrets.set(HOST_RELAY_PRIVATE_KEY_SECRET_KEY, otherCertificate.key);
	const repaired = await store.load();
	assert.notEqual(repaired.cert, regenerated.cert);
	assert.doesNotThrow(() => assertValidRelayCredentials(repaired));
	assert.equal(warnings.length, 1);
	assert.deepEqual(warnings.filter((w) => w.includes("PRIVATE KEY")), []);
});
