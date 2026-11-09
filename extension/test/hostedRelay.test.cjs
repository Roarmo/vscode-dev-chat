const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const dist = path.join(__dirname, "..", "dist");
const { validateRelayUrl, validateHostRelayPort, formatPinnedRelayUrl } = require(path.join(dist, "extension/src/relay/relaySettings.js"));
const { HostedRelay } = require(path.join(dist, "extension/src/relay/hostedRelay.js"));
const { RelayClient } = require(path.join(dist, "extension/src/relay/relayClient.js"));
const { startRelayServer } = require(path.join(dist, "shared/relayServer.js"));
const { generateRelayCertificate } = require(path.join(dist, "shared/relayCertificate.js"));
const authentication = require(path.join(dist, "shared/relayAuthentication.js"));
const { createIdentity, accessOptions } = require(path.join(__dirname, "..", "..", "test-support", "relay.cjs"));

let certificate;
let identity;
test.before(async () => {
	certificate = await generateRelayCertificate();
	identity = createIdentity(authentication);
});

const silentLogger = { info() {}, error() {} };

function waitForState(client, state) {
	if (client.state === state) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${state}`)), 5000);
		const stop = client.onStatusChange((next) => {
			if (next !== state) return;
			clearTimeout(timeout);
			stop();
			resolve();
		});
	});
}

const PIN = "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";

test("validates relay URLs", () => {
	assert.deepEqual(validateRelayUrl("ws://127.0.0.1:8787"), {
		ok: true, url: "ws://127.0.0.1:8787", connectUrl: "ws://127.0.0.1:8787", secure: false,
	});
	assert.deepEqual(validateRelayUrl(" wss://relay.example.com/ "), {
		ok: true, url: "wss://relay.example.com", connectUrl: "wss://relay.example.com", secure: true,
	});

	for (const value of ["", "   ", undefined, 42, "http://127.0.0.1:8787", "not a url", "wss://user:pass@127.0.0.1:8787"]) {
		const result = validateRelayUrl(value);
		assert.equal(result.ok, false, String(value));
		assert.equal(result.code, "INVALID_URL", String(value));
	}
});

test("does not include possible credentials in URL errors or connection logs", async () => {
	const code = authentication.generateJoinCode();
	const invalid = validateRelayUrl(`not a URL ${code}`);
	assert.equal(invalid.ok, false);
	assert.equal(invalid.error.includes(code), false);

	const logs = [];
	const logger = { info: (message) => logs.push(message), error: (message) => logs.push(message) };
	const client = new RelayClient("ws://127.0.0.1:1", logger);
	try {
		client.setUrl(`wss://127.0.0.1:1/path?token=${code}`);
		const failed = waitForState(client, "error");
		client.connect(identity);
		await failed;
		assert.equal(logs.join("\n").includes(code), false);
	} finally {
		client.close();
	}
});

test("parses and normalizes a pinned certificate fingerprint", () => {
	const compact = PIN.replace(/:/g, "").toLowerCase();
	const result = validateRelayUrl(`wss://192.168.1.20:8787/#sha256=${compact}`);
	assert.equal(result.ok, true);
	assert.equal(result.fingerprint, PIN);
	assert.equal(result.connectUrl, "wss://192.168.1.20:8787");
	assert.equal(result.url, `wss://192.168.1.20:8787#sha256=${PIN}`);
	assert.equal(formatPinnedRelayUrl("192.168.1.20", 8787, PIN), result.url);
	assert.equal(formatPinnedRelayUrl("fe80::1", 8787, PIN), `wss://[fe80::1]:8787#sha256=${PIN}`);

	for (const fragment of ["#sha256=", "#sha256=ABCD", `#sha1=${PIN}`, "#nonsense", `#sha256=${PIN}:00`, "#sha256=%E0%A4%A"]) {
		assert.equal(validateRelayUrl(`wss://192.168.1.20:8787${fragment}`).ok, false, fragment);
	}
	assert.equal(validateRelayUrl(`ws://127.0.0.1:8787#sha256=${PIN}`).ok, false);
});

