import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { chmod, lstat, mkdir, readFile, rename, rmdir, unlink, writeFile } from "fs/promises";
import * as path from "path";
import { promisify } from "util";
import type { RelayAccessState, RelayAccessStore } from "../../shared/relayAccess";

const execFileAsync = promisify(execFile);

async function restrictAccess(target: string, directory: boolean): Promise<void> {
	if (process.platform !== "win32") {
		await chmod(target, directory ? 0o700 : 0o600);
		return;
	}
	try {
		const encodedPath = Buffer.from(target, "utf8").toString("base64");
		const infoType = directory ? "DirectoryInfo" : "FileInfo";
		const inheritance = directory
			? "[System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit"
			: "[System.Security.AccessControl.InheritanceFlags]::None";
		const script = [
			"$ErrorActionPreference = 'Stop'",
			"$ProgressPreference = 'SilentlyContinue'",
			`$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`,
			"$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
			`$info = [System.IO.${infoType}]::new($path)`,
			"$sections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner",
			"$acl = $info.GetAccessControl($sections)",
			"if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Relay access state has a different owner.' }",
			"$acl.SetAccessRuleProtection($true, $false)",
			"foreach ($existing in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($existing) }",
			`$inheritance = ${inheritance}`,
			"$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)",
			"$acl.AddAccessRule($rule)",
			"$info.SetAccessControl($acl)",
		].join("; ");
		const encodedScript = Buffer.from(script, "utf16le").toString("base64");
		await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript], {
			windowsHide: true,
		});
	} catch {
		throw new Error("Could not restrict relay access file permissions. Check that Windows PowerShell is available and the relay owns its data directory.");
	}
}

/** Stores relay access data, including the join code, in a local private file. */
export class FileRelayAccessStore implements RelayAccessStore {
	constructor(
		private readonly filePath: string,
		private readonly warn: (message: string) => void = (message) => console.error(`[relay] ${message}`)
	) {}

	public async load(): Promise<unknown> {
		let content: string;
		try {
			const stats = await lstat(this.filePath);
			if (!stats.isFile()) throw new Error("The relay access path must be a regular file, not a link.");
			await restrictAccess(this.filePath, false);
			content = await readFile(this.filePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		try {
			return JSON.parse(content) as unknown;
		} catch {
			throw new Error("Stored relay access state is not valid JSON.");
		}
	}

	public async save(state: RelayAccessState): Promise<void> {
		const parent = path.dirname(this.filePath);
		await mkdir(parent, { recursive: true, mode: 0o700 });
		const temporaryDirectory = path.join(parent, `.devchat-access-${randomUUID()}`);
		const temporaryFile = path.join(temporaryDirectory, "access.json");
		let createdDirectory = false;
		try {
			await mkdir(temporaryDirectory, { mode: 0o700 });
			createdDirectory = true;
			await restrictAccess(temporaryDirectory, true);
			await writeFile(temporaryFile, JSON.stringify(state), { encoding: "utf8", mode: 0o600, flag: "wx" });
			await restrictAccess(temporaryFile, false);
			await rename(temporaryFile, this.filePath);
		} catch (error) {
			if (createdDirectory) {
				try {
					await unlink(temporaryFile);
				} catch (cleanupError) {
					if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
						this.warn("Could not remove a temporary relay access file after a storage failure.");
					}
				}
				try {
					await rmdir(temporaryDirectory);
				} catch (cleanupError) {
					if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
						this.warn("Could not remove a temporary relay access directory after a storage failure.");
					}
				}
			}
			throw error;
		}
		try {
			await rmdir(temporaryDirectory);
		} catch {
			this.warn("Could not remove an empty temporary relay access directory.");
		}
	}
}
