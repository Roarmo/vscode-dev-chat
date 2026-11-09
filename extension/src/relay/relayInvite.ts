import { isIdentityPublicKey, isJoinCode, verifyIdentitySignature } from "../../../shared/relayAuthentication";
import { identityFingerprint } from "../encryption/fingerprint";
import { validateRelayUrl } from "./relaySettings";

const INVITE_PREFIX = "devchat-invite.v1.";
const INVITE_CONTEXT = "devchat.relay-invite.v1";
const MAX_INVITE_LENGTH = 4096;

export interface RelayInvite {
	version: 1;
	relayUrl: string;
	joinCode: string;
	hostPublicKey: string;
	hostSigningKey: string;
	hostFingerprint: string;
	signature: string;
}

export interface RelayInviteIdentity {
	readonly publicKey: string;
	readonly signingPublicKey: string;
	signRelayInvitation(data: Uint8Array): string;
}

function inviteBytes(invite: Omit<RelayInvite, "signature">): Buffer {
	return Buffer.from(JSON.stringify([
		INVITE_CONTEXT,
		invite.version,
		invite.relayUrl,
		invite.joinCode,
		invite.hostPublicKey,
		invite.hostSigningKey,
		invite.hostFingerprint,
	]), "utf8");
}

function pinnedInviteUrl(url: unknown): string {
	const target = validateRelayUrl(url);
	if (!target.ok || !target.secure || !target.fingerprint || new URL(target.connectUrl).search) {
		throw new Error("Relay invitations require a pinned wss:// address without a query string.");
	}
	return target.url;
}

export function createRelayInvite(identity: RelayInviteIdentity, relayUrl: string, joinCode: string): string {
	if (!isIdentityPublicKey(identity.publicKey) || !isIdentityPublicKey(identity.signingPublicKey) || !isJoinCode(joinCode)) {
		throw new Error("Cannot create a relay invitation with invalid identity or access information.");
	}
	const unsigned: Omit<RelayInvite, "signature"> = {
		version: 1,
		relayUrl: pinnedInviteUrl(relayUrl),
		joinCode,
		hostPublicKey: identity.publicKey,
		hostSigningKey: identity.signingPublicKey,
		hostFingerprint: identityFingerprint(identity.publicKey, identity.signingPublicKey),
	};
	const invite: RelayInvite = { ...unsigned, signature: identity.signRelayInvitation(inviteBytes(unsigned)) };
	return INVITE_PREFIX + Buffer.from(JSON.stringify(invite), "utf8").toString("base64url");
}

export function parseRelayInvite(raw: string): RelayInvite {
	const invalid = (): never => { throw new Error("The Dev Chat invitation is invalid or has been altered."); };
	const trimmed = raw.trim();
	if (!trimmed.startsWith(INVITE_PREFIX) || trimmed.length > MAX_INVITE_LENGTH) return invalid();
	const encoded = trimmed.slice(INVITE_PREFIX.length);
	if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return invalid();
	const bytes = Buffer.from(encoded, "base64url");
	if (bytes.toString("base64url") !== encoded) return invalid();

	let parsed: unknown;
	try {
		parsed = JSON.parse(bytes.toString("utf8"));
	} catch {
		return invalid();
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return invalid();
	const value = parsed as Record<string, unknown>;
	const keys = ["version", "relayUrl", "joinCode", "hostPublicKey", "hostSigningKey", "hostFingerprint", "signature"];
	if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) return invalid();
	if (
		value.version !== 1 || typeof value.relayUrl !== "string" ||
		!isJoinCode(value.joinCode) || !isIdentityPublicKey(value.hostPublicKey) ||
		!isIdentityPublicKey(value.hostSigningKey) || typeof value.hostFingerprint !== "string" ||
		typeof value.signature !== "string"
	) return invalid();

	let url: string;
	try {
		url = pinnedInviteUrl(value.relayUrl);
	} catch {
		return invalid();
	}
	if (
		url !== value.relayUrl ||
		value.hostFingerprint !== identityFingerprint(value.hostPublicKey, value.hostSigningKey)
	) return invalid();
	const invite: RelayInvite = {
		version: 1,
		relayUrl: url,
		joinCode: value.joinCode,
		hostPublicKey: value.hostPublicKey,
		hostSigningKey: value.hostSigningKey,
		hostFingerprint: value.hostFingerprint,
		signature: value.signature,
	};
	if (!verifyIdentitySignature(invite.hostSigningKey, inviteBytes(invite), invite.signature)) return invalid();
	return invite;
}
