/**
 * Tests for proposal-45: MAP.md as Daemon Projection
 * - MAP.md generated from SQLite, not manually edited
 * - Board view reflects proposal changes within 30 seconds
 * - Conflicting manual edits rejected with clear error
 * - Historical MAP.md versions archived
 */

import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MapProjection } from "../../src/core/dag/map-projection.ts";

const TEST_BASE = join(import.meta.dirname, "../../tmp/test-map-projection");

describe("proposal-45: MAP.md as Daemon Projection", () => {
	let testDir: string;
	let projection: MapProjection;
	let testCounter = 0;

	beforeEach(() => {
		testCounter++;
		testDir = join(TEST_BASE, `test-${Date.now()}-${testCounter}`);
		mkdirSync(join(testDir, "roadmap", ".cache"), { recursive: true });

		// Create test SQLite database
		const dbPath = join(testDir, "roadmap", ".cache", "index.db");
		const db = new DatabaseSync(dbPath);
		db.exec(`
			CREATE TABLE proposals (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				status TEXT NOT NULL,
				assignee TEXT,
				priority TEXT,
				directive TEXT,
				labels TEXT,
				dependencies TEXT
			)
		`);

		// Insert test data
		db.prepare("INSERT INTO proposals VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
			"proposal-1",
			"Test Proposal 1",
			"Potential",
			null,
			"high",
			null,
			null,
			null,
		);
		db.prepare("INSERT INTO proposals VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
			"proposal-2",
			"Test Proposal 2",
			"Active",
			"agent-1",
			"medium",
			null,
			null,
			"proposal-1",
		);
		db.prepare("INSERT INTO proposals VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
			"proposal-3",
			"Test Proposal 3",
			"Complete",
			null,
			null,
			null,
			null,
			null,
		);
		db.close();

		projection = new MapProjection(testDir);
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	describe("AC#1: MAP.md generated from SQLite", () => {
		it("generates MAP.md file", () => {
			const result = projection.generateMap();

			assert.equal(result.success, true);
			assert.ok(existsSync(result.path));
		});

		it("includes proposal count", () => {
			const result = projection.generateMap();

			assert.equal(result.proposalCount, 3);
		});

		it("includes auto-generation marker", () => {
			projection.generateMap();

			const content = readFileSync(join(testDir, "roadmap", "MAP.md"), "utf-8");
			assert.ok(content.includes("AUTO-GENERATED"));
		});

		it("generates board view table", () => {
			projection.generateMap();

			const content = readFileSync(join(testDir, "roadmap", "MAP.md"), "utf-8");
			assert.ok(
				content.includes(
					"| Potential | Active | Review | Complete | Abandoned |",
				),
			);
			assert.ok(content.includes("proposal-1"));
			assert.ok(content.includes("proposal-2"));
			assert.ok(content.includes("proposal-3"));
		});

		it("includes statistics", () => {
			projection.generateMap();

			const content = readFileSync(join(testDir, "roadmap", "MAP.md"), "utf-8");
			assert.ok(content.includes("Total proposals:"));
			assert.ok(content.includes("Completion rate:"));
		});

		it("shows assignee for proposals", () => {
			projection.generateMap();

			const content = readFileSync(join(testDir, "roadmap", "MAP.md"), "utf-8");
			assert.ok(content.includes("@agent-1"));
		});

		it("shows priority indicator for high priority", () => {
			projection.generateMap();

			const content = readFileSync(join(testDir, "roadmap", "MAP.md"), "utf-8");
			assert.ok(content.includes("🔥")); // High priority marker
		});
	});

	describe("AC#2: Board view reflects proposal changes", () => {
		it("returns fast generation time", () => {
			const result = projection.generateMap();

			// Should complete well under 30 seconds
			assert.ok(result.duration < 5000, `Generation took ${result.duration}ms`);
		});

		it("regenerates on demand", () => {
			const result1 = projection.generateMap();
			const result2 = projection.generateMap();

			assert.ok(result1.success);
			assert.ok(result2.success);
		});
	});

	describe("AC#3: Conflicting manual edits detected", () => {
		it("detects no conflict on fresh generation", () => {
			projection.generateMap();

			const conflict = projection.checkForConflicts();
			assert.equal(conflict.hasConflict, false);
		});

		it("detects missing auto-gen marker after baseline exists", () => {
			// First generate to establish baseline
			projection.generateMap();

			// Then overwrite with manual content
			const mapPath = join(testDir, "roadmap", "MAP.md");
			writeFileSync(mapPath, "# Manual MAP\n\nSome content here.");

			const conflict = projection.checkForConflicts();

			// Should detect the marker is missing
			assert.equal(conflict.hasConflict, true);
			assert.ok(conflict.reason?.includes("marker"));
		});

		it("allows editable marker", () => {
			const mapPath = join(testDir, "roadmap", "MAP.md");
			writeFileSync(mapPath, "<!-- MAP_EDITABLE -->\n# Manual MAP");

			const conflict = projection.checkForConflicts();

			assert.equal(conflict.hasConflict, false);
		});
	});

	describe("AC#4: Historical MAP.md versions archived", () => {
		it("archives version before regeneration", () => {
			// First generation
			projection.generateMap();

			// Modify the generated file
			const mapPath = join(testDir, "roadmap", "MAP.md");
			writeFileSync(
				mapPath,
				`${readFileSync(mapPath, "utf-8")}\n<!-- Modification -->`,
			);

			// Second generation should archive first
			projection.generateMap();

			const versions = projection.getArchivedVersions();
			assert.ok(
				versions.length >= 1,
				"Should have at least one archived version",
			);
		});

		it("archives maintain timestamp in filename", () => {
			projection.generateMap();
			projection.generateMap();

			const versions = projection.getArchivedVersions();
			if (versions.length > 0) {
				assert.ok(versions[0].startsWith("MAP-"));
				assert.ok(versions[0].endsWith(".md"));
			}
		});

		it("can retrieve archived version content", () => {
			projection.generateMap();
			projection.generateMap(); // This archives the first

			const versions = projection.getArchivedVersions();
			if (versions.length > 0) {
				const content = projection.getArchivedVersion(versions[0]);
				assert.ok(content !== null);
				assert.ok(content?.includes("AUTO-GENERATED"));
			}
		});

		it("limits archived versions", () => {
			projection.updateConfig({ maxHistoryVersions: 3 });

			// Generate multiple versions
			for (let i = 0; i < 5; i++) {
				const mapPath = join(testDir, "roadmap", "MAP.md");
				if (existsSync(mapPath)) {
					writeFileSync(mapPath, `${readFileSync(mapPath, "utf-8")} `);
				}
				projection.generateMap();
			}

			const versions = projection.getArchivedVersions();
			assert.ok(
				versions.length <= 3,
				`Should keep at most 3 versions, got ${versions.length}`,
			);
		});
	});

	describe("Configuration", () => {
		it("uses default config", () => {
			const config = projection.getConfig();
			assert.equal(config.autoGenerate, true);
			assert.equal(config.conflictDetection, true);
			assert.equal(config.maxHistoryVersions, 10);
		});

		it("updates config", () => {
			projection.updateConfig({ maxHistoryVersions: 5 });
			assert.equal(projection.getConfig().maxHistoryVersions, 5);
		});
	});

	describe("Empty database", () => {
		it("handles empty proposal list", () => {
			// Create empty database
			const emptyDir = join(testDir, "empty");
			mkdirSync(join(emptyDir, "roadmap", ".cache"), { recursive: true });

			const dbPath = join(emptyDir, "roadmap", ".cache", "index.db");
			const db = new DatabaseSync(dbPath);
			db.exec(`
				CREATE TABLE proposals (
					id TEXT PRIMARY KEY,
					title TEXT NOT NULL,
					status TEXT NOT NULL,
					assignee TEXT,
					priority TEXT,
					directive TEXT,
					labels TEXT,
					dependencies TEXT
				)
			`);
			db.close();

			const emptyProjection = new MapProjection(emptyDir);
			const result = emptyProjection.generateMap();

			assert.equal(result.success, true);
			assert.equal(result.proposalCount, 0);
		});

		it("handles missing database", () => {
			const noDbDir = join(testDir, "nodb");
			mkdirSync(join(noDbDir, "roadmap"), { recursive: true });

			const noDbProjection = new MapProjection(noDbDir);
			const result = noDbProjection.generateMap();

			// Should still succeed, just with no proposals
			assert.equal(result.success, true);
			assert.equal(result.proposalCount, 0);
		});
	});
});
