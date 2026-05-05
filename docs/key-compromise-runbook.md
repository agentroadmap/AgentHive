# Key Compromise Runbook — P472

**SLA: complete within 15 minutes of detection** (AC#102)

This runbook covers the mandatory response procedure when an agency Ed25519
private key is suspected or confirmed to be compromised.

## T+0 — Detection

A key is considered compromised when ANY of the following is observed:

- Private key file found outside expected secure storage (OS keyring / Vault)
- Unauthorized agency action logged with a valid signature
- Vault audit log shows unexpected secret access
- `auditNoplaintextKeys()` scan reports a violation in `key-storage.ts`
- Host intrusion detection alert on the liaison host

**Immediately open an incident.** Declare severity P0. Assign a primary
responder and a secondary for the revocation step.

## T+0 to T+3 — Immediate containment (3 min target)

1. Revoke the compromised agency principal via MCP or direct DB:

   ```sql
   UPDATE roadmap.principal_identity
      SET revoked_at        = now(),
          revocation_reason = 'key_compromise:<brief description>'
    WHERE principal_id = 'agency:<agency_id>'
      AND revoked_at IS NULL;
   ```

   The DB trigger `trg_principal_revocation_cascade` immediately:
   - Sets `revoked_at` on all dependent agent principals.
   - Emits `pg_notify('principal_revoked', ...)` so in-process caches flush
     within 25 seconds.

2. Verify cascade fired:

   ```sql
   SELECT principal_id, revoked_at
     FROM roadmap.principal_identity
    WHERE parent_principal_id = 'agency:<agency_id>';
   ```

   All rows should show `revoked_at IS NOT NULL`.

3. If the liaison process is running, restart it to drop all in-flight agent
   sessions that may hold stale session tokens derived from the compromised key:

   ```bash
   sudo systemctl restart agenthive-liaison
   ```

## T+3 to T+10 — Key rotation (7 min target)

4. Generate a new Ed25519 keypair on the liaison host:

   ```bash
   # Uses the liaison CLI; private key goes directly into secure storage
   agenthive liaison keygen --agency <agency_id> --output-keyring
   ```

   The `--output-keyring` flag stores the private key in the OS keyring via
   `key-storage.ts:OsKeyringStorage`; it is NEVER written to disk.

5. Perform the atomic rotation handshake (AC#100).  Both old-signs-new and
   new-signs-old proofs must pass before the DB accepts the new key:

   ```bash
   agenthive liaison key-rotate \
     --agency <agency_id> \
     --new-public-key <path-to-new-pubkey.pem>
   ```

   Under the hood this calls `PrincipalIdentityStore.rotateAgencyKey()` which
   verifies both signatures before committing.  If you no longer have the old
   private key (because it was compromised), skip to step 6.

6. **If old private key is unavailable** (worst case): an operator with
   `authority` level on the agency scope must perform an emergency re-register:

   ```bash
   agenthive operator emergency-rekey \
     --agency <agency_id> \
     --new-public-key <path-to-new-pubkey.pem> \
     --operator-token <operator_bearer_token>
   ```

   This bypasses the dual-signature check and is only available to operator
   principals.  Every use is logged to `roadmap.audit_log` with
   `action='emergency_rekey'`.

## T+10 to T+15 — Verification and closure (5 min target)

7. Confirm the new key is live:

   ```sql
   SELECT principal_id, public_credential, metadata->>'key_rotated_at'
     FROM roadmap.principal_identity
    WHERE principal_id = 'agency:<agency_id>';
   ```

   `public_credential` must differ from the old key; `key_rotated_at` must be
   populated.

8. Re-spawn any agents that were revoked as part of the cascade.  They will
   receive fresh session tokens derived from the new agency key.

9. Run the plaintext key audit to confirm no private key material remains on
   disk:

   ```bash
   node --import jiti/register scripts/audit-plaintext-keys.ts
   ```

   Must exit 0.

10. Close the incident, post a post-mortem draft within 24 hours.

## Reference: SLA checkpoints

| Checkpoint                     | Target time |
|-------------------------------|-------------|
| Detection → revocation commit  | ≤ 3 min     |
| Revocation → cache flush       | ≤ 30 s (pg_notify + 25s TTL window) |
| New key registered and active  | ≤ 10 min    |
| Audit passes + agents re-spawned | ≤ 15 min  |

The 15-minute SLA is enforced by the incident severity P0 escalation: if any
checkpoint is missed, the incident commander pages the security lead.

## See also

- `src/core/identity/principal-identity.ts` — `rotateAgencyKey()`, revocation
- `src/core/security/key-storage.ts` — `auditNoplaintextKeys()`
- `scripts/audit-plaintext-keys.ts` — standalone audit script
- P472 design doc: `roadmap.principal_identity` schema
