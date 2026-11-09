const assert = require("node:assert/strict");
const Module = require("node:module");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");

const dist = path.join(__dirname, "..", "dist");
const { EncryptionService } = require(path.join(dist, "extension", "src", "encryption", "encryptionService.js"));
const { ContactTrustStore } = require(path.join(dist, "extension", "src", "encryption", "contactTrust.js"));
const { MessageAuthenticator } = require(path.join(dist, "extension", "src", "encryption", "messageAuthenticator.js"));
const { RelayClient } = require(path.join(dist, "extension", "src", "relay", "relayClient.js"));
const { createRelayInvite, parseRelayInvite } = require(path.join(dist, "extension", "src", "relay", "relayInvite.js"));
const { generateRelayCertificate } = require(path.join(dist, "shared", "relayCertificate.js"));
const { generateJoinCode } = require(path.join(dist, "shared", "relayAuthentication.js"));
const { startRelayServer } = require(path.join(dist, "shared", "relayServer.js"));
const { accessOptions, memoryStore } = require(path.join(__dirname, "..", "..", "test-support", "relay.cjs"));

async function newIdentity() {
	const values = new Map();
	return EncryptionService.load({
		secrets: {
			get: async (key) => values.get(key),
			store: async (key, value) => values.set(key, value),
		},
	});
}

function newTrust() {
	const values = new Map();
	return new ContactTrustStore({
		get: (key) => values.get(key),
		update: async (key, value) => { values.set(key, value); },
	});
}

function mockVSCode(port) {
	const ui = {
		input: undefined,
		clipboard: "",
		warningChoices: [],
		quickChoices: [],
		informationChoices: [],
		warnings: [],
		information: [],
		errors: [],
		configUpdates: [],
		commands: [],
	};
	const config = {
		get: (key, fallback) => key === "hostRelay.port" ? port : fallback,
		update: async (key, value, target) => { ui.configUpdates.push({ key, value, target }); },
	};
	const vscode = {
		ConfigurationTarget: { Global: 1 },
		StatusBarAlignment: { Left: 1 },
		Disposable: class { constructor(dispose) { this.dispose = dispose; } },
		window: {
			createStatusBarItem: () => ({ hide() {}, show() {}, dispose() {} }),
			showInputBox: async () => ui.input,
			showInformationMessage: async (message, ...options) => {
				ui.information.push({ message, options });
				return ui.informationChoices.shift();
			},
			showWarningMessage: async (message, ...options) => {
				ui.warnings.push({ message, options });
				return ui.warningChoices.shift();
			},
			showErrorMessage: async (message) => { ui.errors.push(message); },
			showQuickPick: async () => ui.quickChoices.shift(),
		},
		workspace: {
			getConfiguration: () => config,
			onDidChangeConfiguration: () => ({ dispose() {} }),
		},
		env: { clipboard: { writeText: async (value) => { ui.clipboard = value; } } },
		commands: { executeCommand: async (...args) => { ui.commands.push(args); } },
	};
	return { ui, vscode };
}

function loadController(vscode) {
	const modulePath = path.join(dist, "extension", "src", "relay", "relayController.js");
	delete require.cache[require.resolve(modulePath)];
	const originalLoad = Module._load;
	try {
		Module._load = function(request, parent, isMain) {
			return request === "vscode" ? vscode : originalLoad.call(this, request, parent, isMain);
		};
		return require(modulePath).RelayController;
	} finally {
		Module._load = originalLoad;
	}
}

function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

function waitForState(client, expected) {
	if (client.state === expected) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			stop();
			reject(new Error(`Timed out waiting for ${expected}`));
		}, 5000);
		const stop = client.onStatusChange((state) => {
			if (state !== expected) return;
			clearTimeout(timeout);
			stop();
			resolve();
		});
	});
}

