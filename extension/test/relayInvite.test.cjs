const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const dist = path.join(__dirname, "..", "dist");
const { EncryptionService } = require(path.join(dist, "extension", "src", "encryption", "encryptionService.js"));
const { createRelayInvite, parseRelayInvite } = require(path.join(dist, "extension", "src", "relay", "relayInvite.js"));
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

function mutate(invite, change) {
	const prefix = "devchat-invite.v1.";
	const value = JSON.parse(Buffer.from(invite.slice(prefix.length), "base64url").toString("utf8"));
	change(value);
	return prefix + Buffer.from(JSON.stringify(value)).toString("base64url");
}

test("creates and validates a signed invitation with the host's identity", async () => {
	const host = await newIdentity();
	const code = generateJoinCode();
	const url = `wss://192.168.1.20:8787#sha256=${"AB".repeat(32)}`;
	const encoded = createRelayInvite(host, url, code);
	const parsed = parseRelayInvite(encoded);

	assert.equal(parsed.joinCode, code);
	assert.equal(parsed.hostPublicKey, host.publicKey);
	assert.equal(parsed.hostSigningKey, host.signingPublicKey);
	assert.equal(parsed.hostFingerprint, host.fingerprint);
	assert.match(parsed.relayUrl, /^wss:\/\/192\.168\.1\.20:8787#sha256=/);
});

test("rejects altered, malformed, unpinned and non-TLS invitations without echoing their contents", async () => {
	const host = await newIdentity();
	const other = await newIdentity();
	const code = generateJoinCode();
	const url = `wss://192.168.1.20:8787#sha256=${"AB".repeat(32)}`;
	const encoded = createRelayInvite(host, url, code);
	for (const change of [
		(value) => { value.joinCode = generateJoinCode(); },
		(value) => { value.hostPublicKey = other.publicKey; },
		(value) => { value.hostSigningKey = other.signingPublicKey; },
		(value) => { value.hostFingerprint = other.fingerprint; },
		(value) => { value.relayUrl = value.relayUrl.replace("192.168.1.20", "192.168.1.21"); },
		(value) => { value.signature = "invalid"; },
		(value) => { value.version = 2; },
		(value) => { value.extra = "unexpected"; },
	]) {
		assert.throws(() => parseRelayInvite(mutate(encoded, change)), (error) =>
			/invalid|altered/i.test(error.message) && !error.message.includes(code)
		);
	}
	for (const value of ["", "devchat-invite.v1.!", `${encoded}=`, "x".repeat(5000)]) {
		assert.throws(() => parseRelayInvite(value), /invalid|altered/i);
	}
	assert.throws(() => createRelayInvite(host, "ws://127.0.0.1:8787", code), /pinned wss/i);
	assert.throws(() => createRelayInvite(host, "wss://example.test:8787", code), /pinned wss/i);
	assert.throws(
		() => createRelayInvite(host, `wss://example.test:8787?token=x#sha256=${"AB".repeat(32)}`, code),
		/pinned wss/i
	);
});
