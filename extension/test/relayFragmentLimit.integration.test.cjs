const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const WebSocket = require("ws");

const extensionShared = path.join(__dirname, "..", "dist", "shared");
const serverShared = path.join(__dirname, "..", "..", "server", "dist", "shared");
const authentication = require(path.join(extensionShared, "relayAuthentication.js"));
const { createIdentity, accessOptions } = require(path.join(__dirname, "..", "..", "test-support", "relay.cjs"));
const logger = { info() {}, error() {} };
const maxFragments = 128 * 1024;

function openSocket(url) {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url);
		socket.once("open", () => resolve(socket));
		socket.once("error", reject);
	});
}

function nextError(socket) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			socket.off("message", onMessage);
			reject(new Error("Timed out waiting for a relay error."));
		}, 10_000);
		function onMessage(data) {
			const message = JSON.parse(data.toString());
			if (message.type !== "error") return;
			clearTimeout(timeout);
			socket.off("message", onMessage);
			resolve(message);
		}
		socket.on("message", onMessage);
	});
}

function waitForClose(socket) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			socket.off("close", onClose);
			reject(new Error("Relay did not close the excessively fragmented message."));
		}, 10_000);
		function onClose(code) {
			clearTimeout(timeout);
			resolve(code);
		}
		socket.once("close", onClose);
	});
}

for (const [mode, shared] of [["hosted", extensionShared], ["standalone", serverShared]]) {
	test(`${mode} relay rejects excessive fragments before authentication and remains responsive`, async () => {
		const { startRelayServer } = require(path.join(shared, "relayServer.js"));
		const relay = await startRelayServer({
			port: 0,
			host: "127.0.0.1",
			access: accessOptions(createIdentity(authentication)),
			logger,
		});
		let normal;
		let attacker;
		try {
			const url = `ws://127.0.0.1:${relay.port}`;
			normal = await openSocket(url);
			const normalError = nextError(normal);
			normal.send("{", { fin: false });
			normal.send("}", { fin: true });
			assert.equal((await normalError).code, "INVALID_SHAPE");

			attacker = await openSocket(url);
			const closed = waitForClose(attacker);
			// A single unfinished message contains more fragments than the transport permits.
			const continuation = Buffer.from([0x00, 0x81, 0, 0, 0, 0, 0x61]);
			const frames = Buffer.alloc(continuation.length * (maxFragments + 1));
			for (let offset = 0; offset < frames.length; offset += continuation.length) {
				continuation.copy(frames, offset);
			}
			frames[0] = 0x01;
			attacker._socket.write(frames);
			assert.equal(await closed, 1008);

			const afterAttack = nextError(normal);
			normal.send("{}");
			assert.equal((await afterAttack).code, "INVALID_SHAPE");
		} finally {
			normal?.terminate();
			attacker?.terminate();
			await relay.close();
		}
	});
}
