const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const test = require("node:test");
const WebSocket = require("ws");

const dist = path.join(__dirname, "..", "dist");
const { EncryptionService } = require(path.join(dist, "extension", "src", "encryption", "encryptionService.js"));
const { RelayClient } = require(path.join(dist, "extension", "src", "relay", "relayClient.js"));
const { startRelayServer } = require(path.join(dist, "shared", "relayServer.js"));
const { generateJoinCode } = require(path.join(dist, "shared", "relayAuthentication.js"));

async function newIdentity() {
	const values = new Map();
	return EncryptionService.load({
		secrets: {
			get: async (key) => values.get(key),
			store: async (key, value) => values.set(key, value),
		},
	});
}

function memoryStore() {
	let state;
	let failNext = false;
	let failedCode;
	return {
		load: async () => state === undefined ? undefined : structuredClone(state),
		save: async (next) => {
			if (failNext) {
				failNext = false;
				failedCode = next.joinCode;
				throw new Error(`Simulated access storage failure: ${next.joinCode}`);
			}
			state = structuredClone(next);
		},
		failNextSave: () => { failNext = true; },
		lastFailedCode: () => failedCode,
	};
}

function waitForState(client, expected) {
	if (client.state === expected) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			stop();
			reject(new Error(`Timed out waiting for ${expected}; got ${client.state}`));
		}, 5000);
		const stop = client.onStatusChange((state) => {
			if (state !== expected) return;
			clearTimeout(timer);
			stop();
			resolve();
		});
	});
}

function waitForRawMessage(socket, predicate) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			socket.off("message", onMessage);
			reject(new Error("Timed out waiting for a relay response"));
		}, 5000);
		const onMessage = (data) => {
			const message = JSON.parse(data.toString());
			if (!predicate(message)) return;
			clearTimeout(timer);
			socket.off("message", onMessage);
			resolve(message);
		};
		socket.on("message", onMessage);
	});
}

async function fixture(t) {
	const admin = await newIdentity();
	const joinCode = generateJoinCode();
	const store = memoryStore();
	const logs = [];
	const clients = [];
	const sockets = [];
	let clock = Date.now();
	let relay;
	const options = {
		port: 0,
		host: "127.0.0.1",
		access: { adminPublicKey: admin.publicKey, store, initialJoinCode: joinCode },
		logger: { info: (message) => logs.push(message), error: (message) => logs.push(message) },
		now: () => clock,
	};
	relay = await startRelayServer(options);

	t.after(async () => {
		for (const client of clients) client.close();
		for (const socket of sockets) socket.terminate();
		await relay.close();
	});

	async function connect(identity, code, expected = "connected") {
		const url = `ws://127.0.0.1:${relay.port}`;
		const client = new RelayClient(url);
		clients.push(client);
		if (code !== undefined) client.setJoinCode(url, code);
		const ready = waitForState(client, expected);
		client.connect(identity);
		await ready;
		return client;
	}

	async function openRaw() {
		const socket = new WebSocket(`ws://127.0.0.1:${relay.port}`);
		sockets.push(socket);
		await new Promise((resolve, reject) => {
			socket.once("open", resolve);
			socket.once("error", reject);
		});
		return socket;
	}

	async function restart() {
		await relay.close();
		relay = await startRelayServer(options);
	}

	return {
		admin, joinCode, logs, store, connect, openRaw, restart,
		advance: (milliseconds) => { clock += milliseconds; },
	};
}

async function rawChallenge(socket, encryptionKey, signingKey) {
	const requestId = randomUUID();
	const received = waitForRawMessage(socket, (message) => message.type === "relay_challenge");
	socket.send(JSON.stringify({
		type: "hello", requestId, from: encryptionKey, signingKey,
		message: "test", timestamp: new Date().toISOString(),
	}));
	return received;
}

function rawAuthentication(challenge, identity, code) {
	return {
		type: "relay_authenticate",
		requestId: challenge.correlationId,
		challengeId: challenge.challengeId,
		...identity.proveRelayChallenge(challenge, code),
		joinCode: code,
		timestamp: new Date().toISOString(),
	};
}

