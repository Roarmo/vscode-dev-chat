import { randomUUID } from "crypto";
import type * as vscode from "vscode";
import sodium from "libsodium-wrappers";
import { decodeCanonicalBase64 } from "../../../shared/relayAuthentication";
import {
	EncryptionService,
	IDENTITY_BUNDLE_SECRET,
	IDENTITY_FORMAT_SECRET,
	IDENTITY_FORMAT_VALUE,
	PRIVATE_KEY_SECRET,
	SIGNING_SEED_SECRET,
	isIdentityResetId,
	parseIdentityKeyBundle,
	type KeyCreationPolicy,
} from "./encryptionService";

export const IDENTITY_STATE_KEY = "devChat.identity.publicFingerprint";
export const RESET_PENDING_KEY = "devChat.identity.resetPending";

type ResetStatus = "none" | "scheduled" | "in-progress";
type IdentityLoadStatus = "existing" | "created" | "signing-key-created" | "identity-changed" | "reset";

interface IdentityRecord {
	version: 1;
	fingerprint: string;
}

interface ResetRecord {
	version: 1;
	status: "scheduled" | "in-progress";
	id: string;
	previousFingerprint: string | null;
}

interface SecretSnapshot {
	bundle: string | undefined;
	format: string | undefined;
	encryption: string | undefined;
	signing: string | undefined;
}

export interface IdentityDecisions {
	confirmNewIdentity(): Promise<boolean>;
	confirmSigningKeyCreation(): Promise<boolean>;
	confirmIdentityChange(previousFingerprint: string, currentFingerprint: string): Promise<boolean>;
}

export interface LoadedIdentity {
	identity: EncryptionService;
	status: IdentityLoadStatus;
}

export class IdentityLifecycleError extends Error {
	constructor(public readonly code: string, message: string) {
		super(message);
		this.name = "IdentityLifecycleError";
	}
}

export class IdentityLifecycle {
	private loading = false;

	constructor(private readonly context: Pick<vscode.ExtensionContext, "secrets" | "globalState">) {}

	public async load(decisions: IdentityDecisions): Promise<LoadedIdentity> {
		if (this.loading) throw this.busyError();
		this.loading = true;
		try {
			await sodium.ready;
			const reset = this.readResetRecord();
			if (reset) {
				const inProgress: ResetRecord = { ...reset, status: "in-progress" };
				if (reset.status === "scheduled") await this.updateState(RESET_PENDING_KEY, inProgress);
				return await this.finishReset(inProgress);
			}

			const recorded = this.readIdentityRecord();
			const secrets = await this.readSecrets();
			this.validateSecrets(secrets);
			let status: IdentityLoadStatus = "existing";
			let identity: EncryptionService;

			if (secrets.bundle !== undefined) {
				identity = await this.loadKeys({ encryption: false, signing: false });
			} else if (secrets.format !== undefined) {
				throw this.unavailableError();
			} else if (recorded && (secrets.encryption === undefined || secrets.signing === undefined)) {
				throw this.unavailableError();
			} else if (secrets.encryption === undefined && secrets.signing === undefined) {
				await this.requireConfirmation(decisions.confirmNewIdentity);
				await this.assertSnapshotUnchanged(secrets);
				identity = await this.storeKeys();
				status = "created";
			} else if (!recorded && secrets.encryption !== undefined && secrets.signing === undefined) {
				await this.requireConfirmation(decisions.confirmSigningKeyCreation);
				await this.assertSnapshotUnchanged(secrets);
				identity = await this.storeKeys({ encryption: secrets.encryption });
				status = "signing-key-created";
			} else if (secrets.encryption === undefined || secrets.signing === undefined) {
				throw this.unavailableError();
			} else {
				identity = await this.loadKeys({ encryption: false, signing: false });
			}

			await this.assertPersistedIdentity(identity);
			const currentRecord = this.readIdentityRecord();
			if (recorded?.fingerprint !== currentRecord?.fingerprint) throw this.mismatchError();
			if (currentRecord && currentRecord.fingerprint !== identity.fingerprint) {
				const accepted = await this.confirmIdentityChange(
					decisions.confirmIdentityChange,
					currentRecord.fingerprint,
					identity.fingerprint
				);
				if (!accepted) throw this.mismatchError();
				await this.assertPersistedIdentity(identity);
				if (this.readIdentityRecord()?.fingerprint !== currentRecord.fingerprint) throw this.mismatchError();
				status = "identity-changed";
			}

			if (!currentRecord || currentRecord.fingerprint !== identity.fingerprint) {
				await this.updateState(IDENTITY_STATE_KEY, { version: 1, fingerprint: identity.fingerprint });
			}
			if (secrets.bundle !== undefined || status === "created" || status === "signing-key-created") {
				await this.ensureBundleFormat();
				await this.removeLegacySecrets();
			}
			return { identity, status };
		} finally {
			this.loading = false;
		}
	}

