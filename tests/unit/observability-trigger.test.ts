import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Reads the authoritative migration DDL and verifies the trigger is defined correctly.
// This prevents schema drift — if the trigger is removed or altered, CI catches it.
const MIGRATION_PATH = join(
	"/data/code/AgentHive/scripts/migrations",
	"060-p604-observability-schema.sql",
);

const ddl = readFileSync(MIGRATION_PATH, "utf8");

describe("P604 proposal_lifecycle_event trigger DDL", () => {
	it("migration file exists and is non-empty", () => {
		assert.ok(ddl.length > 0, "migration file must not be empty");
	});

	it("defines fn_proposal_lifecycle_event function", () => {
		assert.ok(
			ddl.includes("CREATE OR REPLACE FUNCTION roadmap.fn_proposal_lifecycle_event()"),
			"must define fn_proposal_lifecycle_event",
		);
	});

	it("trigger fires AFTER UPDATE OF status, maturity on roadmap_proposal.proposal", () => {
		assert.ok(
			ddl.includes("AFTER UPDATE OF status, maturity ON roadmap_proposal.proposal"),
			"trigger must fire on status/maturity changes",
		);
	});

	it("trigger executes fn_proposal_lifecycle_event", () => {
		assert.ok(
			ddl.includes("EXECUTE FUNCTION roadmap.fn_proposal_lifecycle_event()"),
			"trigger must execute the lifecycle event function",
		);
	});

	it("trigger has DROP IF EXISTS guard before CREATE", () => {
		const dropIdx = ddl.indexOf("DROP TRIGGER IF EXISTS trg_proposal_lifecycle_event");
		const createIdx = ddl.indexOf("CREATE TRIGGER trg_proposal_lifecycle_event");
		assert.ok(dropIdx !== -1, "must have DROP TRIGGER IF EXISTS guard");
		assert.ok(createIdx !== -1, "must have CREATE TRIGGER statement");
		assert.ok(dropIdx < createIdx, "DROP must precede CREATE");
	});

	it("trigger has FOR EACH ROW and WHEN clause to skip no-op updates", () => {
		assert.ok(ddl.includes("FOR EACH ROW"), "must be row-level trigger");
		assert.ok(
			ddl.includes("WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.maturity IS DISTINCT FROM NEW.maturity)"),
			"must include WHEN clause to skip no-op updates",
		);
	});

	it("proposal_lifecycle_event table has expected columns", () => {
		assert.ok(ddl.includes("from_state"), "must have from_state column");
		assert.ok(ddl.includes("to_state"), "must have to_state column");
		assert.ok(ddl.includes("from_maturity"), "must have from_maturity column");
		assert.ok(ddl.includes("to_maturity"), "must have to_maturity column");
		assert.ok(ddl.includes("occurred_at"), "must have occurred_at column");
	});

	it("no DELETE grant on proposal_lifecycle_event (permanent audit record)", () => {
		// Governance requirement: lifecycle events are immutable audit records
		const grantBlock = ddl.slice(ddl.indexOf("proposal_lifecycle_event: retained indefinitely"));
		assert.ok(
			!grantBlock.includes("GRANT DELETE ON roadmap.proposal_lifecycle_event"),
			"must NOT grant DELETE on proposal_lifecycle_event",
		);
	});
});
