const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const serverPath = path.join(__dirname, "..", "dist", "server", "src", "server.js");

test("standalone startup requires a valid administrator without logging the join code", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "devchat-config-test-"));
	const code = randomBytes(32).toString("base64url");
	try {
		for (const administrator of ["", "not-a-public-key"]) {
			const result = spawnSync(process.execPath, [serverPath], {
				cwd: directory,
				encoding: "utf8",
				env: {
					...process.env,
					DATA_DIR: directory,
					RELAY_ACCESS_FILE: "",
					RELAY_ADMIN_PUBLIC_KEY: administrator,
					RELAY_JOIN_CODE: code,
					TLS_CERT_FILE: "",
					TLS_KEY_FILE: "",
					TLS_DISABLED: "false",
					PORT: "8787",
				},
			});
			assert.equal(result.status, 1);
			const output = result.stdout + result.stderr;
			assert.match(output, /relay administrator/i);
			assert.equal(output.includes(code), false);
		}
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
