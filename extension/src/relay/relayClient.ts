import WebSocket from "ws";
import { Logger } from "../logger";

export class RelayClient {
    private url: string;
    private logger: Logger | undefined;
    private socket: WebSocket | undefined;

    constructor(url: string, logger?: Logger) {
        this.url = url;
        this.logger = logger;
    }

    connect(): WebSocket {
        this.logger?.info(`Connecting to relay at ${this.url}`);
        this.socket = new WebSocket(this.url);
        return this.socket;
    }

    close(): void {
        if (this.socket) {
            try {
                this.socket.close();
                this.logger?.info("Closed relay socket");
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                this.logger?.error(`Error closing relay socket: ${msg}`);
            }
        }
    }
}

export default RelayClient;
