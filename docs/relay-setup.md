# Relay Setup

Dev Chat clients exchange encrypted messages through a small WebSocket relay. For the MVP, the relay is meant for people on the **same local network** (home, office, or lab). There are two ways to run one.

| Option | Best for | Runs while |
| --- | --- | --- |
| [Host from VS Code](#option-1-host-from-vs-code) | Quick sessions, small teams | Your VS Code window is open |
| [Standalone relay](#option-2-standalone-relay) | Home servers, office servers, always-on use | The server is running |

Everyone who wants to chat must connect to the **same** relay.

## Option 1: Host from VS Code

1. Run **Dev Chat: Host Relay on This Network** from the Command Palette.
2. Choose **Copy Address** and send the address (for example `ws://192.168.1.20:8787`) to the people you want to chat with.
3. Your own VS Code connects to the hosted relay automatically. The status bar shows the port and how many clients are connected.
4. Run **Dev Chat: Stop Hosting Relay** (or click the status bar item) when you are done. Closing VS Code also stops the relay, which disconnects everyone.

The relay uses port `8787` by default. If another program already uses it, change **Dev Chat › Host Relay: Port** (`devChat.hostRelay.port`) in Settings.

The first time you host, your operating system may ask whether to allow incoming connections. See [Allow the relay through the firewall](#allow-the-relay-through-the-firewall).

## Option 2: Standalone relay

### With Docker

Build the image from the repository root (the relay uses code in `shared/`):

```sh
docker build -f server/Dockerfile -t dev-chat-relay .
docker run -d --name dev-chat-relay --restart unless-stopped -p 8787:8787 dev-chat-relay
```

Share `ws://<server's LAN IP>:8787`. To use a different port on the host, change the left side of `-p`, for example `-p 9000:8787`, and share port `9000`.

### With Node.js

Requires Node.js 20 or newer.

```sh
npm --prefix server ci
npm --prefix server run build
npm --prefix server start
```

The relay prints the addresses it can be reached at when it starts.

### Configuration

Set these as environment variables (or in `server/.env` when running with Node.js; that file is not committed):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Port to listen on |
| `HOST` | all interfaces | Interface to bind, for example a single LAN address |
| `MAX_MESSAGE_BYTES` | `8192` | Largest accepted message |
| `RATE_LIMIT_WINDOW_MS` / `MAX_MESSAGES_PER_WINDOW` | `1000` / `20` | Per-connection rate limit |
| `HEARTBEAT_INTERVAL_MS` / `STALE_SOCKET_TIMEOUT_MS` | `15000` / `45000` | Idle connection detection |
| `HEALTH_LOG_INTERVAL_MS` | `30000` | How often a health summary is logged |
| `ALLOW_NON_LOCAL_CONNECTIONS` | `false` | Accept connections from public IP addresses. Not recommended; see [Local network only](#local-network-only) |

## Connect to a relay

In VS Code Settings, set **Dev Chat › Relay Url** (`devChat.relayUrl`) to the address you were given, for example `ws://192.168.1.20:8787`, then run **Dev Chat: Connect Relay**. If you are already connected, Dev Chat reconnects to the new address automatically.

This setting is stored per machine, so a workspace you open cannot silently point you at a different relay.

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
- Connections currently use unencrypted `ws://`. Message contents are still end-to-end encrypted, but connection metadata is visible on the network. Encrypted relay connections are tracked in [#27](https://github.com/Roarmo/vscode-dev-chat/issues/27).

## What the relay can see

The relay cannot read messages: they are encrypted on the sender's machine and only the recipient can decrypt them. The relay does see and log metadata needed for routing:

- the public keys of connected users and who sends to whom,
- when messages are sent and their size,
- client IP addresses.

Only run or use a relay operated by someone you trust with this metadata.
