import { test } from "node:test";
import assert from "node:assert/strict";

import {
	assembleJoinPlan,
	countPlanChanges,
	fileSections,
	mapFileSections,
	parseNeedContext,
	parseSubtasks,
	planSections,
	splitPlan,
} from "../plan.js";

const PLAN = `## Summary
Friendly greeting.

## Changes

### \`src/a.ts\` — edit
Say hello.

\`\`\`\`text
<<<<<<< SEARCH
hi
=======
hello
>>>>>>> REPLACE
\`\`\`\`

### \`src/b.ts\` — create
\`\`\`\`ts
export const b = 1;
\`\`\`\`

## Commands
\`\`\`bash
npm test
\`\`\`

## Answer
Done.
`;

test("parses sections and file sections outside fences", () => {
	const sections = planSections(PLAN);
	assert.equal(sections.get("summary"), "Friendly greeting.");
	assert.match(sections.get("commands"), /npm test/);
	assert.equal(sections.get("answer"), "Done.");
	const files = fileSections(PLAN);
	assert.deepEqual(files.map((f) => [f.path, f.kind]), [["src/a.ts", "edit"], ["src/b.ts", "create"]]);
	assert.match(files[0].body, /SEARCH/);
});

test("counts planned file changes", () => {
	assert.equal(countPlanChanges(PLAN), 2);
	assert.equal(countPlanChanges("## Answer\nnothing"), 0);
});

test("ignores headings inside code fences", () => {
	const plan = "## Summary\nx\n\n```md\n## Changes\n### `nope.ts` — edit\n```\n";
	assert.equal(planSections(plan).has("changes"), false);
	assert.deepEqual(fileSections(plan), []);
});

test("detects Need context only without changes", () => {
	assert.equal(parseNeedContext("## Need context\n- read a.ts"), "- read a.ts");
	assert.equal(parseNeedContext("## Need context\n- x\n\n## Changes\n### `a` — edit"), undefined);
	assert.equal(parseNeedContext("## Summary\nfine"), undefined);
});

test("maps file sections while keeping headings and spacing", () => {
	const out = mapFileSections(PLAN, (section) => (section.path === "src/a.ts" ? `${section.heading}\nreplaced` : undefined));
	assert.match(out, /### `src\/a\.ts` — edit\nreplaced\n\n### `src\/b\.ts`/);
	assert.match(out, /### `src\/b\.ts` — create/);
});

test("splits a valid Tasks section into disjoint task plans", () => {
	const plan = PLAN.replace(
		"## Commands",
		"## Tasks\n- T1: `src/a.ts` — edit a\n- T2: `src/b.ts` — create b\n\n## Commands",
	);
	const split = splitPlan(plan);
	assert.ok(split);
	assert.equal(split.tasks.length, 2);
	assert.match(split.tasks[0].plan, /## Task T1 \(1 of 2\)/);
	assert.match(split.tasks[0].plan, /src\/a\.ts/);
	assert.doesNotMatch(split.tasks[0].plan, /src\/b\.ts/);
	assert.match(split.joinPlan, /Already applied/);
	assert.equal(split.answer, "Done.");
});

test("refuses an invalid Tasks section", () => {
	const missing = PLAN.replace("## Commands", "## Tasks\n- T1: `src/a.ts` — edit a\n\n## Commands");
	assert.equal(splitPlan(missing), undefined);
	const duplicate = PLAN.replace("## Commands", "## Tasks\n- T1: `src/a.ts`, `src/a.ts` — x\n- T2: `src/b.ts` — y\n\n## Commands");
	assert.equal(splitPlan(duplicate), undefined);
});

test("parses Subtasks only when the lead wrote no file sections", () => {
	const lead = "## Summary\nSplit.\n\n## Subtasks\n- S1: `src/a.ts` — a\n- S2: `src/b.ts` — b\n";
	const subtasks = parseSubtasks(lead);
	assert.deepEqual(subtasks.map((s) => s.id), ["S1", "S2"]);
	assert.equal(parseSubtasks(lead + "\n### `src/x.ts` — edit\n"), undefined);
});

test("assembles a join plan from sub-plans and revision notes", () => {
	const subPlans = [
		{ id: "S1", goal: "a", plan: "## Summary\ns\n\n## Changes\n\n### `src/a.ts` — edit\nAAA\n" },
		{ id: "S2", goal: "b", plan: "## Changes\n\n### `src/b.ts` — create\nBBB\n" },
	];
	const join = "## Summary\nall\n\n## Revisions\n### `src/a.ts`\nCheck the interface.\n\n## Commands\nnpm test\n";
	const final = assembleJoinPlan(join, subPlans);
	assert.match(final, /### `src\/a\.ts` — edit \(S1\)\nAAA/);
	assert.match(final, /### `src\/b\.ts` — create \(S2\)\nBBB/);
	assert.match(final, /Revisions by the join planner/);
	assert.match(final, /## Commands\nnpm test/);
});

test("expands `from Sx` placeholders in a join that wrote its own Changes", () => {
	const subPlans = [
		{ id: "S1", goal: "a", plan: "## Changes\n\n### `src/a.ts` — edit\nAAA\n" },
		{ id: "S2", goal: "b", plan: "## Changes\n\n### `src/b.ts` — create\nBBB\n" },
	];
	const join =
		"## Summary\nall\n\n## Changes\n\n### `src/a.ts` — from S1\n\n### `src/b.ts` — from S1\n\n### `src/c.ts` — edit\nCCC\n\n" +
		"## Tasks\n- T1: `src/a.ts`, `src/c.ts` — a\n- T2: `src/b.ts` — b\n\n## Commands\nnpm test\n";
	const final = assembleJoinPlan(join, subPlans);
	assert.match(final, /### `src\/a\.ts` — edit \(S1\)\nAAA/);
	// S1 has no section for b.ts: falls back to the sub-plan that does.
	assert.match(final, /### `src\/b\.ts` — create \(S2\)\nBBB/);
	assert.match(final, /### `src\/c\.ts` — edit\nCCC/);
	assert.doesNotMatch(final, /from S\d/);
	assert.equal(countPlanChanges(final), 3);
	assert.equal(splitPlan(final).tasks.length, 2);
});
