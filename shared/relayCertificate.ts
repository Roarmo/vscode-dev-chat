import { X509Certificate, createPrivateKey } from "crypto";

const { generate } = require("selfsigned") as typeof import("selfsigned");

export interface RelayTlsCredentials {
	/** PEM-encoded certificate (may include intermediate certificates after the leaf). */
	cert: string;
	/** PEM-encoded private key. */
	key: string;
}

export interface GeneratedRelayCertificate extends RelayTlsCredentials {
	/** SHA-256 fingerprint as uppercase hex pairs separated by colons. */
	fingerprint: string;
}

export const RELAY_CERTIFICATE_COMMON_NAME = "Dev Chat Relay";
const CERTIFICATE_VALIDITY_YEARS = 10;
const FINGERPRINT_HEX_LENGTH = 64;

/**
 * Creates a self-signed ECDSA P-256 certificate for a relay. Clients trust it
 * by pinning its fingerprint, so the host names it lists are informational.
 */
export async function generateRelayCertificate(): Promise<GeneratedRelayCertificate> {
	const notBeforeDate = new Date(Date.now() - 60 * 60 * 1000);
	const notAfterDate = new Date(notBeforeDate);
	notAfterDate.setFullYear(notAfterDate.getFullYear() + CERTIFICATE_VALIDITY_YEARS);

	const generated = await generate([{ name: "commonName", value: RELAY_CERTIFICATE_COMMON_NAME }], {
		keyType: "ec",
		curve: "P-256",
		algorithm: "sha256",
		notBeforeDate,
		notAfterDate,
		extensions: [
			{ name: "basicConstraints", cA: false },
			{ name: "keyUsage", digitalSignature: true, critical: true },
			{ name: "extKeyUsage", serverAuth: true },
			{
				name: "subjectAltName",
				altNames: [
					{ type: 2, value: "localhost" },
					{ type: 7, ip: "127.0.0.1" },
					{ type: 7, ip: "::1" },
				],
			},
		],
	});

	return {
		cert: generated.cert,
		key: generated.private,
		fingerprint: getCertificateFingerprint(generated.cert),
	};
}

/** SHA-256 fingerprint of the first (leaf) certificate in a PEM string. */
export function getCertificateFingerprint(certificatePem: string): string {
	return new X509Certificate(certificatePem).fingerprint256;
}

/**
 * Parses a SHA-256 fingerprint written with or without colons or spaces, in any
 * letter case. Returns it as uppercase colon-separated hex, or undefined if invalid.
 */
export function normalizeFingerprint(raw: string): string | undefined {
	const hex = raw.replace(/[\s:]/g, "").toUpperCase();
	if (hex.length !== FINGERPRINT_HEX_LENGTH || !/^[0-9A-F]+$/.test(hex)) return undefined;
	return hex.match(/../g)!.join(":");
}

export function fingerprintsMatch(a: string, b: string): boolean {
	const left = normalizeFingerprint(a);
	return left !== undefined && left === normalizeFingerprint(b);
}

/**
 * Throws if the certificate or key cannot be parsed, the key does not belong to
 * the certificate, or the certificate has expired.
 */
export function assertValidRelayCredentials(credentials: RelayTlsCredentials): void {
	const certificate = new X509Certificate(credentials.cert);
	const key = createPrivateKey(credentials.key);
	if (!certificate.checkPrivateKey(key)) {
		throw new Error("The relay private key does not match its certificate.");
	}
	if (new Date(certificate.validTo).getTime() <= Date.now()) {
		throw new Error(`The relay certificate expired on ${certificate.validTo}.`);
	}
}
