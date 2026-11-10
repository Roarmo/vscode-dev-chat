import * as vscode from "vscode";
import { randomBytes } from "crypto";
import type { WebviewToExtensionMessage, ExtensionToWebviewMessage, SaveContactCommand, RemoveContactCommand } from "./webviewProtocol";
import { RelayClient, RelayConnectionState } from "../relay/relayClient";
import { EncryptionService } from "../encryption/encryptionService";
import { recipientKeyFingerprint } from "../encryption/fingerprint";
import { ContactStore } from "../encryption/contactStore";
import { ConversationManager } from "../messaging/conversationManager";
import type { SecureInbox } from "../messaging/secureInbox";

export class ChatPanel {
  public static currentPanel: ChatPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _context: vscode.ExtensionContext;
  private readonly _relayClient: RelayClient;
  private readonly _encryptionService: EncryptionService;
  private _disposables: vscode.Disposable[] = [];
  private _webviewReady = false;
  private _pendingPosts: ExtensionToWebviewMessage[] = [];

  public static createOrShow(
    context: vscode.ExtensionContext,
    relayClient: RelayClient,
    encryptionService: EncryptionService,
    contactStore: ContactStore,
    conversations: ConversationManager,
    inbox: SecureInbox
  ) {
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

    if (ChatPanel.currentPanel) {
      ChatPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "devChat",
      "Dev Chat",
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")]
      }
    );

