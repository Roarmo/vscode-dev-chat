# VS Code Dev Chat

End-to-end encrypted one-to-one messaging for developers inside VS Code. Messages are encrypted and signed on your device; the relay only forwards ciphertext.

## Features

- Multiple conversations with saved contacts, encrypted local history, and unread indicators
- Signed messages and contact fingerprint verification
- Private keys stored in VS Code SecretStorage
- A relay hosted from VS Code or a standalone relay using Node.js 24+ or Docker on your local network
- Invitation-only relay access and pinned encrypted relay connections

## Quick start

1. Select **Dev Chat** in the Activity Bar. Choose **Host Relay on This Network**, or set up a standalone relay.
2. Share the relay invitation privately. Each guest chooses **Join Relay with Invite** and verifies the host's fingerprint through a trusted channel.
3. Exchange public keys through a trusted channel, save each other as contacts, and open a conversation.
4. Compare identity fingerprints out of band before marking contacts verified.

Everyone must connect to the same relay. If needed, allow its TCP port (8787 by default) through the host firewall on private networks only.

See the [full setup guide](https://github.com/Roarmo/vscode-dev-chat#readme), [standalone relay instructions](https://github.com/Roarmo/vscode-dev-chat/blob/main/docs/relay-setup.md), and [end-to-end flow and security boundaries](https://github.com/Roarmo/vscode-dev-chat/blob/main/docs/end-to-end-flow.md).

## Important limitations

Dev Chat is designed for trusted local networks, not as a public Internet chat service. Contact and relay fingerprints should be verified out of band. The relay cannot read message contents, but it can observe connection metadata and forward, delay, or drop traffic.
