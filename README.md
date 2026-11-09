# VS Code Dev Chat

End-to-end encrypted messaging for developers directly inside VS Code.

> **Status: early development (pre-MVP).** One-to-one encrypted chat works between VS Code instances on the same local network. It is not yet published to the VS Code Marketplace. See [Roadmap](#roadmap) for what is still missing before the first release.

## Overview

VS Code Dev Chat is a Visual Studio Code extension for secure developer-to-developer communication without leaving the editor. Messages are encrypted on your machine before they are sent, and a small relay server only forwards encrypted data it cannot read.

Developers regularly jump between their editor and chat tools like Slack or Discord when discussing code. That breaks focus and can expose internal snippets to systems that were not designed for end-to-end privacy. Dev Chat keeps the conversation inside the editor and encrypts it on the client.

## Features

Available now:

- End-to-end encrypted one-to-one messages using [libsodium](https://doc.libsodium.org/) sealed boxes
- Signed messages: every message is signed with the sender's Ed25519 key, and forged, tampered, replayed or stale messages are rejected
- Contact verification: compare short identity fingerprints with a contact to mark them as verified; if a contact's key changes, their messages are held until you review the change
- Encryption and signing key pairs generated on first run, with the private keys kept in VS Code's secret storage
- A chat panel inside VS Code with delivery status, failure reasons, and connection retry
- Two ways to run a relay on your local network: host it from VS Code with one command, or run the standalone relay (Node.js or Docker) on a home or office server
- Encrypted relay connections (`wss://`) with certificate pinning: the relay address you share includes its certificate fingerprint, so nobody on the network can impersonate the relay
- Relay protections: local-network-only connections, message size limits, rate limiting, and idle connection cleanup

Planned for the MVP release (see [Roadmap](#roadmap)): join codes, contacts, multiple conversations, and local history.

## How It Works

```text
VS Code Client A
	|
	| encrypt and sign message locally
	v
Relay Server (WebSocket transport only)
	|
	| forward ciphertext
	v
VS Code Client B
	|
	| verify signature, then decrypt locally
	v
Readable message
```

Encryption and decryption happen entirely on the client. The relay is responsible for transport, not trust. See [docs/end-to-end-flow.md](docs/end-to-end-flow.md) for the full message flow.

## Tech Stack

| Area | Technologies |
| --- | --- |
| Language | [TypeScript](https://www.typescriptlang.org/) (strict mode), compiled to CommonJS |
| Extension | [VS Code Extension API](https://code.visualstudio.com/api), Webview chat panel (HTML, CSS, JavaScript), SecretStorage for private keys |
| Encryption | [libsodium](https://doc.libsodium.org/) via [`libsodium-wrappers`](https://www.npmjs.com/package/libsodium-wrappers) (X25519 sealed boxes, Ed25519 signatures), SHA-256 identity fingerprints |
| Relay | [Node.js](https://nodejs.org/) 20+, [`ws`](https://www.npmjs.com/package/ws) WebSockets, Node `https`/`tls` for `wss://` |
| Relay certificates | [`selfsigned`](https://www.npmjs.com/package/selfsigned) (ECDSA P-256), SHA-256 certificate pinning |
| Testing | Node's built-in test runner (`node:test`) with integration tests against a real relay |
| Packaging | [Docker](https://www.docker.com/) (`node:22-alpine`) for the standalone relay |

## Getting Started

Dev Chat is not on the Marketplace yet, so it currently runs from source. You need [Node.js](https://nodejs.org/) 20 or newer and VS Code 1.90 or newer.

```sh
git clone https://github.com/Roarmo/vscode-dev-chat.git
cd vscode-dev-chat
npm --prefix server install
npm --prefix extension install
```

Open the repository in VS Code and press **F5** (**Run VS Code Dev Chat Extension**) to start an Extension Development Host with Dev Chat loaded.

### Chat with someone on your network

1. **Get a relay.** One person runs **Dev Chat: Host Relay on This Network** and shares the address it shows, for example `wss://192.168.1.20:8787#sha256=6E:37:...`. Alternatively, run the standalone relay on a server. See [docs/relay-setup.md](docs/relay-setup.md).
2. **Point Dev Chat at the relay.** Everyone else sets **Dev Chat › Relay Url** (`devChat.relayUrl`) to that full address, including the `#sha256=` fingerprint. The host does not need to change anything.
3. **Connect.** Run **Dev Chat: Connect Relay**, then **Dev Chat: Open Chat**.
4. **Exchange public keys.** Use **Copy key** in the chat panel and send your key to the other person through a channel you trust. Paste their key into the recipient field and send a message.
5. **Verify each other (recommended).** Run **Dev Chat: Show My Fingerprint** and compare fingerprints in person or on a call, then run **Dev Chat: Verify Contact Fingerprint** to mark the contact as verified. Their messages then show a **Verified** badge.

To try two clients on a single computer, follow [docs/demo.md](docs/demo.md).

## Commands

| Command | Description |
| --- | --- |
| Dev Chat: Connect Relay | Connect to the relay set in `devChat.relayUrl` |
| Dev Chat: Open Chat | Open the chat panel |
| Dev Chat: Show My Fingerprint | Show (and copy) your identity fingerprint to compare with a contact |
| Dev Chat: Verify Contact Fingerprint | Compare a contact's fingerprint with yours and mark them as verified or not verified |
| Dev Chat: Review Contact Key Changes | Accept or discard messages held because a contact's identity key changed |
| Dev Chat: Host Relay on This Network | Run a relay inside VS Code for people on your local network |
| Dev Chat: Stop Hosting Relay | Stop the hosted relay and disconnect everyone using it |
| Dev Chat: Regenerate Hosted Relay Certificate | Replace the hosted relay's certificate (everyone then needs the new address) |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `devChat.relayUrl` | `ws://127.0.0.1:8787` | Relay address to connect to, for example `wss://192.168.1.20:8787#sha256=...`. `ws://` is only allowed for a relay on this computer. Stored per machine. |
| `devChat.hostRelay.port` | `8787` | Port used when hosting a relay from VS Code |

## Security Model

- Messages are encrypted on the sender's machine for the recipient's public key; only the recipient's private key can decrypt them.
- Every message is signed with the sender's Ed25519 signing key. The signature covers the sender, recipient, message ID, send time and ciphertext, so the relay or anyone else cannot forge, alter, redirect or replay a message. Unsigned, tampered, replayed and stale messages are rejected.
- Contacts are trusted on first use. A contact's identity fingerprint (a hash of their encryption and signing keys) can be compared out of band to mark them as verified. If a contact's key changes, their messages are held, still encrypted, until you accept or discard the new key; accepting resets the contact to not verified.
- Private keys stay on the local machine in VS Code's secret storage and are never sent to the relay.
- Relay connections use `wss://`. The relay address includes the SHA-256 fingerprint of the relay's certificate, and Dev Chat refuses to connect if the relay presents a different certificate. See [Encrypted connections](docs/relay-setup.md#encrypted-connections).
- The relay forwards ciphertext. It can see routing metadata: public keys, who messages whom, when, message sizes, and IP addresses. See [What the relay can see](docs/relay-setup.md#what-the-relay-can-see).

Current limitations, all tracked for the MVP:

- **Anyone on the same network who knows the relay address can connect** ([#33](https://github.com/Roarmo/vscode-dev-chat/issues/33)).
- **Losing the private key means losing that identity** ([#30](https://github.com/Roarmo/vscode-dev-chat/issues/30)).

## Project Structure

```text
vscode-dev-chat/
  extension/   VS Code extension (commands, relay client, encryption, chat panel in media/)
  server/      Standalone relay server and its Dockerfile
  shared/      Protocol types and relay core used by both the extension and the server
  docs/        Setup guides and design notes
```

## Development

Run the automated tests from the repository root:

```sh
npm --prefix server test
npm --prefix extension test
```

The extension tests build both packages and cover key storage, encryption, message signing and contact trust, relay hosting, relay certificate pinning over `wss://`, and an encrypted message round trip through a real relay.

## Roadmap

### MVP (first Marketplace release)

- Relay join codes ([#33](https://github.com/Roarmo/vscode-dev-chat/issues/33))
- Contacts, so you don't need to paste public keys every time ([#26](https://github.com/Roarmo/vscode-dev-chat/issues/26))
- Multiple conversations and local history ([#28](https://github.com/Roarmo/vscode-dev-chat/issues/28))
- Identity key lifecycle and key-loss handling ([#30](https://github.com/Roarmo/vscode-dev-chat/issues/30))
- Relay hardening ([#23](https://github.com/Roarmo/vscode-dev-chat/issues/23)) and Marketplace readiness ([#29](https://github.com/Roarmo/vscode-dev-chat/issues/29))

### Later

- Public hosted relay option ([#32](https://github.com/Roarmo/vscode-dev-chat/issues/32))
- Personal invites and admin roles ([#34](https://github.com/Roarmo/vscode-dev-chat/issues/34))
- Group chat, file sharing, and presence

## Contributing

Issues and pull requests are welcome. Check the [open issues](https://github.com/Roarmo/vscode-dev-chat/issues) for planned work, and run both test suites before opening a pull request. Never commit secrets, private keys, or `.env` files.

## License

[MIT](LICENSE)
