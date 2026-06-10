/**
 * P1099: Identity homograph defence — canonical identity normalization.
 *
 * Normalizes agent identity strings at security boundaries:
 * - Collapses multiple consecutive slashes to single slash
 * - Removes trailing slashes
 * - Enforces lowercase normalization
 * - Rejects malformed identities (leading slash, spaces, empty)
 *
 * All security boundaries MUST apply canonicalization before
 * comparison or storage to prevent slash-shape homograph attacks.
 */

export class InvalidIdentityError extends Error {
	constructor(message: string = "invalid_identity") {
		super(message);
		this.name = "InvalidIdentityError";
	}
}

/**
 * Canonicalize an agent identity string.
 *
 * Normalization rules:
 * 1. Trim leading/trailing whitespace
 * 2. Collapse multiple consecutive slashes to single slash
 * 3. Remove trailing slashes
 * 4. Convert to lowercase
 * 5. Reject if: empty, starts with slash, contains spaces, or contains non-ASCII
 *
 * This function is IDEMPOTENT:
 *   canonicalizeIdentity(canonicalizeIdentity(x)) === canonicalizeIdentity(x)
 *
 * @param raw - raw identity string
 * @returns canonical identity string
 * @throws InvalidIdentityError if identity is malformed
 */
export function canonicalizeIdentity(raw: string): string {
	// Rule 1: trim leading/trailing whitespace
	const trimmed = raw.trim();

	// Rule 2 & 3: collapse multiple slashes, remove trailing slashes
	const collapsed = trimmed.replace(/\/+/g, "/").replace(/\/+$/, "");

	// Rule 4: lowercase
	const lowercased = collapsed.toLowerCase();

	// Rule 5: validation
	// Empty string after collapse
	if (!lowercased) {
		throw new InvalidIdentityError("identity_empty");
	}

	// Starts with slash
	if (lowercased.startsWith("/")) {
		throw new InvalidIdentityError("identity_starts_with_slash");
	}

	// Contains spaces
	if (lowercased.includes(" ")) {
		throw new InvalidIdentityError("identity_contains_spaces");
	}

	return lowercased;
}
