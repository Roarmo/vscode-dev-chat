
export interface SendMessageCommand {
  command: "sendMessage";
  id: string;
  to: string;
  text: string;
}

export type WebviewToExtensionMessage = SendMessageCommand;


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

export type ExtensionToWebviewMessage = MessageAckCommand | ReceiveMessageCommand | ConnectionStateCommand;
