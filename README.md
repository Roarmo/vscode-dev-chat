# VS Code Dev Chat

End-to-end encrypted messaging for developers directly inside VS Code.

> **Status: MVP in progress.** One-to-one encrypted chat works between VS Code instances on the same local network. It is not yet published to the VS Code Marketplace. See [Roadmap](#roadmap) for what is still missing before the first release.

## Overview

VS Code Dev Chat is a Visual Studio Code extension for secure developer-to-developer communication without leaving the editor. Messages are encrypted on your machine before they are sent, and a small relay server only forwards encrypted data it cannot read.

Developers regularly jump between their editor and chat tools like Slack or Discord when discussing code. That breaks focus and can expose internal snippets to systems that were not designed for end-to-end privacy. Dev Chat keeps the conversation inside the editor and encrypts it on the client.

## Features

Available now:

- End-to-end encrypted one-to-one messages using [libsodium](https://doc.libsodium.org/) sealed boxes
- Signed messages: every message is signed with the sender's Ed25519 key, and forged, tampered, replayed or stale messages are rejected
- A local contact book with saved recipient public keys and stable key fingerprints; contact data contains no private keys
- Contact verification: compare identity fingerprints to mark a contact as verified; messages are held for review if a known encryption key is presented with a different signing key
- Encryption and signing key pairs created with confirmation, with the private keys kept in VS Code SecretStorage and an explicit identity reset option
- Multiple conversations in one chat panel, with isolated message histories, unread indicators, and delivery status (unconfirmed sends become Unknown after an interruption or restart)
- Encrypted local conversation history, protected by a random key in VS Code SecretStorage
- A chat panel inside VS Code with failure reasons and connection retry
- A Dev Chat Activity Bar sidebar, connection status item, in-chat identity actions, and a review banner for held messages
- A first-install Getting Started walkthrough in Welcome › Walkthroughs, with in-editor actions for local relay setup, connecting, key exchange, and fingerprint verification
- Two ways to run a relay on your local network: host it from VS Code with one command, or run the standalone relay (Node.js or Docker) on a home or office server
- Encrypted relay connections (`wss://`) with certificate pinning: the relay address you share includes its certificate fingerprint, so nobody on the network can impersonate the relay
- Invitation-only relay access, proof of identity ownership, and member management with options to rotate the join code with or without removing members
- Relay protections: local-network-only connections, message size limits, rate limiting, and idle connection cleanup

The extension includes both an offline quick-start guide and a first-install walkthrough. Relay hardening and Marketplace readiness remain in progress (see [Roadmap](#roadmap)).

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
| Extension | [VS Code Extension API](https://code.visualstudio.com/api), Webview chat panel (HTML, CSS, JavaScript), SecretStorage for private keys and hosted relay access, `globalState` for saved public-key contacts |
| Encryption | [libsodium](https://doc.libsodium.org/) via [`libsodium-wrappers`](https://www.npmjs.com/package/libsodium-wrappers) (X25519 sealed boxes, Ed25519 signatures), Node.js crypto for relay ownership proofs, SHA-256 identity fingerprints |
| Relay | [Node.js](https://nodejs.org/) 20+, [`ws`](https://www.npmjs.com/package/ws) WebSockets, Node `https`/`tls` for `wss://` |
| Relay certificates | [`selfsigned`](https://www.npmjs.com/package/selfsigned) (ECDSA P-256), SHA-256 certificate pinning |
| Testing | Node's built-in test runner (`node:test`) with integration tests against a real relay |
| Packaging | [Docker](https://www.docker.com/) (`node:26.13.1-alpine`) for the standalone relay |

## Getting Started

Dev Chat is not on the Marketplace yet, so it currently runs from source. You need [Node.js](https://nodejs.org/) 20 or newer and VS Code 1.90 or newer.

```sh
git clone https://github.com/Roarmo/vscode-dev-chat.git
cd vscode-dev-chat
npm --prefix server install
npm --prefix extension install
```

Open the repository in VS Code and press **F5** (**Run VS Code Dev Chat Extension**) to start an Extension Development Host with Dev Chat loaded.

Select **Dev Chat** in the Activity Bar to open its Connection, Relay, Identity, and Help actions. When disconnected, the Getting Started view offers hosting, joining, and instructions. The connection status item also opens chat or connects to the relay. The same actions remain available from the Command Palette; their names are listed under [Commands](#commands).

On first activation, Dev Chat opens its Getting Started walkthrough. To reopen it later, choose **Help: Get Started** in VS Code, then select the walkthrough under **Walkthroughs**. Select **Open Instructions** in the sidebar or **Help** in the chat panel for the bundled offline quick-start guide.

### Chat with someone on your network

1. **Host a relay.** In the sidebar, one person chooses **Host Relay on This Network**. Alternatively, configure and run the standalone relay; see [docs/relay-setup.md](docs/relay-setup.md).
2. **Share an invitation privately.** The administrator chooses **Copy Invite** in the hosting notification or **Copy Relay Invitation** in the sidebar. An invitation contains a secret join code, so send it only to people you want to admit.
3. **Join.** Each guest chooses **Join Relay with Invite**, pastes the invitation, and compares the host fingerprint with the administrator through a trusted channel before confirming. Dev Chat saves the pinned relay address and remembers a new host's identity as unverified. Saving the host in the contact book is a separate step.
4. **Open chat and save contacts.** Choose **Open Chat**. The guest can choose **Copy Host Key** after joining; the host needs the guest's public key too. Use **Copy key** in the chat panel and share it through a trusted channel, then add each other's name and public key under **Manage contacts**. Choose a conversation from the list to address messages without pasting the recipient key again. Conversations and unread counts are retained locally between panel closes and VS Code restarts.
5. **Verify each other (recommended).** Compare the **Selected key fingerprint** in your chat panel with **Your key fingerprint** in your contact's panel over a trusted channel. This checks their encryption key. Once their identity is known from an invitation or a received message, also compare **identity fingerprints** using **Show My Fingerprint**, then choose **Verify Contact Fingerprint** in the sidebar or **Verify contact** in the chat panel. Verified contacts' messages show a **Verified** badge.

Members can reconnect with **Connect Relay** without pasting the invitation again. The relay administrator can use **Manage Relay Members** or **Change Relay Join Code** in the sidebar. These actions are labeled administrator-only; the relay enforces that restriction. See [Managing access](docs/relay-setup.md#manage-relay-access).

If a contact's identity key changes, the sidebar shows the number of affected contacts and the chat panel shows a **Review** banner. Review the new fingerprint through a trusted channel before accepting it. Held messages remain encrypted in memory and are lost if the extension host restarts before review.

To try two clients on a single computer, follow [docs/demo.md](docs/demo.md).

### Identity, key loss and reset

Dev Chat asks before creating an identity. Its private encryption and signing keys are stored in VS Code SecretStorage, whose availability depends on your platform's secure storage. Profiles using the same VS Code user-data directory share one Dev Chat identity; separate user-data directories and devices do not automatically share or sync those keys. Contacts and saved history are kept separately by profile. Use **Show My Fingerprint** to see the public identity fingerprint.

Dev Chat cannot export or import private keys. If the identity keys are lost or corrupt, it reports the problem instead of silently replacing a recorded identity. Restore the original VS Code SecretStorage from a suitable external backup if available; otherwise, a reset creates a **different identity**, not a recovery. If both the keys and all recorded identity state are lost, Dev Chat cannot distinguish that situation from a first installation.

To reset, close **all other VS Code windows sharing the same user-data directory**, including windows in other profiles. Choose **Reset Identity** in the sidebar or run **Dev Chat: Reset Identity**, read the consequences, and confirm the reload. A scheduled reset can be canceled before it starts; after it starts, reload to retry if it is interrupted. Other profiles must review their previously recorded and current public fingerprints before accepting the changed identity. Do not accept an unexpected change without investigating it.

Reset replaces both identity keys:

- Messages encrypted for the old identity still require its old private key. Saved local conversation history uses a separate key and is not deleted by an identity reset; losing that separate key makes the saved history unreadable.
- Tell contacts to save your new public key and compare identity fingerprints with you over a trusted channel. A replacement encryption key is treated as a new identity, not automatically flagged as a signing-key change.
- You may need a new relay invitation or updated standalone relay administrator configuration. The old identity remains a relay member until an administrator removes it.

## Commands

| Command | Description |
| --- | --- |
| Dev Chat: Connect Relay | Connect to the relay set in `devChat.relayUrl` |
| Dev Chat: Open Chat | Open the chat panel |
| Dev Chat: Show My Fingerprint | Show (and copy) your identity fingerprint to compare with a contact |
| Dev Chat: Reset Identity | Confirm and create new shared identity keys after reloading |
| Dev Chat: Verify Contact Fingerprint | Compare a contact's fingerprint with yours and mark them as verified or not verified |
| Dev Chat: Review Contact Key Changes | Accept or discard messages held because a contact's identity key changed |
| Dev Chat: Host Relay on This Network | Run a relay inside VS Code for people on your local network |
| Dev Chat: Stop Hosting Relay | Stop the hosted relay and disconnect everyone using it |
| Dev Chat: Regenerate Hosted Relay Certificate | Replace the hosted relay's certificate (everyone then needs the new address) |
| Dev Chat: Join Relay with Invite | Validate an invitation, connect, and remember the host's public identity |
| Dev Chat: Copy Relay Invitation | Copy an invitation for the relay you administer |
| Dev Chat: Copy Relay Address | Copy the current relay address; new members still need a private invitation |
| Dev Chat: Manage Relay Members | View and remove members of the relay you administer |
| Dev Chat: Change Relay Join Code | Replace the code, choosing whether to keep or remove existing members |
| Dev Chat: Open Instructions | Open the bundled offline quick-start guide |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `devChat.relayUrl` | `ws://127.0.0.1:8787` | Relay address to connect to, for example `wss://192.168.1.20:8787#sha256=...`. `ws://` is only allowed for a relay on this computer. Stored per machine. |
| `devChat.hostRelay.port` | `8787` | Port used when hosting a relay from VS Code |

## Security Model

- Messages are encrypted on the sender's machine for the recipient's public key; only the recipient's private key can decrypt them.
- Every message is signed with the sender's Ed25519 signing key. The signature covers the sender, recipient, message ID, send time and ciphertext, so the relay or anyone else cannot forge, alter, redirect or replay a message. Unsigned, tampered, replayed and stale messages are rejected.
- Contacts are trusted on first use. A contact's identity fingerprint (a hash of their encryption and signing keys) can be compared out of band to mark them as verified. If a known encryption key is presented with a different signing key, its messages are held, still encrypted, until you accept or discard the new signing key; accepting resets verification.
- The local contact book stores display names and encryption public keys in VS Code global state, separately from private keys in SecretStorage. Its key fingerprint is a stable hash of the recipient encryption key; compare it over a trusted channel before sending sensitive messages. This key fingerprint differs from the identity fingerprint, which covers both encryption and signing keys. Updating or removing a saved contact does not erase the separate verification record for its old key. A replacement encryption key is treated as a new identity, not automatically flagged as a change to the old one; compare and verify it separately.
- Conversation history is stored locally as authenticated ciphertext in VS Code global storage. A random encryption key is held in VS Code SecretStorage; plaintext message text is not written to the history file. History is not synced between devices. If the SecretStorage key is lost or the history file is damaged, the extension leaves the encrypted file untouched and reports that it cannot load it; it cannot recover the history without the original key.
- Identity private keys are stored in VS Code SecretStorage and are never sent to the relay. They are shared by VS Code profiles using the same user-data directory but are not automatically synced between devices.
- Invitations contain a secret join code and a pinned `wss://` address. Dev Chat sends the code only after checking the relay's certificate (or over loopback during development). Invitations are signed, but you still need to compare the host fingerprint through a trusted channel. See [Encrypted connections](docs/relay-setup.md#encrypted-connections).
- The relay requires a valid invitation for new members, and every connection proves possession of both identity private keys. An invite holder can join as themselves, but cannot take over another member's identity without their keys. Invitations are reusable until the code changes; share them privately.
- Removing a member disconnects them but does not change the join code. If they still have an invitation, change the code as well. The administrator can keep other members or remove them all when rotating the code.
- The relay forwards ciphertext. It can see routing metadata: public keys, who messages whom, when, message sizes, and IP addresses. See [What the relay can see](docs/relay-setup.md#what-the-relay-can-see).

Current limitations:

- **Conversation history is local to this VS Code profile** and is not synced to other devices. Losing the history encryption key makes the saved history unreadable; keep VS Code SecretStorage and its profile backed up together if retaining history matters.
- **Messages held for an identity-key review are only in memory** and are not part of saved history until accepted. They are lost if the extension host restarts before review.
- **Invitations are reusable and do not expire individually** ([#34](https://github.com/Roarmo/vscode-dev-chat/issues/34)); rotate the code if an invitation leaks.
- **Losing the identity private keys means losing that identity.** Dev Chat does not provide key export or import; a reset creates a different identity.

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

The extension tests build both packages and cover key storage, encryption, message signing, contact trust and saved contacts, encrypted conversation history and unread tracking, sidebar and chat actions, relay invitations and member management, relay certificate pinning over `wss://`, and an encrypted message round trip through a real relay. Standalone tests also cover protected access-state storage.

## Roadmap

### MVP (first Marketplace release)

- Relay hardening ([#23](https://github.com/Roarmo/vscode-dev-chat/issues/23)) and Marketplace readiness ([#29](https://github.com/Roarmo/vscode-dev-chat/issues/29))

### Later

- Public hosted relay option ([#32](https://github.com/Roarmo/vscode-dev-chat/issues/32))
- Personal invites and admin roles ([#34](https://github.com/Roarmo/vscode-dev-chat/issues/34))
- Group chat, file sharing, and presence

## Contributing

Issues and pull requests are welcome. Check the [open issues](https://github.com/Roarmo/vscode-dev-chat/issues) for planned work, and run both test suites before opening a pull request. The extension package is restricted to compiled scripts, media, and production dependencies; inspect package contents before publishing. Never commit or package secrets, private keys, invitations, access files, or `.env` files.

## License

[MIT](LICENSE)
