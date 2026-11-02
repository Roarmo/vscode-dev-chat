import * as vscode from "vscode";
import { Logger } from "../logger";
import { handleConnect } from "./handlers/connectHandler";
import { ChatPanel } from "../ui/ChatPanel";
import { RelayClient } from "../relay/relayClient";
import { EncryptionService } from "../encryption/encryptionService";

export function registerCommands(context: vscode.ExtensionContext, logger: Logger, relayClient: RelayClient, encryptionService: EncryptionService) {
    const connect = vscode.commands.registerCommand("devChat.connectRelay", () => {
        logger.info("Command invoked: devChat.connectRelay");
        handleConnect(relayClient, encryptionService.publicKey);
    });

    const openChat = vscode.commands.registerCommand("devChat.openChat", () => {
        logger.info("Command invoked: devChat.openChat");
        ChatPanel.createOrShow(context, relayClient, encryptionService);
    });

    context.subscriptions.push(connect, openChat);
}

export default registerCommands;
