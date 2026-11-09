export type MessageType =
	| "hello"
	| "relay_challenge"
	| "relay_authenticate"
	| "relay_admin"
	| "relay_admin_result"
	| "server_ready"
	| "direct_message"
	| "ack"
	| "error";

export interface BaseEnvelope {
	type: MessageType;
	timestamp: string;
}

export interface HelloMessage extends BaseEnvelope {
	type: "hello";
	requestId: string;
	from: string;
	signingKey: string;
	message: string;
}

export interface RelayChallengeMessage extends BaseEnvelope {
	type: "relay_challenge";
	correlationId: string;
	challengeId: string;
	relayId: string;
	sessionId: string;
	nonce: string;
	ephemeralKey: string;
	issuedAt: number;
	expiresAt: number;
}

export interface RelayAuthenticateMessage extends BaseEnvelope {
	type: "relay_authenticate";
	requestId: string;
	challengeId: string;
	proof: string;
	signature: string;
	joinCode: string;
}

export type RelayAdminAction = "list_members" | "get_join_code" | "rotate_code" | "remove_member";

export interface RelayMember {
	publicKey: string;
	signingKey: string;
}

export interface RelayAdminMessage extends BaseEnvelope {
	type: "relay_admin";
	requestId: string;
	action: RelayAdminAction;
	publicKey?: string;
	removeMembers?: boolean;
	expectedRevision?: number;
}

export interface RelayAdminResultMessage extends BaseEnvelope {
	type: "relay_admin_result";
	correlationId: string;
	action: RelayAdminAction;
	revision: number;
	members?: RelayMember[];
	joinCode?: string;
}

export interface ServerReadyMessage extends BaseEnvelope {
	type: "server_ready";
	correlationId: string;
	message: string;
}

export interface DirectMessage extends BaseEnvelope {
	type: "direct_message";
	requestId: string;
	from: string;
	to: string;
	payload: string;
}

export interface AckMessage extends BaseEnvelope {
	type: "ack";
	messageId: string;
	correlationId: string;
	status: "accepted" | "delivered";
}

export interface ErrorMessage extends BaseEnvelope {
	type: "error";
	correlationId: string;
	code: string;
	message: string;
}

export type ClientToServerMessage = HelloMessage | RelayAuthenticateMessage | RelayAdminMessage | DirectMessage;
export type ServerToClientMessage = ServerReadyMessage | RelayChallengeMessage | RelayAdminResultMessage | DirectMessage | AckMessage | ErrorMessage;
export type RelayMessage = ClientToServerMessage | ServerToClientMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function hasBaseEnvelope(candidate: Record<string, unknown>): boolean {
	return isString(candidate.type) && isString(candidate.timestamp);
}

function isHelloMessage(value: unknown): value is HelloMessage {
	if (!isRecord(value)) {
		return false;
	}

	const candidate = value;
	return (
		candidate.type === "hello" &&
		isString(candidate.requestId) &&
		isString(candidate.from) &&
		isString(candidate.signingKey) &&
		isString(candidate.message) &&
		hasBaseEnvelope(candidate)
	);
}

function isRelayChallengeMessage(value: unknown): value is RelayChallengeMessage {
	if (!isRecord(value)) return false;
	return value.type === "relay_challenge" &&
		isString(value.correlationId) && isString(value.challengeId) &&
		isString(value.relayId) && isString(value.sessionId) &&
		isString(value.nonce) && isString(value.ephemeralKey) &&
		Number.isSafeInteger(value.issuedAt) && Number.isSafeInteger(value.expiresAt) &&
		hasBaseEnvelope(value);
}

function isRelayAuthenticateMessage(value: unknown): value is RelayAuthenticateMessage {
	if (!isRecord(value)) return false;
	return value.type === "relay_authenticate" &&
		isString(value.requestId) && isString(value.challengeId) &&
		isString(value.proof) && isString(value.signature) && isString(value.joinCode) &&
		hasBaseEnvelope(value);
}

