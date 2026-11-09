# VS Code Dev Chat

End-to-end encrypted messaging for developers directly inside VS Code.

> **Status: early development (pre-MVP).** One-to-one encrypted chat works between VS Code instances on the same local network. It is not yet published to the VS Code Marketplace. See [Roadmap](#roadmap) for what is still missing before the first release.

## Overview

VS Code Dev Chat is a Visual Studio Code extension for secure developer-to-developer communication without leaving the editor. Messages are encrypted on your machine before they are sent, and a small relay server only forwards encrypted data it cannot read.

Developers regularly jump between their editor and chat tools like Slack or Discord when discussing code. That breaks focus and can expose internal snippets to systems that were not designed for end-to-end privacy. Dev Chat keeps the conversation inside the editor and encrypts it on the client.

## Features

Available now:

- End-to-end encrypted one-to-one messages using [libsodium](https://doc.libsodium.org/) sealed boxes
- A key pair generated on first run, with the private key kept in VS Code's secret storage
- A chat panel inside VS Code with delivery status, failure reasons, and connection retry
- Two ways to run a relay on your local network: host it from VS Code with one command, or run the standalone relay (Node.js or Docker) on a home or office server
- Relay protections: local-network-only connections, message size limits, rate limiting, and idle connection cleanup

Planned for the MVP release (see [Roadmap](#roadmap)): sender verification, encrypted relay connections, join codes, contacts, multiple conversations, and local history.

## How It Works

```text
VS Code Client A
	|
	| encrypt message locally
	v
Relay Server (WebSocket transport only)
	|
	| forward ciphertext
	v
VS Code Client B
	|
	| decrypt message locally
	v
Readable message
```

Encryption and decryption happen entirely on the client. The relay is responsible for transport, not trust. See [docs/end-to-end-flow.md](docs/end-to-end-flow.md) for the full message flow.

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

1. **Get a relay.** One person runs **Dev Chat: Host Relay on This Network** and shares the address it shows (for example `ws://192.168.1.20:8787`). Alternatively, run the standalone relay on a server. See [docs/relay-setup.md](docs/relay-setup.md).
2. **Point Dev Chat at the relay.** Everyone else sets **Dev Chat › Relay Url** (`devChat.relayUrl`) to that address. The host does not need to change anything.
3. **Connect.** Run **Dev Chat: Connect Relay**, then **Dev Chat: Open Chat**.
4. **Exchange public keys.** Use **Copy key** in the chat panel and send your key to the other person through a channel you trust. Paste their key into the recipient field and send a message.

To try two clients on a single computer, follow [docs/demo.md](docs/demo.md).

## Commands

| Command | Description |
| --- | --- |
| Dev Chat: Connect Relay | Connect to the relay set in `devChat.relayUrl` |
| Dev Chat: Open Chat | Open the chat panel |
| Dev Chat: Host Relay on This Network | Run a relay inside VS Code for people on your local network |
| Dev Chat: Stop Hosting Relay | Stop the hosted relay and disconnect everyone using it |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `devChat.relayUrl` | `ws://127.0.0.1:8787` | Relay address to connect to. Stored per machine. |
| `devChat.hostRelay.port` | `8787` | Port used when hosting a relay from VS Code |

## Security Model

- Messages are encrypted on the sender's machine for the recipient's public key; only the recipient's private key can decrypt them.
- Private keys stay on the local machine in VS Code's secret storage and are never sent to the relay.
- The relay forwards ciphertext. It can see routing metadata: public keys, who messages whom, when, message sizes, and IP addresses. See [What the relay can see](docs/relay-setup.md#what-the-relay-can-see).

Current limitations, all tracked for the MVP:

- **Sender identity is not verified yet** ([#25](https://github.com/Roarmo/vscode-dev-chat/issues/25)). Only exchange keys with people through a channel you trust.
- **Relay connections use unencrypted `ws://`** ([#27](https://github.com/Roarmo/vscode-dev-chat/issues/27)). Message contents stay encrypted, but connection metadata is visible on the network.
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

The extension tests build both packages and cover key storage, encryption, relay hosting, and an encrypted message round trip through a real relay.

## Roadmap

### MVP (first Marketplace release)

- Encrypted relay connections with certificate pinning ([#27](https://github.com/Roarmo/vscode-dev-chat/issues/27))
- Sender authentication ([#25](https://github.com/Roarmo/vscode-dev-chat/issues/25)) and relay join codes ([#33](https://github.com/Roarmo/vscode-dev-chat/issues/33))
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
