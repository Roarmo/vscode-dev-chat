Before trusting a contact, compare **identity fingerprints** with them through a trusted channel, such as in person or on a video call. Each person can show their fingerprint from Dev Chat. Compare every character; do not mark a contact verified if anything differs.

[Show my fingerprint](command:devChat.showMyFingerprint) · [Verify a contact](command:devChat.verifyContact)

Once the fingerprints match and the contact is verified, select their conversation in chat and send a message. The fingerprint verifies the contact's identity; it is different from the fingerprint of the encryption public key.

If someone resets their Dev Chat identity, save their new public key and compare their new identity fingerprint again. A new encryption key is treated as a new identity, not automatically flagged as a signing-key change.
