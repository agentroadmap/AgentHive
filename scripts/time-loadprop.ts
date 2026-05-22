import { Roadmap } from "../src/core/roadmap.ts";
import { createFilesystem } from "../src/core/infrastructure/filesystem.ts";
import { createGit } from "../src/core/infrastructure/git.ts";

const fs = createFilesystem(process.cwd());
const git = createGit(process.cwd());
const rm = new Roadmap({ fs, git, enableWatchers: false } as any);

const t0 = performance.now();
const proposals = await rm.loadProposals();
const t1 = performance.now();
console.log(`loadProposals: ${proposals.length} rows in ${(t1 - t0).toFixed(0)}ms`);

const t2 = performance.now();
const direct = await (rm as any).queryProposals({ includeCrossBranch: false });
const t3 = performance.now();
console.log(`queryProposals direct: ${direct.length} rows in ${(t3 - t2).toFixed(0)}ms`);

process.exit(0);
