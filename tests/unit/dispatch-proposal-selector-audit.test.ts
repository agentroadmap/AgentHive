import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { auditDispatchProposalSelectors } from "../../scripts/ci/check-dispatch-proposal-selects.ts";

describe("dispatch proposal selector audit (P1411)", () => {
	it("guards the known dispatch/gate/spawn selectors against paused proposals", () => {
		assert.deepEqual(auditDispatchProposalSelectors(), []);
	});
});
