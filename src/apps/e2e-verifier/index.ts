/**
 * P671: Background e2e verifier service
 *
 * Polls for COMPLETE/new proposals with no active leases and runs their e2e suites.
 * On pass: transitions maturity to 'active' and releases lease.
 * On fail: records failure discussion and releases lease; proposal stays at COMPLETE/new.
 *
 * Configurable via:
 * - E2E_VERIFIER_POLL_INTERVAL_MS (default 60000 ms = 60s)
 * - E2E_VERIFIER_LEASE_DURATION_MIN (default 30 min)
 * - E2E_VERIFIER_BATCH_SIZE (default 5 proposals per poll)
 */

import { pool } from "../../postgres/pool.ts";
import { execSync, spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const POLL_INTERVAL_MS = parseInt(process.env.E2E_VERIFIER_POLL_INTERVAL_MS ?? "60000", 10);
const LEASE_DURATION_MIN = parseInt(process.env.E2E_VERIFIER_LEASE_DURATION_MIN ?? "30", 10);
const BATCH_SIZE = parseInt(process.env.E2E_VERIFIER_BATCH_SIZE ?? "5", 10);
const REPO_ROOT = process.env.AGENTHIVE_REPO_ROOT ?? process.cwd();

interface ProposalRow {
	id: number;
	display_id: string;
	title: string;
}

async function log(msg: string) {
	console.log(`[E2E-Verifier ${new Date().toISOString()}] ${msg}`);
}

async function pollProposals(): Promise<ProposalRow[]> {
	const result = await pool.query<ProposalRow>(
		`SELECT p.id, p.display_id, p.title
		 FROM roadmap_proposal.proposal p
		 LEFT JOIN roadmap_proposal.proposal_lease pl
		   -- P1391 AC-8: a lease is live only when released_at IS NULL AND it has
		   -- not passed its TTL. A released_at-null-but-expired row is NOT a live
		   -- lease, so it must not mask a COMPLETE/new proposal from the verifier.
		   ON pl.proposal_id = p.id AND pl.released_at IS NULL AND pl.expires_at > now()
		 WHERE p.status = 'COMPLETE'
		   AND p.maturity = 'new'
		   AND pl.id IS NULL
		 ORDER BY p.modified_at ASC
		 LIMIT $1`,
		[BATCH_SIZE],
	);
	return result.rows;
}

async function claimProposal(proposalId: number): Promise<boolean> {
	try {
		const expiresAt = new Date(Date.now() + LEASE_DURATION_MIN * 60 * 1000);
		await pool.query(
			`INSERT INTO roadmap_proposal.proposal_lease
			 (proposal_id, agent_identity, expires_at)
			 VALUES ($1, $2, $3)`,
			[proposalId, 'e2e-verifier', expiresAt],
		);
		return true;
	} catch (err) {
		log(`Failed to claim proposal ${proposalId}: ${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
}

async function releaseProposal(proposalId: number): Promise<void> {
	await pool.query(
		`UPDATE roadmap_proposal.proposal_lease
		 SET released_at = now()
		 WHERE proposal_id = $1 AND agent_identity = $2 AND released_at IS NULL`,
		[proposalId, 'e2e-verifier'],
	);
}

async function insertDiscussion(
	proposalId: number,
	contextPrefix: string,
	body: string,
): Promise<void> {
	try {
		await pool.query(
			`INSERT INTO roadmap_proposal.proposal_discussions
			 (proposal_id, author_identity, context_prefix, body, project_id)
			 VALUES ($1, $2, $3, $4, $5)`,
			[proposalId, 'e2e-verifier', contextPrefix, body, 1],
		);
	} catch (err) {
		log(`Failed to insert discussion for proposal ${proposalId}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function insertAgentRun(
	proposalId: number,
	status: 'running' | 'success' | 'failure' | 'timeout',
	durationMs?: number,
	errorDetail?: string,
): Promise<void> {
	try {
		await pool.query(
			`INSERT INTO roadmap_workforce.agent_runs
			 (proposal_id, agent_identity, status, duration_ms, error_detail, started_at, completed_at)
			 VALUES ($1, $2, $3, $4, $5, now(), CASE WHEN $3 = 'running' THEN NULL ELSE now() END)`,
			[proposalId, 'e2e-verifier', status, durationMs ?? null, errorDetail ?? null],
		);
	} catch (err) {
		log(`Failed to insert agent_run for proposal ${proposalId}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function setMaturity(proposalId: number, maturity: 'active' | 'new'): Promise<void> {
	try {
		await pool.query(
			`UPDATE roadmap_proposal.proposal
			 SET maturity = $1
			 WHERE id = $2`,
			[maturity, proposalId],
		);
	} catch (err) {
		log(`Failed to set maturity for proposal ${proposalId}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function runE2eTests(displayId: string): Promise<{
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
}> {
	const startTime = Date.now();
	const command = process.env.E2E_CMD_TEMPLATE ?? `npm run test:e2e -- --filter=${displayId}`;

	return new Promise((resolve) => {
		let stdout = '';
		let stderr = '';

		try {
			const child = spawn('bash', ['-c', command], {
				cwd: REPO_ROOT,
				stdio: ['pipe', 'pipe', 'pipe'],
			});

			child.stdout?.on('data', (data) => {
				stdout += data.toString();
			});

			child.stderr?.on('data', (data) => {
				stderr += data.toString();
			});

			const timeout = setTimeout(() => {
				child.kill();
				const durationMs = Date.now() - startTime;
				resolve({
					exitCode: 124, // timeout exit code
					stdout,
					stderr,
					durationMs,
				});
			}, 15 * 60 * 1000); // 15 min timeout

			child.on('exit', (code) => {
				clearTimeout(timeout);
				const durationMs = Date.now() - startTime;
				resolve({
					exitCode: code ?? -1,
					stdout,
					stderr,
					durationMs,
				});
			});

			child.on('error', (err) => {
				clearTimeout(timeout);
				const durationMs = Date.now() - startTime;
				resolve({
					exitCode: -1,
					stdout,
					stderr: `Failed to spawn process: ${err.message}`,
					durationMs,
				});
			});
		} catch (err) {
			const durationMs = Date.now() - startTime;
			resolve({
				exitCode: -1,
				stdout,
				stderr: err instanceof Error ? err.message : String(err),
				durationMs,
			});
		}
	});
}

async function verifyProposal(proposal: ProposalRow): Promise<void> {
	log(`Processing [${proposal.display_id}] ${proposal.title}`);

	// Claim the proposal
	const claimed = await claimProposal(proposal.id);
	if (!claimed) {
		log(`Could not claim proposal ${proposal.display_id}, skipping.`);
		return;
	}

	// Record start of verification run
	await insertAgentRun(proposal.id, 'running');

	// Run e2e tests
	const testResult = await runE2eTests(proposal.display_id);

	if (testResult.exitCode === 0) {
		// Success: transition to active and release
		log(`✅ [${proposal.display_id}] e2e tests passed`);
		await insertDiscussion(
			proposal.id,
			'e2e-verify',
			`E2E verification suite passed. Duration: ${testResult.durationMs}ms`,
		);
		await setMaturity(proposal.id, 'active');
		await insertAgentRun(proposal.id, 'success', testResult.durationMs);
	} else {
		// Failure: log failure discussion and release
		log(`❌ [${proposal.display_id}] e2e tests failed (exit code ${testResult.exitCode})`);

		// Extract failing test names from stderr/stdout (simple heuristic)
		const failingTests = (testResult.stdout + testResult.stderr)
			.split('\n')
			.filter((line) => line.match(/FAIL|fail|error/i))
			.slice(0, 5) // first 5 failures
			.join('\n');

		await insertDiscussion(
			proposal.id,
			'e2e-verify-failed',
			`E2E verification suite failed (exit ${testResult.exitCode}). Details:\n${failingTests}`,
		);
		await insertAgentRun(proposal.id, 'failure', testResult.durationMs, `e2e tests failed`);
		// Proposal stays at COMPLETE/new
	}

	// Release the lease
	await releaseProposal(proposal.id);
}

async function pollCycle() {
	try {
		const proposals = await pollProposals();
		if (proposals.length === 0) {
			log('polling COMPLETE/new proposals: no matches');
			return;
		}

		log(`polling COMPLETE/new proposals: found ${proposals.length}`);

		for (const proposal of proposals) {
			try {
				await verifyProposal(proposal);
			} catch (err) {
				log(`Error verifying proposal ${proposal.display_id}: ${err instanceof Error ? err.message : String(err)}`);
				await releaseProposal(proposal.id);
			}
		}
	} catch (err) {
		log(`Poll cycle failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function main() {
	log(`Starting e2e-verifier service (poll interval: ${POLL_INTERVAL_MS}ms)`);

	// Initial poll
	await pollCycle();

	// Recurring polls
	setInterval(pollCycle, POLL_INTERVAL_MS);
}

main().catch((err) => {
	console.error('Fatal error in e2e-verifier:', err);
	process.exit(1);
});
