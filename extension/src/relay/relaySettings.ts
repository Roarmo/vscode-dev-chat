import { isLoopbackHost } from "../../../shared/networkAddress";
import { normalizeFingerprint } from "../../../shared/relayCertificate";

export const DEFAULT_RELAY_URL = "ws://127.0.0.1:8787";
export const DEFAULT_HOST_RELAY_PORT = 8787;

const PIN_PARAMETER = "sha256";

export interface ParsedRelayUrl {
    /** Normalized URL, including the certificate pin fragment when present. */
    url: string;
    /** URL the WebSocket connects to. The pin fragment is never sent to the relay. */
    connectUrl: string;
    secure: boolean;
    /** Pinned SHA-256 certificate fingerprint, uppercase hex with colons. */
    fingerprint?: string;
}

export type RelayUrlValidation =
    | ({ ok: true } & ParsedRelayUrl)
    | { ok: false; code: "INVALID_URL" | "INSECURE_URL"; error: string };

/**
 * Validates a relay URL such as `wss://192.168.1.20:8787#sha256=AB:CD:...`.
 * Plain `ws://` is accepted only for relays on this computer.
 */
export function validateRelayUrl(raw: unknown): RelayUrlValidation {
    if (typeof raw !== "string" || raw.trim() === "") {
        return { ok: false, code: "INVALID_URL", error: "Relay URL is empty." };
    }

    let parsed: URL;
    try {
        parsed = new URL(raw.trim());
    } catch {
        return { ok: false, code: "INVALID_URL", error: "Relay URL is not a valid URL." };
    }

    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
        return { ok: false, code: "INVALID_URL", error: "Relay URL must start with wss:// or ws://." };
    }

    if (!parsed.hostname) {
        return { ok: false, code: "INVALID_URL", error: "Relay URL is missing a host name." };
    }

    if (parsed.username || parsed.password) {
        return { ok: false, code: "INVALID_URL", error: "Relay URL must not contain a user name or password." };
    }

    const secure = parsed.protocol === "wss:";
    if (!secure && !isLoopbackHost(parsed.hostname)) {
        return {
            ok: false,
            code: "INSECURE_URL",
            error: "Unencrypted ws:// is only allowed for a relay on this computer. Use the pinned wss:// address shared by the relay host.",
        };
    }

    let fingerprint: string | undefined;
    if (parsed.hash) {
        const fragment = parsed.hash.slice(1);
        const separator = fragment.indexOf("=");
        const name = separator === -1 ? "" : fragment.slice(0, separator).toLowerCase();
        let value = "";
        try {
            value = separator === -1 ? "" : decodeURIComponent(fragment.slice(separator + 1));
        } catch {
            value = "";
        }
        if (name !== PIN_PARAMETER) {
            return { ok: false, code: "INVALID_URL", error: `Relay URL fragment must be #${PIN_PARAMETER}=<certificate fingerprint>.` };
        }
        fingerprint = normalizeFingerprint(value);
        if (!fingerprint) {
            return { ok: false, code: "INVALID_URL", error: "The certificate fingerprint in the relay URL is not a valid SHA-256 fingerprint (64 hex characters)." };
        }
        if (!secure) {
            return { ok: false, code: "INVALID_URL", error: "A certificate fingerprint only applies to wss:// relay URLs." };
        }
        parsed.hash = "";
    }

    const connectUrl = parsed.toString().replace(/\/$/, "");
    return {
        ok: true,
        url: fingerprint ? `${connectUrl}#${PIN_PARAMETER}=${fingerprint}` : connectUrl,
        connectUrl,
        secure,
        ...(fingerprint ? { fingerprint } : {}),
    };
}

/** Builds a shareable relay URL that pins the given certificate fingerprint. */
export function formatPinnedRelayUrl(host: string, port: number, fingerprint: string): string {
    const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    return `wss://${formattedHost}:${port}#${PIN_PARAMETER}=${fingerprint}`;
}

export function validateHostRelayPort(raw: unknown): number | undefined {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 65535) {
        return undefined;
    }
    return raw;
}