test("authenticates both identity keys and preserves the legitimate session during a hijack", async (t) => {
	const f = await fixture(t);
	const admin = await f.connect(f.admin);
	const alice = await newIdentity();
	const aliceClient = await f.connect(alice, f.joinCode);
	await assert.rejects(aliceClient.requestAdmin("get_join_code"), /not the relay administrator/i);
	const attacker = await newIdentity();
	const raw = await f.openRaw();
	const challenge = await rawChallenge(raw, alice.publicKey, attacker.signingPublicKey);
	const rejected = waitForRawMessage(raw, (message) => message.type === "error");
	raw.send(JSON.stringify(rawAuthentication(challenge, attacker, f.joinCode)));

	assert.equal((await rejected).code, "AUTHENTICATION_FAILED");
	assert.equal(aliceClient.state, "connected");
	assert.equal(admin.state, "connected");
	const members = await admin.requestAdmin("list_members");
	assert.ok(members.members.some((member) => member.publicKey === alice.publicKey));
	assert.equal(members.members.some((member) => member.publicKey === attacker.publicKey), false);
	assert.equal(f.logs.join("\n").includes(f.joinCode), false);
});

test("rejects expired and replayed challenges", async (t) => {
	const f = await fixture(t);
	const identity = await newIdentity();
	const raw = await f.openRaw();
	const challenge = await rawChallenge(raw, identity.publicKey, identity.signingPublicKey);
	const authentication = rawAuthentication(challenge, identity, f.joinCode);
	f.advance(30_001);
	const expired = waitForRawMessage(raw, (message) => message.type === "error");
	raw.send(JSON.stringify(authentication));
	assert.equal((await expired).code, "CHALLENGE_EXPIRED");

	const replaySocket = await f.openRaw();
	const replayError = waitForRawMessage(replaySocket, (message) => message.type === "error");
	replaySocket.send(JSON.stringify(authentication));
	assert.equal((await replayError).code, "INVALID_CHALLENGE");

	const otherSocket = await f.openRaw();
	await rawChallenge(otherSocket, identity.publicKey, identity.signingPublicKey);
	const reused = waitForRawMessage(otherSocket, (message) => message.type === "error");
	otherSocket.send(JSON.stringify(authentication));
	assert.equal((await reused).code, "AUTHENTICATION_FAILED");
});

test("rate-limits invalid join codes across connections without blocking existing members", async (t) => {
	const f = await fixture(t);
	const member = await newIdentity();
	const first = await f.connect(member, f.joinCode);
	first.close();

	const stranger = await newIdentity();
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const denied = await f.connect(stranger, generateJoinCode(), "error");
		assert.equal(denied.lastError.code, "INVITE_REQUIRED");
	}
	const limited = await f.connect(stranger, f.joinCode, "error");
	assert.equal(limited.lastError.code, "JOIN_RATE_LIMITED");
	const reconnected = await f.connect(member);
	assert.equal(reconnected.state, "connected");

	f.advance(60_001);
	const joined = await f.connect(stranger, f.joinCode);
	assert.equal(joined.state, "connected");
});

test("keeps members across restarts and code rotation, and rejects an old invite", async (t) => {
	const f = await fixture(t);
	let admin = await f.connect(f.admin);
	const member = await newIdentity();
	let client = await f.connect(member, f.joinCode);
	const pendingIdentity = await newIdentity();
	const pendingSocket = await f.openRaw();
	const pendingChallenge = await rawChallenge(pendingSocket, pendingIdentity.publicKey, pendingIdentity.signingPublicKey);
	const pendingAuthentication = rawAuthentication(pendingChallenge, pendingIdentity, f.joinCode);
	const rotated = await admin.requestAdmin("rotate_code", { removeMembers: false });
	const pendingRejected = waitForRawMessage(pendingSocket, (message) => message.type === "error");
	pendingSocket.send(JSON.stringify(pendingAuthentication));
	assert.equal((await pendingRejected).code, "INVALID_JOIN_CODE");
	assert.notEqual(rotated.joinCode, f.joinCode);
	assert.equal(client.state, "connected");
	const staleExistingInvite = await f.connect(member, f.joinCode, "error");
	assert.equal(staleExistingInvite.lastError.code, "INVITE_REQUIRED");
	assert.equal(client.state, "connected");
	const reconnectedWithoutInvite = waitForState(staleExistingInvite, "connected");
	staleExistingInvite.connect(member);
	await reconnectedWithoutInvite;
	staleExistingInvite.close();
	client = await f.connect(member);
	assert.equal(client.state, "connected");

	const stranger = await newIdentity();
	const denied = await f.connect(stranger, f.joinCode, "error");
	assert.equal(denied.lastError.code, "INVITE_REQUIRED");
	await f.connect(stranger, rotated.joinCode);

	await f.restart();
	admin = await f.connect(f.admin);
	client = await f.connect(member);
	assert.equal(client.state, "connected");
	assert.equal((await admin.requestAdmin("get_join_code")).joinCode, rotated.joinCode);
	assert.equal(f.logs.join("\n").includes(f.joinCode), false);
	assert.equal(f.logs.join("\n").includes(rotated.joinCode), false);
});

