import * as vscode from "vscode";
import { Logger } from "../logger";
import { RelayPortInUseError } from "../../../shared/relayServer";
import { HostedRelay, type HostedRelayInfo } from "./hostedRelay";
import { HostRelayCertificateStore } from "./hostRelayCertificate";
import { RelayClient } from "./relayClient";
import {
    DEFAULT_HOST_RELAY_PORT,
    DEFAULT_RELAY_URL,
    validateHostRelayPort,
    validateRelayUrl,
} from "./relaySettings";

const CONFIG_SECTION = "devChat";

/** Relay URL from settings, falling back to the default when the setting is invalid. */
export function getConfiguredRelayUrl(logger: Logger, notifyIfInvalid = false): string {
    const raw = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>("relayUrl", DEFAULT_RELAY_URL);
    const result = validateRelayUrl(raw);
    if (result.ok) return result.url;

    logger.error(`Invalid devChat.relayUrl setting: ${result.error} Using ${DEFAULT_RELAY_URL}.`);
    if (notifyIfInvalid) {
        void offerToOpenSettings(
            `Dev Chat: invalid relay URL setting. ${result.error} Using ${DEFAULT_RELAY_URL} instead.`,
            `${CONFIG_SECTION}.relayUrl`
        );
    }
    return DEFAULT_RELAY_URL;
}

async function offerToOpenSettings(message: string, setting: string): Promise<void> {
    const choice = await vscode.window.showErrorMessage(message, "Open Settings");
    if (choice === "Open Settings") {
        await vscode.commands.executeCommand("workbench.action.openSettings", setting);
    }
}

/**
 * Decides which relay the client talks to: the `devChat.relayUrl` setting, or
 * the relay hosted by this VS Code instance while host mode is active.
 */
