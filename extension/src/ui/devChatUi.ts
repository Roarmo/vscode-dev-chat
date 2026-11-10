import * as vscode from "vscode";
import type { Logger } from "../logger";
import type { SecureInbox } from "../messaging/secureInbox";
import type { RelayClient, RelayConnectionState } from "../relay/relayClient";
import type { RelayController } from "../relay/relayController";
import { validateRelayUrl } from "../relay/relaySettings";

interface SidebarNode {
	item: vscode.TreeItem;
	children: SidebarNode[];
}

interface UiState {
	connection: RelayConnectionState;
	hosting: boolean;
	changingHosting: boolean;
	joining: boolean;
	pendingContacts: number;
	pendingMessages: number;
	canConnect: boolean;
	canHost: boolean;
	canJoin: boolean;
	canAdminister: boolean;
}

export class DevChatUi implements vscode.TreeDataProvider<SidebarNode>, vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<SidebarNode | undefined | void>();
	public readonly onDidChangeTreeData = this.changed.event;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly statusBar: vscode.StatusBarItem;
	private contextUpdates: Promise<void> = Promise.resolve();
	private disposed = false;

	constructor(
		private readonly relay: RelayClient,
		private readonly controller: RelayController,
		private readonly inbox: SecureInbox,
		private readonly logger: Logger
	) {
		this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
		this.statusBar.name = "Dev Chat Connection";
		this.disposables.push(
			this.changed,
			this.statusBar,
			vscode.window.registerTreeDataProvider("devChat.actions", this),
			vscode.window.registerTreeDataProvider("devChat.welcome", {
				getTreeItem: (item: vscode.TreeItem) => item,
				getChildren: () => [],
			}),
			new vscode.Disposable(this.relay.onStatusChange(() => this.refresh())),
			new vscode.Disposable(this.relay.onUrlChange(() => this.refresh())),
			new vscode.Disposable(this.controller.onStateChange(() => this.refresh())),
			new vscode.Disposable(this.inbox.onEvent((event) => {
				if (event.type === "pendingKeyChanges") this.refresh();
			}))
		);
		this.statusBar.show();
		this.refresh();
	}

	public getTreeItem(element: SidebarNode): vscode.TreeItem {
		return element.item;
	}

	public getChildren(element?: SidebarNode): SidebarNode[] {
		if (element) return element.children;
		const state = this.getState();
		const connection: SidebarNode[] = [
			info("connection-state", `Connection: ${connectionLabel(state.connection)}`, connectionIcon(state.connection)),
			info("relay-address", `Relay: ${relayLabel(this.relay.url)}`, "server"),
		];
		if (state.canConnect) {
			connection.push(action(
				"connect",
				state.connection === "error" ? "Retry Connection" : "Connect Relay",
				"plug",
				"devChat.connectRelay"
			));
		}
		connection.push(action("open-chat", "Open Chat", "comment-discussion", "devChat.openChat"));
		if (state.canJoin) {
			connection.push(action("join", "Join Relay with Invite", "link", "devChat.joinRelayWithInvite"));
		}

		const relayActions: SidebarNode[] = [];
		if (state.hosting && !state.changingHosting) {
			relayActions.push(action("stop-hosting", "Stop Hosting Relay", "debug-stop", "devChat.stopHostingRelay"));
		} else if (state.canHost) {
			relayActions.push(action("host", "Host Relay on This Network", "radio-tower", "devChat.hostRelay"));
		}
		if (!state.changingHosting && !state.joining && (state.hosting || state.connection === "connected")) {
			relayActions.push(action("copy-address", "Copy Relay Address", "copy", "devChat.copyRelayAddress"));
		}
		if (state.canAdminister) {
			relayActions.push(
				action("copy-invite", "Copy Relay Invitation", "mail", "devChat.copyRelayInvite", "Relay administrator only"),
				action("manage-members", "Manage Relay Members", "organization", "devChat.manageRelayMembers", "Relay administrator only"),
				action("change-code", "Change Relay Join Code", "key", "devChat.changeRelayJoinCode", "Relay administrator only")
			);
		}
		if (!state.changingHosting) {
			relayActions.push(action(
				"regenerate-certificate",
				"Regenerate Hosted Relay Certificate",
				"shield",
				"devChat.regenerateHostRelayCertificate"
			));
		}

		const identity: SidebarNode[] = [
			action("show-fingerprint", "Show My Fingerprint", "key", "devChat.showMyFingerprint"),
			action("verify-contact", "Verify Contact Fingerprint", "verified", "devChat.verifyContact"),
			action("reset-identity", "Reset Identity", "refresh", "devChat.resetIdentity"),
			info(
				"pending-changes",
				`Pending key changes: ${state.pendingContacts}`,
				state.pendingContacts > 0 ? "warning" : "pass",
				`${state.pendingMessages} held message${state.pendingMessages === 1 ? "" : "s"}`
			),
		];
		if (state.pendingContacts > 0) {
			identity.push(action("review-changes", "Review Contact Key Changes", "warning", "devChat.reviewKeyChanges"));
		}

		return [
			group("connection", "Connection", connection),
			group("relay", "Relay", relayActions),
			group("identity", "Identity", identity),
			group("help", "Help", [action("instructions", "Open Instructions", "book", "devChat.openInstructions")]),
		];
	}

	public dispose(): void {
		this.disposed = true;
		for (const disposable of this.disposables.splice(0)) disposable.dispose();
	}

	private getState(): UiState {
		const connection = this.relay.state;
		const hosting = this.controller.isHosting;
		const changingHosting = this.controller.isChangingHosting;
		const joining = this.controller.isJoining;
		const pending = this.inbox.pendingKeyChanges;
		const busy = joining || changingHosting;
		return {
			connection,
			hosting,
			changingHosting,
			joining,
			pendingContacts: pending.contacts,
			pendingMessages: pending.messages,
			canConnect: (connection === "disconnected" || connection === "error") && !busy,
			canHost: !hosting && !busy && connection !== "connecting",
			canJoin: !hosting && !busy && connection !== "connecting",
			canAdminister: connection === "connected" && !busy,
		};
	}

	private refresh(): void {
		if (this.disposed) return;
		const state = this.getState();
		const label = connectionLabel(state.connection);
		this.statusBar.text = `$(${connectionIcon(state.connection)}) Dev Chat: ${label}`;
		this.statusBar.command = state.canConnect ? "devChat.connectRelay" : "devChat.openChat";
		const actionText = state.canConnect ? "Connect to the relay" : "Open chat";
		this.statusBar.tooltip = `Dev Chat: ${label}. ${actionText}.`;
		this.statusBar.accessibilityInformation = { label: `Dev Chat ${label}. ${actionText}.` };
		this.changed.fire();

		const contexts: Array<[string, boolean]> = [
			["devChat.canConnect", state.canConnect],
			["devChat.canHost", state.canHost],
			["devChat.isHosting", state.hosting],
			["devChat.canStopHosting", state.hosting && !state.changingHosting],
			["devChat.hasPendingKeyChanges", state.pendingContacts > 0],
			["devChat.needsSetup", state.canConnect],
		];
		this.contextUpdates = this.contextUpdates.then(async () => {
			if (this.disposed) return;
			for (const [key, value] of contexts) {
				await vscode.commands.executeCommand("setContext", key, value);
			}
		}).catch((error: unknown) => {
			const reason = error instanceof Error ? error.message : String(error);
			this.logger.error(`Could not update Dev Chat UI context: ${reason}`);
			void vscode.window.showErrorMessage("Dev Chat could not update its UI state. See the Dev Chat output for details.");
		});
	}
}

