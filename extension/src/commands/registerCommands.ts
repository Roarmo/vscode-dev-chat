import * as vscode from "vscode";
import { Logger } from "../logger";
import { handleConnect } from "./handlers/connectHandler";
import { ChatPanel } from "../ui/ChatPanel";
import { RelayClient } from "../relay/relayClient";
import { RelayController } from "../relay/relayController";
import { EncryptionService } from "../encryption/encryptionService";

export function registerCommands(context: vscode.ExtensionContext, logger: Logger, relayClient: RelayClient, relayController: RelayController, encryptionService: EncryptionService) {
    const connect = vscode.commands.registerCommand("devChat.connectRelay", () => {
        logger.info("Command invoked: devChat.connectRelay");
        handleConnect(relayClient, encryptionService.publicKey);
    });

    const openChat = vscode.commands.registerCommand("devChat.openChat", () => {
        logger.info("Command invoked: devChat.openChat");
        ChatPanel.createOrShow(context, relayClient, encryptionService);
    });

    const hostRelay = vscode.commands.registerCommand("devChat.hostRelay", () => {
        logger.info("Command invoked: devChat.hostRelay");
        return relayController.startHosting();
    });

    const stopHostingRelay = vscode.commands.registerCommand("devChat.stopHostingRelay", () => {
        logger.info("Command invoked: devChat.stopHostingRelay");
        return relayController.stopHosting();
    });

    const regenerateCertificate = vscode.commands.registerCommand("devChat.regenerateHostRelayCertificate", () => {
        logger.info("Command invoked: devChat.regenerateHostRelayCertificate");
        return relayController.regenerateCertificate();
    });

    context.subscriptions.push(connect, openChat, hostRelay, stopHostingRelay, regenerateCertificate);
}

export default registerCommands;
