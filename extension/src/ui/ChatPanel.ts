import * as vscode from "vscode";
import { randomBytes } from "crypto";
import type { WebviewToExtensionMessage, ExtensionToWebviewMessage } from "./webviewProtocol";
import type { DirectMessage } from "../../../shared/types";
import { RelayClient, RelayConnectionState } from "../relay/relayClient";
import { EncryptionService } from "../encryption/encryptionService";

export class ChatPanel {
  public static currentPanel: ChatPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _context: vscode.ExtensionContext;
  private readonly _relayClient: RelayClient;
  private readonly _encryptionService: EncryptionService;
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(context: vscode.ExtensionContext, relayClient: RelayClient, encryptionService: EncryptionService) {
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

    ChatPanel.currentPanel = new ChatPanel(panel, context, relayClient, encryptionService);
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, relayClient: RelayClient, encryptionService: EncryptionService) {
    this._panel = panel;
    this._context = context;
    this._relayClient = relayClient;
    this._encryptionService = encryptionService;

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._disposables.push(new vscode.Disposable(relayClient.onStatusChange((state) => {
      void this.postMessage({ command: "connectionState", state });
    })));
    this._disposables.push(new vscode.Disposable(relayClient.onMessage((message) => {
      if (message.type === "direct_message") {
        const incoming: DirectMessage = message;
        try {
          const response: ExtensionToWebviewMessage = {
            command: "receiveMessage",
            message: {
              id: incoming.requestId,
              author: incoming.from.slice(0, 12),
              text: this._encryptionService.decrypt(incoming.payload),
              time: new Date(incoming.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            },
          };
          void this.postMessage(response);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          void vscode.window.showErrorMessage(`Could not decrypt incoming Dev Chat message: ${reason}`);
        }
      } else if (message.type === "ack" && message.status === "delivered") {
        void this.postMessage({ command: "messageAck", id: message.correlationId, status: "sent" });
      } else if (message.type === "error") {
        if (message.correlationId) {
          void this.postMessage({ command: "messageAck", id: message.correlationId, status: "failed" });
        }
      }
    })));

    this._panel.webview.onDidReceiveMessage(
      (message: WebviewToExtensionMessage) => {
        switch (message.command) {
          case "copyPublicKey":
            void vscode.env.clipboard.writeText(this._encryptionService.publicKey).then(
              () => this.postMessage({ command: "publicKeyCopied" }),
              () => vscode.window.showErrorMessage("Could not copy your public key.")
            );
            break;
          case "sendMessage": {
            if (!message.to.trim() || !message.text.trim()) {
              void this.postMessage({ command: "messageAck", id: message.id, status: "failed" });
              break;
            }
            try {
              const encryptedPayload = this._encryptionService.encrypt(message.text, message.to.trim());
              const queued = this._relayClient.sendDirectMessage(message.to.trim(), encryptedPayload, message.id);
              if (!queued) {
                void this.postMessage({ command: "messageAck", id: message.id, status: "failed" });
              }
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              void vscode.window.showErrorMessage(`Could not encrypt outgoing Dev Chat message: ${reason}`);
              void this.postMessage({ command: "messageAck", id: message.id, status: "failed" });
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

  /** Post a typed message to the webview (e.g. from relay layer). */
  public postMessage(message: ExtensionToWebviewMessage): Thenable<boolean> {
    return this._panel.webview.postMessage(message);
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
          <input id="input" placeholder="Write a message…" aria-label="Message input" autocomplete="off" />
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
