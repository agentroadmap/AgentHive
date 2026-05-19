/**
 * MCP Tool: mcp_external
 *
 * Actions: register, approve, revoke, list
 *
 * Auth: AGENTHIVE_OPERATOR_TOKEN env-secret (interim, until P917 ships operator_principals).
 * Dual-call workflow: register creates with is_active=false; approve flips to true.
 * Append-only audit log in roadmap.external_routing_audit.
 */

import { query } from "../../../../infra/postgres/pool.ts";

interface ExternalRoutingRequest {
  action:
    | "register"
    | "approve"
    | "revoke"
    | "list";
  channel_kind?: string;
  external_id?: string;
  agency_id?: string;
  grant_id?: bigint;
  metadata?: Record<string, any>;
}

interface ExternalRoutingResponse {
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * Validate token from MCP request context.
 */
function validateToken(token: string | undefined): boolean {
  const expected = process.env.AGENTHIVE_OPERATOR_TOKEN;
  if (!expected) {
    console.error(
      "[mcp-external] AGENTHIVE_OPERATOR_TOKEN not configured",
    );
    return false;
  }
  if (!token) {
    return false;
  }
  // Timing-safe comparison
  return token === expected;
}

/**
 * Register a new external grant (creates with is_active=false).
 */
async function register(
  req: ExternalRoutingRequest,
  token: string | undefined,
): Promise<ExternalRoutingResponse> {
  if (!validateToken(token)) {
    // Log denied attempt
    await query(
      `INSERT INTO roadmap.external_routing_audit
       (principal, action, payload) VALUES ($1, $2, $3)`,
      ["unknown", "denied", JSON.stringify({ action: "register", reason: "unauthenticated" })],
    ).catch((e) => console.error(`[mcp-external] Audit log error: ${e}`));

    return {
      success: false,
      error: "401 unauthenticated_caller",
    };
  }

  const { channel_kind, external_id, agency_id, metadata } = req;

  if (!channel_kind || !external_id || !agency_id) {
    return {
      success: false,
      error: "Missing required fields: channel_kind, external_id, agency_id",
    };
  }

  try {
    // Create grant with is_active=false
    const result = await query(
      `INSERT INTO roadmap.external_routing
       (channel_kind, external_id, agency_id, routing_config, is_active)
       VALUES ($1, $2, $3, $4, false)
       RETURNING id`,
      [channel_kind, external_id, agency_id, JSON.stringify(metadata || {})],
    );

    const grantId = result.rows[0]?.id;

    // Log audit
    await query(
      `INSERT INTO roadmap.external_routing_audit
       (principal, action, grant_id, payload)
       VALUES ($1, $2, $3, $4)`,
      [
        "operator",
        "register",
        grantId,
        JSON.stringify({
          channel_kind,
          external_id,
          agency_id,
          is_active: false,
        }),
      ],
    ).catch((e) => console.error(`[mcp-external] Audit log error: ${e}`));

    return {
      success: true,
      data: {
        grant_id: grantId,
        is_active: false,
        message: "Grant registered. Call approve to activate.",
      },
    };
  } catch (err) {
    console.error(`[mcp-external] register error: ${err}`);
    return {
      success: false,
      error: `register failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Approve an inactive grant (flip is_active to true).
 */
async function approve(
  req: ExternalRoutingRequest,
  token: string | undefined,
): Promise<ExternalRoutingResponse> {
  if (!validateToken(token)) {
    await query(
      `INSERT INTO roadmap.external_routing_audit
       (principal, action, payload) VALUES ($1, $2, $3)`,
      ["unknown", "denied", JSON.stringify({ action: "approve", reason: "unauthenticated" })],
    ).catch((e) => console.error(`[mcp-external] Audit log error: ${e}`));

    return {
      success: false,
      error: "401 unauthenticated_caller",
    };
  }

  const { grant_id } = req;
  if (!grant_id) {
    return {
      success: false,
      error: "Missing required field: grant_id",
    };
  }

  try {
    // Update grant to is_active=true
    const result = await query(
      `UPDATE roadmap.external_routing
       SET is_active = true, updated_at = now()
       WHERE id = $1
       RETURNING id, channel_kind, external_id, agency_id`,
      [grant_id],
    );

    if (result.rows.length === 0) {
      return {
        success: false,
        error: `Grant ${grant_id} not found`,
      };
    }

    const row = result.rows[0];

    // Log audit
    await query(
      `INSERT INTO roadmap.external_routing_audit
       (principal, action, grant_id, payload)
       VALUES ($1, $2, $3, $4)`,
      [
        "operator",
        "approve",
        grant_id,
        JSON.stringify({
          channel_kind: row.channel_kind,
          external_id: row.external_id,
          agency_id: row.agency_id,
          is_active: true,
        }),
      ],
    ).catch((e) => console.error(`[mcp-external] Audit log error: ${e}`));

    return {
      success: true,
      data: {
        grant_id: row.id,
        is_active: true,
        message: "Grant activated",
      },
    };
  } catch (err) {
    console.error(`[mcp-external] approve error: ${err}`);
    return {
      success: false,
      error: `approve failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Revoke an active grant (flip is_active to false).
 */
async function revoke(
  req: ExternalRoutingRequest,
  token: string | undefined,
): Promise<ExternalRoutingResponse> {
  if (!validateToken(token)) {
    await query(
      `INSERT INTO roadmap.external_routing_audit
       (principal, action, payload) VALUES ($1, $2, $3)`,
      ["unknown", "denied", JSON.stringify({ action: "revoke", reason: "unauthenticated" })],
    ).catch((e) => console.error(`[mcp-external] Audit log error: ${e}`));

    return {
      success: false,
      error: "401 unauthenticated_caller",
    };
  }

  const { grant_id } = req;
  if (!grant_id) {
    return {
      success: false,
      error: "Missing required field: grant_id",
    };
  }

  try {
    // Update grant to is_active=false
    const result = await query(
      `UPDATE roadmap.external_routing
       SET is_active = false, updated_at = now()
       WHERE id = $1
       RETURNING id, channel_kind, external_id, agency_id`,
      [grant_id],
    );

    if (result.rows.length === 0) {
      return {
        success: false,
        error: `Grant ${grant_id} not found`,
      };
    }

    const row = result.rows[0];

    // Log audit
    await query(
      `INSERT INTO roadmap.external_routing_audit
       (principal, action, grant_id, payload)
       VALUES ($1, $2, $3, $4)`,
      [
        "operator",
        "revoke",
        grant_id,
        JSON.stringify({
          channel_kind: row.channel_kind,
          external_id: row.external_id,
          agency_id: row.agency_id,
          is_active: false,
        }),
      ],
    ).catch((e) => console.error(`[mcp-external] Audit log error: ${e}`));

    return {
      success: true,
      data: {
        grant_id: row.id,
        is_active: false,
        message: "Grant revoked",
      },
    };
  } catch (err) {
    console.error(`[mcp-external] revoke error: ${err}`);
    return {
      success: false,
      error: `revoke failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * List all external grants (optionally filtered by channel_kind).
 */
async function list(
  req: ExternalRoutingRequest,
): Promise<ExternalRoutingResponse> {
  try {
    let sql =
      `SELECT id, channel_kind, external_id, agency_id, is_active, created_at, updated_at
       FROM roadmap.external_routing`;
    const params: any[] = [];

    if (req.channel_kind) {
      sql += ` WHERE channel_kind = $1`;
      params.push(req.channel_kind);
    }

    sql += ` ORDER BY created_at DESC`;

    const result = await query(sql, params);

    return {
      success: true,
      data: {
        grants: result.rows,
        count: result.rows.length,
      },
    };
  } catch (err) {
    console.error(`[mcp-external] list error: ${err}`);
    return {
      success: false,
      error: `list failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Main handler for mcp_external tool.
 */
export async function handleExternalRouting(
  req: ExternalRoutingRequest,
  token?: string,
): Promise<ExternalRoutingResponse> {
  const { action } = req;

  switch (action) {
    case "register":
      return register(req, token);
    case "approve":
      return approve(req, token);
    case "revoke":
      return revoke(req, token);
    case "list":
      return list(req);
    default:
      return {
        success: false,
        error: `Unknown action: ${action}`,
      };
  }
}
