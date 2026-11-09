import { randomUUID } from "crypto";
import type { TLSSocket } from "tls";
import WebSocket, { RawData } from "ws";
import type {
    AckMessage,
    DirectMessage,
    ErrorMessage,
    HelloMessage,
    RelayMessage,
    ServerToClientMessage,
} from "../../../shared/types";
import { isRelayMessage } from "../../../shared/types";
import { fingerprintsMatch } from "../../../shared/relayCertificate";
import { Logger } from "../logger";
import { validateRelayUrl } from "./relaySettings";

export type RelayConnectionState = "disconnected" | "connecting" | "connected" | "error";

export type RelayConnectionErrorCode =
    | "INVALID_URL"
    | "INSECURE_URL"
    | "CERTIFICATE_MISMATCH"
    | "CERTIFICATE_UNTRUSTED"
    | "CONNECTION_FAILED";

export interface RelayConnectionError {
    code: RelayConnectionErrorCode;
    message: string;
}

export interface RelayClientOptions {
    /** Extra certificate authorities to trust for wss:// relays without a pinned fingerprint. */
    ca?: string | Buffer | Array<string | Buffer>;
}

const ACK_TIMEOUT_MS = 15000;

const UNTRUSTED_CERTIFICATE_CODES = new Set([
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "CERT_HAS_EXPIRED",
    "CERT_NOT_YET_VALID",
    "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export class RelayClient {
    private socket: WebSocket | undefined;
    private identity: string | undefined;
    private helloRequestId: string | undefined;
    private connectionState: RelayConnectionState = "disconnected";
    private lastConnectionError: RelayConnectionError | undefined;
    private readonly statusListeners = new Set<(state: RelayConnectionState) => void>();
    private readonly messageListeners = new Set<(message: ServerToClientMessage) => void>();
    private readonly connectionErrorListeners = new Set<(error: RelayConnectionError) => void>();
    private readonly pendingMessages = new Map<string, NodeJS.Timeout>();

    constructor(
        private relayUrl: string,
        private readonly logger?: Logger,
        private readonly options: RelayClientOptions = {}
    ) {}

    public get state(): RelayConnectionState {
        return this.connectionState;
    }

    public get url(): string {
        return this.relayUrl;
    }

    /** Why the most recent connection attempt failed, if it did. */
    public get lastError(): RelayConnectionError | undefined {
        return this.lastConnectionError;
    }

    /**
     * Points the client at a different relay. An active or in-progress
     * connection is closed and re-established against the new URL.
     */
    public setUrl(url: string): void {
        if (url === this.relayUrl) return;
        this.relayUrl = url;
        this.logger?.info(`Relay URL changed to ${url}`);

        const identity = this.identity;
        if (identity && this.socket) {
            this.close();
            this.connect(identity);
        }
    }

    public connect(identity: string): void {
        if (
            this.socket &&
            this.connectionState !== "error" &&
            (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN)
        ) {
            return;
        }

        if (this.socket) {
            const previousSocket = this.socket;
            this.socket = undefined;
            if (previousSocket.readyState < WebSocket.CLOSING) previousSocket.close();
        }
        this.identity = identity;
        this.lastConnectionError = undefined;
        this.setState("connecting");

        const target = validateRelayUrl(this.relayUrl);
        if (!target.ok) {
            this.failConnection(undefined, { code: target.code, message: target.error });
            return;
        }
        const pinnedFingerprint = target.fingerprint;
        this.logger?.info(
            `Connecting to relay at ${target.connectUrl}${pinnedFingerprint ? " (pinned certificate)" : ""}`
        );

        let socket: WebSocket;
        try {
            socket = new WebSocket(
                target.connectUrl,
                pinnedFingerprint
                    // Self-signed relay certificates are trusted by fingerprint, checked on "upgrade" below.
                    ? { rejectUnauthorized: false }
                    : this.options.ca ? { ca: this.options.ca } : {}
            );
        } catch (error) {
            this.failConnection(undefined, {
                code: "CONNECTION_FAILED",
                message: `Relay connection failed: ${error instanceof Error ? error.message : String(error)}`,
            });
            return;
        }
        this.socket = socket;
        let certificateVerified = pinnedFingerprint === undefined;

        socket.on("upgrade", (response) => {
            if (this.socket !== socket || !pinnedFingerprint) return;

            const tlsSocket = response.socket as Partial<TLSSocket>;
            const presented = tlsSocket.getPeerCertificate?.()?.fingerprint256;
            if (presented && fingerprintsMatch(presented, pinnedFingerprint)) {
                certificateVerified = true;
                return;
            }

            this.failConnection(socket, {
                code: "CERTIFICATE_MISMATCH",
                message:
                    `The relay at ${new URL(target.connectUrl).host} presented a different certificate than the one in your relay URL ` +
                    `(expected ${pinnedFingerprint}, got ${presented ?? "none"}). ` +
                    "The relay certificate may have been regenerated, or someone may be intercepting the connection. " +
                    "Confirm the new address with the relay host through a channel you trust before updating devChat.relayUrl.",
            });
            socket.terminate();
        });

        socket.on("open", () => {
            if (this.socket !== socket) return;
            if (!certificateVerified) {
                this.failConnection(socket, {
                    code: "CERTIFICATE_MISMATCH",
                    message: "The relay certificate could not be verified.",
                });
                socket.terminate();
                return;
            }

            const hello: HelloMessage = {
                type: "hello",
                requestId: randomUUID(),
                from: identity,
                message: "VS Code Dev Chat client",
                timestamp: new Date().toISOString(),
            };
            this.helloRequestId = hello.requestId;
            socket.send(JSON.stringify(hello), (error) => {
                if (error && this.socket === socket) {
                    this.logger?.error(`Failed to register with relay: ${error.message}`);
                    this.setState("error");
                }
            });
        });

        socket.on("message", (data: RawData) => this.handleMessage(socket, data));
        socket.on("error", (error: NodeJS.ErrnoException) => {
            if (this.socket !== socket) return;
            if (error.code && UNTRUSTED_CERTIFICATE_CODES.has(error.code)) {
                this.failConnection(socket, {
                    code: "CERTIFICATE_UNTRUSTED",
                    message:
                        `The relay certificate is not trusted (${error.message}). ` +
                        "If the relay uses a self-signed certificate, use the full address its host shares, including #sha256=<fingerprint>.",
                });
                return;
            }
            this.failConnection(socket, {
                code: "CONNECTION_FAILED",
                message:
                    `Relay connection failed: ${error.message}` +
                    (target.secure ? "" : " If the relay uses encrypted connections, use the wss:// address it shows at startup."),
            });
        });
        socket.on("close", () => {
            if (this.socket !== socket) return;
            this.socket = undefined;
            this.helloRequestId = undefined;
            this.setState(this.connectionState === "error" ? "error" : "disconnected");
        });
    }

    public sendDirectMessage(to: string, payload: string, requestId: string): boolean {
        const socket = this.socket;
        if (!this.identity || !socket || socket.readyState !== WebSocket.OPEN || this.state !== "connected") {
            return false;
        }

        const message: DirectMessage = {
            type: "direct_message",
            requestId,
            from: this.identity,
            to,
            payload,
            timestamp: new Date().toISOString(),
        };

        try {
            const timeout = setTimeout(() => this.failPendingMessage(requestId, "Delivery could not be confirmed. The recipient may still receive the message."), ACK_TIMEOUT_MS);
            this.pendingMessages.set(requestId, timeout);
            socket.send(JSON.stringify(message), (error) => {
                if (error) {
                    this.logger?.error(`Failed to send relay message: ${error.message}`);
                    this.failPendingMessage(requestId, "Could not send the message to the relay.");
                }
            });
            return true;
        } catch (error) {
            this.clearPendingMessage(requestId);
            this.logger?.error(`Failed to send relay message: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }

    public onStatusChange(listener: (state: RelayConnectionState) => void): () => void {
        this.statusListeners.add(listener);
        return () => this.statusListeners.delete(listener);
    }

    public onMessage(listener: (message: ServerToClientMessage) => void): () => void {
        this.messageListeners.add(listener);
        return () => this.messageListeners.delete(listener);
    }

    public onConnectionError(listener: (error: RelayConnectionError) => void): () => void {
        this.connectionErrorListeners.add(listener);
        return () => this.connectionErrorListeners.delete(listener);
    }

    public close(): void {
        const socket = this.socket;
        this.socket = undefined;
        this.helloRequestId = undefined;
        if (socket && socket.readyState < WebSocket.CLOSING) {
            socket.close();
        }
        this.setState("disconnected");
        this.logger?.info("Closed relay socket");
    }

    private handleMessage(socket: WebSocket, data: RawData): void {
        if (this.socket !== socket) return;

        let parsed: unknown;
        try {
            parsed = JSON.parse(data.toString());
        } catch {
            this.logger?.error("Relay sent invalid JSON.");
            this.setState("error");
            return;
        }

        if (!isRelayMessage(parsed)) {
            this.logger?.error("Relay sent a message that does not match the protocol.");
            this.setState("error");
            return;
        }

        const message = parsed as RelayMessage;
        if (message.type === "ack") {
            this.handleAck(message);
        } else if (message.type === "error") {
            this.handleError(message);
        } else if (message.type === "server_ready") {
            this.logger?.info(`Relay ready: ${message.message}`);
        }

        if (message.type !== "hello") {
            this.emitMessage(message as ServerToClientMessage);
        }
    }

    private handleAck(message: AckMessage): void {
        if (message.status === "delivered") this.clearPendingMessage(message.correlationId);
        if (message.correlationId === this.helloRequestId && message.status === "accepted") {
            this.setState("connected");
            this.logger?.info("Registered with relay.");
        }
    }

    private handleError(message: ErrorMessage): void {
        this.clearPendingMessage(message.correlationId);
        this.logger?.error(`Relay error ${message.code}: ${message.message}`);
        if (message.correlationId === this.helloRequestId) {
            this.setState("error");
        }
    }

    private emitMessage(message: ServerToClientMessage): void {
        for (const listener of this.messageListeners) listener(message);
    }

    private clearPendingMessage(requestId: string): void {
        const timeout = this.pendingMessages.get(requestId);
        if (timeout) clearTimeout(timeout);
        this.pendingMessages.delete(requestId);
    }

    private failPendingMessage(requestId: string, reason: string): void {
        if (!this.pendingMessages.has(requestId)) return;
        this.clearPendingMessage(requestId);
        this.emitMessage({
            type: "error",
            correlationId: requestId,
            code: "SEND_FAILED",
            message: reason,
            timestamp: new Date().toISOString(),
        });
    }

    /** Abandons the current connection attempt and reports why. Ignores stale sockets. */
    private failConnection(socket: WebSocket | undefined, error: RelayConnectionError): void {
        if (socket && this.socket !== socket) return;
        if (socket) {
            this.socket = undefined;
            this.helloRequestId = undefined;
        }
        this.lastConnectionError = error;
        this.logger?.error(`[${error.code}] ${error.message}`);
        this.setState("error");
        for (const listener of this.connectionErrorListeners) listener(error);
    }

    private setState(state: RelayConnectionState): void {
        if (this.connectionState === state) return;
        this.connectionState = state;
        if (state === "error" || state === "disconnected") {
            for (const requestId of this.pendingMessages.keys()) {
                this.failPendingMessage(requestId, "Connection lost before delivery was confirmed.");
            }
        }
        for (const listener of this.statusListeners) listener(state);
    }
}

export default RelayClient;