test("host and guest use the invite UI, save the contact, and confirm removing members", async () => {
	const port = await freePort();
	const { ui, vscode } = mockVSCode(port);
	const RelayController = loadController(vscode);
	const certificate = await generateRelayCertificate();
	const host = await newIdentity();
	const guest = await newIdentity();
	const hostClient = new RelayClient("ws://127.0.0.1:1");
	const guestClient = new RelayClient("ws://127.0.0.1:1");
	const guestTrust = newTrust();
	const log = [];
	const logger = { info: (message) => log.push(message), error: (message) => log.push(message) };
	const certificates = { load: async () => certificate };
	const hostController = new RelayController(hostClient, host, logger, certificates, memoryStore(), newTrust());
	const guestController = new RelayController(guestClient, guest, logger, certificates, memoryStore(), guestTrust);
	hostController.hostedRelay.listAddresses = () => ["127.0.0.1"];

	try {
		await hostController.startHosting();
		await hostController.copyRelayInvite();
		const invite = parseRelayInvite(ui.clipboard);
		assert.equal(invite.hostPublicKey, host.publicKey);
		assert.equal(invite.hostFingerprint, host.fingerprint);
		assert.equal(log.join("\n").includes(invite.joinCode), false);

		ui.input = ui.clipboard;
		ui.warningChoices.push("Join Relay");
		ui.informationChoices.push("Open Chat");
		await guestController.joinRelayWithInvite();
		assert.deepEqual(ui.errors, []);
		assert.equal(guestClient.state, "connected");
		assert.equal(ui.configUpdates.at(-1).value, invite.relayUrl);
		assert.equal(JSON.stringify(ui.configUpdates).includes(invite.joinCode), false);
		assert.deepEqual(guestTrust.get(host.publicKey).signingKey, host.signingPublicKey);
		assert.equal(guestTrust.get(host.publicKey).verified, false);
		assert.deepEqual(ui.commands.at(-1), ["devChat.openChat"]);
		assert.match(ui.warnings.at(-1).options[0].detail, /Compare this fingerprint/);

		ui.quickChoices.push("Change code and remove all members");
		ui.warningChoices.push("Change Code and Remove Members");
		const removed = waitForState(guestClient, "error");
		await hostController.changeJoinCode();
		await removed;
		assert.match(ui.warnings.at(-1).message, /remove 1 relay member\?/);
		assert.equal(hostClient.state, "connected");
		assert.notEqual((await hostClient.requestAdmin("get_join_code")).joinCode, invite.joinCode);
		assert.equal(log.join("\n").includes(invite.joinCode), false);
		assert.equal(JSON.stringify(ui.information).includes(invite.joinCode), false);
	} finally {
		guestClient.close();
		await guestController.dispose();
		await hostController.dispose();
	}
});

test("a changed host key is shown before joining and is not silently replaced", async () => {
	const { ui, vscode } = mockVSCode(8787);
	const RelayController = loadController(vscode);
	const host = await newIdentity();
	const another = await newIdentity();
	const guest = await newIdentity();
	const trust = newTrust();
	await trust.evaluate(host.publicKey, another.signingPublicKey);
	const client = new RelayClient("ws://127.0.0.1:1");
	const log = [];
	const logger = { info: (message) => log.push(message), error: (message) => log.push(message) };
	const controller = new RelayController(client, guest, logger, {}, memoryStore(), trust);
	const code = generateJoinCode();
	ui.input = createRelayInvite(host, `wss://127.0.0.1:8787#sha256=${"AB".repeat(32)}`, code);

	try {
		await controller.joinRelayWithInvite();
		assert.match(ui.warnings[0].options[0].detail, /signing key differs/);
		assert.match(ui.warnings[0].options[0].detail, /review the held key change/i);
		assert.equal(trust.get(host.publicKey).signingKey, another.signingPublicKey);
		assert.equal(ui.configUpdates.length, 0);
		assert.equal(client.state, "disconnected");
		assert.equal(log.join("\n").includes(code), false);
	} finally {
		await controller.dispose();
	}
});

