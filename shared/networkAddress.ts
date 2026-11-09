import { BlockList, isIP } from "net";
import { networkInterfaces } from "os";

const localNetworks = new BlockList();
localNetworks.addSubnet("127.0.0.0", 8, "ipv4");
localNetworks.addSubnet("10.0.0.0", 8, "ipv4");
localNetworks.addSubnet("172.16.0.0", 12, "ipv4");
localNetworks.addSubnet("192.168.0.0", 16, "ipv4");
localNetworks.addSubnet("169.254.0.0", 16, "ipv4");
localNetworks.addAddress("::1", "ipv6");
localNetworks.addSubnet("fc00::", 7, "ipv6");
localNetworks.addSubnet("fe80::", 10, "ipv6");

const IPV4_MAPPED_PREFIX = "::ffff:";

/**
 * Normalizes a socket remote address for classification: strips IPv6 zone IDs
 * (fe80::1%eth0) and converts IPv4-mapped IPv6 addresses to plain IPv4.
 */
export function normalizeRemoteAddress(address: string): string {
	let normalized = address.trim().toLowerCase();
	const zoneIndex = normalized.indexOf("%");
	if (zoneIndex !== -1) normalized = normalized.slice(0, zoneIndex);

	if (normalized.startsWith(IPV4_MAPPED_PREFIX)) {
		const embedded = normalized.slice(IPV4_MAPPED_PREFIX.length);
		if (isIP(embedded) === 4) return embedded;

		const hexMatch = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(embedded);
		if (hexMatch && hexMatch[1] && hexMatch[2]) {
			const high = parseInt(hexMatch[1], 16);
			const low = parseInt(hexMatch[2], 16);
			return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
		}
	}

	return normalized;
}

/**
 * True for loopback, private (RFC 1918 / IPv6 ULA) and link-local addresses.
 * Anything else, including unparseable input, is treated as non-local.
 */
export function isLocalNetworkAddress(address: string): boolean {
	const normalized = normalizeRemoteAddress(address);
	const family = isIP(normalized);
	if (family === 4) return localNetworks.check(normalized, "ipv4");
	if (family === 6) return localNetworks.check(normalized, "ipv6");
	return false;
}

function addressPriority(address: string): number {
	if (address.startsWith("192.168.")) return 0;
	if (address.startsWith("10.")) return 1;
	return 2;
}

/**
 * IPv4 addresses of this machine that other devices on the local network can
 * likely reach, ordered so typical home/office LAN addresses come first.
 */
export function getLocalNetworkAddresses(): string[] {
	const addresses = new Set<string>();
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.internal || entry.family !== "IPv4") continue;
			if (entry.address.startsWith("169.254.")) continue;
			if (isLocalNetworkAddress(entry.address)) addresses.add(entry.address);
		}
	}
	return [...addresses].sort((a, b) => addressPriority(a) - addressPriority(b));
}
