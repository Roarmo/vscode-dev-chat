import * as vscode from "vscode";
import { randomUUID } from "crypto";
import WebSocket, { RawData } from "ws";
import { HelloMessage, ServerToClientMessage, isRelayMessage } from "../../../../shared/types";
import { RelayClient } from "../../relay/relayClient";
import { Logger } from "../../logger";

export async function handleConnect(url: string, logger: Logger): Promise<void> {
    const client = new RelayClient(url, logger);
    const socket = client.connect();

    socket.on("open", () => {
        const payload: HelloMessage = {
            type: "hello",
            requestId: randomUUID(),
            from: "local-dev-client",
            message: "Hello from VS Code extension",
            timestamp: new Date().toISOString(),
        };

        socket.send(JSON.stringify(payload));
        logger.info("Connected to relay and sent a test message.");
        void vscode.window.showInformationMessage("Connected to relay and sent a test message.");
    });

    socket.on("message", (data: RawData) => {
        let parsed: unknown;
        try {
            parsed = JSON.parse(data.toString());
        } catch {
            logger.error("Relay response was not valid JSON.");
            void vscode.window.showErrorMessage("Relay response was not valid JSON.");
            socket.close();
            return;
        }

        if (!isRelayMessage(parsed)) {
            logger.error("Relay response did not match protocol format.");
            void vscode.window.showErrorMessage("Relay response did not match protocol format.");
            socket.close();
            return;
        }

        const message = parsed as ServerToClientMessage;
        if (message.type === "server_ready") {
            logger.info(`Relay ready: ${message.message}`);
            void vscode.window.showInformationMessage(`Relay ready: ${message.message}`);
        } else if (message.type === "ack") {
            logger.info(`Relay ack: ${message.status}`);
            void vscode.window.showInformationMessage(`Relay ack: ${message.status}`);
        } else if (message.type === "direct_message") {
            logger.info(`Direct message from ${message.from}: ${message.payload}`);
            void vscode.window.showInformationMessage(`Direct message from ${message.from}: ${message.payload}`);
        } else {
            logger.error(`Relay error: ${message.message}`);
            void vscode.window.showErrorMessage(`Relay error: ${message.message}`);
        }

        socket.close();
    });

    socket.on("error", (err: Error) => {
        logger.error(`Relay connection failed: ${err.message}`);
        void vscode.window.showErrorMessage(`Relay connection failed: ${err.message}`);
    });
}

export default handleConnect;
