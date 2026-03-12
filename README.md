# VS Code Dev Chat

End-to-end encrypted messaging for developers directly inside VS Code.

## Overview

VS Code Dev Chat is a planned Visual Studio Code extension for secure developer-to-developer communication without leaving the editor. The goal is to make it easy to discuss code, share snippets, and collaborate in context while keeping message contents private.

Instead of moving sensitive conversations to third-party chat platforms, this project is designed around client-side encryption so the relay layer only handles ciphertext.

## Problem

Developers regularly jump between their editor and chat tools like Slack or Discord when discussing code. That breaks focus, separates code from conversation, and can expose internal snippets or implementation details to systems that were not designed for end-to-end privacy.

VS Code Dev Chat aims to solve that by keeping communication inside the editor and encrypting messages before they leave the client.

## Core Goals

- Keep developer conversations inside VS Code
- Encrypt messages on the client before transmission
- Support identity through public/private keypairs
- Allow secure sharing of short code snippets
- Use a relay server that cannot read message contents

## Planned Features

- End-to-end encrypted direct messaging
- Public key based identity
- Secure relay server over WebSockets
- Embedded chat panel in VS Code
- Code snippet sharing inside conversations
- Future support for contacts, history, groups, and file transfer

## Architecture

High-level message flow:

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

Design principle: encryption and decryption happen entirely on the client. The relay server is responsible for transport, not trust.

## Security Model

- Messages are encrypted before leaving the sender's machine
- The relay server forwards ciphertext and should not have access to plaintext
- Private keys remain on the local machine
- Public keys are used to identify peers and establish secure communication
- Sensitive logic should live in the extension client, not in the relay layer

## Proposed Tech Stack

Extension client:

- TypeScript
- VS Code Extension API
- Webview UI

Backend relay:

- Node.js
- WebSockets

Encryption:

- libsodium

## Project Status

This repository is currently in the planning and early setup stage. The implementation folders referenced below are part of the intended structure and are not fully scaffolded yet.

## Intended Project Structure

```text
vscode-dev-chat/
  extension/   VS Code extension source
  server/      WebSocket relay server
  shared/      Shared types, protocol, and utilities
  docs/        Architecture and design notes
```

## Roadmap

### v1

- Client keypair generation
- Encrypted one-to-one messaging
- Basic chat panel UI inside VS Code

### v2

- Contact list
- Local message history
- Better session and identity management

### v3

- Group chat
- File sharing
- Presence and richer collaboration features

## Contributing

This project is still being defined. Early contributions should focus on:

- extension scaffolding
- secure message protocol design
- relay server design
- encryption flow validation
- UI/UX for the chat panel

## License

MIT
