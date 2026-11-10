import { randomUUID } from "crypto";
import type { TLSSocket } from "tls";
import WebSocket, { RawData } from "ws";
import type {
    AckMessage,
    DirectMessage,
    ErrorMessage,
    HelloMessage,
    RelayAdminAction,
    RelayAdminMessage,
    RelayAdminResultMessage,
    RelayAuthenticateMessage,
    RelayChallengeMessage,
    ServerToClientMessage,
} from "../../../shared/types";
import { isServerToClientMessage } from "../../../shared/types";
import { isJoinCode } from "../../../shared/relayAuthentication";
import { fingerprintsMatch } from "../../../shared/relayCertificate";
import { isLoopbackHost } from "../../../shared/networkAddress";
import { Logger } from "../logger";
import { validateRelayUrl, type ParsedRelayUrl } from "./relaySettings";

export type RelayConnectionState = "disconnected" | "connecting" | "connected" | "error";

export type RelayConnectionErrorCode =
    | "INVALID_URL"
    | "INSECURE_URL"
    | "CERTIFICATE_MISMATCH"
    | "CERTIFICATE_UNTRUSTED"
    | "AUTHENTICATION_FAILED"
    | "INVITE_REQUIRED"
    | "JOIN_RATE_LIMITED"
    | "CONNECTION_FAILED";

export interface RelayConnectionError {
    code: RelayConnectionErrorCode;
    message: string;
}

export interface RelayClientOptions {
    /** Extra certificate authorities to trust for wss:// relays without a pinned fingerprint. */
    ca?: string | Buffer | Array<string | Buffer>;
}

export interface RelayIdentity {
    readonly publicKey: string;
    readonly signingPublicKey: string;
    proveRelayChallenge(challenge: RelayChallengeMessage, joinCode: string): { proof: string; signature: string };
}

interface PendingAdminRequest {
    action: RelayAdminAction;
    timer: NodeJS.Timeout;
    resolve(result: RelayAdminResultMessage): void;
    reject(error: Error): void;
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
    private disposed = false;
    private socket: WebSocket | undefined;
    private identity: RelayIdentity | undefined;
    private helloRequestId: string | undefined;
    private helloTimer: NodeJS.Timeout | undefined;
    private challengeAnswered = false;
    private credentialTransportSafe = false;
    private joinCredential: { url: string; code: string } | undefined;
    private connectionState: RelayConnectionState = "disconnected";
    private lastConnectionError: RelayConnectionError | undefined;
    private readonly statusListeners = new Set<(state: RelayConnectionState) => void>();
    private readonly urlListeners = new Set<(url: string) => void>();
    private readonly messageListeners = new Set<(message: ServerToClientMessage) => void>();
    private readonly connectionErrorListeners = new Set<(error: RelayConnectionError) => void>();
    private readonly pendingMessages = new Map<string, NodeJS.Timeout>();
    private readonly pendingAdmin = new Map<string, PendingAdminRequest>();

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
        const target = validateRelayUrl(url);
        if (!target.ok || this.joinCredential?.url !== target.url) this.joinCredential = undefined;
        this.relayUrl = url;
        this.logger?.info("Relay URL changed.");
        for (const listener of this.urlListeners) listener(url);

