If a known contact's signing key changes, Dev Chat holds their new messages for review instead of displaying them as trusted. The held messages remain encrypted in memory only and are lost if the extension host restarts before review.

Contact the person through a trusted channel and compare identity fingerprints before accepting the new key. Accepting a changed key resets that contact's verification. If you cannot confirm the change, keep the old key and discard the held messages.

[Review contact key changes](command:devChat.reviewKeyChanges)