	public resetStatus(): ResetStatus {
		return this.readResetRecord()?.status ?? "none";
	}

	public isResetPending(): boolean {
		return this.resetStatus() !== "none";
	}

	public async currentFingerprintForReset(): Promise<string | null> {
		if (this.loading) throw this.busyError();
		await sodium.ready;
		return this.fingerprintIfUsable(await this.readSecrets());
	}

	public async scheduleReset(expectedFingerprint: string | null): Promise<void> {
		if (this.loading) throw this.busyError();
		this.assertNoPendingReset();
		const previousFingerprint = await this.currentFingerprintForReset();
		if (previousFingerprint !== expectedFingerprint) throw this.resetConflictError();
		this.assertNoPendingReset();
		const reset: ResetRecord = {
			version: 1,
			status: "scheduled",
			id: randomUUID(),
			previousFingerprint,
		};
		await this.updateState(RESET_PENDING_KEY, reset);
	}

	private assertNoPendingReset(): void {
		try {
			const pending = this.readResetRecord();
			if (pending) {
				throw new IdentityLifecycleError(
					pending.status === "in-progress" ? "RESET_INCOMPLETE" : "RESET_ALREADY_SCHEDULED",
					pending.status === "in-progress"
						? "An identity reset has already started. Reload VS Code to finish it."
						: "An identity reset is already scheduled. Run Dev Chat: Reset Identity to review or cancel it."
				);
			}
		} catch (error) {
			if (!(error instanceof IdentityLifecycleError) || error.code !== "METADATA_CORRUPT") throw error;
		}
	}

	public async cancelReset(): Promise<void> {
		if (this.loading) throw this.busyError();
		if (this.resetStatus() === "in-progress") {
			throw new IdentityLifecycleError(
				"RESET_INCOMPLETE",
				"The identity reset has started and cannot be safely canceled. Reload VS Code to finish it."
			);
		}
		await this.updateState(RESET_PENDING_KEY, undefined);
	}

	private async finishReset(reset: ResetRecord): Promise<LoadedIdentity> {
		try {
			const current = await this.readSecrets();
			const bundle = current.bundle === undefined ? undefined : parseIdentityKeyBundle(current.bundle);
			let identity: EncryptionService;
			if (bundle?.resetId === reset.id) {
				if (current.format !== IDENTITY_FORMAT_VALUE) await this.repairFormatForReset();
				identity = await this.loadKeys({ encryption: false, signing: false });
			} else {
				const allowPendingLegacy = reset.previousFingerprint !== null &&
					current.bundle === undefined && current.format === IDENTITY_FORMAT_VALUE;
				if (this.fingerprintIfUsable(current, allowPendingLegacy) !== reset.previousFingerprint) {
					await this.abortConflictingReset();
				}
				identity = await this.storeKeys({ resetId: reset.id });
			}

			const persisted = await this.readSecrets();
			if (persisted.bundle === undefined || parseIdentityKeyBundle(persisted.bundle)?.resetId !== reset.id) {
				await this.abortConflictingReset();
			}
			await this.assertPersistedIdentity(identity);
			await this.ensureBundleFormat();
			await this.removeLegacySecrets();
			await this.updateState(IDENTITY_STATE_KEY, { version: 1, fingerprint: identity.fingerprint });
			await this.updateState(RESET_PENDING_KEY, undefined);
			return { identity, status: "reset" };
		} catch (error) {
			if (error instanceof IdentityLifecycleError && error.code === "RESET_CONFLICT") throw error;
			throw new IdentityLifecycleError(
				"RESET_INCOMPLETE",
				"Dev Chat could not finish the confirmed identity reset. The shared keys may already have changed, and old keys may still be stored. Reload VS Code to retry; the reset cannot be safely canceled after it has started."
			);
		}
	}

	private async abortConflictingReset(): Promise<never> {
		await this.updateState(RESET_PENDING_KEY, undefined);
		throw this.resetConflictError();
	}

	private resetConflictError(): IdentityLifecycleError {
		return new IdentityLifecycleError(
			"RESET_CONFLICT",
			"The shared Dev Chat identity changed while this reset was being confirmed or was pending. No further reset was applied. Reload and review the current identity before using it."
		);
	}

	private async assertPersistedIdentity(identity: EncryptionService): Promise<void> {
		const persisted = await this.loadKeys({ encryption: false, signing: false });
		if (persisted.fingerprint !== identity.fingerprint) throw this.mismatchError();
	}

