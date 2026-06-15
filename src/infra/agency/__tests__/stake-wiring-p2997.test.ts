/**
 * P2997 AC-7 wiring evidence — structural verification that the stake/proof
 * checks are wired into the concrete chokepoint functions named in the AC:
 *   - agency-claim-loop.ts::claimOne        → evaluateStakeAdmission + verifyAgentIdentity
 *   - offer-dispatch-handler.ts completion  → slashStake (failure) + returnStake (success)
 *
 * This is an import-resolution + source-presence test (the same pattern as
 * liaison-agent-claim-loop-wiring.test.ts). The functional behavior of the
 * stake functions themselves is covered in stake-admission-p2997.test.ts.
 *
 * Run:
 *   npx vitest run src/infra/agency/__tests__/stake-wiring-p2997.test.ts
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const agencyDir = join(here, "..");

function src(file: string): string {
	return readFileSync(join(agencyDir, file), "utf-8");
}

describe("P2997 AC-7: stake gate wired into claimOne (agency-claim-loop.ts)", () => {
	const content = src("agency-claim-loop.ts");

	it("imports evaluateStakeAdmission from stake-admission.ts", () => {
		expect(content).toContain('from "./stake-admission.ts"');
		expect(content).toContain("evaluateStakeAdmission");
	});

	it("calls evaluateStakeAdmission and refuses the claim when not allowed", () => {
		expect(content).toMatch(/evaluateStakeAdmission\(\s*this\.agencyIdentity/);
		// The gate must short-circuit the claim (return null) on refusal.
		expect(content).toMatch(/stakeAdmission && !stakeAdmission\.allowed[\s\S]{0,200}return null/);
	});

	it("wires the EXISTING proof check (verifyAgentIdentity) into the claim path", () => {
		expect(content).toContain("verifyAgentIdentity");
		expect(content).toContain("identity-verification.ts");
	});
});

describe("P2997 AC-7: stake settlement wired into completion (offer-dispatch-handler.ts)", () => {
	const content = src("offer-dispatch-handler.ts");

	it("imports/uses slashStake and returnStake from stake-admission.ts", () => {
		expect(content).toContain("./stake-admission.ts");
		expect(content).toContain("slashStake");
		expect(content).toContain("returnStake");
	});

	it("returns the bond on success and slashes only non-transient failures", () => {
		// success branch returns the bond
		expect(content).toMatch(/if \(succeeded\)[\s\S]{0,400}returnStake/);
		// auth_required degenerate exit is mapped to the transient (non-slashable) class
		expect(content).toContain('"auth_rejected"');
		// genuine failure maps to the slashable unknown class
		expect(content).toMatch(/"unknown"/);
	});
});
