const assert = require("node:assert/strict");
const { execSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

test("the Marketplace identity and VSCE exclusion strategy are configured", () => {
	const manifest = require("../package.json");
	assert.equal(manifest.publisher, "Roarmo");
	assert.equal(manifest.name, "vscode-dev-chat");
	assert.equal(manifest.files, undefined, "VSCE uses .vscodeignore instead of a manifest files allowlist");
});

test("the VSIX file list includes release assets and excludes development artifacts and secrets", () => {
	const extensionDirectory = path.resolve(__dirname, "..");
	const output = execSync("npm run package:files", {
		cwd: extensionDirectory,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const files = output
		.split(/\r?\n/)
		.map((file) => file.trim())
		.filter((file) => file !== "" && !file.startsWith(">"));

	for (const expected of [
		"LICENSE",
		"README.md",
		"package.json",
		"dist/extension/src/extensions.js",
		"media/dev-chat-marketplace.png",
	]) {
		assert.ok(files.includes(expected), `${expected} must be included in the VSIX`);
	}
	assert.ok(files.some((file) => file.startsWith("node_modules/libsodium-wrappers/")), "production dependencies must be included");

	const allowedPatterns = [
		/^(?:LICENSE|README\.md|package\.json)$/,
		/^dist\/.*\.js$/i,
		/^media\/.*\.(?:js|css|svg|png|md)$/i,
		/^node_modules\/.+/i,
	];
	const unexpectedFiles = files.filter((file) => !allowedPatterns.some((pattern) => pattern.test(file)));
	assert.deepEqual(unexpectedFiles, [], "the VSIX must not include files outside the release assets");

	const excludedPatterns = [
		/\.map$/i,
		/\.ts$/i,
		/^(?:src|test|scripts|coverage)\//i,
		/^node_modules\/.*\/(?:test|tests|__tests__|coverage)\//i,
		/(^|\/)\.env(?:\.|$)/i,
		/\.(?:key|pem|crt|p12|pfx)$/i,
		/(^|\/)relay-access\.json$/i,
		/(^|\/)relay-data(?:\/|$)/i,
		/(^|\/)\.devchat-access-/i,
		/\.vsix$/i,
		/^node_modules\/(?:@vscode\/vsce|@types|typescript)(?:\/|$)/i,
	];
	for (const pattern of excludedPatterns) {
		assert.equal(files.some((file) => pattern.test(file)), false, `${pattern} must not match packaged files`);
	}
});
