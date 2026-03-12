# VS Code Dev Chat
End-to-End Encrypted Messaging for Developers Inside VS Code

CodeCipher is a Visual Studio Code extension that enables secure, end-to-end encrypted messaging between developers directly inside the editor.

---

## Why this project exists

Developers often switch between tools like Slack or Discord when discussing code.  
This interrupts workflow and exposes sensitive code snippets to third-party platforms.

CodeCipher provides encrypted messaging directly inside VS Code.

---

## Features

- End-to-end encrypted messaging
- Public key identity
- Secure relay server
- Code snippet sharing
- Chat panel inside VS Code

---

## Architecture

VS Code Client A  
⬇  
Encrypted Message  
⬇  
Relay Server (WebSocket)  
⬇  
VS Code Client B

Encryption happens entirely on the client.

---

## Tech Stack

Extension
- TypeScript
- VS Code Extension API
- Webview UI

Backend
- Node.js
- WebSockets

Encryption
- libsodium

---

## Project Structure

codecipher/

extension/  
server/  
shared/  
docs/

---

## Security Model

Messages are encrypted on the client before being sent.

The relay server only forwards ciphertext and cannot read message contents.

Private keys never leave the user's machine.

---

## Development Roadmap

### v1
- encrypted messaging
- keypair generation
- chat UI

### v2
- contact list
- message history

### v3
- group chat
- file sharing

---

## License

MIT
