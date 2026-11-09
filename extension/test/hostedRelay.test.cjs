const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const dist = path.join(__dirname, "..", "dist");
const { validateRelayUrl, validateHostRelayPort } = require(path.join(dist, "extension/src/relay/relaySettings.js"));
const { HostedRelay } = require(path.join(dist, "extension/src/relay/hostedRelay.js"));
const { RelayClient } = require(path.join(dist, "extension/src/relay/relayClient.js"));
const { startRelayServer } = require(path.join(dist, "shared/relayServer.js"));

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

test("validates relay URLs", () => {
	assert.deepEqual(validateRelayUrl("ws://192.168.1.20:8787"), { ok: true, url: "ws://192.168.1.20:8787" });
	assert.deepEqual(validateRelayUrl(" wss://relay.example.com/ "), { ok: true, url: "wss://relay.example.com" });

	for (const value of ["", "   ", undefined, 42, "http://127.0.0.1:8787", "not a url", "ws://user:pass@127.0.0.1:8787"]) {
		assert.equal(validateRelayUrl(value).ok, false, String(value));
	}
});

test("validates host relay ports", () => {
	assert.equal(validateHostRelayPort(8787), 8787);
	for (const value of [0, 65536, 80.5, "8787", undefined]) {
		assert.equal(validateHostRelayPort(value), undefined, String(value));
	}
});

test("setUrl reconnects an active client to the new relay", async () => {
	const first = await startRelayServer({ port: 0, host: "127.0.0.1", logger: silentLogger });
	const second = await startRelayServer({ port: 0, host: "127.0.0.1", logger: silentLogger });
	const client = new RelayClient(`ws://127.0.0.1:${first.port}`);
	try {
		client.connect("identity-a");
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

	const [info, again] = await Promise.all([hosted.start(0), hosted.start(0)]);
	try {
		assert.equal(hosted.isRunning, true);
		assert.deepEqual(again, info);
		assert.equal(info.localUrl, `ws://127.0.0.1:${info.port}`);
		assert.deepEqual(info.networkUrls, [`ws://192.168.1.20:${info.port}`]);

		const client = new RelayClient(info.localUrl);
		client.connect("host-identity");
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

	await assert.rejects(hosted.start(0), /boom/);
	assert.equal(hosted.isRunning, false);

	const info = await hosted.start(0);
	assert.deepEqual(info.networkUrls, []);
	await hosted.stop();
});