test("allows unencrypted ws:// only for loopback relays", () => {
	for (const url of [
		"ws://127.0.0.1:8787",
		"ws://127.8.9.10:8787",
		"ws://localhost:8787",
		"ws://LOCALHOST.:8787",
		"ws://[::1]:8787",
		"ws://[::ffff:127.0.0.1]:8787",
	]) {
		assert.equal(validateRelayUrl(url).ok, true, url);
	}
	for (const url of [
		"ws://192.168.1.20:8787",
		"ws://10.0.0.5:8787",
		"ws://[fe80::1]:8787",
		"ws://[::ffff:192.168.1.20]:8787",
		"ws://relay.example.com:8787",
		"ws://localhost.example.com:8787",
		"ws://128.0.0.1:8787",
	]) {
		const result = validateRelayUrl(url);
		assert.equal(result.ok, false, url);
		assert.equal(result.code, "INSECURE_URL", url);
		assert.match(result.error, /wss:\/\//);
	}
});

test("refuses to connect to a non-loopback ws:// relay", () => {
	const client = new RelayClient("ws://192.168.1.20:8787");
	const errors = [];
	client.onConnectionError((error) => errors.push(error));
	client.connect(identity);
	assert.equal(client.state, "error");
	assert.equal(errors.length, 1);
	assert.equal(errors[0].code, "INSECURE_URL");
	assert.equal(client.lastError.code, "INSECURE_URL");
	client.close();
});

test("refuses to prepare an invitation code for an unpinned remote TLS connection", () => {
	const client = new RelayClient("wss://relay.example.test:8787");
	const code = authentication.generateJoinCode();
	assert.throws(() => client.setJoinCode(client.url, code), /pinned TLS/i);
	assert.doesNotThrow(() => client.setJoinCode("ws://127.0.0.1:8787", code));
	client.close();
});

test("validates host relay ports", () => {
	assert.equal(validateHostRelayPort(8787), 8787);
	for (const value of [0, 65536, 80.5, "8787", undefined]) {
		assert.equal(validateHostRelayPort(value), undefined, String(value));
	}
});

test("setUrl reconnects an active client to the new relay", async () => {
	const first = await startRelayServer({ port: 0, host: "127.0.0.1", logger: silentLogger, access: accessOptions(identity) });
	const second = await startRelayServer({ port: 0, host: "127.0.0.1", logger: silentLogger, access: accessOptions(identity) });
	const client = new RelayClient(`ws://127.0.0.1:${first.port}`);
	try {
		client.connect(identity);
		await waitForState(client, "connected");
		assert.equal(first.connectionCount(), 1);

		client.setUrl(`ws://127.0.0.1:${second.port}`);
		assert.equal(client.url, `ws://127.0.0.1:${second.port}`);
		await waitForState(client, "connected");
		assert.equal(second.connectionCount(), 1);
	} finally {
		client.close();
		await Promise.all([first.close(), second.close()]);
	}
});

test("setUrl does not connect an idle client", () => {
	const client = new RelayClient("ws://127.0.0.1:1");
	client.setUrl("ws://127.0.0.1:2");
	assert.equal(client.url, "ws://127.0.0.1:2");
	assert.equal(client.state, "disconnected");
});

test("hosted relay starts once, reports addresses and stops", async () => {
	const loopbackStart = (options) => startRelayServer({ ...options, host: "127.0.0.1" });
	const hosted = new HostedRelay(silentLogger, loopbackStart, () => ["192.168.1.20"]);
	const counts = [];
	hosted.onConnectionCountChange((count) => counts.push(count));

	const access = accessOptions(identity);
	const [info, again] = await Promise.all([hosted.start(0, certificate, access), hosted.start(0, certificate, access)]);
	try {
		assert.equal(hosted.isRunning, true);
		assert.deepEqual(again, info);
		assert.equal(info.fingerprint, certificate.fingerprint);
		assert.equal(info.localUrl, `wss://127.0.0.1:${info.port}#sha256=${certificate.fingerprint}`);
		assert.deepEqual(info.networkUrls, [`wss://192.168.1.20:${info.port}#sha256=${certificate.fingerprint}`]);

		const client = new RelayClient(info.localUrl);
		client.connect(identity);
		await waitForState(client, "connected");
		assert.equal(hosted.connectionCount, 1);
		client.close();
	} finally {
		await hosted.stop();
	}

	assert.equal(hosted.isRunning, false);
	assert.equal(hosted.info, undefined);
	assert.equal(counts[0], 1);
	await hosted.stop();
});

test("hosted relay surfaces start failures and can retry", async () => {
	let attempts = 0;
	const failingStart = async (options) => {
		attempts += 1;
		if (attempts === 1) throw new Error("boom");
		return startRelayServer({ ...options, host: "127.0.0.1" });
	};
	const hosted = new HostedRelay(silentLogger, failingStart, () => []);

	const access = accessOptions(identity);
	await assert.rejects(hosted.start(0, certificate, access), /boom/);
	assert.equal(hosted.isRunning, false);

	const info = await hosted.start(0, certificate, access);
	assert.deepEqual(info.networkUrls, []);
	await hosted.stop();
});