function isRelayAdminAction(value: unknown): value is RelayAdminAction {
	return value === "list_members" || value === "get_join_code" ||
		value === "rotate_code" || value === "remove_member";
}

function isRelayAdminMessage(value: unknown): value is RelayAdminMessage {
	if (!isRecord(value)) return false;
	if (value.type !== "relay_admin" || !isString(value.requestId) ||
		!isRelayAdminAction(value.action) || !hasBaseEnvelope(value)) return false;
	if (value.action === "remove_member") return isString(value.publicKey);
	if (value.action === "rotate_code") {
		return typeof value.removeMembers === "boolean" &&
			(!value.removeMembers || Number.isSafeInteger(value.expectedRevision));
	}
	return true;
}

function isRelayMember(value: unknown): value is RelayMember {
	return isRecord(value) && isString(value.publicKey) && isString(value.signingKey);
}

function isRelayAdminResultMessage(value: unknown): value is RelayAdminResultMessage {
	if (!isRecord(value)) return false;
	if (value.type !== "relay_admin_result" || !isString(value.correlationId) ||
		!isRelayAdminAction(value.action) || !Number.isSafeInteger(value.revision) ||
		!hasBaseEnvelope(value)) return false;
	if (value.members !== undefined && (!Array.isArray(value.members) || !value.members.every(isRelayMember))) return false;
	if (value.joinCode !== undefined && !isString(value.joinCode)) return false;
	return true;
}

function isServerReadyMessage(value: unknown): value is ServerReadyMessage {
	if (!isRecord(value)) {
		return false;
	}

	const candidate = value;
	return (
		candidate.type === "server_ready" &&
		isString(candidate.correlationId) &&
		isString(candidate.message) &&
		hasBaseEnvelope(candidate)
	);
}

function isDirectMessage(value: unknown): value is DirectMessage {
	if (!isRecord(value)) {
		return false;
	}

	const candidate = value;
	return (
		candidate.type === "direct_message" &&
		isString(candidate.requestId) &&
		isString(candidate.from) &&
		isString(candidate.to) &&
		isString(candidate.payload) &&
		hasBaseEnvelope(candidate)
	);
}

function isAckMessage(value: unknown): value is AckMessage {
	if (!isRecord(value)) {
		return false;
	}

	const candidate = value;
	return (
		candidate.type === "ack" &&
		isString(candidate.messageId) &&
		isString(candidate.correlationId) &&
		(candidate.status === "accepted" || candidate.status === "delivered") &&
		hasBaseEnvelope(candidate)
	);
}

function isErrorMessage(value: unknown): value is ErrorMessage {
	if (!isRecord(value)) {
		return false;
	}

	const candidate = value;
	return (
		candidate.type === "error" &&
		isString(candidate.correlationId) &&
		isString(candidate.code) &&
		isString(candidate.message) &&
		hasBaseEnvelope(candidate)
	);
}

export function isRelayMessage(value: unknown): value is RelayMessage {
	if (!isRecord(value)) {
		return false;
	}

	return (
		isHelloMessage(value) ||
		isRelayChallengeMessage(value) ||
		isRelayAuthenticateMessage(value) ||
		isRelayAdminMessage(value) ||
		isRelayAdminResultMessage(value) ||
		isServerReadyMessage(value) ||
		isDirectMessage(value) ||
		isAckMessage(value) ||
		isErrorMessage(value)
	);
}

export function isClientToServerMessage(value: unknown): value is ClientToServerMessage {
	return isHelloMessage(value) || isRelayAuthenticateMessage(value) ||
		isRelayAdminMessage(value) || isDirectMessage(value);
}

export function isServerToClientMessage(value: unknown): value is ServerToClientMessage {
	return isServerReadyMessage(value) || isRelayChallengeMessage(value) ||
		isRelayAdminResultMessage(value) || isDirectMessage(value) ||
		isAckMessage(value) || isErrorMessage(value);
}
