export type MessageType = "hello" | "server_ready" | "direct_message" | "ack" | "error";

export interface BaseEnvelope {
	type: MessageType;
	timestamp: string;
}

export interface HelloMessage extends BaseEnvelope {
	type: "hello";
	requestId: string;
	from: string;
	message: string;
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

export type ClientToServerMessage = HelloMessage | DirectMessage;
export type ServerToClientMessage = ServerReadyMessage | DirectMessage | AckMessage | ErrorMessage;
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
		isString(candidate.message) &&
		hasBaseEnvelope(candidate)
	);
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
		isServerReadyMessage(value) ||
		isDirectMessage(value) ||
		isAckMessage(value) ||
		isErrorMessage(value)
	);
}
