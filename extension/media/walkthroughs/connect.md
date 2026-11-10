If you are new to a relay, use a private invitation. Dev Chat checks the invitation and asks you to compare the relay host's identity fingerprint through a trusted channel before joining.

[Join with an invitation](command:devChat.joinRelayWithInvite)

If you have already joined, you can reconnect with the saved relay address. It must include the full `wss://` address and its `#sha256=` certificate pin. Do not remove or change the pin unless you have confirmed the new address with the administrator through a trusted channel.

[Open the Relay URL setting](command:workbench.action.openSettings?%22devChat.relayUrl%22) · [Connect to the saved relay](command:devChat.connectRelay)

Hosting from VS Code connects your client automatically. Unencrypted `ws://` is allowed only for a relay on the same computer.