        const identity = this.identity;
        if (identity && this.socket) {
            this.close();
            this.connect(identity);
        }
    }

    /** Keeps an invitation code only in memory and scopes it to one relay address. */
    public setJoinCode(url: string, code: string): void {
        const target = validateRelayUrl(url);
        if (!target.ok || !isJoinCode(code)) throw new Error("The relay invitation is invalid.");
        if (!target.fingerprint && !isLoopbackHost(new URL(target.connectUrl).hostname)) {
            throw new Error("A relay invitation requires a pinned TLS certificate.");
        }
        this.joinCredential = { url: target.url, code };
    }

    public connect(identity: RelayIdentity): void {
        if (this.disposed) return;
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
        this.clearHello();
        this.challengeAnswered = false;
        this.credentialTransportSafe = false;
        this.setState("connecting");

        const target = validateRelayUrl(this.relayUrl);
        if (!target.ok) {
            this.failConnection(undefined, { code: target.code, message: target.error });
            return;
        }
        const pinnedFingerprint = target.fingerprint;
        this.logger?.info(`Connecting to relay${pinnedFingerprint ? " (pinned certificate)" : ""}.`);

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
        let peerIsLoopback = false;

        socket.on("upgrade", (response) => {
            if (this.socket !== socket) return;
            peerIsLoopback = isLoopbackHost(response.socket.remoteAddress ?? "");
            if (!pinnedFingerprint) return;

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
                from: identity.publicKey,
                signingKey: identity.signingPublicKey,
                message: "VS Code Dev Chat client",
                timestamp: new Date().toISOString(),
            };
            this.helloRequestId = hello.requestId;
            this.credentialTransportSafe = Boolean(pinnedFingerprint && certificateVerified) || peerIsLoopback;
            this.helloTimer = setTimeout(() => {
                if (this.socket !== socket) return;
                this.failConnection(socket, { code: "AUTHENTICATION_FAILED", message: "Relay authentication timed out." });
                socket.terminate();
            }, ACK_TIMEOUT_MS);
            this.sendHandshake(socket, hello, "Could not start relay authentication.");
        });

        socket.on("message", (data: RawData) => this.handleMessage(socket, data, target));
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
        socket.on("close", (code) => {
            if (this.socket !== socket) return;
            if (code === 4003 && this.connectionState === "connected") {
                this.failConnection(socket, {
                    code: "INVITE_REQUIRED",
                    message: "Your relay membership was removed. Ask the administrator for a new invitation.",
                });
                return;
            }
            this.socket = undefined;
            this.clearHello();
            this.credentialTransportSafe = false;
            this.joinCredential = undefined;
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
            from: this.identity.publicKey,
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

    public requestAdmin(
        action: RelayAdminAction,
        options: Pick<RelayAdminMessage, "publicKey" | "removeMembers" | "expectedRevision"> = {}
    ): Promise<RelayAdminResultMessage> {
        const socket = this.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN || this.state !== "connected") {
            return Promise.reject(new Error("Connect to the relay before managing it."));
        }
        if (!this.credentialTransportSafe) {
            return Promise.reject(new Error("Relay administration requires a pinned TLS connection or loopback."));
        }

        const requestId = randomUUID();
        const message: RelayAdminMessage = {
            type: "relay_admin",
            requestId,
            action,
            ...options,
            timestamp: new Date().toISOString(),
        };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => this.rejectAdminRequest(requestId, "Relay administration timed out."), ACK_TIMEOUT_MS);
            this.pendingAdmin.set(requestId, { action, timer, resolve, reject });
            try {
                socket.send(JSON.stringify(message), (error) => {
                    if (error) this.rejectAdminRequest(requestId, "Could not send the relay administration request.");
                });
            } catch {
                this.rejectAdminRequest(requestId, "Could not send the relay administration request.");
            }
        });
    }

    public onStatusChange(listener: (state: RelayConnectionState) => void): () => void {
        this.statusListeners.add(listener);
        return () => this.statusListeners.delete(listener);
    }

    public onUrlChange(listener: (url: string) => void): () => void {
        this.urlListeners.add(listener);
        return () => this.urlListeners.delete(listener);
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
        this.clearHello();
        this.credentialTransportSafe = false;
        this.joinCredential = undefined;
        if (socket && socket.readyState < WebSocket.CLOSING) {
            socket.close();
        }
        this.setState("disconnected");
        this.logger?.info("Closed relay socket");
    }

    public dispose(): void {
        this.disposed = true;
        this.close();
    }

    private handleMessage(socket: WebSocket, data: RawData, target: ParsedRelayUrl): void {
        if (this.socket !== socket) return;

        let parsed: unknown;
        try {
            parsed = JSON.parse(data.toString());
        } catch {
            this.failConnection(socket, { code: "CONNECTION_FAILED", message: "Relay sent invalid JSON." });
            socket.terminate();
            return;
        }

        if (!isServerToClientMessage(parsed)) {
            this.failConnection(socket, { code: "CONNECTION_FAILED", message: "Relay sent an invalid protocol message." });
            socket.terminate();
            return;
        }

        const message = parsed;
        if (message.type === "relay_challenge") {
            this.answerChallenge(socket, target, message);
            return;
        }
        if (message.type === "relay_admin_result") {
            this.handleAdminResult(message);
            return;
        }
        if (message.type === "ack") {
            if (!this.handleAck(socket, message)) return;
        } else if (message.type === "error") {
            if (!this.handleError(socket, message)) return;
        } else if (message.type === "server_ready") {
            this.logger?.info("Relay connection established.");
        } else if (message.type === "direct_message" && this.state !== "connected") {
            this.failConnection(socket, { code: "AUTHENTICATION_FAILED", message: "Relay sent a message before authentication completed." });
            socket.terminate();
            return;
        }

        this.emitMessage(message);
    }

    private answerChallenge(socket: WebSocket, target: ParsedRelayUrl, challenge: RelayChallengeMessage): void {
        const identity = this.identity;
        if (
            !identity || this.connectionState !== "connecting" || this.challengeAnswered ||
            challenge.correlationId !== this.helloRequestId ||
            challenge.expiresAt <= challenge.issuedAt || challenge.expiresAt - challenge.issuedAt > 60_000
        ) {
            this.failConnection(socket, { code: "AUTHENTICATION_FAILED", message: "Relay sent an unexpected authentication challenge." });
            socket.terminate();
            return;
        }
        if (target.fingerprint && !fingerprintsMatch(target.fingerprint, challenge.relayId)) {
            this.failConnection(socket, { code: "CERTIFICATE_MISMATCH", message: "The authentication challenge does not match the pinned relay certificate." });
            socket.terminate();
            return;
        }
        const joinCode = this.joinCredential?.url === target.url ? this.joinCredential.code : "";
        if (joinCode && !this.credentialTransportSafe) {
            this.failConnection(socket, { code: "CERTIFICATE_UNTRUSTED", message: "A relay invitation may only be sent over pinned TLS or loopback." });
            socket.terminate();
            return;
        }

        let response: { proof: string; signature: string };
        try {
            response = identity.proveRelayChallenge(challenge, joinCode);
        } catch {
            this.failConnection(socket, { code: "AUTHENTICATION_FAILED", message: "Relay sent an invalid authentication challenge." });
            socket.terminate();
            return;
        }
        const authentication: RelayAuthenticateMessage = {
            type: "relay_authenticate",
            requestId: challenge.correlationId,
            challengeId: challenge.challengeId,
            proof: response.proof,
            signature: response.signature,
            joinCode,
            timestamp: new Date().toISOString(),
        };
        this.challengeAnswered = true;
        this.sendHandshake(socket, authentication, "Could not send relay authentication.");
    }

    private sendHandshake(socket: WebSocket, message: HelloMessage | RelayAuthenticateMessage, errorMessage: string): void {
        const fail = (): void => {
            if (this.socket !== socket) return;
            this.failConnection(socket, { code: "CONNECTION_FAILED", message: errorMessage });
            socket.terminate();
        };
        try {
            socket.send(JSON.stringify(message), (error) => {
                if (error) fail();
            });
        } catch {
            fail();
        }
    }

    private handleAck(socket: WebSocket, message: AckMessage): boolean {
        if (message.status === "delivered") this.clearPendingMessage(message.correlationId);
        if (message.correlationId === this.helloRequestId && message.status === "accepted") {
            if (!this.challengeAnswered) {
                this.failConnection(socket, { code: "AUTHENTICATION_FAILED", message: "Relay accepted the connection without an ownership challenge." });
                socket.terminate();
                return false;
            }
            this.clearHello();
            this.joinCredential = undefined;
            this.setState("connected");
            this.logger?.info("Registered with relay.");
        }
        return true;
    }

    private handleError(socket: WebSocket, message: ErrorMessage): boolean {
        if (this.pendingAdmin.has(message.correlationId)) {
            const reason = message.code === "MEMBERS_CHANGED"
                ? "The member list changed. Review it before trying again."
                : message.code === "ADMIN_REQUIRED"
                    ? "This identity is not the relay administrator."
                    : "The relay rejected the administration request.";
            this.rejectAdminRequest(message.correlationId, reason);
            return false;
        }
        this.clearPendingMessage(message.correlationId);
        if (message.correlationId === this.helloRequestId) {
            const error: RelayConnectionError = message.code === "INVALID_JOIN_CODE"
                ? { code: "INVITE_REQUIRED", message: "A valid relay invitation is required." }
                : message.code === "JOIN_RATE_LIMITED"
                    ? { code: "JOIN_RATE_LIMITED", message: "Too many failed relay join attempts. Try again later." }
                    : { code: "AUTHENTICATION_FAILED", message: "The relay could not authenticate this identity." };
            this.failConnection(socket, error);
            socket.close();
            return false;
        }
        this.logger?.error("Relay rejected a message.");
        return true;
    }

    private handleAdminResult(message: RelayAdminResultMessage): void {
        const pending = this.pendingAdmin.get(message.correlationId);
        if (!pending) {
            this.logger?.error("Relay sent an unexpected administration response.");
            return;
        }
        clearTimeout(pending.timer);
        this.pendingAdmin.delete(message.correlationId);
        if (message.action !== pending.action) {
            pending.reject(new Error("Relay returned an invalid administration response."));
            return;
        }
        pending.resolve(message);
    }

    private rejectAdminRequest(requestId: string, reason: string): void {
        const pending = this.pendingAdmin.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingAdmin.delete(requestId);
        pending.reject(new Error(reason));
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

    private clearHello(): void {
        if (this.helloTimer) clearTimeout(this.helloTimer);
        this.helloTimer = undefined;
        this.helloRequestId = undefined;
        this.challengeAnswered = false;
    }

    /** Abandons the current connection attempt and reports why. Ignores stale sockets. */
    private failConnection(socket: WebSocket | undefined, error: RelayConnectionError): void {
        if (socket && this.socket !== socket) return;
        if (socket) {
            this.socket = undefined;
        }
        this.clearHello();
        this.credentialTransportSafe = false;
        this.joinCredential = undefined;
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
            for (const requestId of this.pendingAdmin.keys()) {
                this.rejectAdminRequest(requestId, "Connection lost before the relay administration request completed.");
            }
        }
        for (const listener of this.statusListeners) listener(state);
    }
}

export default RelayClient;
