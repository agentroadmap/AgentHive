import { Pool } from "pg";

const pool = new Pool({
  host: "127.0.0.1",
  user: "admin",
  password: "YMA3peHGLi6shUTr",
  database: "agenthive",
});

async function test() {
  // Insert flag with override
  await pool.query(
    `INSERT INTO roadmap.feature_flag
    (flag_name, display_name, enabled_default, per_tenant_override, updated_by)
    VALUES ($1, $2, $3, $4, $5)`,
    [
      "test.tenant_override_debug",
      "Test Tenant Override",
      false,
      JSON.stringify({ agenthive: { enabled: true } }),
      "test",
    ]
  );

  // Check if it was inserted
  const checkResult = await pool.query(
    `SELECT * FROM roadmap.feature_flag WHERE flag_name = $1`,
    ["test.tenant_override_debug"]
  );
  console.log("Inserted row:", checkResult.rows[0]);

  // Now try to fetch it
  const result = await pool.query(
    `SELECT
      flag_name,
      enabled_default,
      per_tenant_override,
      rollout_percent
    FROM roadmap.feature_flag
    WHERE flag_name = $1 AND NOT is_archived`,
    ["test.tenant_override_debug"]
  );

  console.log("Fetched row:", result.rows[0]);
  if (result.rows.length > 0) {
    const flag = result.rows[0];
    const projectSlug = "agenthive";
    const override = flag.per_tenant_override[projectSlug];
    console.log("Override:", override);
    console.log("Override enabled:", override?.enabled);
  }

  await pool.query("DELETE FROM roadmap.feature_flag WHERE flag_name LIKE 'test.%'");
  await pool.end();
}

test().catch(console.error);