test("a failed membership save does not register a new client or disturb existing sessions", async (t) => {
	const f = await fixture(t);
	const admin = await f.connect(f.admin);
	const member = await newIdentity();
	const existing = await f.connect(member, f.joinCode);
	const candidate = await newIdentity();
	f.store.failNextSave();
	const denied = await f.connect(candidate, f.joinCode, "error");
	assert.equal(denied.lastError.code, "AUTHENTICATION_FAILED");
	assert.equal(existing.state, "connected");
	const members = await admin.requestAdmin("list_members");
	assert.equal(members.members.some((item) => item.publicKey === candidate.publicKey), false);
	assert.equal(f.logs.join("\n").includes(f.joinCode), false);

	f.store.failNextSave();
	await assert.rejects(admin.requestAdmin("rotate_code", { removeMembers: false }), /rejected/i);
	assert.equal((await admin.requestAdmin("get_join_code")).joinCode, f.joinCode);
	assert.equal(existing.state, "connected");
	assert.equal(f.logs.join("\n").includes(f.store.lastFailedCode()), false);
});

test("reports handshake send failures without exposing the join code", async (t) => {
	const f = await fixture(t);
	const originalSend = WebSocket.prototype.send;
	try {
		for (const type of ["hello", "relay_authenticate"]) {
			for (const mode of ["throw", "callback"]) {
				WebSocket.prototype.send = function(data, callback) {
					const message = JSON.parse(data.toString());
					if (!this._isServer && message.type === type) {
						const error = new Error(`Simulated send failure: ${f.joinCode}`);
						if (mode === "throw") throw error;
						process.nextTick(() => callback(error));
						return;
					}
					return originalSend.apply(this, arguments);
				};
				const client = await f.connect(await newIdentity(), f.joinCode, "error");
				assert.equal(client.lastError.code, "CONNECTION_FAILED");
				assert.match(client.lastError.message, /relay authentication/i);
				assert.equal(client.lastError.message.includes(f.joinCode), false);
			}
		}
	} finally {
		WebSocket.prototype.send = originalSend;
	}
	assert.equal(f.logs.join("\n").includes(f.joinCode), false);
});

test("removes members, preserves the administrator and detects changes before destructive rotation", async (t) => {
	const f = await fixture(t);
	const admin = await f.connect(f.admin);
	const alice = await newIdentity();
	const aliceClient = await f.connect(alice, f.joinCode);
	const initialList = await admin.requestAdmin("list_members");
	const bob = await newIdentity();
	const bobClient = await f.connect(bob, f.joinCode);

	await assert.rejects(
		admin.requestAdmin("rotate_code", { removeMembers: true, expectedRevision: initialList.revision }),
		/member list changed/i
	);
	assert.equal((await admin.requestAdmin("get_join_code")).joinCode, f.joinCode);
	assert.equal(aliceClient.state, "connected");
	assert.equal(bobClient.state, "connected");

	const aliceRemoved = waitForState(aliceClient, "error");
	await admin.requestAdmin("remove_member", { publicKey: alice.publicKey });
	await aliceRemoved;
	assert.equal(aliceClient.lastError.code, "INVITE_REQUIRED");
	const denied = await f.connect(alice, undefined, "error");
	assert.equal(denied.lastError.code, "INVITE_REQUIRED");
	assert.equal(bobClient.state, "connected");

	const currentList = await admin.requestAdmin("list_members");
	const bobRemoved = waitForState(bobClient, "error");
	const rotated = await admin.requestAdmin("rotate_code", {
		removeMembers: true,
		expectedRevision: currentList.revision,
	});
	await bobRemoved;
	assert.equal(admin.state, "connected");
	assert.notEqual(rotated.joinCode, f.joinCode);
	const after = await admin.requestAdmin("list_members");
	assert.deepEqual(after.members.map((member) => member.publicKey), [f.admin.publicKey]);
	const noInvite = await f.connect(bob, undefined, "error");
	assert.equal(noInvite.lastError.code, "INVITE_REQUIRED");
	await f.connect(bob, rotated.joinCode);
	assert.equal(f.logs.join("\n").includes(rotated.joinCode), false);
});