test("clipboard failures do not expose the invitation in errors or logs", async () => {
	const port = await freePort();
	const { ui, vscode } = mockVSCode(port);
	const RelayController = loadController(vscode);
	const certificate = await generateRelayCertificate();
	const host = await newIdentity();
	const client = new RelayClient("ws://127.0.0.1:1");
	const log = [];
	const logger = { info: (message) => log.push(message), error: (message) => log.push(message) };
	const controller = new RelayController(client, host, logger, { load: async () => certificate }, memoryStore(), newTrust());
	controller.hostedRelay.listAddresses = () => ["127.0.0.1"];
	let attemptedInvite;
	vscode.env.clipboard.writeText = async (value) => {
		attemptedInvite = value;
		throw new Error(value);
	};

	try {
		await controller.startHosting();
		await controller.copyRelayInvite();
		const invite = parseRelayInvite(attemptedInvite);
		assert.match(ui.errors.at(-1), /clipboard access/i);
		for (const text of [...log, ...ui.errors]) {
			assert.equal(text.includes(attemptedInvite), false);
			assert.equal(text.includes(invite.joinCode), false);
		}
	} finally {
		await controller.dispose();
	}
});

test("cannot start hosting while an invitation is being entered", async () => {
	const { ui, vscode } = mockVSCode(8787);
	const RelayController = loadController(vscode);
	const identity = await newIdentity();
	const client = new RelayClient("ws://127.0.0.1:1");
	const logger = { info() {}, error() {} };
	const controller = new RelayController(client, identity, logger, {}, memoryStore(), newTrust());
	let cancelInput;
	vscode.window.showInputBox = () => new Promise((resolve) => { cancelInput = resolve; });
	try {
		const joining = controller.joinRelayWithInvite();
		await controller.startHosting();
		assert.match(ui.errors.at(-1), /finish joining/i);
		assert.equal(controller.hostedRelay.isRunning, false);
		cancelInput(undefined);
		await joining;
		assert.equal(controller.isJoining, false);
	} finally {
		if (cancelInput) cancelInput(undefined);
		await controller.dispose();
	}
});

test("joining with a changed host key keeps it untrusted until the normal key review", async () => {
	const port = await freePort();
	const { ui, vscode } = mockVSCode(port);
	const RelayController = loadController(vscode);
	const certificate = await generateRelayCertificate();
	const host = await newIdentity();
	const previous = await newIdentity();
	const guest = await newIdentity();
	const guestTrust = newTrust();
	await guestTrust.evaluate(host.publicKey, previous.signingPublicKey);
	await guestTrust.setVerified(host.publicKey, true);
	const hostClient = new RelayClient("ws://127.0.0.1:1");
	const guestClient = new RelayClient("ws://127.0.0.1:1");
	const logger = { info() {}, error() {} };
	const certificates = { load: async () => certificate };
	const hostController = new RelayController(hostClient, host, logger, certificates, memoryStore(), newTrust());
	const guestController = new RelayController(guestClient, guest, logger, certificates, memoryStore(), guestTrust);
	hostController.hostedRelay.listAddresses = () => ["127.0.0.1"];

	try {
		await hostController.startHosting();
		await hostController.copyRelayInvite();
		ui.input = ui.clipboard;
		ui.warningChoices.push("Join Relay");
		await guestController.joinRelayWithInvite();
		assert.equal(guestClient.state, "connected");
		assert.equal(guestTrust.get(host.publicKey).signingKey, previous.signingPublicKey);
		assert.equal(guestTrust.get(host.publicKey).verified, true);
		assert.match(ui.warnings.at(-1).message, /changed signing key has not been accepted/);

		const authenticator = new MessageAuthenticator(guest, guestTrust);
		const requestId = "host-after-join";
		const held = await authenticator.receive({
			from: host.publicKey,
			to: guest.publicKey,
			requestId,
			payload: host.seal("hello", guest.publicKey, requestId),
		});
		assert.equal(held.kind, "held");
		assert.equal(held.change.newFingerprint, host.fingerprint);
		assert.deepEqual((await authenticator.acceptKeyChange(host.publicKey)).map((message) => message.text), ["hello"]);
		assert.equal(guestTrust.get(host.publicKey).signingKey, host.signingPublicKey);
		assert.equal(guestTrust.get(host.publicKey).verified, false);
	} finally {
		guestClient.close();
		await guestController.dispose();
		await hostController.dispose();
	}
});

