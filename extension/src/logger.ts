import * as vscode from "vscode";

export class Logger {
    private channel: vscode.OutputChannel;

    constructor(name = "VSCode Dev Chat") {
        this.channel = vscode.window.createOutputChannel(name);
    }

    info(message: string): void {
        const ts = new Date().toISOString();
        const line = `[INFO ${ts}] ${message}`;
        this.channel.appendLine(line);
        console.log(line);
    }

    error(message: string): void {
        const ts = new Date().toISOString();
        const line = `[ERROR ${ts}] ${message}`;
        this.channel.appendLine(line);
        console.error(line);
    }

    dispose(): void {
        this.channel.dispose();
    }
}

export default Logger;
