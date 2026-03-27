import * as vscode from "vscode";
import { Logger } from "../logger";
import { handleConnect } from "./handlers/connectHandler";

export function registerCommands(context: vscode.ExtensionContext, url: string, logger: Logger) {
    const connect = vscode.commands.registerCommand("devChat.connectRelay", () => {
        logger.info("Command invoked: devChat.connectRelay");
        void handleConnect(url, logger);
    });

    context.subscriptions.push(connect);
}

export default registerCommands;
