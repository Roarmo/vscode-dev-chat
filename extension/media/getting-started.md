# Dev Chat quick start

Open **Dev Chat** in the Activity Bar to find connection, relay, identity, and help actions. The same actions are also available from the Command Palette.

1. **Get a relay.** Choose **Host Relay on This Network**, or ask the administrator of an existing relay for an invitation.
2. **Invite or join.** A host can choose **Copy Relay Invitation** and share it privately. A guest chooses **Join Relay with Invite**, pastes the invitation, and compares the host fingerprint through a trusted channel. Invitations contain a secret join code.
3. **Open chat and add contacts.** Choose **Open Chat**, copy and exchange public keys through a trusted channel, and save each contact under **Manage contacts**. Select a conversation to send a message.
4. **Verify identities.** Choose **Show My Fingerprint** and **Verify Contact Fingerprint**. Compare identity fingerprints through a trusted channel before marking a contact verified.
5. **Review changed keys.** If messages are held because a contact's signing key changed, choose **Review Contact Key Changes**. Compare the new fingerprint before accepting it.

Use **Connect Relay** to reconnect to a relay you have already joined. Reconnection after a relay shutdown is not automatic. The connection status appears in the status bar; select it to connect or open chat. An **Unknown** message may already have reached its recipient; check before sending it again.

The relay administrator can use the sidebar to manage members or change the join code. **Copy Relay Address** copies the address, including its certificate pin when present, not an invitation; new members still need a private invitation.

The MVP relay is intended for the same local network. If a connection fails, check the relay address, port and firewall. If the certificate fingerprint changes unexpectedly, confirm the new address with the administrator through a trusted channel before connecting.

Conversation history is encrypted locally. It is not synced between devices, and losing the history key in VS Code SecretStorage makes that history unreadable.

Messages held for a key-change review are kept encrypted in memory, not in saved history. They are lost if the extension host restarts before you review them.

## Identity and key loss

Dev Chat asks before creating an identity. Its private encryption and signing keys are kept in VS Code SecretStorage. Profiles sharing the same VS Code user-data directory share the identity, but the keys are not automatically synced to other devices. Use **Show My Fingerprint** to see your public identity fingerprint.

If the identity keys are missing or invalid, Dev Chat will not silently create replacements for a recorded identity. Dev Chat cannot export or import private keys; restore the original SecretStorage from a suitable external backup if available. If both the keys and all recorded identity state are lost, Dev Chat cannot tell that apart from a first installation.

To create a different identity, first close all other VS Code windows sharing the same user-data directory, including other profiles. Choose **Reset Identity**, read the warning, and confirm the reload. Other profiles must review the changed identity before using it. If a reset has already started and is interrupted, reload to retry it.

Reset changes both keys. Messages encrypted for the old identity still need its old private key; saved local history uses a separate key and is not deleted by the reset. Contacts must save your new public key and compare identity fingerprints again through a trusted channel. A replacement encryption key is treated as a new identity, not automatically flagged as a signing-key change. You may need a new relay invitation or updated administrator configuration; the old identity remains a relay member until removed.
