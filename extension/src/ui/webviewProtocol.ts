
export interface SendMessageCommand {
  command: "sendMessage";
  id: string;
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

export type ExtensionToWebviewMessage = MessageAckCommand | ReceiveMessageCommand;
