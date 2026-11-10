import * as vscode from "vscode";
import { Logger } from "../logger";
import { handleConnect } from "./handlers/connectHandler";
import { ChatPanel } from "../ui/ChatPanel";
import { RelayClient } from "../relay/relayClient";
import { RelayController } from "../relay/relayController";
import { EncryptionService } from "../encryption/encryptionService";
import { ContactStore } from "../encryption/contactStore";
import { SecureInbox } from "../messaging/secureInbox";
import { ConversationManager } from "../messaging/conversationManager";

export function registerCommands(context: vscode.ExtensionContext, logger: Logger, relayClient: RelayClient, relayController: RelayController, encryptionService: EncryptionService, inbox: SecureInbox, contactStore: ContactStore, conversationManager: ConversationManager) {
    const connect = vscode.commands.registerCommand("devChat.connectRelay", () => {
        logger.info("Command invoked: devChat.connectRelay");
        handleConnect(relayClient, encryptionService);
    });

    const openChat = vscode.commands.registerCommand("devChat.openChat", () => {
        logger.info("Command invoked: devChat.openChat");
        ChatPanel.createOrShow(context, relayClient, encryptionService, contactStore, conversationManager, inbox);
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

    const showMyFingerprint = vscode.commands.registerCommand("devChat.showMyFingerprint", () => {
        logger.info("Command invoked: devChat.showMyFingerprint");
        return inbox.showMyFingerprint();
    });

    const verifyContact = vscode.commands.registerCommand("devChat.verifyContact", () => {
        logger.info("Command invoked: devChat.verifyContact");
        return inbox.verifyContact();
    });

    const reviewKeyChanges = vscode.commands.registerCommand("devChat.reviewKeyChanges", () => {
        logger.info("Command invoked: devChat.reviewKeyChanges");
        return inbox.reviewKeyChange();
    });

    const joinRelayWithInvite = vscode.commands.registerCommand("devChat.joinRelayWithInvite", () => {
        logger.info("Command invoked: devChat.joinRelayWithInvite");
        return relayController.joinRelayWithInvite();
    });

    const copyRelayInvite = vscode.commands.registerCommand("devChat.copyRelayInvite", () => {
        logger.info("Command invoked: devChat.copyRelayInvite");
        return relayController.copyRelayInvite();
    });

    const copyRelayAddress = vscode.commands.registerCommand("devChat.copyRelayAddress", () => {
        logger.info("Command invoked: devChat.copyRelayAddress");
        return relayController.copyRelayAddress();
    });

    const manageRelayMembers = vscode.commands.registerCommand("devChat.manageRelayMembers", () => {
        logger.info("Command invoked: devChat.manageRelayMembers");
        return relayController.manageMembers();
    });

    const changeRelayJoinCode = vscode.commands.registerCommand("devChat.changeRelayJoinCode", () => {
        logger.info("Command invoked: devChat.changeRelayJoinCode");
        return relayController.changeJoinCode();
    });

    const openInstructions = vscode.commands.registerCommand("devChat.openInstructions", async () => {
        logger.info("Command invoked: devChat.openInstructions");
        try {
            const guide = vscode.Uri.joinPath(context.extensionUri, "media", "getting-started.md");
            await vscode.commands.executeCommand("markdown.showPreview", guide);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            logger.error(`Could not open Dev Chat instructions: ${reason}`);
            void vscode.window.showErrorMessage("Dev Chat could not open its instructions. See the Dev Chat output for details.");
        }
    });

    const registrations = [
        connect, openChat, hostRelay, stopHostingRelay, regenerateCertificate, showMyFingerprint,
        verifyContact, reviewKeyChanges, joinRelayWithInvite, copyRelayInvite, copyRelayAddress,
        manageRelayMembers, changeRelayJoinCode, openInstructions
    ];
    context.subscriptions.push(...registrations);
    let disposed = false;
    return {
        dispose: () => {
            if (disposed) return;
            disposed = true;
            for (const registration of registrations) registration.dispose();
        },
    };
}

export default registerCommands;
