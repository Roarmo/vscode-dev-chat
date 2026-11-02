# Local Encrypted Chat Demo

## Prerequisites

- Node.js 20 or newer
- VS Code with this repository open

## Run the relay

From the repository root, install dependencies and start the relay in a terminal:

```powershell
npm --prefix server install
npm --prefix extension install
npm --prefix server run build
npm --prefix server start
```

The relay listens at `ws://127.0.0.1:8787` by default.

## Run two extension hosts

In a second terminal, build the extension and launch the first isolated Extension Development Host:

```powershell
npm --prefix extension run build
code --new-window --user-data-dir "$env:TEMP\dev-chat-host-a" --extensionDevelopmentPath "$PWD\extension" "$PWD"
```

Run the same `code` command in another terminal with a different data directory, such as `dev-chat-host-b`, to launch the second host. Separate data directories ensure each host creates its own local keypair.

In both hosts:

1. Run **Dev Chat: Connect Relay** from the Command Palette.
2. Run **Dev Chat: Open Chat** and wait for the connection status to show `connected`.
3. Copy the public key shown in one host and paste it into the recipient field in the other host.
4. Send a message, then reverse the recipient keys to reply.

The relay routes ciphertext; it cannot decrypt message content. This demo does not authenticate sender identities, so only exchange keys with people through a channel you trust.

## Run automated checks

From the repository root:

```powershell
npm --prefix server test
npm --prefix extension test
```

The extension test command builds both packages and checks key persistence, encryption/decryption, and an encrypted message round trip through a temporary relay process.