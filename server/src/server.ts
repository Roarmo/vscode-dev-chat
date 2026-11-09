import * as dotenv from "dotenv";
import { DEFAULT_RELAY_LIMITS, DEFAULT_RELAY_PORT, startRelayServer } from "../../shared/relayServer";
import { getLocalNetworkAddresses } from "../../shared/networkAddress";

dotenv.config();

function logInfo(message: string): void {
	console.log(`[relay] ${message}`);
}

function logError(message: string): void {
	console.error(`[relay] ${message}`);
}

function parsePort(rawPort: string | undefined): number {
	if (!rawPort || rawPort.trim() === "") {
		logInfo(`No PORT specified; using default ${DEFAULT_RELAY_PORT}`);
		return DEFAULT_RELAY_PORT;
	}

	const parsed = Number(rawPort);
	const isValidPort = Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535;
	if (!isValidPort) {
		throw new Error(
			`Invalid PORT value "${rawPort}". Expected an integer between 1 and 65535.`
		);
	}

	return parsed;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
	if (!raw || raw.trim() === "") {
		return fallback;
	}

	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		return fallback;
	}

	return parsed;
}

function parseBoolean(raw: string | undefined): boolean {
	return raw !== undefined && ["1", "true", "yes"].includes(raw.trim().toLowerCase());
}

async function main(): Promise<void> {
	const port = parsePort(process.env.PORT);
	const host = process.env.HOST?.trim();
	const allowNonLocal = parseBoolean(process.env.ALLOW_NON_LOCAL_CONNECTIONS);

	const relay = await startRelayServer({
		port,
		...(host ? { host } : {}),
		...(allowNonLocal ? { isRemoteAddressAllowed: () => true } : {}),
		limits: {
			maxMessageBytes: parsePositiveInt(process.env.MAX_MESSAGE_BYTES, DEFAULT_RELAY_LIMITS.maxMessageBytes),
			rateLimitWindowMs: parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, DEFAULT_RELAY_LIMITS.rateLimitWindowMs),
			maxMessagesPerWindow: parsePositiveInt(process.env.MAX_MESSAGES_PER_WINDOW, DEFAULT_RELAY_LIMITS.maxMessagesPerWindow),
			heartbeatIntervalMs: parsePositiveInt(process.env.HEARTBEAT_INTERVAL_MS, DEFAULT_RELAY_LIMITS.heartbeatIntervalMs),
			staleSocketTimeoutMs: parsePositiveInt(process.env.STALE_SOCKET_TIMEOUT_MS, DEFAULT_RELAY_LIMITS.staleSocketTimeoutMs),
			healthLogIntervalMs: parsePositiveInt(process.env.HEALTH_LOG_INTERVAL_MS, DEFAULT_RELAY_LIMITS.healthLogIntervalMs),
		},
	});

	logInfo(`Dev Chat relay server listening on port ${relay.port}`);
	logInfo(`  This machine:  ws://127.0.0.1:${relay.port}`);
	for (const address of getLocalNetworkAddresses()) {
		logInfo(`  Local network: ws://${address}:${relay.port}`);
	}
	if (allowNonLocal) {
		logInfo("WARNING: ALLOW_NON_LOCAL_CONNECTIONS is enabled; connections from any network are accepted.");
	} else {
		logInfo("Only connections from loopback, private and link-local addresses are accepted.");
	}

	let shuttingDown = false;
	const shutdown = (signal: NodeJS.Signals): void => {
		if (shuttingDown) return;
		shuttingDown = true;
		logInfo(`Received ${signal}; shutting down relay server.`);
		relay.close().then(
			() => process.exit(0),
			(error: unknown) => {
				logError(`Shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
				process.exit(1);
			}
		);
	};

	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	logError(`Startup failed: ${message}`);
	process.exit(1);
});
