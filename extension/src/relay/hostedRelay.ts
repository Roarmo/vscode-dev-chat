import {
    startRelayServer,
    type RelayLogger,
    type RelayServerOptions,
    type RunningRelayServer,
} from "../../../shared/relayServer";
import { getLocalNetworkAddresses } from "../../../shared/networkAddress";
import { getCertificateFingerprint, type RelayTlsCredentials } from "../../../shared/relayCertificate";
import { formatPinnedRelayUrl } from "./relaySettings";

export interface HostedRelayInfo {
    port: number;
    /** URL the hosting VS Code instance itself connects to. */
    localUrl: string;
    /** URLs other people on the same network can use. */
    networkUrls: string[];
    /** SHA-256 fingerprint of the relay certificate that clients pin. */
    fingerprint: string;
}

type StartRelayServer = (options: RelayServerOptions) => Promise<RunningRelayServer>;

/**
 * Runs the relay inside the extension host so a VS Code user can share it
 * with others on the same local network.
 */
export class HostedRelay {
    private server: RunningRelayServer | undefined;
    private fingerprint = "";
    private pending: Promise<unknown> = Promise.resolve();
    private readonly connectionListeners = new Set<(count: number) => void>();

    constructor(
        private readonly logger?: RelayLogger,
        private readonly startServer: StartRelayServer = startRelayServer,
        private readonly listAddresses: () => string[] = getLocalNetworkAddresses
    ) {}

    public get isRunning(): boolean {
        return this.server !== undefined;
    }

    public get info(): HostedRelayInfo | undefined {
        return this.server ? this.describe(this.server.port) : undefined;
    }

    public get connectionCount(): number {
        return this.server?.connectionCount() ?? 0;
    }

    public onConnectionCountChange(listener: (count: number) => void): () => void {
        this.connectionListeners.add(listener);
        return () => this.connectionListeners.delete(listener);
    }

    /** Starts the relay over wss://, or returns the running one. Rejects with RelayPortInUseError if the port is taken. */
    public start(port: number, tls: RelayTlsCredentials): Promise<HostedRelayInfo> {
        return this.enqueue(async () => {
            if (this.server) return this.describe(this.server.port);

            const fingerprint = getCertificateFingerprint(tls.cert);
            this.server = await this.startServer({
                port,
                tls,
                ...(this.logger ? { logger: this.logger } : {}),
                onConnectionCountChange: (count) => {
                    for (const listener of this.connectionListeners) listener(count);
                },
            });
            this.fingerprint = fingerprint;
            return this.describe(this.server.port);
        });
    }

    public stop(): Promise<void> {
        return this.enqueue(async () => {
            const server = this.server;
            this.server = undefined;
            await server?.close();
        });
    }

    private describe(port: number): HostedRelayInfo {
        return {
            port,
            localUrl: formatPinnedRelayUrl("127.0.0.1", port, this.fingerprint),
            networkUrls: this.listAddresses().map((address) => formatPinnedRelayUrl(address, port, this.fingerprint)),
            fingerprint: this.fingerprint,
        };
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.pending.then(operation, operation);
        this.pending = result.catch(() => undefined);
        return result;
    }
}

export default HostedRelay;
