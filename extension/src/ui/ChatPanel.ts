import * as vscode from "vscode";
import { randomBytes } from "crypto";
import type { WebviewToExtensionMessage, ExtensionToWebviewMessage, SaveContactCommand, RemoveContactCommand } from "./webviewProtocol";
import { RelayClient, RelayConnectionState } from "../relay/relayClient";
import { EncryptionService } from "../encryption/encryptionService";
import { recipientKeyFingerprint, shortKeyLabel } from "../encryption/fingerprint";
import { ContactStore } from "../encryption/contactStore";
import type { InboxEvent, SecureInbox } from "../messaging/secureInbox";

export class ChatPanel {
  public static currentPanel: ChatPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _context: vscode.ExtensionContext;
  private readonly _relayClient: RelayClient;
  private readonly _encryptionService: EncryptionService;
  private _disposables: vscode.Disposable[] = [];
  private _webviewReady = false;
  private _pendingPosts: ExtensionToWebviewMessage[] = [];

  public static createOrShow(context: vscode.ExtensionContext, relayClient: RelayClient, encryptionService: EncryptionService, inbox: SecureInbox, contactStore: ContactStore) {
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

    ChatPanel.currentPanel = new ChatPanel(panel, context, relayClient, encryptionService, inbox, contactStore);
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, relayClient: RelayClient, encryptionService: EncryptionService, inbox: SecureInbox, private readonly _contactStore: ContactStore) {
    this._panel = panel;
    this._context = context;
    this._relayClient = relayClient;
    this._encryptionService = encryptionService;

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._disposables.push(new vscode.Disposable(relayClient.onStatusChange((state) => {
      void this.postMessage({ command: "connectionState", state });
    })));
    this._disposables.push(new vscode.Disposable(inbox.onEvent((event) => this.handleInboxEvent(event))));
    this._disposables.push(new vscode.Disposable(relayClient.onMessage((message) => {
      if (message.type === "ack" && message.status === "delivered") {
        void this.postMessage({ command: "messageAck", id: message.correlationId, status: "sent" });
      } else if (message.type === "error") {
        if (message.correlationId) {
          void this.postMessage({ command: "messageAck", id: message.correlationId, status: "failed", reason: message.message });
        }
        void this.postMessage({ command: "errorNotice", message: message.message });
      }
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
            break;
          case "retryConnection":
            this._relayClient.connect(this._encryptionService);
            break;
          case "copyPublicKey":
            void vscode.env.clipboard.writeText(this._encryptionService.publicKey).then(
              () => this.postMessage({ command: "publicKeyCopied" }),
              () => vscode.window.showErrorMessage("Could not copy your public key.")
            );
            break;
          case "saveContact":
            void this.saveContact(message);
            break;
          case "removeContact":
            void this.removeContact(message);
            break;
          case "sendMessage": {
            if (!message.to.trim() || !message.text.trim()) {
              void this.postMessage({ command: "messageAck", id: message.id, status: "failed", reason: "Enter a recipient and message." });
              break;
            }
            try {
              const encryptedPayload = this._encryptionService.seal(message.text, message.to.trim(), message.id);
              const queued = this._relayClient.sendDirectMessage(message.to.trim(), encryptedPayload, message.id);
              if (!queued) {
                void this.postMessage({ command: "messageAck", id: message.id, status: "failed", reason: "Connect to the relay before sending." });
              }
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              void vscode.window.showErrorMessage(`Could not encrypt outgoing Dev Chat message: ${reason}`);
              void this.postMessage({ command: "messageAck", id: message.id, status: "failed", reason: "Could not encrypt this message. Check the recipient's public key." });
            }
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

  private handleInboxEvent(event: InboxEvent): void {
    switch (event.type) {
      case "message": {
        const { message } = event;
        void this.postMessage({
          command: "receiveMessage",
          message: {
            id: message.requestId,
            author: shortKeyLabel(message.sender.publicKey),
            senderKey: message.sender.publicKey,
            fingerprint: message.sender.fingerprint,
            verified: message.sender.verified,
            text: message.text,
            time: new Date(message.sentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          },
        });
        break;
      }
      case "rejected":
        void this.postMessage({ command: "errorNotice", message: event.reason });
        break;
      case "held":
        void this.postMessage({
          command: "errorNotice",
          message: `Messages from ${shortKeyLabel(event.publicKey)} are held because their identity key changed. Run "Dev Chat: Review Contact Key Changes" to review it.`,
        });
        break;
      case "trustChanged":
        void this.postMessage({ command: "senderTrust", senderKey: event.publicKey, verified: event.verified });
        break;
    }
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
      await this.postContacts(message.publicKey);
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

  public dispose() {
    ChatPanel.currentPanel = undefined;

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
      <div class="status" id="connection-status" data-state="${connectionState}" role="status">${connectionState}</div>
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
    <div class="notice error-notice" id="error-notice" role="alert" hidden>
      <span id="error-notice-text"></span>
      <button id="dismiss-error" type="button" aria-label="Dismiss error" title="Dismiss error">&times;</button>
    </div>
    <section class="conversation" aria-label="Conversation">
      <main class="messages" id="messages" role="log" aria-live="polite"></main>
      <div class="empty-state" id="empty-state">
        <div class="empty-mark" aria-hidden="true">&gt;_</div>
        <div class="empty-title">Your conversation starts here</div>
        <div class="empty-subtitle">No messages yet</div>
      </div>
    </section>
    <footer class="composer">
      <div class="composer-inner">
        <div class="recipient-row">
          <label for="contact-select">To</label>
          <select id="contact-select" aria-label="Select saved contact">
            <option value="">Manual public key</option>
          </select>
          <input id="recipient" aria-label="Recipient public key" placeholder="Paste recipient public key" autocomplete="off" spellcheck="false" />
        </div>
        <div class="contact-fingerprint-row" id="contact-fingerprint-row" hidden>
          <span>Selected key fingerprint</span>
          <code id="contact-fingerprint"></code>
        </div>
        <details class="contacts-manager">
          <summary>Manage contacts</summary>
          <p class="contacts-help">To add a contact, select Manual public key. Saved contacts contain public keys only. Compare the selected key fingerprint with your contact's key fingerprint over a trusted channel.</p>
          <div class="contact-form">
            <label for="contact-name">Name</label>
            <input id="contact-name" maxlength="80" autocomplete="off" />
            <label for="contact-public-key">Public key</label>
            <input id="contact-public-key" autocomplete="off" spellcheck="false" />
            <div class="contact-actions">
              <button id="save-contact" type="button">Add contact</button>
              <button id="remove-contact" type="button" disabled>Remove</button>
            </div>
          </div>
        </details>
        <div class="compose-row">
          <input id="input" placeholder="Write a messageâ€¦" aria-label="Message input" autocomplete="off" />
          <button id="send" type="button">Send <span aria-hidden="true">&rarr;</span></button>
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
