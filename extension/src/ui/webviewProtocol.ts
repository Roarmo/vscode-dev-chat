
export interface SendMessageCommand {
  command: "sendMessage";
  id: string;
  to: string;
  text: string;
}

export interface CopyPublicKeyCommand {
  command: "copyPublicKey";
}

export type WebviewToExtensionMessage = SendMessageCommand | CopyPublicKeyCommand;


export interface MessageAckCommand {
  command: "messageAck";
  id: string;
  status: "sent" | "failed";
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

export type ExtensionToWebviewMessage = MessageAckCommand | ReceiveMessageCommand | ConnectionStateCommand | PublicKeyCopiedCommand;