test("a contact storage failure closes the join and does not remember a partial contact", async () => {
	const port = await freePort();
	const { ui, vscode } = mockVSCode(port);
	const RelayController = loadController(vscode);
	const certificate = await generateRelayCertificate();
	const host = await newIdentity();
	const guest = await newIdentity();
	const hostClient = new RelayClient("ws://127.0.0.1:1");
	const guestClient = new RelayClient("ws://127.0.0.1:1");
	const guestTrust = new ContactTrustStore({
		get: () => undefined,
		update: async () => { throw new Error("Contact storage unavailable"); },
	});
	const log = [];
	const logger = { info: (message) => log.push(message), error: (message) => log.push(message) };
	const certificates = { load: async () => certificate };
	const hostController = new RelayController(hostClient, host, logger, certificates, memoryStore(), newTrust());
	const guestController = new RelayController(guestClient, guest, logger, certificates, memoryStore(), guestTrust);
	hostController.hostedRelay.listAddresses = () => ["127.0.0.1"];

	try {
		await hostController.startHosting();
		await hostController.copyRelayInvite();
		const invite = parseRelayInvite(ui.clipboard);
		ui.input = ui.clipboard;
		ui.warningChoices.push("Join Relay");
		await guestController.joinRelayWithInvite();
		assert.match(ui.errors.at(-1), /Contact storage unavailable/);
		assert.equal(guestClient.state, "disconnected");
		assert.equal(guestClient.url, "ws://127.0.0.1:1");
		assert.equal(guestTrust.get(host.publicKey), undefined);
		assert.equal(ui.configUpdates.length, 0);
		assert.equal(log.join("\n").includes(invite.joinCode), false);
		assert.equal(JSON.stringify(ui.configUpdates).includes(invite.joinCode), false);
		assert.equal(JSON.stringify(ui.information).includes(invite.joinCode), false);
	} finally {
		guestClient.close();
		await guestController.dispose();
		await hostController.dispose();
	}
});

test("a rejected invitation preserves and reconnects the previously active relay", async () => {
	const port = await freePort();
	const { ui, vscode } = mockVSCode(port);
	const RelayController = loadController(vscode);
	const certificate = await generateRelayCertificate();
	const host = await newIdentity();
	const guest = await newIdentity();
	const logger = { info() {}, error() {} };
	const previousRelay = await startRelayServer({
		port: 0,
		host: "127.0.0.1",
		logger,
		access: accessOptions(guest),
	});
	const previousUrl = `ws://127.0.0.1:${previousRelay.port}`;
	const hostClient = new RelayClient("ws://127.0.0.1:1");
	const guestClient = new RelayClient(previousUrl);
	const guestTrust = newTrust();
	const certificates = { load: async () => certificate };
	const hostController = new RelayController(hostClient, host, logger, certificates, memoryStore(), newTrust());
	const guestController = new RelayController(guestClient, guest, logger, certificates, memoryStore(), guestTrust);
	hostController.hostedRelay.listAddresses = () => ["127.0.0.1"];

	try {
		guestClient.connect(guest);
		await waitForState(guestClient, "connected");
		await hostController.startHosting();
		await hostController.copyRelayInvite();
		ui.input = ui.clipboard;
		await hostClient.requestAdmin("rotate_code", { removeMembers: false });
		ui.warningChoices.push("Join Relay");

		await guestController.joinRelayWithInvite();
		assert.match(ui.errors.at(-1), /valid relay invitation/i);
		assert.equal(ui.configUpdates.length, 0);
		assert.equal(guestClient.url, previousUrl);
		await waitForState(guestClient, "connected");
		assert.equal(guestTrust.get(host.publicKey), undefined);
	} finally {
		guestClient.close();
		await guestController.dispose();
		await hostController.dispose();
		await previousRelay.close();
	}
});

