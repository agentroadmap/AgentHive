/**
 * P836: SSRF-Safe Callback URL Validator
 *
 * Validates callback URLs for cross-host message delivery with protection against:
 * 1. SSRF attacks (blocks private/link-local IP ranges)
 * 2. DNS rebinding attacks (re-validates before every POST)
 * 3. Invalid schemes (requires https in production)
 *
 * Uses pure Node.js net module for IP validation (no external dependencies).
 */

import { URL } from "url";
import { resolve4, resolve6 } from "dns/promises";
import net from "net";

/**
 * IPv4 and IPv6 ranges that are blocked for callback delivery.
 * These include:
 * - Private (RFC 1918): 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 * - Loopback (RFC 5735): 127.0.0.0/8, ::1/128
 * - Link-local (RFC 3927): 169.254.0.0/16, fe80::/10
 */
const BLOCKED_RANGES: { range: string; type: "ipv4" | "ipv6" }[] = [
	// IPv4 private and reserved ranges
	{ range: "10.0.0.0/8", type: "ipv4" },
	{ range: "172.16.0.0/12", type: "ipv4" },
	{ range: "192.168.0.0/16", type: "ipv4" },
	{ range: "127.0.0.0/8", type: "ipv4" },
	{ range: "169.254.0.0/16", type: "ipv4" },
	// IPv6 private and reserved ranges
	{ range: "::1/128", type: "ipv6" },
	{ range: "fe80::/10", type: "ipv6" },
];

/**
 * Parse CIDR notation (e.g., "10.0.0.0/8") into network and prefix.
 */
function parseCIDR(cidr: string): { network: string; prefix: number } {
	const [network, prefixStr] = cidr.split("/");
	const prefix = parseInt(prefixStr, 10);
	if (!network || isNaN(prefix)) {
		throw new Error(`Invalid CIDR notation: ${cidr}`);
	}
	return { network, prefix };
}

/**
 * Check if an IPv4 address matches a CIDR range.
 */
function ipv4InRange(ip: string, cidr: string): boolean {
	try {
		const { network, prefix } = parseCIDR(cidr);
		const ipParts = ip.split(".").map((x) => parseInt(x, 10));
		const netParts = network.split(".").map((x) => parseInt(x, 10));

		if (ipParts.length !== 4 || netParts.length !== 4) {
			return false;
		}

		// Convert to 32-bit integers
		const ipNum =
			(ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3];
		const netNum =
			(netParts[0] << 24) | (netParts[1] << 16) | (netParts[2] << 8) | netParts[3];

		// Create mask
		const mask = prefix === 0 ? 0 : 0xffffffff ^ ((1 << (32 - prefix)) - 1);

		return (ipNum & mask) === (netNum & mask);
	} catch {
		return false;
	}
}

/**
 * Check if an IPv6 address matches a CIDR range.
 * Uses BigInt for 128-bit arithmetic.
 */
function ipv6InRange(ip: string, cidr: string): boolean {
	try {
		const { network, prefix } = parseCIDR(cidr);

		// Parse IPv6 addresses to BigInt
		const ipNum = ipv6ToBigInt(ip);
		const netNum = ipv6ToBigInt(network);

		if (ipNum === null || netNum === null) {
			return false;
		}

		// Create 128-bit mask
		const mask =
			prefix === 0
				? 0n
				: (0xffffffffffffffffffffffffffffffffn ^
						((1n << BigInt(128 - prefix)) - 1n));

		return (ipNum & mask) === (netNum & mask);
	} catch {
		return false;
	}
}

/**
 * Convert an IPv6 address string to BigInt for CIDR matching.
 * Handles both full and compressed formats.
 *
 * Uses simple hex parsing for well-formed addresses.
 * This is a simplified implementation that handles common cases.
 */
function ipv6ToBigInt(addr: string): bigint | null {
	try {
		// Handle IPv4-mapped addresses
		if (addr.startsWith("::ffff:")) {
			const ipv4Part = addr.substring(7);
			if (net.isIPv4(ipv4Part)) {
				// Convert to IPv4-mapped IPv6: ::ffff:x.x.x.x -> 0x0000000000000000 0x0000ffff + ipv4bytes
				const ipv4Parts = ipv4Part.split(".").map((x) => parseInt(x, 10));
				const ipv4Num =
					(ipv4Parts[0] << 24) |
					(ipv4Parts[1] << 16) |
					(ipv4Parts[2] << 8) |
					ipv4Parts[3];
				return BigInt("0xffff") << 32n | BigInt(ipv4Num);
			}
		}

		// Simple validation for IPv6 format (must contain colons)
		if (!addr.includes(":")) {
			return null;
		}

		// For simplicity, try to parse using JavaScript's address validation
		// Full IPv6 parsing is complex; we'll use a regex-based approach for common cases

		// Allow loopback and link-local without full expansion
		if (addr === "::1" || addr === "fe80::1") {
			// Parse using a simple approach for common values
			if (addr === "::1") {
				return 1n; // Loopback
			}
			if (addr === "fe80::1") {
				return BigInt("0xfe800000000000000000000000000001");
			}
		}

		// For other addresses, we need proper parsing
		// This is a simplified version that handles compressed notation
		const parts = addr.split(":").filter((x) => x.length > 0);

		// If the address starts/ends with ::, we need to expand it
		const doubleColon = addr.indexOf("::");
		if (doubleColon !== -1) {
			// Compressed notation — expand zeros
			const before = addr.substring(0, doubleColon).split(":").filter((x) => x);
			const after = addr
				.substring(doubleColon + 2)
				.split(":")
				.filter((x) => x);
			const zeros = 8 - before.length - after.length;

			if (zeros < 0) {
				return null; // Invalid
			}

			const all = [...before, ...Array(zeros).fill("0"), ...after];
			return parseIPv6Parts(all);
		} else {
			// Full notation (no compression)
			if (parts.length !== 8) {
				return null;
			}
			return parseIPv6Parts(parts);
		}
	} catch {
		return null;
	}
}

