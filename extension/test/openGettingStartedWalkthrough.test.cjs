const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

function loadOpener(executeCommand) {
	const vscode = { commands: { executeCommand } };
	const modulePath = path.join(__dirname, "../dist/extension/src/ui/openGettingStartedWalkthrough.js");
	delete require.cache[require.resolve(modulePath)];
	const originalLoad = Module._load;
	let openGettingStartedWalkthrough;
	try {
		Module._load = function(request, parent, isMain) {
			return request === "vscode" ? vscode : originalLoad.call(this, request, parent, isMain);
		};
		({ openGettingStartedWalkthrough } = require(modulePath));
	} finally {
		Module._load = originalLoad;
	}
	return openGettingStartedWalkthrough;
}

test("opens the walkthrough once and persists the first-run marker", async () => {
	const executed = [];
	const updates = [];
	const openGettingStartedWalkthrough = loadOpener(async (...args) => executed.push(args));
	let opened = false;
	const context = {
		extension: { id: "roarmo.extension" },
		globalState: {
			get: (_key, fallback) => opened || fallback,
			update: async (key, value) => {
				updates.push([key, value]);
				opened = value;
			},
		},
	};
	const logger = { error() { assert.fail("successful walkthrough opening should not log an error"); } };

	await openGettingStartedWalkthrough(context, logger);
	await openGettingStartedWalkthrough(context, logger);

	assert.deepEqual(executed, [[
		"workbench.action.openWalkthrough",
		"roarmo.extension#devChat.gettingStarted",
		false,
	]]);
	assert.deepEqual(updates, [["devChat.gettingStarted.opened", true]]);
});

test("does not mark the walkthrough opened when VS Code cannot open it", async () => {
	const errors = [];
	const updates = [];
	const openGettingStartedWalkthrough = loadOpener(async () => {
		throw new Error("walkthrough command unavailable");
	});
	const context = {
		extension: { id: "roarmo.extension" },
		globalState: {
			get: (_key, fallback) => fallback,
			update: async (...args) => updates.push(args),
		},
	};

	await openGettingStartedWalkthrough(context, { error: (message) => errors.push(message) });

	assert.equal(updates.length, 0);
	assert.match(errors[0], /walkthrough command unavailable/);
});
