const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const WebSocket = require("ws");

const sharedDist = path.join(__dirname, "..", "dist", "shared");
const { startRelayServer, RelayPortInUseError } = require(path.join(sharedDist, "relayServer.js"));
const { getLocalNetworkAddresses, isLocalNetworkAddress, normalizeRemoteAddress } = require(path.join(sharedDist, "networkAddress.js"));
const authentication = require(path.join(sharedDist, "relayAuthentication.js"));
const { createIdentity, accessOptions } = require(path.join(__dirname, "..", "..", "test-support", "relay.cjs"));

const silentLogger = { info() {}, error() {} };

function openSocket(url) {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url);
		socket.once("open", () => resolve(socket));
		socket.once("error", reject);
		socket.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
	});
}

test("classifies local network addresses", () => {
	for (const address of [
		"127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.20",
		"169.254.10.10", "::1", "fd12:3456::1", "fe80::1%eth0",
		"::ffff:192.168.1.5", "::ffff:c0a8:0105", "::FFFF:127.0.0.1",
	]) {
		assert.equal(isLocalNetworkAddress(address), true, address);
	}

	for (const address of [
		"8.8.8.8", "172.32.0.1", "100.64.0.1", "2001:4860:4860::8888",
		"::ffff:8.8.8.8", "", "not-an-ip",
	]) {
		assert.equal(isLocalNetworkAddress(address), false, address);
	}

	assert.equal(normalizeRemoteAddress("::ffff:c0a8:0105"), "192.168.1.5");
});

test("starts on an ephemeral port, accepts local clients and closes idempotently", async () => {
	const counts = [];
	const relay = await startRelayServer({
		port: 0,
		host: "127.0.0.1",
		access: accessOptions(createIdentity(authentication)),
		logger: silentLogger,
		onConnectionCountChange: (count) => counts.push(count),
	});
	assert.ok(relay.port > 0);

	const socket = await openSocket(`ws://127.0.0.1:${relay.port}`);
	const closed = new Promise((resolve) => socket.once("close", (code) => resolve(code)));
	assert.equal(relay.connectionCount(), 1);

	await Promise.all([relay.close(), relay.close()]);
	assert.equal(await closed, 1001);
	assert.deepEqual(counts, [1, 0]);
	await relay.close();
});

test("rejects connections from disallowed addresses", async () => {
	const relay = await startRelayServer({
		port: 0,
		host: "127.0.0.1",
		access: accessOptions(createIdentity(authentication)),
		logger: silentLogger,
		isRemoteAddressAllowed: () => false,
	});

	try {
		await assert.rejects(openSocket(`ws://127.0.0.1:${relay.port}`), /HTTP 403/);
		assert.equal(relay.connectionCount(), 0);
	} finally {
		await relay.close();
	}
});

test("rejects unencrypted connections over a local network interface", async (t) => {
	const [address] = getLocalNetworkAddresses();
	if (!address) {
		t.skip("No private IPv4 interface is available.");
		return;
	}
	const relay = await startRelayServer({
		port: 0,
		host: address,
		access: accessOptions(createIdentity(authentication)),
		logger: silentLogger,
		isRemoteAddressAllowed: () => true,
	});
	try {
		await assert.rejects(openSocket(`ws://${address}:${relay.port}`), /HTTP 403/);
		assert.equal(relay.connectionCount(), 0);
	} finally {
		await relay.close();
	}
});

test("reports a friendly error when the port is in use", async () => {
	const first = await startRelayServer({ port: 0, host: "127.0.0.1", logger: silentLogger, access: accessOptions(createIdentity(authentication)) });
	try {
		await assert.rejects(
			startRelayServer({ port: first.port, host: "127.0.0.1", logger: silentLogger, access: accessOptions(createIdentity(authentication)) }),
			(error) => error instanceof RelayPortInUseError && error.port === first.port
		);
	} finally {
		await first.close();
	}
});
