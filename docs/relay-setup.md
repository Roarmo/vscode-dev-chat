# Relay Setup

Dev Chat clients exchange encrypted messages through a small WebSocket relay. For the MVP, the relay is meant for people on the **same local network** (home, office, or lab). There are two ways to run one.

| Option | Best for | Runs while |
| --- | --- | --- |
| [Host from VS Code](#option-1-host-from-vs-code) | Quick sessions, small teams | Your VS Code window is open |
| [Standalone relay](#option-2-standalone-relay) | Home servers, office servers, always-on use | The server is running |

Everyone who wants to chat must connect to the **same** relay.

Both options serve encrypted `wss://` connections with a certificate the relay creates for itself. The address you share includes that certificate's fingerprint, for example:

```text
wss://192.168.1.20:8787#sha256=6E:37:98:73:CD:CB:F1:1B:52:36:9F:0E:CB:47:9C:59:81:39:BE:F8:6C:DC:BE:57:4D:7F:7A:35:48:BE:B2:5B
```

Always share and paste the **whole** address. See [Encrypted connections](#encrypted-connections) for why.

## Option 1: Host from VS Code

1. Run **Dev Chat: Host Relay on This Network** from the Command Palette.
2. Choose **Copy Address** and send the address (`wss://<your LAN IP>:8787#sha256=...`) to the people you want to chat with, through a channel you trust.
3. Your own VS Code connects to the hosted relay automatically. The status bar shows the port and how many clients are connected; hover it to see the certificate fingerprint and the addresses to share.
4. Run **Dev Chat: Stop Hosting Relay** (or click the status bar item) when you are done. Closing VS Code also stops the relay, which disconnects everyone.

The relay uses port `8787` by default. If another program already uses it, change **Dev Chat › Host Relay: Port** (`devChat.hostRelay.port`) in Settings.

The relay certificate is created the first time you host and reused afterwards, so the address you shared keeps working. The certificate is stored in VS Code's extension storage and its private key in VS Code's secret storage. To replace it, see [Regenerate the certificate](#regenerate-the-certificate).

The first time you host, your operating system may ask whether to allow incoming connections. See [Allow the relay through the firewall](#allow-the-relay-through-the-firewall).

## Option 2: Standalone relay

### With Docker

Build the image from the repository root (the relay uses code in `shared/`):

```sh
docker build -f server/Dockerfile -t dev-chat-relay .
docker run -d --name dev-chat-relay --restart unless-stopped \
  -p 8787:8787 -v dev-chat-relay-data:/app/server/relay-data dev-chat-relay
docker logs dev-chat-relay
```

The logs show the certificate fingerprint and the address to share: `wss://<server's LAN IP>:8787#sha256=...`. Keep the `-v` volume: it stores the certificate, so the fingerprint stays the same when the container is recreated. Without it, every new container gets a new certificate and everyone has to update their address.

To use a different port on the host, change the left side of `-p`, for example `-p 9000:8787`, and share port `9000`.

### With Node.js

Requires Node.js 20 or newer.

```sh
npm --prefix server ci
npm --prefix server run build
npm --prefix server start
```

When it starts, the relay prints its certificate fingerprint and the full addresses it can be reached at. The certificate is stored in `server/relay-data/` (ignored by git). The private key file is readable only by the user running the relay on macOS and Linux; on Windows, keep the folder in a location only you can access.

### Configuration

Set these as environment variables (or in `server/.env` when running with Node.js; that file is not committed):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Port to listen on |
| `HOST` | all interfaces | Interface to bind, for example a single LAN address. Leave unset in Docker; use `-p` instead |
| `DATA_DIR` | `relay-data` (relative to the working directory); `/app/server/relay-data` in Docker | Where the relay keeps its self-signed certificate (`relay-cert.pem`) and private key (`relay-key.pem`) |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | unset | Use your own certificate and private key (PEM) instead of the self-signed one. Set both |
| `TLS_DISABLED` | `false` | Serve unencrypted `ws://`. Only for local development, or behind a reverse proxy that already provides `wss://`. Dev Chat refuses `ws://` to any relay that is not on the same computer |
| `MAX_MESSAGE_BYTES` | `8192` | Largest accepted message |
| `RATE_LIMIT_WINDOW_MS` / `MAX_MESSAGES_PER_WINDOW` | `1000` / `20` | Per-connection rate limit |
| `HEARTBEAT_INTERVAL_MS` / `STALE_SOCKET_TIMEOUT_MS` | `15000` / `45000` | Idle connection detection |
| `HEALTH_LOG_INTERVAL_MS` | `30000` | How often a health summary is logged |
| `ALLOW_NON_LOCAL_CONNECTIONS` | `false` | Accept connections from public IP addresses. Not recommended; see [Local network only](#local-network-only) |

## Connect to a relay

In VS Code Settings, set **Dev Chat › Relay Url** (`devChat.relayUrl`) to the full address you were given, including `#sha256=...`, then run **Dev Chat: Connect Relay**. If you are already connected, Dev Chat reconnects to the new address automatically.

This setting is stored per machine, so a workspace you open cannot silently point you at a different relay.

## Encrypted connections

Messages are always end-to-end encrypted, whatever the connection type. Encrypting the connection to the relay additionally protects what travels alongside them from others on the network: public keys, who is messaging whom, and (once added) join codes.

- **The `#sha256=` fingerprint pins the relay's certificate.** Dev Chat checks that the relay presents exactly that certificate before sending anything. Someone on the network pretending to be the relay cannot produce it. The fingerprint is part of the URL fragment, which is never sent over the network.
- **Get the address from the relay host through a channel you trust** (in person, or a chat you already trust). Whoever gives you the address decides which relay you trust.
- **Certificates from a trusted certificate authority** also work. If the relay uses `TLS_CERT_FILE`/`TLS_KEY_FILE` with a certificate issued for its host name (for example `wss://relay.example.lan:8787`), you can leave out the `#sha256=` part and Dev Chat validates the certificate normally. Adding the fingerprint still works and pins that exact certificate.
- **Unencrypted `ws://`** is only accepted for a relay on the same computer (`localhost`, `127.x.x.x`, `::1`). Dev Chat refuses `ws://` addresses for anything else.

### If Dev Chat refuses to connect

| Message | What it means | What to do |
| --- | --- | --- |
| *presented a different certificate than the one in your relay URL* | The relay's certificate does not match the fingerprint you pinned. Either the relay host regenerated it (or recreated a Docker container without a volume), or someone is intercepting the connection. | Ask the relay host, through a channel you trust, whether they changed the certificate. Only then update **Dev Chat › Relay Url** to the new address they give you. There is deliberately no "connect anyway" option. |
| *The relay certificate is not trusted* | The address uses `wss://` without a fingerprint, and the certificate is self-signed or not valid for that host name. | Use the full address the relay host shares, including `#sha256=...`. |
| *Unencrypted ws:// is only allowed for a relay on this computer* | The address uses `ws://` for another machine. | Use the `wss://` address the relay prints at startup. |

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
- Anyone on the same network who knows the address can connect. Access control with join codes is tracked in [#33](https://github.com/Roarmo/vscode-dev-chat/issues/33).

## What the relay can see

The relay cannot read messages: they are encrypted on the sender's machine and only the recipient can decrypt them. Encrypted `wss://` connections hide traffic from others on the network, but the relay itself still sees and logs metadata needed for routing:

- the public keys of connected users and who sends to whom,
- when messages are sent and their size,
- client IP addresses.

Only run or use a relay operated by someone you trust with this metadata.
