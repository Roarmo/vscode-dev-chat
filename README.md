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
- Invitation-only relay access, proof of identity ownership, and member management with options to rotate the join code with or without removing members
- Relay protections: local-network-only connections, message size limits, rate limiting, and idle connection cleanup

Planned for the MVP release (see [Roadmap](#roadmap)): contacts, multiple conversations, and local history.

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
| Extension | [VS Code Extension API](https://code.visualstudio.com/api), Webview chat panel (HTML, CSS, JavaScript), SecretStorage for private keys and hosted relay access |
| Encryption | [libsodium](https://doc.libsodium.org/) via [`libsodium-wrappers`](https://www.npmjs.com/package/libsodium-wrappers) (X25519 sealed boxes, Ed25519 signatures), Node.js crypto for relay ownership proofs, SHA-256 identity fingerprints |
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

1. **Host a relay.** One person runs **Dev Chat: Host Relay on This Network**. Alternatively, configure and run the standalone relay; see [docs/relay-setup.md](docs/relay-setup.md).
2. **Share an invitation privately.** The administrator chooses **Copy Invite** in the hosting notification, or runs **Dev Chat: Copy Relay Invitation**. An invitation contains a secret join code, so send it only to people you want to admit.
3. **Join.** Each guest runs **Dev Chat: Join Relay with Invite**, pastes the invitation, and compares the host fingerprint with the administrator through a trusted channel before confirming. Dev Chat saves the pinned relay address and remembers a new host as an unverified contact.
4. **Open chat and exchange public keys.** Run **Dev Chat: Open Chat**. The guest can choose **Copy Host Key** after joining; the host needs the guest's public key too. Use **Copy key** in the chat panel and share it through a trusted channel, then paste the recipient's key to send a message.
5. **Verify each other (recommended).** Run **Dev Chat: Show My Fingerprint** and compare fingerprints in person or on a trusted call, then run **Dev Chat: Verify Contact Fingerprint**. Verified contacts' messages show a **Verified** badge.

Members can reconnect with **Dev Chat: Connect Relay** without pasting the invitation again. To remove members or change the code, use **Dev Chat: Manage Relay Members** or **Dev Chat: Change Relay Join Code**. See [Managing access](docs/relay-setup.md#manage-relay-access).

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
| Dev Chat: Join Relay with Invite | Validate an invitation, connect, and remember the host's public identity |
| Dev Chat: Copy Relay Invitation | Copy an invitation for the relay you administer |
| Dev Chat: Manage Relay Members | View and remove members of the relay you administer |
| Dev Chat: Change Relay Join Code | Replace the code, choosing whether to keep or remove existing members |

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
- Invitations contain a secret join code and a pinned `wss://` address. Dev Chat sends the code only after checking the relay's certificate (or over loopback during development). Invitations are signed, but you still need to compare the host fingerprint through a trusted channel. See [Encrypted connections](docs/relay-setup.md#encrypted-connections).
- The relay requires a valid invitation for new members, and every connection proves possession of both identity private keys. An invite holder can join as themselves, but cannot take over another member's identity without their keys. Invitations are reusable until the code changes; share them privately.
- Removing a member disconnects them but does not change the join code. If they still have an invitation, change the code as well. The administrator can keep other members or remove them all when rotating the code.
- The relay forwards ciphertext. It can see routing metadata: public keys, who messages whom, when, message sizes, and IP addresses. See [What the relay can see](docs/relay-setup.md#what-the-relay-can-see).

Current limitations, all tracked for the MVP:

- **Invitations are reusable and do not expire individually** ([#34](https://github.com/Roarmo/vscode-dev-chat/issues/34)); rotate the code if an invitation leaks.
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

The extension tests build both packages and cover key storage, encryption, message signing and contact trust, relay invitations and member management, relay certificate pinning over `wss://`, and an encrypted message round trip through a real relay. Standalone tests also cover protected access-state storage.

## Roadmap

### MVP (first Marketplace release)

- Contacts, so you don't need to paste public keys every time ([#26](https://github.com/Roarmo/vscode-dev-chat/issues/26))
- Multiple conversations and local history ([#28](https://github.com/Roarmo/vscode-dev-chat/issues/28))
- Dev Chat actions in the UI: sidebar, chat panel buttons, and status bar ([#37](https://github.com/Roarmo/vscode-dev-chat/issues/37))
- In-editor Getting Started instructions ([#38](https://github.com/Roarmo/vscode-dev-chat/issues/38))
- Identity key lifecycle and key-loss handling ([#30](https://github.com/Roarmo/vscode-dev-chat/issues/30))
- Relay hardening ([#23](https://github.com/Roarmo/vscode-dev-chat/issues/23)) and Marketplace readiness ([#29](https://github.com/Roarmo/vscode-dev-chat/issues/29))

### Later

- Public hosted relay option ([#32](https://github.com/Roarmo/vscode-dev-chat/issues/32))
- Personal invites and admin roles ([#34](https://github.com/Roarmo/vscode-dev-chat/issues/34))
- Group chat, file sharing, and presence

## Contributing

Issues and pull requests are welcome. Check the [open issues](https://github.com/Roarmo/vscode-dev-chat/issues) for planned work, and run both test suites before opening a pull request. The extension package is restricted to compiled scripts, media, and production dependencies; inspect package contents before publishing. Never commit or package secrets, private keys, invitations, access files, or `.env` files.

## License

[MIT](LICENSE)