test("a host-key clipboard failure does not undo a successful invitation join", async () => {
	const port = await freePort();
	const { ui, vscode } = mockVSCode(port);
	const RelayController = loadController(vscode);
	const certificate = await generateRelayCertificate();
	const host = await newIdentity();
	const guest = await newIdentity();
	const log = [];
	const logger = { info: (message) => log.push(message), error: (message) => log.push(message) };
	const hostClient = new RelayClient("ws://127.0.0.1:1");
	const guestClient = new RelayClient("ws://127.0.0.1:1");
	const guestTrust = newTrust();
	const certificates = { load: async () => certificate };
	const hostController = new RelayController(hostClient, host, logger, certificates, memoryStore(), newTrust());
	const guestController = new RelayController(guestClient, guest, logger, certificates, memoryStore(), guestTrust);
	hostController.hostedRelay.listAddresses = () => ["127.0.0.1"];

	try {
		await hostController.startHosting();
		await hostController.copyRelayInvite();
		ui.input = ui.clipboard;
		const invite = parseRelayInvite(ui.input);
		vscode.env.clipboard.writeText = async () => { throw new Error(ui.input); };
		ui.warningChoices.push("Join Relay");
		ui.informationChoices.push("Copy Host Key");

		await guestController.joinRelayWithInvite();
		assert.equal(ui.errors.at(-1).includes(ui.input), false, "Errors must not contain the invitation.");
		assert.equal(/clipboard/i.test(ui.errors.at(-1)), true);
		assert.equal(guestClient.state, "connected");
		assert.equal(ui.configUpdates.at(-1).value, invite.relayUrl);
		assert.equal(guestTrust.get(host.publicKey).signingKey, host.signingPublicKey);
		for (const text of [...log, ...ui.errors]) {
			assert.equal(text.includes(ui.input), false);
			assert.equal(text.includes(invite.joinCode), false);
		}
	} finally {
		guestClient.close();
		await guestController.dispose();
		await hostController.dispose();
	}
});

test("a relay-setting save failure restores the previous relay URL", async () => {
	const port = await freePort();
	const { ui, vscode } = mockVSCode(port);
	const RelayController = loadController(vscode);
	const certificate = await generateRelayCertificate();
	const host = await newIdentity();
	const guest = await newIdentity();
	const hostClient = new RelayClient("ws://127.0.0.1:1");
	const guestClient = new RelayClient("ws://127.0.0.1:2");
	const logger = { info() {}, error() {} };
	const certificates = { load: async () => certificate };
	const hostController = new RelayController(hostClient, host, logger, certificates, memoryStore(), newTrust());
	const guestController = new RelayController(guestClient, guest, logger, certificates, memoryStore(), newTrust());
	hostController.hostedRelay.listAddresses = () => ["127.0.0.1"];

	try {
		await hostController.startHosting();
		await hostController.copyRelayInvite();
		ui.input = ui.clipboard;
		ui.warningChoices.push("Join Relay");
		vscode.workspace.getConfiguration().update = async () => { throw new Error("Settings storage unavailable"); };

		await guestController.joinRelayWithInvite();
		assert.match(ui.errors.at(-1), /Settings storage unavailable/);
		assert.equal(guestClient.state, "disconnected");
		assert.equal(guestClient.url, "ws://127.0.0.1:2");
		assert.equal(ui.configUpdates.length, 0);
	} finally {
		guestClient.close();
		await guestController.dispose();
		await hostController.dispose();
	}
});
