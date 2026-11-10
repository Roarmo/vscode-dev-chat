
import type { ConversationState } from "../messaging/conversationHistory";
import type { PendingKeyChangeSummary } from "../messaging/secureInbox";

export interface SendMessageCommand {
  command: "sendMessage";
  id: string;
  to: string;
  text: string;
}

export interface CopyPublicKeyCommand {
  command: "copyPublicKey";
}

export interface SaveContactCommand {
  command: "saveContact";
  name: string;
  publicKey: string;
  currentPublicKey: string | null;
}

export interface RemoveContactCommand {
  command: "removeContact";
  publicKey: string;
}

export interface RetryConnectionCommand {
  command: "retryConnection";
}

export interface SelectConversationCommand {
  command: "selectConversation";
  publicKey: string | null;
}

export interface WebviewReadyCommand {
  command: "webviewReady";
}

export interface ChatActionCommand {
  command: "showMyFingerprint" | "verifyContact" | "reviewKeyChanges" | "openInstructions";
}

export type WebviewToExtensionMessage =
  | SendMessageCommand
  | CopyPublicKeyCommand
  | SaveContactCommand
  | RemoveContactCommand
  | RetryConnectionCommand
  | SelectConversationCommand
  | ChatActionCommand
  | WebviewReadyCommand;

export interface ConnectionStateCommand {
  command: "connectionState";
  state: "disconnected" | "connecting" | "connected" | "error";
}

export interface PublicKeyCopiedCommand {
  command: "publicKeyCopied";
}

export interface ContactView {
  name: string;
  publicKey: string;
  fingerprint: string;
}

export interface ContactsUpdatedCommand {
  command: "contactsUpdated";
  contacts: ContactView[];
  selectedPublicKey: string | null;
}

export interface ConversationStateCommand {
  command: "conversationState";
  state: ConversationState;
}

export interface ErrorNoticeCommand {
  command: "errorNotice";
  message: string;
}

export interface PendingKeyChangesCommand {
  command: "pendingKeyChanges";
  summary: PendingKeyChangeSummary;
}

export type ExtensionToWebviewMessage =
  | ConnectionStateCommand
  | PublicKeyCopiedCommand
  | ContactsUpdatedCommand
  | ConversationStateCommand
  | PendingKeyChangesCommand
  | ErrorNoticeCommand;