	private async assertSnapshotUnchanged(expected: SecretSnapshot): Promise<void> {
		const current = await this.readSecrets();
		if (current.bundle !== expected.bundle || current.format !== expected.format || current.encryption !== expected.encryption ||
			current.signing !== expected.signing) {
			throw this.mismatchError();
		}
	}

	private async loadKeys(creation: KeyCreationPolicy): Promise<EncryptionService> {
		try {
			return await EncryptionService.load(this.context, creation);
		} catch {
			throw this.secretStorageError();
		}
	}

	private async storeKeys(options: { encryption?: string; resetId?: string } = {}): Promise<EncryptionService> {
		try {
			return await EncryptionService.storeIdentity(this.context, options);
		} catch {
			throw this.secretStorageError();
		}
	}

	private async readSecrets(): Promise<SecretSnapshot> {
		try {
			const [bundle, format] = await Promise.all([
				this.context.secrets.get(IDENTITY_BUNDLE_SECRET),
				this.context.secrets.get(IDENTITY_FORMAT_SECRET),
			]);
			if (bundle !== undefined) return { bundle, format, encryption: undefined, signing: undefined };
			const [encryption, signing] = await Promise.all([
				this.context.secrets.get(PRIVATE_KEY_SECRET),
				this.context.secrets.get(SIGNING_SEED_SECRET),
			]);
			return { bundle, format, encryption, signing };
		} catch {
			throw this.secretStorageError();
		}
	}

	private validateSecrets(secrets: SecretSnapshot): void {
		if (secrets.format !== undefined && secrets.format !== IDENTITY_FORMAT_VALUE) {
			throw this.corruptError();
		}
		if (secrets.bundle !== undefined) {
			if (parseIdentityKeyBundle(secrets.bundle)) return;
		} else if (secrets.format !== undefined) {
			return;
		} else if ([secrets.encryption, secrets.signing].every((value) =>
			value === undefined || this.isValidSecret(value)
		)) {
			return;
		}
		throw this.corruptError();
	}

	private isValidSecret(value: string): boolean {
		const decoded = decodeCanonicalBase64(value, 32);
		if (!decoded) return false;
		decoded.fill(0);
		return true;
	}

	private fingerprintIfUsable(secrets: SecretSnapshot, allowPendingLegacy = false): string | null {
		if (secrets.bundle !== undefined) {
			const bundle = parseIdentityKeyBundle(secrets.bundle);
			return bundle ? EncryptionService.fromKeyBundle(bundle).fingerprint : null;
		}
		if (secrets.format === IDENTITY_FORMAT_VALUE && !allowPendingLegacy) {
			return null;
		}
		if (secrets.encryption === undefined || secrets.signing === undefined ||
			!this.isValidSecret(secrets.encryption) || !this.isValidSecret(secrets.signing)) {
			return null;
		}
		return EncryptionService.fromKeyBundle({
			version: 1, encryption: secrets.encryption, signing: secrets.signing,
		}).fingerprint;
	}

	private async repairFormatForReset(): Promise<void> {
		try {
			await this.context.secrets.store(IDENTITY_FORMAT_SECRET, IDENTITY_FORMAT_VALUE);
		} catch {
			throw this.secretStorageError();
		}
	}

	private async ensureBundleFormat(): Promise<void> {
		try {
			const format = await this.context.secrets.get(IDENTITY_FORMAT_SECRET);
			if (format === undefined) await this.context.secrets.store(IDENTITY_FORMAT_SECRET, IDENTITY_FORMAT_VALUE);
			else if (format !== IDENTITY_FORMAT_VALUE) throw this.corruptError();
		} catch (error) {
			if (error instanceof IdentityLifecycleError) throw error;
			throw this.secretStorageError();
		}
	}

	private async removeLegacySecrets(): Promise<void> {
		try {
			for (const key of [PRIVATE_KEY_SECRET, SIGNING_SEED_SECRET]) {
				if (await this.context.secrets.get(key) !== undefined) await this.context.secrets.delete(key);
			}
		} catch {
			throw new IdentityLifecycleError(
				"SECRET_STORAGE_ERROR",
				"Dev Chat could not remove old identity keys from VS Code SecretStorage. Reload to retry; no identity was activated in this window."
			);
		}
	}

	private readIdentityRecord(): IdentityRecord | undefined {
		let value: unknown;
		try {
			value = this.context.globalState.get<unknown>(IDENTITY_STATE_KEY);
		} catch {
			throw this.stateError();
		}
		if (value === undefined) return undefined;
		if (!value || typeof value !== "object" || Array.isArray(value)) throw this.metadataError();
		const record = value as Record<string, unknown>;
		if (record.version !== 1 || typeof record.fingerprint !== "string" || !this.isFingerprint(record.fingerprint)) {
			throw this.metadataError();
		}
		return { version: 1, fingerprint: record.fingerprint };
	}

