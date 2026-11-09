import {
    assertValidRelayCredentials,
    generateRelayCertificate,
    type GeneratedRelayCertificate,
    type RelayTlsCredentials,
} from "../../../shared/relayCertificate";

export const HOST_RELAY_CERTIFICATE_STATE_KEY = "devChat.hostRelay.certificate";
export const HOST_RELAY_PRIVATE_KEY_SECRET_KEY = "devChat.hostRelay.privateKey";

/** The subset of vscode.Memento used here. */
export interface CertificateStateStorage {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void>;
}

/** The subset of vscode.SecretStorage used here. */
export interface PrivateKeyStorage {
    get(key: string): Thenable<string | undefined>;
    store(key: string, value: string): Thenable<void>;
}

/**
 * Keeps the hosted relay's TLS certificate stable across VS Code restarts, so
 * people who pinned its fingerprint can reconnect. The certificate is public
 * and stored in extension state; its private key lives in secret storage.
 */
export class HostRelayCertificateStore {
    constructor(
        private readonly state: CertificateStateStorage,
        private readonly secrets: PrivateKeyStorage,
        private readonly generate: () => Promise<GeneratedRelayCertificate> = generateRelayCertificate,
        private readonly onWarning?: (message: string) => void
    ) {}

    /** Returns the stored certificate, creating one if none exists or the stored one is unusable. */
    public async load(): Promise<RelayTlsCredentials> {
        const cert = this.state.get<string>(HOST_RELAY_CERTIFICATE_STATE_KEY);
        const key = await this.secrets.get(HOST_RELAY_PRIVATE_KEY_SECRET_KEY);
        if (cert && key) {
            try {
                assertValidRelayCredentials({ cert, key });
                return { cert, key };
            } catch (error) {
                this.onWarning?.(
                    `Stored relay certificate is unusable (${error instanceof Error ? error.message : String(error)}); creating a new one.`
                );
            }
        }
        return this.regenerate();
    }

    /** Replaces the certificate. Clients that pinned the old fingerprint will refuse to connect. */
    public async regenerate(): Promise<RelayTlsCredentials> {
        const generated = await this.generate();
        await this.secrets.store(HOST_RELAY_PRIVATE_KEY_SECRET_KEY, generated.key);
        await this.state.update(HOST_RELAY_CERTIFICATE_STATE_KEY, generated.cert);
        return { cert: generated.cert, key: generated.key };
    }
}

export default HostRelayCertificateStore;
