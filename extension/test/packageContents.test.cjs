const assert = require("node:assert/strict");
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

test("the npm package includes runtime files but excludes local secrets and development files", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "devchat-package-test-"));
	const manifest = require("../package.json");
	try {
		fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(manifest));
		fs.copyFileSync(path.join(__dirname, "..", ".npmignore"), path.join(directory, ".npmignore"));
		fs.mkdirSync(path.join(directory, "dist", "extension", "src"), { recursive: true });
		fs.mkdirSync(path.join(directory, "dist", "relay-data"), { recursive: true });
		fs.mkdirSync(path.join(directory, "media"), { recursive: true });
		fs.mkdirSync(path.join(directory, "media", "walkthroughs"), { recursive: true });
		for (const [file, content] of [
			["dist/extension/src/extensions.js", "module.exports = {};"],
			["dist/extension/src/extensions.js.map", "{}"],
			["media/chat.js", ""],
			["media/chat.css", ""],
			["media/dev-chat.svg", "<svg></svg>"],
			["media/dev-chat-marketplace.png", "PNG"],
			["media/getting-started.md", "# Getting started"],
			["media/walkthroughs/get-relay.md", "# Get a relay"],
			[".env", "DUMMY_TEST_VALUE"],
			["relay-access.json", "DUMMY_TEST_VALUE"],
			["dist/private.pem", "DUMMY_TEST_VALUE"],
			["dist/relay-data/access.js", "DUMMY_TEST_VALUE"],
			["media/.env", "DUMMY_TEST_VALUE"],
			["media/.env.local.js", "DUMMY_TEST_VALUE"],
			["media/notes.txt", "DUMMY_TEST_VALUE"],
			["development-notes.txt", "DUMMY_TEST_VALUE"],
		]) {
			fs.writeFileSync(path.join(directory, file), content);
		}
		const result = execSync("npm pack --dry-run --json", {
			cwd: directory,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const files = JSON.parse(result)[0].files.map((file) => file.path);
		for (const expected of [
			"dist/extension/src/extensions.js",
			"media/chat.js",
			"media/chat.css",
			"media/dev-chat.svg",
			"media/dev-chat-marketplace.png",
			"media/getting-started.md",
			"media/walkthroughs/get-relay.md",
		]) {
			assert.ok(files.includes(expected), `${expected} must be included`);
		}
		assert.equal(files.includes("dist/extension/src/extensions.js.map"), false, "source maps must be excluded");
		for (const excluded of [
			".env",
			"relay-access.json",
			"dist/private.pem",
			"dist/relay-data/access.js",
			"media/.env",
			"media/.env.local.js",
			"media/notes.txt",
			"development-notes.txt",
		]) {
			assert.equal(files.includes(excluded), false, `${excluded} must be excluded`);
		}
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
