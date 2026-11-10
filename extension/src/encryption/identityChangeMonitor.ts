import type * as vscode from "vscode";
import {
	EncryptionService,
	IDENTITY_BUNDLE_SECRET,
	IDENTITY_FORMAT_SECRET,
	PRIVATE_KEY_SECRET,
	SIGNING_SEED_SECRET,
} from "./encryptionService";

const IDENTITY_KEYS = new Set([IDENTITY_BUNDLE_SECRET, IDENTITY_FORMAT_SECRET, PRIVATE_KEY_SECRET, SIGNING_SEED_SECRET]);

export class IdentityChangeMonitor implements vscode.Disposable {
	private readonly subscription: vscode.Disposable;
	private pending: Promise<boolean> | undefined;
	private revision = 0;
	private checkedRevision = -1;
	private invalidated = false;
	private disposed = false;

	constructor(
		private readonly secrets: vscode.SecretStorage,
		private readonly fingerprint: string,
		private readonly onInvalidated: () => void
	) {
		this.subscription = secrets.onDidChange((event) => {
			if (this.disposed || !IDENTITY_KEYS.has(event.key)) return;
			this.revision++;
			void this.check();
		});
	}

	public check(): Promise<boolean> {
		if (this.invalidated || this.disposed) return Promise.resolve(false);
		if (!this.pending) {
			this.pending = this.checkChanges().finally(() => {
				this.pending = undefined;
				if (!this.disposed && !this.invalidated && this.checkedRevision !== this.revision) {
					void this.check();
				}
			});
		}
		return this.pending;
	}

	public dispose(): void {
		this.disposed = true;
		this.subscription.dispose();
	}

	private async checkChanges(): Promise<boolean> {
		do {
			const revision = this.revision;
			try {
				const identity = await EncryptionService.load(
					{ secrets: this.secrets },
					{ encryption: false, signing: false }
				);
				if (this.disposed) return false;
				if (identity.fingerprint !== this.fingerprint) return this.invalidate();
			} catch {
				if (this.disposed) return false;
				return this.invalidate();
			}
			this.checkedRevision = revision;
		} while (this.checkedRevision !== this.revision);
		return true;
	}

	private invalidate(): false {
		this.invalidated = true;
		this.onInvalidated();
		return false;
	}
}
