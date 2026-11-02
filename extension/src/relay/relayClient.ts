import { randomUUID } from "crypto";
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
import { Logger } from "../logger";

export type RelayConnectionState = "disconnected" | "connecting" | "connected" | "error";

export class RelayClient {
    private socket: WebSocket | undefined;
    private identity: string | undefined;
    private helloRequestId: string | undefined;
    private connectionState: RelayConnectionState = "disconnected";
    private readonly statusListeners = new Set<(state: RelayConnectionState) => void>();
    private readonly messageListeners = new Set<(message: ServerToClientMessage) => void>();

    constructor(private readonly url: string, private readonly logger?: Logger) {}

    public get state(): RelayConnectionState {
        return this.connectionState;
    }

    public connect(identity: string): void {
        if (
            this.socket &&
            (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN)
        ) {
            return;
        }

        this.identity = identity;
        this.setState("connecting");
        this.logger?.info(`Connecting to relay at ${this.url}`);

        const socket = new WebSocket(this.url);
        this.socket = socket;

        socket.on("open", () => {
            if (this.socket !== socket) return;

            const hello: HelloMessage = {
                type: "hello",
                requestId: randomUUID(),
                from: identity,
                message: "VS Code Dev Chat client",
                timestamp: new Date().toISOString(),
            };
            this.helloRequestId = hello.requestId;
            socket.send(JSON.stringify(hello), (error) => {
                if (error) {
                    this.logger?.error(`Failed to register with relay: ${error.message}`);
                    this.setState("error");
                }
            });
        });

        socket.on("message", (data: RawData) => this.handleMessage(socket, data));
        socket.on("error", (error: Error) => {
            if (this.socket !== socket) return;
            this.logger?.error(`Relay connection failed: ${error.message}`);
            this.setState("error");
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
            socket.send(JSON.stringify(message), (error) => {
                if (error) {
                    this.logger?.error(`Failed to send relay message: ${error.message}`);
                    this.emitMessage({
                        type: "error",
                        correlationId: requestId,
                        code: "SEND_FAILED",
                        message: error.message,
                        timestamp: new Date().toISOString(),
                    });
                }
            });
            return true;
        } catch (error) {
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
        if (message.correlationId === this.helloRequestId && message.status === "accepted") {
            this.setState("connected");
            this.logger?.info("Registered with relay.");
        }
    }

    private handleError(message: ErrorMessage): void {
        this.logger?.error(`Relay error ${message.code}: ${message.message}`);
        if (message.correlationId === this.helloRequestId) {
            this.setState("error");
        }
    }

    private emitMessage(message: ServerToClientMessage): void {
        for (const listener of this.messageListeners) listener(message);
    }

    private setState(state: RelayConnectionState): void {
        if (this.connectionState === state) return;
        this.connectionState = state;
        for (const listener of this.statusListeners) listener(state);
    }
}

export default RelayClient;
