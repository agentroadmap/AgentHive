/**
 * Sequences — Re-export from proposal subdirectory
 *
 * computeSequences, planMoveToSequence, planMoveToUnsequenced
 * are implemented in ./proposal/sequences.ts.
 * This barrel keeps the import path in roadmap.ts valid.
 */

export {
	computeSequences,
	planMoveToSequence,
	planMoveToUnsequenced,
} from "./proposal/sequences.ts";
