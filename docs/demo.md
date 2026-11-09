# Local Encrypted Chat Demo

## Prerequisites

- Node.js 20 or newer
- VS Code with this repository open and a PowerShell terminal

## Run the relay

From the repository root, install dependencies and start the relay in a terminal:

```powershell
npm --prefix server install
npm --prefix extension install
npm --prefix server run build
npm --prefix server start
```

The relay serves encrypted `wss://` connections with a self-signed certificate it creates on first start (stored in `server/relay-data/`, which git ignores). Copy the full **This machine** address it prints, for example `wss://127.0.0.1:8787#sha256=6E:37:...`, and set **Dev Chat › Relay Url** (`devChat.relayUrl`) to it in both extension hosts. You can also skip this step and run **Dev Chat: Host Relay on This Network** in Host A instead, then paste the address it shows into Host B; see [Relay Setup](relay-setup.md).

## Run two extension hosts

VS Code reuses a development window for the same extension path. Prepare a temporary copy with a different extension ID so that the two hosts also have separate secret-storage keys. From the repository root in a second PowerShell terminal:

```powershell
npm --prefix extension run build
$demoPath = Join-Path $env:TEMP 'dev-chat-demo-host-b'
if (Test-Path $demoPath) { throw "Demo folder already exists: $demoPath" }
New-Item -ItemType Directory -Path $demoPath
Get-Item extension/package.json,extension/dist,extension/media,extension/node_modules | Copy-Item -Destination $demoPath -Recurse
$manifestPath = Join-Path $demoPath 'package.json'
$manifest = Get-Content -Raw $manifestPath | ConvertFrom-Json
$manifest.name = 'dev-chat-demo-host-b'
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 100), [System.Text.UTF8Encoding]::new($false))
```

If the demo folder already exists, choose another name and use that same name in the Host B launch path below. The copy is a snapshot: rebuild and create a fresh copy after changing the extension.

In `.vscode/launch.json`, temporarily add the following two objects to the existing `configurations` array, keeping the original **Run VS Code Dev Chat Extension** configuration:

```json
[
	{
		"name": "Dev Chat Demo Host A",
		"type": "extensionHost",
		"request": "launch",
		"runtimeExecutable": "${execPath}",
		"args": [
			"--extensionDevelopmentPath=${workspaceFolder}/extension",
			"--user-data-dir=${env:TEMP}/dev-chat-demo-data-a"
		],
		"outFiles": ["${workspaceFolder}/extension/dist/**/*.js"],
		"preLaunchTask": "build-extension"
	},
	{
		"name": "Dev Chat Demo Host B",
		"type": "extensionHost",
		"request": "launch",
		"runtimeExecutable": "${execPath}",
		"args": [
			"--extensionDevelopmentPath=${env:TEMP}/dev-chat-demo-host-b",
			"--user-data-dir=${env:TEMP}/dev-chat-demo-data-b"
		],
		"outFiles": ["${env:TEMP}/dev-chat-demo-host-b/dist/**/*.js"]
	}
]
```

Copy the two objects inside the outer brackets into the existing array; do not add a nested array.

Add this `compounds` property alongside `configurations` in the same file:

```json
"compounds": [
	{
		"name": "Dev Chat Two-Host Demo",
		"configurations": ["Dev Chat Demo Host A", "Dev Chat Demo Host B"]
	}
]
```

In the original project window, open **Run and Debug**, select **Dev Chat Two-Host Demo**, and start it. Two Extension Development Host windows should open. If one host replaces the other, check that Host B's development path points to the temporary copy, not the original extension folder.

In both hosts:

1. Run **Dev Chat: Connect Relay** from the Command Palette.
2. Run **Dev Chat: Open Chat** and wait for the connection status to show `connected`.
3. Confirm that the public keys differ, then use **Copy key** to paste one host's public key into the other host's recipient field.
4. Send a message, then reverse the recipient keys to reply. Each message should appear in the other host and show a sent indicator in the sender.

When finished, close both hosts and remove the temporary launch entries. You may delete the temporary extension copy; its test identity can remain in VS Code secret storage. Do not delete your regular identity or profile.

The relay routes ciphertext; it cannot decrypt message content. This demo does not authenticate sender identities, so only exchange keys with people through a channel you trust.

## Run automated checks

From the repository root:

```powershell
npm --prefix server test
npm --prefix extension test
```

The extension test command builds both packages and checks key persistence, encryption/decryption, an encrypted message round trip through a temporary relay process, and relay certificate pinning over `wss://`.