export class RelayController implements vscode.Disposable {
    private readonly hostedRelay: HostedRelay;
    private readonly statusBarItem: vscode.StatusBarItem;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly relayClient: RelayClient,
        private readonly identity: string,
        private readonly logger: Logger,
        private readonly certificates: HostRelayCertificateStore
    ) {
        this.hostedRelay = new HostedRelay({
            info: (message) => logger.info(`[relay] ${message}`),
            error: (message) => logger.error(`[relay] ${message}`),
        });

        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBarItem.command = "devChat.hostRelay";
        this.disposables.push(this.statusBarItem);

        const stopListening = this.hostedRelay.onConnectionCountChange(() => this.updateStatusBar());
        this.disposables.push(new vscode.Disposable(stopListening));

        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration(`${CONFIG_SECTION}.relayUrl`)) this.handleRelayUrlChanged();
            })
        );
    }

    public async startHosting(): Promise<void> {
        if (this.hostedRelay.isRunning) {
            this.showHostingInfo(this.hostedRelay.info);
            return;
        }

        const rawPort = vscode.workspace.getConfiguration(CONFIG_SECTION).get<number>("hostRelay.port", DEFAULT_HOST_RELAY_PORT);
        const port = validateHostRelayPort(rawPort);
        if (port === undefined) {
            void offerToOpenSettings(
                `Dev Chat: devChat.hostRelay.port must be a whole number between 1 and 65535 (got ${String(rawPort)}).`,
                `${CONFIG_SECTION}.hostRelay.port`
            );
            return;
        }

        let info: HostedRelayInfo;
        try {
            const credentials = await this.certificates.load();
            info = await this.hostedRelay.start(port, credentials);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to host relay: ${message}`);
            if (error instanceof RelayPortInUseError) {
                void offerToOpenSettings(
                    `Dev Chat could not host the relay: ${message}`,
                    `${CONFIG_SECTION}.hostRelay.port`
                );
            } else {
                void vscode.window.showErrorMessage(`Dev Chat could not host the relay: ${message}`);
            }
            return;
        }

        this.logger.info(`Hosting relay on port ${info.port} (certificate ${info.fingerprint}): ${info.networkUrls.join(", ") || "no local network address found"}`);
        this.relayClient.setUrl(info.localUrl);
        if (this.relayClient.state !== "connected" && this.relayClient.state !== "connecting") {
            this.relayClient.connect(this.identity);
        }
        this.updateStatusBar();
        this.showHostingInfo(info);
    }

    public async stopHosting(): Promise<void> {
        if (!this.hostedRelay.isRunning) {
            void vscode.window.showInformationMessage("Dev Chat is not hosting a relay.");
            return;
        }

        await this.stopHostedRelay();
        void vscode.window.showInformationMessage(
            `Dev Chat stopped hosting the relay. Use "Dev Chat: Connect Relay" to connect to ${this.relayClient.url}.`
        );
    }

    /**
     * Replaces the hosted relay's certificate after confirmation. Everyone who
     * connects to it must then use the new address with the new fingerprint.
     */
    public async regenerateCertificate(): Promise<void> {
        const confirm = "Regenerate Certificate";
        const choice = await vscode.window.showWarningMessage(
            "Regenerate the certificate of the relay you host?",
            {
                modal: true,
                detail:
                    "Everyone who connects to your hosted relay will be refused until they update Dev Chat › Relay Url to the new address you share with them. " +
                    "Do this if you think the relay's private key was exposed." +
                    (this.hostedRelay.isRunning ? "\n\nThe relay is running and will restart, disconnecting everyone." : ""),
            },
            confirm
        );
        if (choice !== confirm) return;

        const wasHosting = this.hostedRelay.isRunning;
        try {
            if (wasHosting) await this.stopHostedRelay();
            await this.certificates.regenerate();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to regenerate relay certificate: ${message}`);
            void vscode.window.showErrorMessage(`Dev Chat could not regenerate the relay certificate: ${message}`);
            return;
        }
        this.logger.info("Regenerated hosted relay certificate.");

        if (wasHosting) {
            await this.startHosting();
        } else {
            void vscode.window.showInformationMessage(
                "Dev Chat created a new relay certificate. It will be used the next time you host a relay."
            );
        }
    }

    public async dispose(): Promise<void> {
        await this.stopHostedRelay();
        for (const disposable of this.disposables.splice(0)) disposable.dispose();
    }

    private async stopHostedRelay(): Promise<void> {
        if (!this.hostedRelay.isRunning) return;

        this.relayClient.close();
        await this.hostedRelay.stop();
        this.relayClient.setUrl(getConfiguredRelayUrl(this.logger));
        this.updateStatusBar();
        this.logger.info("Stopped hosting relay.");
    }

    private handleRelayUrlChanged(): void {
        const url = getConfiguredRelayUrl(this.logger, true);
        if (this.hostedRelay.isRunning) {
            void vscode.window.showInformationMessage(
                "Dev Chat: the new relay URL will be used after you stop hosting the relay."
            );
            return;
        }
        this.relayClient.setUrl(url);
    }

    private showHostingInfo(info: HostedRelayInfo | undefined): void {
        if (!info) return;

        const shareUrl = info.networkUrls[0];
        const message = shareUrl
            ? `Dev Chat is hosting an encrypted relay on this network. Share this address with the people you trust; they set "Dev Chat: Relay Url" to it: ${shareUrl}`
            : `Dev Chat is hosting a relay on port ${info.port}, but no local network address was found. Others on your network will not be able to connect.`;
        const actions = shareUrl ? ["Copy Address", "Stop Hosting"] : ["Stop Hosting"];

        void vscode.window.showInformationMessage(message, ...actions).then(async (choice) => {
            if (choice === "Copy Address" && shareUrl) {
                await vscode.env.clipboard.writeText(shareUrl);
                void vscode.window.showInformationMessage(`Copied ${shareUrl} to the clipboard.`);
            } else if (choice === "Stop Hosting") {
                await this.stopHosting();
            }
        });
    }

    private updateStatusBar(): void {
        const info = this.hostedRelay.info;
        if (!info) {
            this.statusBarItem.hide();
            return;
        }

        const count = this.hostedRelay.connectionCount;
        this.statusBarItem.text = `$(broadcast) Dev Chat relay :${info.port} (${count} connected)`;
        this.statusBarItem.tooltip = [
            "Dev Chat is hosting a relay on this computer.",
            `Certificate SHA-256: ${info.fingerprint}`,
            ...info.networkUrls.map((url) => `Share: ${url}`),
            "Click for options.",
        ].join("\n");
        this.statusBarItem.show();
    }
}

export default RelayController;
