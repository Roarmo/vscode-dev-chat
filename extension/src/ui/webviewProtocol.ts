
export interface SendMessageCommand {
  command: "sendMessage";
  id: string;
  to: string;
  text: string;
}

export interface CopyPublicKeyCommand {
  command: "copyPublicKey";
}

export interface RetryConnectionCommand {
  command: "retryConnection";
}

export interface WebviewReadyCommand {
  command: "webviewReady";
}

export type WebviewToExtensionMessage = SendMessageCommand | CopyPublicKeyCommand | RetryConnectionCommand | WebviewReadyCommand;


export interface MessageAckCommand {
  command: "messageAck";
  id: string;
  status: "sent" | "failed";
  reason?: string;
}

export interface ReceiveMessageCommand {
  command: "receiveMessage";
  message: {
    id: string;
    author: string;
    text: string;
    time: string;
  };
}

export interface ConnectionStateCommand {
  command: "connectionState";
  state: "disconnected" | "connecting" | "connected" | "error";
}

export interface PublicKeyCopiedCommand {
  command: "publicKeyCopied";
}

export interface ErrorNoticeCommand {
  command: "errorNotice";
  message: string;
}

export type ExtensionToWebviewMessage = MessageAckCommand | ReceiveMessageCommand | ConnectionStateCommand | PublicKeyCopiedCommand | ErrorNoticeCommand;
