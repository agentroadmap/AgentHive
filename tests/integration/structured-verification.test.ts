import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { VerificationProposalmentsManager } from "../../src/markdown/structured-sections.ts";

describe("Structured Verification Proposalments", () => {
	test("round-trip structured verification proposalments", () => {
		const original = `---
id: proposal-1
---
## Verification Proposalments
<!-- VERIFY:BEGIN -->
- [ ] #1 [builder] Test item 1 (evidence: unit test)
- [x] #2 [peer-tester] Test item 2 (evidence: observation)
<!-- VERIFY:END -->
`;
		const proposalments =
			VerificationProposalmentsManager.parseVerificationProposalments(original);
		assert.equal(proposalments.length, 2);

		assert.equal(proposalments[0]?.text, "Test item 1");
		assert.equal(proposalments[0]?.role, "builder");
		assert.equal(proposalments[0]?.evidence, "unit test");
		assert.equal(proposalments[0]?.checked, false);

		assert.equal(proposalments[1]?.text, "Test item 2");
		assert.equal(proposalments[1]?.role, "peer-tester");
		assert.equal(proposalments[1]?.evidence, "observation");
		assert.equal(proposalments[1]?.checked, true);

		const updated = VerificationProposalmentsManager.updateContent(
			original,
			proposalments,
		);
		assert.ok(
			updated.includes("- [ ] #1 [builder] Test item 1 (evidence: unit test)"),
		);
		assert.ok(
			updated.includes(
				"- [x] #2 [peer-tester] Test item 2 (evidence: observation)",
			),
		);
	});

	test("adding structured proposalments via manager", () => {
		const content = `## Verification Proposalments
<!-- VERIFY:BEGIN -->
<!-- VERIFY:END -->
`;
		const updated = VerificationProposalmentsManager.addCriteria(content, [
			"[builder] New proposalment (evidence: logs)",
		]);

		assert.ok(
			updated.includes("- [ ] #1 [builder] New proposalment (evidence: logs)"),
		);

		const parsed =
			VerificationProposalmentsManager.parseVerificationProposalments(updated);
		assert.equal(parsed[0]?.role, "builder");
		assert.equal(parsed[0]?.evidence, "logs");
	});
});
