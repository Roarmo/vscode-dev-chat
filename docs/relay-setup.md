# Relay Setup

Dev Chat clients exchange encrypted messages through a small WebSocket relay. For the MVP, the relay is meant for people on the **same local network** (home, office, or lab). There are two ways to run one.

| Option | Best for | Runs while |
| --- | --- | --- |
| [Host from VS Code](#option-1-host-from-vs-code) | Quick sessions, small teams | Your VS Code window is open |
| [Standalone relay](#option-2-standalone-relay) | Home servers, office servers, always-on use | The server is running |

Everyone who wants to chat must connect to the **same** relay. Both options use encrypted `wss://` connections and require an invitation for each new member. An invitation contains the pinned relay address, a secret join code, and the administrator's public identity. It is signed by the administrator, but the recipient must still compare the administrator's identity fingerprint through a trusted channel.

**Upgrading from an older open relay:** update the standalone server and all clients together; the old protocol cannot complete the new authentication handshake. Set the administrator key before starting the updated standalone server. Existing users must join once with an invitation because the new member list starts empty.

## Option 1: Host from VS Code

1. Run **Dev Chat: Host Relay on This Network** from the Command Palette.
2. Choose **Copy Invite** and send the invitation privately to the people you want to admit. If you have multiple network addresses, select the one your contacts can reach. You can also run **Dev Chat: Copy Relay Invitation** later.
3. Your own VS Code connects to the hosted relay automatically. The status bar shows the port and how many clients are connected; click it for hosting options.
4. Run **Dev Chat: Stop Hosting Relay** (or click the status bar item) when you are done. Closing VS Code also stops the relay, which disconnects everyone.

The relay uses port `8787` by default. If another program already uses it, change **Dev Chat › Host Relay: Port** (`devChat.hostRelay.port`) in Settings.

The certificate and access state are created the first time you host and reused afterwards. The certificate is stored in VS Code's extension storage; its private key, the join code, and the public member list are stored in VS Code's secret storage. The relay does not store members' private identity keys. To replace the certificate, see [Regenerate the certificate](#regenerate-the-certificate).

The first time you host, your operating system may ask whether to allow incoming connections. See [Allow the relay through the firewall](#allow-the-relay-through-the-firewall).

## Option 2: Standalone relay

The standalone relay needs a designated administrator's **Dev Chat encryption public key** before it starts:

1. On the administrator's VS Code, run **Dev Chat: Open Chat** and use **Copy key**, even if the chat is not connected yet. This is a public key, not the fingerprint or a private key.
2. Set `RELAY_ADMIN_PUBLIC_KEY` in the terminal that will start the relay. Replace the placeholder with that public key:

   ```sh
   export RELAY_ADMIN_PUBLIC_KEY='PASTE_ADMIN_PUBLIC_KEY_HERE'
   ```

   In PowerShell, use:

   ```powershell
   $env:RELAY_ADMIN_PUBLIC_KEY = 'PASTE_ADMIN_PUBLIC_KEY_HERE'
   ```

Only the corresponding Dev Chat identity can administer the relay; it still has to prove ownership of its private keys. Keep using that identity to manage invitations and members.

### With Docker

Build the image from the repository root (the relay uses code in `shared/`):

```sh
docker build -f server/Dockerfile -t dev-chat-relay .
docker run -d --name dev-chat-relay --restart unless-stopped -e RELAY_ADMIN_PUBLIC_KEY -p 8787:8787 -v dev-chat-relay-data:/app/server/relay-data dev-chat-relay
docker logs dev-chat-relay
```

The logs show the certificate fingerprint and addresses, **not the join code**. Use the `wss://<server LAN IP>:8787#sha256=...` address on the administrator's VS Code to [connect and create invitations](#connect-to-a-relay). Keep the volume: it stores the certificate, private key, join code, and member list across container recreation. Protect the volume and any backups.

To use a different port on the host, change the left side of `-p`, for example `-p 9000:8787`, and share port `9000`.

### With Node.js

Requires Node.js 20 or newer.

```sh
npm --prefix server ci
npm --prefix server run build
npm --prefix server start
```

When it starts, the relay prints its certificate fingerprint and the full addresses it can be reached at. The certificate is stored in `server/relay-data/` (ignored by git). The private key file is readable only by the user running the relay on macOS and Linux; on Windows, keep the folder in a location only you can access.

The generated join code and member list are stored in a separate protected access file, not printed in the logs. On macOS and Linux, the file is owner-only (`0600`); on Windows, it has an owner-only access control list. The relay must be able to enforce those permissions or it fails rather than storing the code unprotected. Protect the data directory and its backups as well.

### Configuration

Set these as environment variables (or in `server/.env` when running with Node.js; that file is not committed):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Port to listen on |
| `HOST` | all interfaces | Interface to bind, for example a single LAN address. Leave unset in Docker; use `-p` instead |
| `RELAY_ADMIN_PUBLIC_KEY` | required | The administrator's Dev Chat encryption public key, copied from their chat panel |
| `DATA_DIR` | `relay-data` (relative to the working directory); `/app/server/relay-data` in Docker | Where the relay keeps its certificate, private key, and default access file |
| `RELAY_ACCESS_FILE` | `<DATA_DIR>/relay-access.json` | Path to the protected join-code and public-member-list file. A custom path also needs a private directory and secure backups |
| `RELAY_JOIN_CODE` | generated on first start | Optional initial code: a cryptographically random 32-byte value encoded as a 43-character base64url string. Used only when creating a new access file; existing saved state takes precedence |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | unset | Use your own certificate and private key (PEM) instead of the self-signed one. Set both |
| `TLS_DISABLED` | `false` | Serve unencrypted `ws://` for loopback development only. Non-loopback connections are rejected; this is not a supported reverse-proxy setup. The invitation UI requires `wss://` |
| `MAX_MESSAGE_BYTES` | `8192` | Largest accepted message |
| `RATE_LIMIT_WINDOW_MS` / `MAX_MESSAGES_PER_WINDOW` | `1000` / `20` | Per-connection rate limit |
| `HEARTBEAT_INTERVAL_MS` / `STALE_SOCKET_TIMEOUT_MS` | `15000` / `45000` | Idle connection detection |
| `HEALTH_LOG_INTERVAL_MS` | `30000` | How often a health summary is logged |
| `ALLOW_NON_LOCAL_CONNECTIONS` | `false` | Accept connections from public IP addresses. Not recommended; see [Local network only](#local-network-only) |

Normally, leave `RELAY_JOIN_CODE` unset and let the relay generate it. If you provide one, use a cryptographic random-number generator, not a memorable password; for Docker, also pass `-e RELAY_JOIN_CODE`. Even when saved state already exists, a supplied value must have the correct format. Environment variables can be visible to local processes or container administrators. Never commit an access file, join code, invitation, `.env` file, or private key. The default access-file name is ignored by git and Docker, but you must exclude any differently named custom access file yourself.

## Connect to a relay

**Administrator of a standalone relay:**

1. In VS Code Settings, set **Dev Chat › Relay Url** (`devChat.relayUrl`) to the full `wss://` address printed by the relay, including `#sha256=...`. Use a LAN address reachable by your guests.
2. Run **Dev Chat: Connect Relay**, then **Dev Chat: Copy Relay Invitation**. Share the invitation privately and provide your identity fingerprint separately through a trusted channel using **Dev Chat: Show My Fingerprint**.
3. Use the same VS Code identity for **Dev Chat: Manage Relay Members** and **Dev Chat: Change Relay Join Code**.

**Guest:**

1. Run **Dev Chat: Join Relay with Invite** and paste the complete invitation. Do not paste it into the relay URL setting.
2. Compare the host fingerprint shown in the confirmation with the administrator through a trusted channel. Confirm only if it matches.
3. The extension saves the pinned address, connects, and remembers a new host's public identity as unverified. Use **Copy Host Key** to address them in the chat panel or add them under **Manage contacts**; exchange your own public key with them too. Saving them in the contact book is separate from identity verification. Run **Dev Chat: Verify Contact Fingerprint** after comparing identity fingerprints.
4. On subsequent sessions, use **Dev Chat: Connect Relay**; members prove key ownership and do not need to paste the invitation again.

If joining fails, the previous relay setting is kept and an active previous connection is re-established when possible.

The relay URL is stored per machine, so a workspace cannot silently change it. The invitation flow saves only the address and certificate pin there, not the join code. If an invitation shows a different signing key for a host you already know, the saved key is not replaced. After verifying the new fingerprint, you can join, ask the host to send a message, and use **Dev Chat: Review Contact Key Changes** to review the held message and accept the new key.

## Manage relay access

- **View or remove a member:** run **Dev Chat: Manage Relay Members**, select a member, and confirm. They are disconnected and must join again. Removing a member does **not** invalidate the current invitation; if they still have it, also change the code.
- **Change code and keep members:** run **Dev Chat: Change Relay Join Code** and choose this option. Existing members remain connected and can reconnect without a code; new joins need a new invitation.
- **Change code and remove all members:** choose this option and confirm the displayed member count. Other members are disconnected and must join with a new invitation; the administrator remains connected.

Both options immediately invalidate the old code and old invitations. After a change, choose **Copy New Invite** or run **Dev Chat: Copy Relay Invitation**. Existing members should reconnect with **Dev Chat: Connect Relay**, not paste an old invitation. If membership changes while a destructive rotation is being confirmed, review the updated list and try again.

Invitations are reusable and do not expire individually. Anyone holding a current invitation can join as their **own** identity; the key-ownership challenge prevents them from joining as somebody else without that person's private keys. Share invitations privately, and rotate the code if one is exposed. To remove an individual without excluding everyone else, remove that member and then rotate the code while keeping the remaining members.

The relay closes connections that send excessively fragmented WebSocket messages, including before authentication. This limits one resource-exhaustion risk but does not prevent all denial-of-service attacks.

## Encrypted connections

Messages are always end-to-end encrypted, whatever the connection type. Encrypting the connection to the relay additionally protects what travels alongside them from others on the network: public keys, who is messaging whom, and join codes.

- **The `#sha256=` fingerprint pins the relay's certificate.** Dev Chat checks that the relay presents exactly that certificate before sending anything. Someone on the network pretending to be the relay cannot produce it. The fingerprint is part of the URL fragment, which is never sent over the network.
- **Receive invitations privately and compare the host fingerprint through a trusted channel** (in person or on a trusted call). A signed invitation does not by itself prove who the host is.
- **Certificates from a trusted certificate authority** also work for reconnecting existing members without a pin. However, joining with an invitation and administering a remote relay require the pinned address, even for CA-signed certificates.
- **Unencrypted `ws://`** is accepted by both client and server only for actual loopback connections on the same computer. It is for development; the invitation UI requires a pinned `wss://` address.

### If Dev Chat refuses to connect

| Message | What it means | What to do |
| --- | --- | --- |
| *presented a different certificate than the one in your relay URL* | The relay's certificate does not match the fingerprint you pinned. Either the relay host regenerated it (or recreated a Docker container without a volume), or someone is intercepting the connection. | Ask the relay host, through a channel you trust, whether they changed the certificate. Only then update **Dev Chat › Relay Url** to the new address they give you. There is deliberately no "connect anyway" option. |
| *The relay certificate is not trusted* | The address uses `wss://` without a fingerprint, and the certificate is self-signed or not valid for that host name. | Use the full address the relay host shares, including `#sha256=...`. |
| *Unencrypted ws:// is only allowed for a relay on this computer* | The address uses `ws://` for another machine. | Use the `wss://` address the relay prints at startup. |
| *A valid relay invitation is required* | You are not a member, were removed, or pasted an old invitation after the code changed. | Ask the administrator for a current invitation. If you are still a member, use **Dev Chat: Connect Relay** without pasting the old invitation. |
| *Too many failed relay join attempts* | The relay temporarily limited failed new-member joins from your source address. | Wait a minute and use a current invitation. Existing members can still reconnect without a code. |

## Regenerate the certificate

Replace the certificate if you think its private key was exposed. Everyone using the relay is then refused until they switch to the new address, so tell them first.

- **Hosted from VS Code:** run **Dev Chat: Regenerate Hosted Relay Certificate** and confirm. If the relay is running, it restarts with the new certificate and shows the new address to share.
- **Standalone with Node.js:** stop the relay, then start it once with `npm --prefix server start -- --regenerate-certificate`. It prints the new address.
- **Standalone with Docker:** delete the stored certificate and restart the container; the relay creates a new one on startup. Then check the logs for the new address:

  ```sh
  docker exec dev-chat-relay rm relay-data/relay-cert.pem relay-data/relay-key.pem
  docker restart dev-chat-relay
  docker logs dev-chat-relay
  ```

If you use `TLS_CERT_FILE`/`TLS_KEY_FILE`, replace those files instead and restart the relay.

New invitations must use the new certificate fingerprint. Regenerating a certificate does not change the join code; rotate the code separately if an invitation may have leaked.

## Allow the relay through the firewall

Only allow the port on **private** networks.

**Windows** (PowerShell as Administrator):

```powershell
New-NetFirewallRule -DisplayName "Dev Chat relay" -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow -Profile Private
```

Make sure your network is set to **Private** in Windows settings, not Public.

**macOS:** when prompted, allow incoming connections for VS Code (Option 1) or Node.js (Option 2). You can review this in System Settings › Network › Firewall › Options.

**Linux (ufw):** allow only your LAN range, for example:

```sh
sudo ufw allow from 192.168.1.0/24 to any port 8787 proto tcp
```

## Local network only

The relay rejects connections whose source address is not loopback, private (`10.x`, `172.16–31.x`, `192.168.x`, IPv6 `fc00::/7`), or link-local. This is a safety net, not access control:

- Behind port forwarding, reverse proxies, or Docker's port publishing, the relay may see the proxy's private address instead of the real client, so the check cannot tell where the client really is. **Do not expose the relay to the internet** with port forwarding.
- New members also need the current invitation and must prove identity-key ownership. A shared proxy or container network may make several clients appear to come from the same address for join-attempt rate limiting.

## What the relay can see

The relay cannot read messages: they are encrypted on the sender's machine and only the recipient can decrypt them. Encrypted `wss://` connections hide traffic from others on the network, but the relay itself still sees:

- the public keys of connected users and who sends to whom,
- when messages are sent and their size,
- client IP addresses,
- the join code used to admit new members.

The relay logs connection and routing metadata, but not join codes. Only run or use a relay operated by someone you trust with this information.
