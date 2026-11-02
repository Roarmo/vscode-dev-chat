import * as vscode from "vscode";
import { randomBytes } from "crypto";
import type { WebviewToExtensionMessage, ExtensionToWebviewMessage } from "./webviewProtocol";
import type { DirectMessage, ErrorMessage } from "../../../shared/types";
import { RelayClient, RelayConnectionState } from "../relay/relayClient";

export class ChatPanel {
  public static currentPanel: ChatPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _context: vscode.ExtensionContext;
  private readonly _relayClient: RelayClient;
  private readonly _identity: string;
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(context: vscode.ExtensionContext, relayClient: RelayClient, identity: string) {
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

    ChatPanel.currentPanel = new ChatPanel(panel, context, relayClient, identity);
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, relayClient: RelayClient, identity: string) {
    this._panel = panel;
    this._context = context;
    this._relayClient = relayClient;
    this._identity = identity;

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._disposables.push(new vscode.Disposable(relayClient.onStatusChange((state) => {
      void this.postMessage({ command: "connectionState", state });
    })));
    this._disposables.push(new vscode.Disposable(relayClient.onMessage((message) => {
      if (message.type === "direct_message") {
        const incoming: DirectMessage = message;
        const response: ExtensionToWebviewMessage = {
          command: "receiveMessage",
          message: {
            id: incoming.requestId,
            author: incoming.from,
            text: incoming.payload,
            time: new Date(incoming.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          },
        };
        void this.postMessage(response);
      } else if (message.type === "ack" && message.status === "delivered") {
        void this.postMessage({ command: "messageAck", id: message.correlationId, status: "sent" });
      } else if (message.type === "error") {
        const failure: ErrorMessage = message;
        if (failure.correlationId) {
          void this.postMessage({ command: "messageAck", id: failure.correlationId, status: "failed" });
        }
      }
    })));

    this._panel.webview.onDidReceiveMessage(
      (message: WebviewToExtensionMessage) => {
        switch (message.command) {
          case "sendMessage": {
            if (!message.to.trim() || !message.text.trim()) {
              void this.postMessage({ command: "messageAck", id: message.id, status: "failed" });
              break;
            }
            const queued = this._relayClient.sendDirectMessage(message.to.trim(), message.text, message.id);
            if (!queued) {
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
      <div class="title">Dev Chat</div>
      <div class="identity">Your ID: ${escapeHtml(this._identity)}</div>
      <div class="status" id="connection-status" data-state="${connectionState}">${connectionState}</div>
    </header>
    <main class="messages" id="messages" role="log" aria-live="polite"></main>
    <footer class="composer">
      <input id="recipient" placeholder="Recipient ID" aria-label="Recipient ID" />
      <input id="input" placeholder="Type a message…" aria-label="Message input" />
      <button id="send">Send</button>
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