	private readResetRecord(): ResetRecord | undefined {
		let value: unknown;
		try {
			value = this.context.globalState.get<unknown>(RESET_PENDING_KEY);
		} catch {
			throw this.stateError();
		}
		if (value === undefined || value === false) return undefined;
		if (!value || typeof value !== "object" || Array.isArray(value)) throw this.resetMetadataError();
		const record = value as Record<string, unknown>;
		if (
			record.version !== 1 ||
			(record.status !== "scheduled" && record.status !== "in-progress") ||
			!isIdentityResetId(record.id) ||
			(record.previousFingerprint !== null &&
				(typeof record.previousFingerprint !== "string" || !this.isFingerprint(record.previousFingerprint)))
		) throw this.resetMetadataError();
		return {
			version: 1,
			status: record.status,
			id: record.id,
			previousFingerprint: record.previousFingerprint,
		};
	}

	private isFingerprint(value: string): boolean {
		return /^([0-9A-F]{4} ){9}[0-9A-F]{4}$/.test(value);
	}

	private async requireConfirmation(confirm: () => Promise<boolean>): Promise<void> {
		let accepted: boolean;
		try {
			accepted = await confirm();
		} catch {
			throw new IdentityLifecycleError(
				"CONFIRMATION_FAILED",
				"Dev Chat could not request identity confirmation. No identity was activated; reload to try again."
			);
		}
		if (!accepted) {
			throw new IdentityLifecycleError(
				"SETUP_CANCELLED",
				"Dev Chat identity setup was canceled. No new keys were created. Restore your original secrets if available, or reload to try again."
			);
		}
	}

	private async confirmIdentityChange(
		confirm: IdentityDecisions["confirmIdentityChange"],
		previous: string,
		current: string
	): Promise<boolean> {
		try {
			return await confirm(previous, current);
		} catch {
			throw new IdentityLifecycleError(
				"CONFIRMATION_FAILED",
				"Dev Chat could not request identity review. No identity was activated; reload to try again."
			);
		}
	}

	private async updateState(key: string, value: unknown): Promise<void> {
		try {
			await this.context.globalState.update(key, value);
		} catch {
			throw this.stateError();
		}
	}

	private secretStorageError(): IdentityLifecycleError {
		return new IdentityLifecycleError(
			"SECRET_STORAGE_ERROR",
			"Dev Chat could not read or write its identity keys in VS Code SecretStorage. Check secret storage and reload; no identity was activated in this window."
		);
	}

	private unavailableError(): IdentityLifecycleError {
		return new IdentityLifecycleError(
			"IDENTITY_UNAVAILABLE",
			"Dev Chat identity keys are missing or incomplete. Restore the original VS Code SecretStorage if available, or use Dev Chat: Reset Identity to create a different identity. Existing keys were not changed."
		);
	}

	private corruptError(): IdentityLifecycleError {
		return new IdentityLifecycleError(
			"IDENTITY_CORRUPT",
			"A Dev Chat identity key or storage marker is invalid. No keys were replaced. Restore the original VS Code SecretStorage if available, or use Dev Chat: Reset Identity."
		);
	}

	private stateError(): IdentityLifecycleError {
		return new IdentityLifecycleError(
			"IDENTITY_STATE_ERROR",
			"Dev Chat could not read or save its identity state. Check VS Code profile storage and reload; no identity was activated in this window."
		);
	}

	private metadataError(): IdentityLifecycleError {
		return new IdentityLifecycleError(
			"METADATA_CORRUPT",
			"Dev Chat's saved identity fingerprint is invalid. Identity data was left untouched. Restore the VS Code profile if available, or use Dev Chat: Reset Identity."
		);
	}

	private resetMetadataError(): IdentityLifecycleError {
		return new IdentityLifecycleError(
			"METADATA_CORRUPT",
			"Dev Chat's identity reset state is invalid. Restore the VS Code profile if available, or confirm a new identity reset."
		);
	}

	private mismatchError(): IdentityLifecycleError {
		return new IdentityLifecycleError(
			"IDENTITY_MISMATCH",
			"Dev Chat's shared identity differs from the previously recorded fingerprint, or changed during setup. No keys were replaced. Reload to review the current identity, or restore the original secrets."
		);
	}

	private busyError(): IdentityLifecycleError {
		return new IdentityLifecycleError(
			"IDENTITY_BUSY",
			"Dev Chat is still initializing its identity. Finish setup before changing it."
		);
	}
}
