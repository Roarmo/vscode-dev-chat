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
3. If first run, extension generates a keypair and stores private key locally.
4. Extension connects to relay via WebSocket.
5. User selects a contact and types a message.
6. Message is encrypted on sender client before sending.
7. Relay receives encrypted payload and routing metadata.
8. Relay forwards ciphertext to recipient client.
9. Recipient decrypts locally and sees plaintext in the chat panel.
10. Sender receives status feedback (sent, delivered, failed).

## Technical Flow (Message Sequence)

1. Connect
- Client opens WebSocket to relay.
- Client sends hello payload with public identity metadata.
- Relay registers active session.

2. Send Message
- Sender builds a direct message envelope.
- Sender encrypts plaintext payload locally.
- Sender transmits ciphertext envelope to relay.

3. Route Message
- Relay validates envelope shape.
- Relay resolves recipient active session.
- Relay forwards ciphertext envelope.

4. Receive Message
- Recipient extension receives ciphertext.
- Recipient decrypts using local key material.
- Recipient UI renders plaintext message.

5. Acknowledgement
- Relay returns ack or structured error.
- Sender UI updates message state.

## Security Boundaries

What stays local on clients:
- Private keys
- Plaintext message content
- Local decrypted history (if enabled)

What relay can see:
- Routing metadata
- Connection metadata
- Ciphertext blobs

What relay should not see:
- Plaintext message content
- Private key material

## v1 Definition of Done

1. Two developers can run the extension and connect to the same relay.
2. They can exchange direct encrypted messages.
3. Relay forwards messages but cannot decrypt message content.
4. Sender sees deterministic status updates.
5. Setup steps are documented and reproducible.
6. No secrets or private keys are committed to source control.

## Non-Goals for v1

- Group chat
- File transfer
- Multi-device sync
- Full offline queue and replay

## Future Extensions

v2 ideas:
- Contacts list and identity verification UX
- Local encrypted message history
- Reconnect and session resilience improvements

v3 ideas:
- Group messaging
- File and snippet sharing enhancements
- Presence and richer collaboration signals

## Quick Validation Checklist

- Relay starts and listens on configured port.
- Extension command connects to relay successfully.
- Test message sent from extension reaches relay.
- Relay forwards response and client receives it.
- No plaintext appears in relay routing logic for real chat payloads.
