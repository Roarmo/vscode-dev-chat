import { generateJoinCode, isIdentityPublicKey, isJoinCode } from "./relayAuthentication";
import type { RelayMember } from "./types";

export interface RelayAccessState {
	version: 1;
	joinCode: string;
	revision: number;
	members: RelayMember[];
}

/** The join code is secret; implementations must protect the entire stored state. */
export interface RelayAccessStore {
	load(): Promise<unknown>;
	save(state: RelayAccessState): Promise<void>;
}

export interface RelayAccessOptions {
	adminPublicKey: string;
	store: RelayAccessStore;
	/** Used only when creating a new access state. */
	initialJoinCode?: string;
}

export function copyRelayAccessState(state: RelayAccessState): RelayAccessState {
	return { ...state, members: state.members.map((member) => ({ ...member })) };
}

export async function saveRelayAccess(store: RelayAccessStore, state: RelayAccessState): Promise<void> {
	try {
		await store.save(copyRelayAccessState(state));
	} catch {
		throw new Error("Could not save relay access state. Check storage permissions and available space.");
	}
}

function validateRelayAccessState(value: unknown): RelayAccessState {
	if (!value || typeof value !== "object") throw new Error("Stored relay access state is invalid.");
	const candidate = value as Record<string, unknown>;
	if (
		candidate.version !== 1 ||
		!isJoinCode(candidate.joinCode) ||
		typeof candidate.revision !== "number" ||
		!Number.isSafeInteger(candidate.revision) ||
		candidate.revision < 0 ||
		!Array.isArray(candidate.members)
	) {
		throw new Error("Stored relay access state is invalid.");
	}

	const members: RelayMember[] = [];
	const identities = new Set<string>();
	for (const item of candidate.members) {
		if (!item || typeof item !== "object") throw new Error("Stored relay membership is invalid.");
		const member = item as Record<string, unknown>;
		if (
			!isIdentityPublicKey(member.publicKey) ||
			!isIdentityPublicKey(member.signingKey) ||
			identities.has(member.publicKey)
		) {
			throw new Error("Stored relay membership is invalid.");
		}
		identities.add(member.publicKey);
		members.push({ publicKey: member.publicKey, signingKey: member.signingKey });
	}
	return { version: 1, joinCode: candidate.joinCode, revision: candidate.revision, members };
}

export async function loadRelayAccess(options: RelayAccessOptions): Promise<RelayAccessState> {
	if (!isIdentityPublicKey(options.adminPublicKey)) {
		throw new Error("The relay administrator must have a valid Dev Chat public key.");
	}
	if (options.initialJoinCode !== undefined && !isJoinCode(options.initialJoinCode)) {
		throw new Error("The initial relay join code must be a randomly generated Dev Chat join code.");
	}

	let stored: unknown;
	try {
		stored = await options.store.load();
	} catch {
		throw new Error("Could not read relay access state. Check the access file or secret storage.");
	}
	if (stored !== undefined) return validateRelayAccessState(stored);

	const state: RelayAccessState = {
		version: 1,
		joinCode: options.initialJoinCode ?? generateJoinCode(),
		revision: 0,
		members: [],
	};
	await saveRelayAccess(options.store, state);
	return state;
}
