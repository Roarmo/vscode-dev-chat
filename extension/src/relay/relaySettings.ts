export const DEFAULT_RELAY_URL = "ws://127.0.0.1:8787";
export const DEFAULT_HOST_RELAY_PORT = 8787;

export type RelayUrlValidation =
    | { ok: true; url: string }
    | { ok: false; error: string };

export function validateRelayUrl(raw: unknown): RelayUrlValidation {
    if (typeof raw !== "string" || raw.trim() === "") {
        return { ok: false, error: "Relay URL is empty." };
    }

    let parsed: URL;
    try {
        parsed = new URL(raw.trim());
    } catch {
        return { ok: false, error: `"${raw}" is not a valid URL.` };
    }

    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
        return { ok: false, error: `Relay URL must start with ws:// or wss:// (got ${parsed.protocol}//).` };
    }

    if (!parsed.hostname) {
        return { ok: false, error: "Relay URL is missing a host name." };
    }

    if (parsed.username || parsed.password) {
        return { ok: false, error: "Relay URL must not contain a user name or password." };
    }

    return { ok: true, url: parsed.toString().replace(/\/$/, "") };
}

export function validateHostRelayPort(raw: unknown): number | undefined {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 65535) {
        return undefined;
    }
    return raw;
}
