const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

test("registers contributed commands and opens the bundled instructions", async () => {
	const handlers = new Map();
	const executed = [];
	const errors = [];
	const logged = [];
	let previewFails = false;
	let copiedAddresses = 0;
	const vscode = {
		Uri: { joinPath: (...segments) => segments.join("/") },
		window: { showErrorMessage: async (message) => { errors.push(message); } },
		commands: {
			registerCommand: (id, handler) => {
				handlers.set(id, handler);
				return { dispose() {} };
			},
			executeCommand: async (...args) => {
				executed.push(args);
				if (previewFails) throw new Error("markdown preview unavailable");
			},
		},
	};
	const modulePath = path.join(__dirname, "../dist/extension/src/commands/registerCommands.js");
	delete require.cache[require.resolve(modulePath)];
	const originalLoad = Module._load;
	let registerCommands;
	try {
		Module._load = function(request, parent, isMain) {
			return request === "vscode" ? vscode : originalLoad.call(this, request, parent, isMain);
		};
		({ registerCommands } = require(modulePath));
	} finally {
		Module._load = originalLoad;
	}

	const context = { extensionUri: "extension", subscriptions: [] };
	const logger = { info() {}, error: (message) => logged.push(message) };
	registerCommands(context, logger, {}, {
		copyRelayAddress: async () => { copiedAddresses++; },
	}, {}, {}, {}, {});

	const contributed = require("../package.json").contributes.commands
		.map((command) => command.command)
		.filter((command) => command !== "devChat.resetIdentity");
	assert.deepEqual([...handlers.keys()].sort(), contributed.sort());
	assert.equal(context.subscriptions.length, contributed.length);
	await handlers.get("devChat.copyRelayAddress")();
	assert.equal(copiedAddresses, 1);
	await handlers.get("devChat.openInstructions")();
	assert.deepEqual(executed[0], ["markdown.showPreview", "extension/media/getting-started.md"]);

	previewFails = true;
	await handlers.get("devChat.openInstructions")();
	assert.match(logged[0], /markdown preview unavailable/);
	assert.match(errors[0], /could not open its instructions/i);
});
