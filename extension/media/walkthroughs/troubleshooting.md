- **Cannot connect:** Check that both computers are on the same local network, the relay is running, the address and port are reachable, and the host's firewall allows incoming connections.
- **Certificate mismatch:** Stop and verify the relay's new certificate fingerprint and address with its administrator through a trusted channel. Do not bypass the pin warning.
- **Invitation rejected:** Ask the administrator for a current private invitation. A relay address by itself is not enough for a new member.
- **Network limits:** The MVP is for a trusted home, office, or lab network. It does not provide a public hosted relay or internet-wide discovery.

[Open the bundled quick-start guide](command:devChat.openInstructions)

For advanced setup and firewall guidance, see the [relay setup documentation](https://github.com/Roarmo/vscode-dev-chat/blob/main/docs/relay-setup.md).
