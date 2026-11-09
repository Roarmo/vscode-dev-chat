# End-to-End Flow

## Purpose

This document describes the intended final user journey and technical message flow for VS Code Dev Chat.

## Product Goal

Developers can securely chat inside VS Code while keeping plaintext messages off the relay server.

Core principle:
- Encryption and decryption happen on client devices.
- The relay server only transports ciphertext.

## User Journey (Final Experience)

1. User opens VS Code and activates Dev Chat.
2. Extension loads local identity.
3. If first run, the extension generates encryption and signing key pairs and stores the private keys locally.
4. A relay administrator shares a signed invitation privately. The guest compares the host fingerprint through a trusted channel, then joins using **Dev Chat: Join Relay with Invite**. The pinned address and host's public identity are saved. Existing members reconnect without another invitation (see [Relay Setup](relay-setup.md)).
5. User selects a contact and types a message. (Currently the user pastes the recipient's public key; a contact list is tracked in [#26](https://github.com/Roarmo/vscode-dev-chat/issues/26).)
6. Message is encrypted on sender client before sending.
7. Relay receives encrypted payload and routing metadata.
8. Relay forwards ciphertext to recipient client.
9. Recipient decrypts locally and sees plaintext in the chat panel.
10. Sender receives status feedback (sent, delivered, failed).

## Technical Flow (Message Sequence)

1. Connect
- Client opens a WebSocket to the relay over `wss://` and checks the certificate fingerprint pinned in the invitation. On a mismatch it disconnects before sending anything.
- Client sends a hello with its encryption and signing public keys. The relay returns a single-use, time-limited challenge bound to its relay identity and session.
- An ephemeral X25519 exchange and HMAC prove possession of the encryption private key; an Ed25519 signature binds the proof, both public keys, and any join code to the challenge.
- A new non-administrator member must also supply the current join code. The relay saves the member's public keys and registers the session only after both ownership and access checks succeed. Existing members reconnect with key proof and no code.

2. Send Message
- Sender builds a direct message envelope.
- Sender encrypts the message locally with a libsodium sealed box (`crypto_box_seal`) for the recipient's public key. The encrypted content also carries the sender's public keys, which binds the ciphertext to its sender.
- Sender signs the sender key, recipient key, message ID, send time and ciphertext with its Ed25519 signing key (`crypto_sign_detached`).
- Sender transmits the signed ciphertext envelope to relay.

3. Route Message
- Relay validates envelope shape.
- Relay resolves recipient active session.
- Relay forwards ciphertext envelope.

4. Receive Message
- Recipient extension receives ciphertext.
- Recipient verifies the signature before decrypting and rejects messages addressed to someone else, sent too far in the future, older than 24 hours, or already received (replays).
- Recipient checks the sender's signing key against its contact trust store. A new contact is trusted on first use; a changed key holds the message, still encrypted, until the user reviews the change.
- Recipient decrypts using local key material and checks that the sender keys inside the ciphertext match the signed envelope.
- Recipient UI renders plaintext message with a Verified or Not verified badge.

5. Acknowledgement
- Relay returns ack or structured error.
- Sender UI updates message state.

## Security Boundaries

What stays local on clients:
- Private keys
- Plaintext message content
- Local decrypted history (if enabled)

What relay can see:
- Routing metadata (sender and recipient public keys, timing, message sizes)
- Connection metadata (client IP addresses)
- Ciphertext blobs

Invitation join codes are sent only over pinned `wss://` or actual loopback connections; the invitation UI requires pinned `wss://` (see [Encrypted connections](relay-setup.md#encrypted-connections)). An invite holder can join as themselves, but cannot claim another member's identity without its private keys. Invitations are reusable until the code is rotated, so they must be shared privately. Messages are signed by their sender, and users confirm a contact's identity by comparing fingerprints out of band.

What relay should not see:
- Plaintext message content
- Private key material

## v1 Definition of Done

1. Two developers can run the extension and connect to the same invitation-only relay.
2. They can exchange direct encrypted messages.
3. Relay forwards messages but cannot decrypt message content.
4. Sender sees deterministic status updates.
5. Setup steps are documented and reproducible.
6. Members can reconnect, and administrators can remove members or rotate invitations.
7. No secrets or private keys are committed to source control.

## Non-Goals for v1

- Group chat
- File transfer
- Multi-device sync
- Full offline queue and replay

## Future Extensions

MVP work still in progress includes a contacts list, multiple conversations, local history, and identity lifecycle improvements. See the [roadmap](../README.md#roadmap).

Later ideas:
- Group messaging
- File and snippet sharing enhancements
- Presence and richer collaboration signals

## Quick Validation Checklist

- Relay starts and listens on configured port.
- A guest joins using a private invitation and compares the host fingerprint.
- A member reconnects without an invitation; an uninvited identity cannot register.
- Removing a member or rotating the code has the intended effect.
- Test message sent from extension reaches relay.
- Relay forwards response and client receives it.
- No plaintext appears in relay routing logic for real chat payloads.