    ChatPanel.currentPanel = new ChatPanel(panel, context, relayClient, encryptionService, contactStore, conversations, inbox);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    relayClient: RelayClient,
    encryptionService: EncryptionService,
    private readonly _contactStore: ContactStore,
    private readonly _conversations: ConversationManager,
    private readonly _inbox: SecureInbox
  ) {
    this._panel = panel;
    this._context = context;
    this._relayClient = relayClient;
    this._encryptionService = encryptionService;

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._disposables.push(new vscode.Disposable(relayClient.onStatusChange((state) => {
      void this.postMessage({ command: "connectionState", state });
    })));
    this._disposables.push(new vscode.Disposable(this._conversations.onEvent((event) => {
      if (event.type === "changed") void this.postMessage({ command: "conversationState", state: event.state });
      else void this.postMessage({ command: "errorNotice", message: event.message });
    })));
    this._disposables.push(new vscode.Disposable(this._inbox.onEvent((event) => {
      if (event.type === "pendingKeyChanges") void this.postMessage({ command: "pendingKeyChanges", summary: event.summary });
    })));

    this._panel.webview.onDidReceiveMessage(
      (message: WebviewToExtensionMessage) => {
        switch (message.command) {
          case "webviewReady":
            this._webviewReady = true;
            for (const pending of this._pendingPosts.splice(0)) {
              void this._panel.webview.postMessage(pending);
            }
            void this.postMessage({ command: "connectionState", state: this._relayClient.state });
            void this.postContacts(null);
            void this.postMessage({ command: "conversationState", state: this._conversations.state });
            void this.postMessage({ command: "pendingKeyChanges", summary: this._inbox.pendingKeyChanges });
            break;
          case "retryConnection":
            this._relayClient.connect(this._encryptionService);
            break;
          case "selectConversation":
            void this.selectConversation(message.publicKey);
            break;
          case "copyPublicKey":
            void vscode.env.clipboard.writeText(this._encryptionService.publicKey).then(
              () => this.postMessage({ command: "publicKeyCopied" }),
              () => vscode.window.showErrorMessage("Could not copy your public key.")
            );
            break;
          case "showMyFingerprint":
            void this.runAction("devChat.showMyFingerprint");
            break;
          case "verifyContact":
            void this.runAction("devChat.verifyContact");
            break;
          case "reviewKeyChanges":
            void this.runAction("devChat.reviewKeyChanges");
            break;
          case "openInstructions":
            void this.runAction("devChat.openInstructions");
            break;
          case "saveContact":
            void this.saveContact(message);
            break;
          case "removeContact":
            void this.removeContact(message);
            break;
          case "sendMessage": {
            void this.sendMessage(message);
            break;
          }
        }
      },
      null,
      this._disposables
    );

    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
  }

  /** Post a typed message to the webview. Messages are buffered until the webview script has loaded. */
  public postMessage(message: ExtensionToWebviewMessage): Thenable<boolean> {
    if (!this._webviewReady) {
      this._pendingPosts.push(message);
      return Promise.resolve(true);
    }
    return this._panel.webview.postMessage(message);
  }

  private async saveContact(message: SaveContactCommand): Promise<void> {
    try {
      if (
        typeof message.name !== "string" ||
        typeof message.publicKey !== "string" ||
        (message.currentPublicKey !== null && typeof message.currentPublicKey !== "string")
      ) {
        throw new Error("Contact details are invalid. Enter a name and a valid Dev Chat public key.");
      }
      await this._contactStore.save(message.name, message.publicKey, message.currentPublicKey ?? undefined);
      this._conversations.notifyContactsChanged();
      await this.postContacts(message.publicKey);
      await this._conversations.select(message.publicKey);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      void this.postMessage({ command: "errorNotice", message: `Could not save contact: ${reason}` });
    }
  }

  private async removeContact(message: RemoveContactCommand): Promise<void> {
    try {
      if (typeof message.publicKey !== "string") {
        throw new Error("Contact details are invalid. Refresh the contact list and try again.");
      }
      const contact = this._contactStore.list().find((item) => item.publicKey === message.publicKey);
      if (!contact) throw new Error("This contact no longer exists. Refresh the contact list and try again.");
      const choice = await vscode.window.showWarningMessage(
        `Remove ${contact.name} from your saved contacts? Identity verification records will be kept.`,
        { modal: true },
        "Remove"
      );
      if (choice !== "Remove") return;
      await this._contactStore.remove(message.publicKey);
      this._conversations.notifyContactsChanged();
      if (this._conversations.state.activePublicKey === message.publicKey) {
        await this._conversations.select(null);
      }
      await this.postContacts(null);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      void this.postMessage({ command: "errorNotice", message: `Could not remove contact: ${reason}` });
    }
  }

  private postContacts(selectedPublicKey: string | null): Thenable<boolean> {
    return this.postMessage({
      command: "contactsUpdated",
      contacts: this._contactStore.list().map((contact) => ({
        ...contact,
        fingerprint: recipientKeyFingerprint(contact.publicKey),
      })),
      selectedPublicKey,
    });
  }

  private async selectConversation(publicKey: string | null): Promise<void> {
    try {
      if (publicKey !== null && typeof publicKey !== "string") {
        throw new Error("The selected conversation is invalid.");
      }
      await this._conversations.select(publicKey);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      void this.postMessage({ command: "errorNotice", message: `Could not open conversation: ${reason}` });
    }
  }

  private async sendMessage(message: Extract<WebviewToExtensionMessage, { command: "sendMessage" }>): Promise<void> {
    try {
      await this._conversations.send(message.to, message.id, message.text);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      void this.postMessage({ command: "errorNotice", message: reason });
    }
  }

  private async runAction(command: string): Promise<void> {
    try {
      await vscode.commands.executeCommand(command);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      void this.postMessage({ command: "errorNotice", message: `Could not run Dev Chat action: ${reason}` });
    }
  }

  public dispose() {
    ChatPanel.currentPanel = undefined;
    this._conversations.deactivate();

    this._panel.dispose();

    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const nonce = getNonce();
        const cspSource = webview.cspSource;

        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, "media", "chat.css"));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, "media", "chat.js"));
        const connectionState: RelayConnectionState = this._relayClient.state;

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https:; style-src ${cspSource}; script-src ${cspSource} 'nonce-${nonce}';">
  <title>Dev Chat</title>
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div class="container">
    <header class="header">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">&gt;_</div>
        <div><div class="title">Dev Chat</div><div class="subtitle">Direct messages</div></div>
      </div>
      <div class="header-actions">
        <button class="header-action" id="show-fingerprint" type="button" aria-label="Show my identity fingerprint">Fingerprint</button>
        <button class="header-action" id="verify-contact" type="button" aria-label="Verify a contact fingerprint">Verify contact</button>
        <button class="header-action" id="open-instructions" type="button" aria-label="Open Dev Chat instructions">Help</button>
        <div class="status" id="connection-status" data-state="${connectionState}" role="status">${connectionState}</div>
      </div>
    </header>
    <div class="identity-bar">
      <div class="identity-label">Your public key</div>
      <code class="identity" title="${escapeHtml(this._encryptionService.publicKey)}">${escapeHtml(this._encryptionService.publicKey)}</code>
      <button class="copy-key" id="copy-key" type="button" title="Copy public key">Copy key</button>
      <div class="identity-label">Your key fingerprint</div>
      <code class="identity fingerprint" id="own-key-fingerprint" aria-label="Your public key fingerprint" title="Compare this with your contact's selected key fingerprint">${escapeHtml(recipientKeyFingerprint(this._encryptionService.publicKey))}</code>
      <div class="identity-label">Your identity fingerprint</div>
      <code class="identity fingerprint" id="own-fingerprint" aria-label="Your identity fingerprint" title="Compare this with your contacts to verify both identity keys">${escapeHtml(this._encryptionService.fingerprint)}</code>
    </div>
    <div class="notice connection-notice" id="connection-notice" role="status"${connectionState === "connected" || connectionState === "connecting" ? " hidden" : ""}>
      <span id="connection-notice-text">${connectionState === "error" ? "Could not connect to the relay." : "Not connected to the relay."}</span>
      <button id="retry-connection" type="button">${connectionState === "error" ? "Retry" : "Connect"}</button>
    </div>
    <div class="notice key-change-notice" id="key-change-notice" role="status" hidden>
      <span id="key-change-notice-text"></span>
      <button id="review-key-changes" type="button" aria-label="Review contact identity key changes">Review</button>
    </div>
    <div class="notice error-notice" id="error-notice" role="alert" hidden>
      <span id="error-notice-text"></span>
      <button id="dismiss-error" type="button" aria-label="Dismiss error" title="Dismiss error">&times;</button>
    </div>
    <div class="chat-layout">
      <aside class="conversation-sidebar" aria-label="Conversations">
        <div class="conversation-sidebar-header">
          <h2>Conversations</h2>
          <span id="unread-total" aria-live="polite"></span>
        </div>
        <nav class="conversation-list" id="conversation-list" aria-label="Conversation list"></nav>
        <div class="conversation-list-empty" id="conversation-list-empty">Add a contact to start a conversation.</div>
      </aside>
      <section class="conversation" aria-label="Active conversation">
        <div class="active-conversation-header">
          <h2 id="conversation-title">Select a conversation</h2>
          <span id="conversation-key-label"></span>
        </div>
        <main class="messages" id="messages" role="log" aria-live="polite"></main>
        <div class="empty-state" id="empty-state">
          <div class="empty-mark" aria-hidden="true">&gt;_</div>
          <div class="empty-title">Your conversation starts here</div>
          <div class="empty-subtitle">No messages yet</div>
        </div>
      </section>
    </div>
    <footer class="composer">
      <div class="composer-inner">
        <details class="contacts-manager">
          <summary>Manage contacts</summary>
          <p class="contacts-help">Select a saved contact to edit it, or choose Add a new contact. Saved contacts contain public keys only. Removing a contact does not erase its conversation history. Compare key fingerprints over a trusted channel.</p>
          <div class="contact-select-row">
            <label for="contact-select">Contact</label>
            <select id="contact-select" aria-label="Select contact to manage">
              <option value="">Add a new contact</option>
            </select>
          </div>
          <div class="contact-form">
            <label for="contact-name">Name</label>
            <input id="contact-name" maxlength="80" autocomplete="off" />
            <label for="contact-public-key">Public key</label>
            <input id="contact-public-key" aria-label="Contact public key" autocomplete="off" spellcheck="false" />
            <div class="contact-actions">
              <button id="save-contact" type="button">Add contact</button>
              <button id="remove-contact" type="button" disabled>Remove</button>
            </div>
          </div>
          <div class="contact-fingerprint-row" id="contact-fingerprint-row" hidden>
            <span>Selected key fingerprint</span>
            <code id="contact-fingerprint"></code>
          </div>
        </details>
        <div class="compose-row">
          <input id="input" placeholder="Select a conversation to write a message" aria-label="Message input" autocomplete="off" disabled />
          <button id="send" type="button" disabled>Send <span aria-hidden="true">&rarr;</span></button>
        </div>
      </div>
    </footer>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce() {
  return randomBytes(16).toString('base64');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

export default ChatPanel;
