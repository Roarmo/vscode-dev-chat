import * as vscode from "vscode";
import { randomBytes } from "crypto";
import type { WebviewToExtensionMessage, ExtensionToWebviewMessage } from "./webviewProtocol";
import { RelayClient, RelayConnectionState } from "../relay/relayClient";
import { EncryptionService } from "../encryption/encryptionService";
import { shortKeyLabel } from "../encryption/fingerprint";
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

  public static createOrShow(context: vscode.ExtensionContext, relayClient: RelayClient, encryptionService: EncryptionService, inbox: SecureInbox) {
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

    ChatPanel.currentPanel = new ChatPanel(panel, context, relayClient, encryptionService, inbox);
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, relayClient: RelayClient, encryptionService: EncryptionService, inbox: SecureInbox) {
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
      <div class="identity-label">Your fingerprint</div>
      <code class="identity fingerprint" id="own-fingerprint" title="Compare this with your contacts to verify each other">${escapeHtml(this._encryptionService.fingerprint)}</code>
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
          <label for="recipient">To</label>
          <input id="recipient" placeholder="Paste recipient public key" autocomplete="off" spellcheck="false" />
        </div>
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
