import type * as vscode from "vscode";
import type { RelayAccessState, RelayAccessStore } from "../../../shared/relayAccess";

const ACCESS_SECRET = "devChat.hostRelay.access";

export class SecretRelayAccessStore implements RelayAccessStore {
	constructor(private readonly secrets: vscode.SecretStorage) {}

	public async load(): Promise<unknown> {
		const stored = await this.secrets.get(ACCESS_SECRET);
		if (stored === undefined) return undefined;
		try {
			return JSON.parse(stored) as unknown;
		} catch {
			throw new Error("Stored relay access state is not valid JSON.");
		}
	}

	public async save(state: RelayAccessState): Promise<void> {
		await this.secrets.store(ACCESS_SECRET, JSON.stringify(state));
	}
}
