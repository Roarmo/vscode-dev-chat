# Dev Chat quick start

Open **Dev Chat** in the Activity Bar to find connection, relay, identity, and help actions. The same actions are also available from the Command Palette.

1. **Get a relay.** Choose **Host Relay on This Network**, or ask the administrator of an existing relay for an invitation.
2. **Invite or join.** A host can choose **Copy Relay Invitation** and share it privately. A guest chooses **Join Relay with Invite**, pastes the invitation, and compares the host fingerprint through a trusted channel. Invitations contain a secret join code.
3. **Open chat and add contacts.** Choose **Open Chat**, copy and exchange public keys through a trusted channel, and save each contact under **Manage contacts**. Select a conversation to send a message.
4. **Verify identities.** Choose **Show My Fingerprint** and **Verify Contact Fingerprint**. Compare identity fingerprints through a trusted channel before marking a contact verified.
5. **Review changed keys.** If messages are held because a contact's signing key changed, choose **Review Contact Key Changes**. Compare the new fingerprint before accepting it.

Use **Connect Relay** to reconnect to a relay you have already joined. The connection status appears in the status bar; select it to connect or open chat.

The relay administrator can use the sidebar to manage members or change the join code. **Copy Relay Address** copies the address, including its certificate pin when present, not an invitation; new members still need a private invitation.

The MVP relay is intended for the same local network. If a connection fails, check the relay address, port and firewall. If the certificate fingerprint changes unexpectedly, confirm the new address with the administrator through a trusted channel before connecting.

Conversation history is encrypted locally. It is not synced between devices, and losing the history key in VS Code SecretStorage makes that history unreadable.

Messages held for a key-change review are kept encrypted in memory, not in saved history. They are lost if the extension host restarts before you review them.
