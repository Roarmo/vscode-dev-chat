import * as dotenv from "dotenv";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import * as path from "path";
import { DEFAULT_RELAY_LIMITS, DEFAULT_RELAY_PORT, startRelayServer } from "../../shared/relayServer";
import { getLocalNetworkAddresses } from "../../shared/networkAddress";
import {
	assertValidRelayCredentials,
	generateRelayCertificate,
	getCertificateFingerprint,
	type RelayTlsCredentials,
} from "../../shared/relayCertificate";

dotenv.config({ quiet: true });

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

const REGENERATE_FLAG = "--regenerate-certificate";
const CERTIFICATE_FILE_NAME = "relay-cert.pem";
const PRIVATE_KEY_FILE_NAME = "relay-key.pem";

type TlsSetup =
	| { mode: "disabled" }
	| { mode: "provided" | "stored" | "generated"; credentials: RelayTlsCredentials; fingerprint: string; location: string };

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function readCredentials(certFile: string, keyFile: string): RelayTlsCredentials {
	const credentials = { cert: readFileSync(certFile, "utf8"), key: readFileSync(keyFile, "utf8") };
	assertValidRelayCredentials(credentials);
	return credentials;
}

/**
 * Chooses how the relay serves TLS: a certificate supplied by the operator, or
 * a self-signed one kept in DATA_DIR so its fingerprint survives restarts.
 */
async function loadTls(regenerate: boolean): Promise<TlsSetup> {
	if (parseBoolean(process.env.TLS_DISABLED)) {
		if (regenerate) throw new Error(`${REGENERATE_FLAG} cannot be used while TLS_DISABLED is set.`);
		return { mode: "disabled" };
	}

	const certFile = process.env.TLS_CERT_FILE?.trim();
	const keyFile = process.env.TLS_KEY_FILE?.trim();
	if (certFile || keyFile) {
		if (!certFile || !keyFile) throw new Error("Set both TLS_CERT_FILE and TLS_KEY_FILE, or neither.");
		if (regenerate) throw new Error(`${REGENERATE_FLAG} only applies to the relay's own certificate, not TLS_CERT_FILE.`);
		let credentials: RelayTlsCredentials;
		try {
			credentials = readCredentials(certFile, keyFile);
		} catch (error) {
			throw new Error(`Could not use TLS_CERT_FILE/TLS_KEY_FILE: ${describeError(error)}`);
		}
		return { mode: "provided", credentials, fingerprint: getCertificateFingerprint(credentials.cert), location: certFile };
	}

	const dataDir = path.resolve(process.env.DATA_DIR?.trim() || "relay-data");
	const certPath = path.join(dataDir, CERTIFICATE_FILE_NAME);
	const keyPath = path.join(dataDir, PRIVATE_KEY_FILE_NAME);

	if (!regenerate && existsSync(certPath) && existsSync(keyPath)) {
		let credentials: RelayTlsCredentials;
		try {
			credentials = readCredentials(certPath, keyPath);
		} catch (error) {
			throw new Error(
				`The stored relay certificate in ${dataDir} is unusable: ${describeError(error)} ` +
				`Start the relay with ${REGENERATE_FLAG} to create a new one, then share the new address.`
			);
		}
		return { mode: "stored", credentials, fingerprint: getCertificateFingerprint(credentials.cert), location: certPath };
	}

	const generated = await generateRelayCertificate();
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	writeFileSync(keyPath, generated.key, { mode: 0o600 });
	chmodSync(keyPath, 0o600);
	writeFileSync(certPath, generated.cert, { mode: 0o644 });
	return {
		mode: "generated",
		credentials: { cert: generated.cert, key: generated.key },
		fingerprint: generated.fingerprint,
		location: certPath,
	};
}

function relayAddress(scheme: "ws" | "wss", host: string, port: number | string, fingerprint: string | undefined): string {
	const base = `${scheme}://${host}:${port}`;
	return fingerprint ? `${base}#sha256=${fingerprint}` : base;
}

async function main(): Promise<void> {
	const regenerate = process.argv.includes(REGENERATE_FLAG);
	const tls = await loadTls(regenerate);
	const port = parsePort(process.env.PORT);
	const host = process.env.HOST?.trim();
	const allowNonLocal = parseBoolean(process.env.ALLOW_NON_LOCAL_CONNECTIONS);

	const relay = await startRelayServer({
		port,
		...(host ? { host } : {}),
		...(allowNonLocal ? { isRemoteAddressAllowed: () => true } : {}),
		...(tls.mode === "disabled" ? {} : { tls: tls.credentials }),
		limits: {
			maxMessageBytes: parsePositiveInt(process.env.MAX_MESSAGE_BYTES, DEFAULT_RELAY_LIMITS.maxMessageBytes),
			rateLimitWindowMs: parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, DEFAULT_RELAY_LIMITS.rateLimitWindowMs),
			maxMessagesPerWindow: parsePositiveInt(process.env.MAX_MESSAGES_PER_WINDOW, DEFAULT_RELAY_LIMITS.maxMessagesPerWindow),
			heartbeatIntervalMs: parsePositiveInt(process.env.HEARTBEAT_INTERVAL_MS, DEFAULT_RELAY_LIMITS.heartbeatIntervalMs),
			staleSocketTimeoutMs: parsePositiveInt(process.env.STALE_SOCKET_TIMEOUT_MS, DEFAULT_RELAY_LIMITS.staleSocketTimeoutMs),
			healthLogIntervalMs: parsePositiveInt(process.env.HEALTH_LOG_INTERVAL_MS, DEFAULT_RELAY_LIMITS.healthLogIntervalMs),
		},
	});

	const scheme = tls.mode === "disabled" ? "ws" : "wss";
	const fingerprint = tls.mode === "disabled" ? undefined : tls.fingerprint;
	logInfo(`Dev Chat relay server listening on port ${relay.port} (${scheme}://)`);
	if (tls.mode === "disabled") {
		logInfo(
			"WARNING: TLS_DISABLED is set; the relay serves unencrypted ws://. Dev Chat only connects to ws:// relays on the " +
			"same computer, so use this only for local development or behind a reverse proxy that terminates TLS."
		);
	} else {
		const origin = {
			provided: "Using the certificate from TLS_CERT_FILE",
			stored: "Using the relay certificate stored at",
			generated: "Created a new self-signed relay certificate at",
		}[tls.mode];
		logInfo(`${origin} ${tls.location}`);
		logInfo(`Certificate SHA-256 fingerprint: ${tls.fingerprint}`);
		if (tls.mode === "provided") {
			logInfo("If this certificate is issued by a trusted CA for the relay's host name, clients may omit the #sha256= part.");
		}
	}
	logInfo("Share one of these addresses; people set Dev Chat > Relay Url to it:");
	if (existsSync("/.dockerenv")) {
		logInfo(`  Docker host:   ${relayAddress(scheme, "127.0.0.1", "<published port>", fingerprint)}`);
		logInfo(`  Local network: ${relayAddress(scheme, "<host computer's LAN IP>", "<published port>", fingerprint)}`);
	} else {
		logInfo(`  This machine:  ${relayAddress(scheme, "127.0.0.1", relay.port, fingerprint)}`);
		for (const address of getLocalNetworkAddresses()) {
			logInfo(`  Local network: ${relayAddress(scheme, address, relay.port, fingerprint)}`);
		}
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
