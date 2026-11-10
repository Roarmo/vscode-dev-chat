# Local Encrypted Chat Demo

## Prerequisites

- Node.js 20 or newer
- VS Code with this repository open and a PowerShell terminal

## Prepare the extension

From the repository root, install dependencies and build the extension:

```powershell
npm --prefix server install
npm --prefix extension install
npm --prefix extension run build
```

The simplest demo uses the relay hosted inside Host A. An active local network address is needed for the hosted relay's invitation.

## Run two extension hosts

VS Code reuses a development window for the same extension path. Prepare a temporary copy with a different extension ID so that the two hosts also have separate secret-storage keys. From the repository root in a second PowerShell terminal:

```powershell
$demoPath = Join-Path $env:TEMP 'dev-chat-demo-host-b'
if (Test-Path $demoPath) { throw "Demo folder already exists: $demoPath" }
New-Item -ItemType Directory -Path $demoPath
Get-Item extension\package.json,extension\dist,extension\media,extension\node_modules | Copy-Item -Destination $demoPath -Recurse
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

1. Open **Dev Chat** in each host's Activity Bar. In Host A, choose **Host Relay on This Network** and then **Copy Invite**. If prompted, choose an address reachable from Host B.
2. In Host B, choose **Join Relay with Invite**, paste the invitation, and compare the host fingerprint with Host A's **Show My Fingerprint** before confirming. Choose **Copy Host Key** if you want to add the host as a contact.
3. In both hosts, choose **Open Chat** and wait for the connection status to show `connected`.
4. Confirm that their public keys differ. Use **Copy key** in each chat panel, and under **Manage contacts** add the other host's name and public key. Select the saved contact, then compare **Selected key fingerprint** with **Your key fingerprint** in the other host.
5. Send a message, then reply from the other host. Each message should appear in the other host and show a sent indicator in the sender. Incoming messages show a **Not verified** badge.
6. In each host, choose **Verify Contact Fingerprint** in the sidebar or **Verify contact** in the chat panel, pick the other host's key, check that the identity fingerprint matches **Show My Fingerprint** in the other host, and choose **Mark as Verified**. The badge on that contact's messages changes to **Verified**. The identity fingerprint covers both keys and differs from the encryption key fingerprint in step 4.
7. Close and reopen a chat panel, or restart the extension host; confirm that the saved contact and encrypted local message history are still available.
8. Test access management from Host A: remove Host B, or change the code with the keep-members and remove-all options. Share a fresh invitation privately when Host B needs to join again.

When finished, close both hosts and remove the temporary launch entries. You may delete the temporary extension copy; its test identity can remain in VS Code secret storage. Do not delete your regular identity or profile.

The relay routes signed ciphertext; it cannot decrypt, forge or alter message content.

### Try the standalone relay instead

Stop hosting the built-in relay. Copy Host A's public key from its chat panel, set `RELAY_ADMIN_PUBLIC_KEY` to that value in the terminal, then build and start the standalone server as described in [Relay Setup](relay-setup.md#option-2-standalone-relay). Configure Host A with the full printed `wss://` address and fingerprint, connect, and use **Dev Chat: Copy Relay Invitation**. Host B can join with that invitation. The code is kept in the protected access file, not printed in server logs.

This same-computer demo is not a substitute for testing both relay modes between two physical machines on a LAN before release.

## Run automated checks

From the repository root:

```powershell
npm --prefix server test
npm --prefix extension test
```

The extension test command builds both packages and checks key persistence, encryption/decryption, invitation and membership flows, an encrypted message round trip through a temporary relay process, and relay certificate pinning over `wss://`.