/**
 * Helper: Parse 8 hex groups into a BigInt.
 */
function parseIPv6Parts(parts: string[]): bigint | null {
	try {
		let result = 0n;
		for (const part of parts) {
			const val = parseInt(part || "0", 16);
			if (isNaN(val) || val < 0 || val > 0xffff) {
				return null;
			}
			result = (result << 16n) | BigInt(val);
		}
		return result;
	} catch {
		return null;
	}
}

/**
 * Check if an IP address is in any blocked range.
 */
function isAddressBlocked(ip: string, allowlistCIDR?: string[]): boolean {
	// Check blocked ranges
	for (const { range, type } of BLOCKED_RANGES) {
		const isBlocked =
			type === "ipv4" ? ipv4InRange(ip, range) : ipv6InRange(ip, range);
		if (isBlocked) {
			return true;
		}
	}

	// If allowlist is configured, ensure IP is in it
	if (allowlistCIDR && allowlistCIDR.length > 0) {
		for (const cidr of allowlistCIDR) {
			const isAllowed = cidr.includes(":")
				? ipv6InRange(ip, cidr)
				: ipv4InRange(ip, cidr);
			if (isAllowed) {
				return false; // IP is in allowlist
			}
		}
		// IP is not in allowlist
		return true;
	}

	return false;
}

/**
 * Normalize an IPv6 address to canonical form.
 * Handles IPv4-mapped IPv6 addresses (::ffff:127.0.0.1 → 127.0.0.1).
 */
function normalizeIP(ip: string): string {
	// Handle IPv4-mapped IPv6 addresses
	if (ip.startsWith("::ffff:")) {
		const ipv4Part = ip.substring(7);
		// Verify it's a valid IPv4
		if (net.isIPv4(ipv4Part)) {
			return ipv4Part;
		}
	}
	return ip;
}

/**
 * Validate a callback URL for SSRF safety.
 * Throws if the URL is invalid, uses http in production, or resolves to a blocked IP.
 *
 * @param url - Callback URL to validate (should be https://)
 * @param isDevMode - If true, allows http:// URLs (defaults to process.env.NODE_ENV !== 'production')
 * @throws {Error} if validation fails
 */
export async function validateCallbackUrl(
	url: string,
	isDevMode?: boolean,
): Promise<void> {
	const devMode =
		isDevMode !== undefined
			? isDevMode
			: process.env.NODE_ENV !== "production";

	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch (err) {
		throw new Error(`Invalid callback URL: ${err instanceof Error ? err.message : String(err)}`);
	}

	// Validate scheme
	if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
		throw new Error(
			`Invalid scheme: ${parsedUrl.protocol} (only http and https allowed)`,
		);
	}

	if (parsedUrl.protocol === "http:" && !devMode) {
		throw new Error(
			"HTTP callback URLs not allowed in production — must use HTTPS",
		);
	}

	// Resolve hostname to IP addresses
	const hostname = parsedUrl.hostname;
	if (!hostname) {
		throw new Error("Callback URL has no hostname");
	}

	// Skip validation for localhost in dev mode
	if (devMode && (hostname === "localhost" || hostname === "127.0.0.1")) {
		return;
	}

	const allowlistCIDRStr = process.env.CALLBACK_URL_ALLOWLIST_CIDR;
	const allowlistCIDR = allowlistCIDRStr
		? allowlistCIDRStr.split(",").map((s) => s.trim())
		: undefined;

	// Resolve IPv4 addresses
	let resolvedIPv4: string[] = [];
	try {
		resolvedIPv4 = await resolve4(hostname);
	} catch {
		// IPv4 resolution failed (may be IPv6-only hostname)
	}

	// Resolve IPv6 addresses
	let resolvedIPv6: string[] = [];
	try {
		resolvedIPv6 = await resolve6(hostname);
	} catch {
		// IPv6 resolution failed
	}

	// If no addresses resolved, the hostname is invalid or not resolvable
	if (resolvedIPv4.length === 0 && resolvedIPv6.length === 0) {
		throw new Error(
			`Cannot resolve hostname: ${hostname} (no A or AAAA records)`,
		);
	}

	// Check all resolved IPs against blocked ranges
	for (const ip of resolvedIPv4) {
		const normalized = normalizeIP(ip);
		if (isAddressBlocked(normalized, allowlistCIDR)) {
			throw new Error(
				`Callback URL resolves to blocked IP: ${normalized} (private/reserved range)`,
			);
		}
	}

	for (const ip of resolvedIPv6) {
		const normalized = normalizeIP(ip);
		if (isAddressBlocked(normalized, allowlistCIDR)) {
			throw new Error(
				`Callback URL resolves to blocked IP: ${normalized} (private/reserved range)`,
			);
		}
	}
}

/**
 * Re-validate callback URL immediately before delivery.
 * Prevents DNS rebinding attacks where attacker re-points domain to private IP.
 *
 * Same logic as validateCallbackUrl, called fresh before every POST.
 *
 * @param callbackUrl - Callback URL to re-validate
 * @throws {Error} if validation fails
 */
export async function revalidateBeforeDelivery(
	callbackUrl: string,
): Promise<void> {
	// Re-validate using same function (non-dev mode to be strict)
	await validateCallbackUrl(callbackUrl, false);
}
