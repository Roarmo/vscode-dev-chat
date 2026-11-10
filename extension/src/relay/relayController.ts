import * as vscode from "vscode";
import { Logger } from "../logger";
import { RelayPortInUseError } from "../../../shared/relayServer";
import type { RelayAccessStore } from "../../../shared/relayAccess";
import { isIdentityPublicKey, isJoinCode } from "../../../shared/relayAuthentication";
import type { RelayMember } from "../../../shared/types";
import type { EncryptionService } from "../encryption/encryptionService";
import type { ContactTrustStore } from "../encryption/contactTrust";
import { identityFingerprint, shortKeyLabel } from "../encryption/fingerprint";
import { HostedRelay, type HostedRelayInfo } from "./hostedRelay";
import { HostRelayCertificateStore } from "./hostRelayCertificate";
import { createRelayInvite, parseRelayInvite } from "./relayInvite";
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
    private readonly stateListeners = new Set<() => void>();
    private joining = false;
    private changingHosting = false;

    constructor(
        private readonly relayClient: RelayClient,
        private readonly identity: EncryptionService,
        private readonly logger: Logger,
        private readonly certificates: HostRelayCertificateStore,
        private readonly accessStore: RelayAccessStore,
        private readonly trust: ContactTrustStore
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

    public get isJoining(): boolean {
        return this.joining;
    }

    public get isHosting(): boolean {
        return this.hostedRelay.isRunning;
    }

    public get isChangingHosting(): boolean {
        return this.changingHosting;
    }

    public onStateChange(listener: () => void): () => void {
        this.stateListeners.add(listener);
        return () => this.stateListeners.delete(listener);
    }

    public async startHosting(): Promise<void> {
        if (this.reportHostingBusy()) return;
        if (this.joining) {
            void vscode.window.showErrorMessage("Finish joining the other relay before starting a hosted relay.");
            return;
        }
        if (this.hostedRelay.isRunning) {
            this.showHostingInfo(this.hostedRelay.info);
            return;
        }

        this.setChangingHosting(true);
        try {
            await this.startHostedRelay();
        } finally {
            this.setChangingHosting(false);
        }
    }

    public async stopHosting(): Promise<void> {
        if (this.reportHostingBusy()) return;
        if (!this.hostedRelay.isRunning) {
            void vscode.window.showInformationMessage("Dev Chat is not hosting a relay.");
            return;
        }

        this.setChangingHosting(true);
        try {
            await this.stopHostedRelay();
            void vscode.window.showInformationMessage(
                `Dev Chat stopped hosting the relay. Use "Dev Chat: Connect Relay" to connect to ${this.relayClient.url}.`
            );
        } finally {
            this.setChangingHosting(false);
        }
    }

    /**
     * Replaces the hosted relay's certificate after confirmation. Everyone who
     * connects to it must then use the new address with the new fingerprint.
     */
    public async regenerateCertificate(): Promise<void> {
        if (this.reportHostingBusy()) return;
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
        if (this.reportHostingBusy()) return;

        const wasHosting = this.hostedRelay.isRunning;
        this.setChangingHosting(true);
        try {
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
                await this.startHostedRelay();
            } else {
                void vscode.window.showInformationMessage(
                    "Dev Chat created a new relay certificate. It will be used the next time you host a relay."
                );
            }
        } finally {
            this.setChangingHosting(false);
        }
    }

    public async copyRelayAddress(): Promise<void> {
        try {
            const address = await this.selectShareableAddress();
            if (!address) return;
            try {
                await vscode.env.clipboard.writeText(address);
            } catch {
                throw new Error("Could not copy the relay address. Check clipboard access and try again.");
            }
            void vscode.window.showInformationMessage(
                "Relay address copied. New members also need a private invitation to join."
            );
        } catch (error) {
            this.reportAccessError("copy the relay address", error);
        }
    }

    public async copyRelayInvite(): Promise<void> {
        try {
            await this.waitForConnection();
            const address = await this.selectShareableAddress();
            if (!address) return;
            const result = await this.relayClient.requestAdmin("get_join_code");
            if (!isJoinCode(result.joinCode)) throw new Error("The relay returned an invalid invitation code.");
            const invite = createRelayInvite(this.identity, address, result.joinCode);
            try {
                await vscode.env.clipboard.writeText(invite);
            } catch {
                throw new Error("Could not copy the invitation. Check clipboard access and try again.");
            }
            void vscode.window.showInformationMessage(
                "Relay invitation copied. Anyone with it can join as themselves; share it privately."
            );
        } catch (error) {
            this.reportAccessError("create a relay invitation", error);
        }
    }

    public async joinRelayWithInvite(): Promise<void> {
        if (this.joining) {
            void vscode.window.showInformationMessage("A relay join is already in progress.");
            return;
        }
        if (this.changingHosting) {
            void vscode.window.showErrorMessage("Wait for the relay hosting operation to finish before joining another relay.");
            return;
        }
        if (this.hostedRelay.isRunning) {
            void vscode.window.showErrorMessage("Stop hosting your relay before joining another relay.");
            return;
        }
        this.joining = true;
        this.notifyStateChanged();
        let attemptedUrl: string | undefined;
        let previousConnection: { url: string; reconnect: boolean } | undefined;
        let joined = false;
        try {
            const input = await vscode.window.showInputBox({
                title: "Join a Dev Chat relay",
                prompt: "Paste the invitation shared by the relay administrator.",
                password: true,
                ignoreFocusOut: true,
            });
            if (input === undefined) return;

            const invite = parseRelayInvite(input);
            if (invite.hostPublicKey === this.identity.publicKey) {
                throw new Error("This invitation identifies your own Dev Chat identity as the host.");
            }
            const existing = this.trust.get(invite.hostPublicKey);
            const changed = existing && existing.signingKey !== invite.hostSigningKey;
            const choice = await vscode.window.showWarningMessage(
                `Join the relay at ${new URL(invite.relayUrl).host}?`,
                {
                    modal: true,
                    detail: changed
                        ? `The host's signing key differs from the contact saved on this device.\n` +
                            `Saved fingerprint: ${identityFingerprint(invite.hostPublicKey, existing.signingKey)}\n` +
                            `Invitation fingerprint: ${invite.hostFingerprint}\n\n` +
                            "Compare the new fingerprint with the administrator over a trusted channel. " +
                            "Joining will not replace your saved key. Ask the host to send you a message, " +
                            "then review the held key change before accepting it."
                        : `Host fingerprint: ${invite.hostFingerprint}\n\n` +
                            "Compare this fingerprint with the administrator over a trusted channel. " +
                            "An invitation alone does not establish who the host is.",
                },
                "Join Relay"
            );
            if (choice !== "Join Relay") return;
            if (this.hostedRelay.isRunning) {
                throw new Error("Stop hosting your relay before joining another relay.");
            }

            previousConnection = {
                url: this.relayClient.url,
                reconnect: this.relayClient.state === "connected" || this.relayClient.state === "connecting",
            };
            this.relayClient.close();
            this.relayClient.setUrl(invite.relayUrl);
            attemptedUrl = invite.relayUrl;
            this.relayClient.setJoinCode(invite.relayUrl, invite.joinCode);
            this.relayClient.connect(this.identity);
            await this.waitForConnection();

            const trust = await this.trust.evaluate(invite.hostPublicKey, invite.hostSigningKey);
            if (this.relayClient.url !== invite.relayUrl || this.relayClient.state !== "connected") {
                throw new Error("The relay connection changed before the invitation was fully processed.");
            }
            await vscode.workspace.getConfiguration(CONFIG_SECTION).update("relayUrl", invite.relayUrl, vscode.ConfigurationTarget.Global);
            joined = true;
            if (this.relayClient.url !== invite.relayUrl || this.relayClient.state !== "connected") {
                throw new Error("The relay connection changed while the invitation was being saved.");
            }
            const next = trust.status === "changed"
                ? await vscode.window.showWarningMessage(
                    "Joined the relay, but the host's changed signing key has not been accepted. " +
                    "Ask the host to send you a message, then use Dev Chat: Review Contact Key Changes.",
                    "Open Chat",
                    "Copy Host Key"
                )
                : await vscode.window.showInformationMessage(
                    `Joined the relay. Host fingerprint: ${invite.hostFingerprint}. ` +
                    (trust.record.verified ? "This host is verified." : "The host is saved as not verified."),
                    "Open Chat",
                    "Copy Host Key"
                );
            if (next === "Open Chat") {
                await vscode.commands.executeCommand("devChat.openChat");
            } else if (next === "Copy Host Key") {
                try {
                    await vscode.env.clipboard.writeText(invite.hostPublicKey);
                } catch {
                    throw new Error("Could not copy the host key. Check clipboard access and try again.");
                }
                void vscode.window.showInformationMessage("Host public key copied.");
            }
        } catch (error) {
            if (!joined && attemptedUrl && this.relayClient.url === attemptedUrl) {
                this.relayClient.close();
                if (previousConnection) {
                    this.relayClient.setUrl(previousConnection.url);
                    if (previousConnection.reconnect) this.relayClient.connect(this.identity);
                }
            }
            this.reportAccessError(joined ? "complete the invitation action" : "join the relay", error);
        } finally {
            this.joining = false;
            this.notifyStateChanged();
        }
    }

    public async manageMembers(): Promise<void> {
        try {
            await this.waitForConnection();
            const list = await this.getMembers();
            const members = list.members.filter((member) => member.publicKey !== this.identity.publicKey);
            if (members.length === 0) {
                void vscode.window.showInformationMessage("This relay has no other members.");
                return;
            }
            const selected = await vscode.window.showQuickPick(
                members.map((member) => ({
                    label: shortKeyLabel(member.publicKey),
                    description: identityFingerprint(member.publicKey, member.signingKey),
                    member,
                })),
                { title: "Relay members", placeHolder: "Select a member to remove" }
            );
            if (!selected) return;
            const confirm = await vscode.window.showWarningMessage(
                `Remove relay member ${selected.label}?`,
                {
                    modal: true,
                    detail:
                        "They will be disconnected and must join again. If they still have the current invitation, " +
                        "change the join code to prevent them from reusing it.",
                },
                "Remove Member"
            );
            if (confirm !== "Remove Member") return;
            await this.relayClient.requestAdmin("remove_member", { publicKey: selected.member.publicKey });
            void vscode.window.showInformationMessage("Relay member removed.");
        } catch (error) {
            this.reportAccessError("manage relay members", error);
        }
    }

    public async changeJoinCode(): Promise<void> {
        const keep = "Change code and keep members";
        const remove = "Change code and remove all members";
        const selected = await vscode.window.showQuickPick([keep, remove], {
            title: "Change relay join code",
            placeHolder: "Choose what happens to existing members",
        });
        if (!selected) return;

        try {
            await this.waitForConnection();
            const removeMembers = selected === remove;
            let expectedRevision: number | undefined;
            if (removeMembers) {
                const list = await this.getMembers();
                const count = list.members.filter((member) => member.publicKey !== this.identity.publicKey).length;
                const confirm = await vscode.window.showWarningMessage(
                    `Change the join code and remove ${count} relay member${count === 1 ? "" : "s"}?`,
                    {
                        modal: true,
                        detail:
                            "Those members will be disconnected and must join with a new invitation. " +
                            "Your administrator session remains connected. All previous invitations stop working.",
                    },
                    "Change Code and Remove Members"
                );
                if (confirm !== "Change Code and Remove Members") return;
                expectedRevision = list.revision;
            } else {
                const confirm = await vscode.window.showWarningMessage(
                    "Change the join code and keep existing relay members?",
                    { modal: true, detail: "Existing members stay connected and can reconnect. All previous invitations stop working." },
                    "Change Code"
                );
                if (confirm !== "Change Code") return;
            }

            const result = await this.relayClient.requestAdmin("rotate_code", {
                removeMembers,
                ...(expectedRevision !== undefined ? { expectedRevision } : {}),
            });
            if (!isJoinCode(result.joinCode)) throw new Error("The relay returned an invalid new invitation code.");
            const next = await vscode.window.showInformationMessage(
                "Relay join code changed. Previous invitations no longer work.",
                "Copy New Invite"
            );
            if (next === "Copy New Invite") await this.copyRelayInvite();
        } catch (error) {
            this.reportAccessError("change the relay join code", error);
        }
    }

    public async dispose(): Promise<void> {
        await this.stopHostedRelay();
        for (const disposable of this.disposables.splice(0)) disposable.dispose();
        this.stateListeners.clear();
    }

    private async startHostedRelay(): Promise<void> {
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
            info = await this.hostedRelay.start(port, credentials, {
                adminPublicKey: this.identity.publicKey,
                store: this.accessStore,
            });
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
        this.notifyStateChanged();
        this.showHostingInfo(info);
    }

    private async stopHostedRelay(): Promise<void> {
        if (!this.hostedRelay.isRunning) return;

        this.relayClient.close();
        await this.hostedRelay.stop();
        this.relayClient.setUrl(getConfiguredRelayUrl(this.logger));
        this.updateStatusBar();
        this.notifyStateChanged();
        this.logger.info("Stopped hosting relay.");
    }

    private async selectShareableAddress(): Promise<string | undefined> {
        const info = this.hostedRelay.info;
        if (!info) {
            const target = validateRelayUrl(this.relayClient.url);
            if (!target.ok) throw new Error(target.error);
            return target.url;
        }
        if (info.networkUrls.length === 0) {
            throw new Error("No local network address is available to share.");
        }
        if (info.networkUrls.length === 1) return info.networkUrls[0];
        return vscode.window.showQuickPick(info.networkUrls, {
            title: "Choose the relay address reachable by your contacts",
        });
    }

    private notifyStateChanged(): void {
        for (const listener of [...this.stateListeners]) listener();
    }

    private setChangingHosting(value: boolean): void {
        this.changingHosting = value;
        this.notifyStateChanged();
    }

    private reportHostingBusy(): boolean {
        if (!this.changingHosting) return false;
        void vscode.window.showInformationMessage("A relay hosting operation is already in progress. Try again when it finishes.");
        return true;
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
            ? `Dev Chat is hosting an encrypted, invitation-only relay on this network. Copy an invitation to share privately. Relay address: ${shareUrl}`
            : `Dev Chat is hosting a relay on port ${info.port}, but no local network address was found. Others on your network will not be able to connect.`;
        const actions = shareUrl
            ? ["Copy Invite", "Manage Members", "Change Code", "Stop Hosting"]
            : ["Manage Members", "Change Code", "Stop Hosting"];

        void vscode.window.showInformationMessage(message, ...actions).then(async (choice) => {
            if (choice === "Copy Invite" && shareUrl) {
                await this.copyRelayInvite();
            } else if (choice === "Manage Members") {
                await this.manageMembers();
            } else if (choice === "Change Code") {
                await this.changeJoinCode();
            } else if (choice === "Stop Hosting") {
                await this.stopHosting();
            }
        });
    }

    private async getMembers(): Promise<{ members: RelayMember[]; revision: number }> {
        const result = await this.relayClient.requestAdmin("list_members");
        if (
            !result.members || result.revision < 0 ||
            result.members.some((member) => !isIdentityPublicKey(member.publicKey) || !isIdentityPublicKey(member.signingKey)) ||
            new Set(result.members.map((member) => member.publicKey)).size !== result.members.length
        ) {
            throw new Error("The relay returned an invalid member list.");
        }
        return { members: result.members, revision: result.revision };
    }

    private waitForConnection(): Promise<void> {
        if (this.relayClient.state === "connected") return Promise.resolve();
        if (this.relayClient.state !== "connecting") {
            return Promise.reject(new Error(this.relayClient.lastError?.message ?? "Connect to the relay first."));
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                stop();
                reject(new Error("Timed out waiting for the relay connection."));
            }, 20_000);
            const stop = this.relayClient.onStatusChange((state) => {
                if (state === "connecting") return;
                clearTimeout(timer);
                stop();
                if (state === "connected") resolve();
                else reject(new Error(this.relayClient.lastError?.message ?? "The relay connection failed."));
            });
        });
    }

    private reportAccessError(action: string, error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Could not ${action}: ${message}`);
        void vscode.window.showErrorMessage(`Dev Chat could not ${action}: ${message}`);
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
            ...info.networkUrls.map((url) => `Relay address: ${url}`),
            "Use Copy Relay Invitation to invite someone.",
            "Click for options.",
        ].join("\n");
        this.statusBarItem.show();
    }
}

export default RelayController;