function group(id: string, label: string, children: SidebarNode[]): SidebarNode {
	const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
	item.id = `devChat.group.${id}`;
	return { item, children };
}

function info(id: string, label: string, icon: string, tooltip?: string): SidebarNode {
	const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
	item.id = `devChat.info.${id}`;
	item.iconPath = new vscode.ThemeIcon(icon);
	if (tooltip) item.tooltip = tooltip;
	return { item, children: [] };
}

function action(id: string, label: string, icon: string, command: string, tooltip?: string): SidebarNode {
	const node = info(id, label, icon, tooltip);
	node.item.id = `devChat.action.${id}`;
	node.item.command = { command, title: label };
	return node;
}

function connectionLabel(state: RelayConnectionState): string {
	switch (state) {
		case "connected": return "Connected";
		case "connecting": return "Connecting";
		case "error": return "Connection error";
		case "disconnected": return "Disconnected";
	}
}

function connectionIcon(state: RelayConnectionState): string {
	switch (state) {
		case "connected": return "pass";
		case "connecting": return "sync~spin";
		case "error": return "error";
		case "disconnected": return "debug-disconnect";
	}
}

function relayLabel(raw: string): string {
	const target = validateRelayUrl(raw);
	if (!target.ok) return "Invalid relay address";
	const url = new URL(target.connectUrl);
	return `${url.protocol}//${url.host}`;
}
