const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { FileRelayAccessStore } = require("../dist/server/src/fileRelayAccessStore.js");
const authentication = require("../dist/shared/relayAuthentication.js");
const { createIdentity } = require("../../test-support/relay.cjs");

function assertPrivateAccess(filePath) {
	if (process.platform !== "win32") {
		assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
		return;
	}
	const encodedPath = Buffer.from(filePath, "utf8").toString("base64");
	const script = [
		"$ErrorActionPreference = 'Stop'",
		"$ProgressPreference = 'SilentlyContinue'",
		`$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`,
		"$acl = Get-Acl -LiteralPath $path",
		"$expected = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
		"$allow = @($acl.Access | Where-Object { $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow })",
		"if (-not $acl.AreAccessRulesProtected -or $allow.Count -ne 1 -or $allow[0].IsInherited) { exit 1 }",
		"$actual = $allow[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value",
		"if ($actual -ne $expected) { exit 2 }",
		"if (($allow[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { exit 3 }",
		"'OK'",
	].join("; ");
	const encodedScript = Buffer.from(script, "utf16le").toString("base64");
	const result = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript], {
		encoding: "utf8",
		windowsHide: true,
	});
	assert.equal(result.trim(), "OK");
}

test("stores access state atomically with owner-only permissions and reloads it", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "devchat-access-test-"));
	const file = path.join(directory, "relay-access.json");
	const warnings = [];
	const store = new FileRelayAccessStore(file, (message) => warnings.push(message));
	const identity = createIdentity(authentication);
	const state = {
		version: 1,
		joinCode: authentication.generateJoinCode(),
		revision: 1,
		members: [{ publicKey: identity.publicKey, signingKey: identity.signingPublicKey }],
	};
	try {
		assert.equal(await store.load(), undefined);
		await store.save(state);
		assertPrivateAccess(file);
		assert.deepEqual(await store.load(), state);

		const changed = { ...state, revision: 2, joinCode: authentication.generateJoinCode() };
		await store.save(changed);
		assertPrivateAccess(file);
		assert.deepEqual(await store.load(), changed);
		assert.deepEqual(fs.readdirSync(directory), ["relay-access.json"]);
		assert.deepEqual(warnings, []);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("rejects malformed or non-file state without exposing its contents", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "devchat-access-test-"));
	const file = path.join(directory, "relay-access.json");
	const secret = authentication.generateJoinCode();
	try {
		fs.writeFileSync(file, `invalid-json-${secret}`);
		const store = new FileRelayAccessStore(file);
		await assert.rejects(store.load(), (error) =>
			/not valid JSON/i.test(error.message) && !error.message.includes(secret)
		);
		fs.unlinkSync(file);
		fs.mkdirSync(file);
		await assert.rejects(store.load(), /regular file/i);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
