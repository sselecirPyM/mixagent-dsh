import { test } from "node:test";
import assert from "node:assert/strict";
import { isAbsolute, resolve } from "node:path";

import {
	applyBlocks,
	autoApplyPlan,
	insideCwd,
	parseCreateSection,
	parseEditSection,
} from "../apply.js";
import { AUTO_APPLIED } from "../prompts.js";

const CWD = isAbsolute("C:/work") ? "C:/work" : "/work";
const at = (relative) => resolve(CWD, relative);

/** In-memory file operations used by autoApplyPlan. */
function ops(files) {
	const store = new Map(Object.entries(files));
	return {
		store,
		read: async (path) => store.get(path),
		exists: async (path) => store.has(path),
		isFile: async (path) => store.has(path),
		write: async (path, content) => {
			store.set(path, content);
			return `Wrote ${path}.`;
		},
		remove: async (path) => {
			store.delete(path);
			return `Deleted ${path}.`;
		},
	};
}

const editPlan = (search, replace) => `## Summary
s

## Changes

### \`src/a.ts\` — edit
Desc.

\`\`\`\`text
<<<<<<< SEARCH
${search}
=======
${replace}
>>>>>>> REPLACE
\`\`\`\`
`;

test("parses a plain edit section", () => {
	const parsed = parseEditSection("Desc.\n\n````text\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n````");
	assert.equal(typeof parsed, "object");
	assert.equal(parsed.description, "Desc.");
	assert.deepEqual(parsed.blocks, [{ oldText: "old", newText: "new" }]);
});

test("rejects ambiguous or malformed edit sections", () => {
	assert.equal(parseEditSection("<<<<<<< SEARCH\na\n=======\nb\n=======\nc\n>>>>>>> REPLACE"), "a block with two dividers (ambiguous)");
	assert.equal(parseEditSection("<<<<<<< SEARCH\na\n>>>>>>> REPLACE"), "malformed SEARCH/REPLACE markers");
	assert.equal(parseEditSection("<<<<<<< SEARCH\n   \n=======\nb\n>>>>>>> REPLACE"), "an empty SEARCH block");
	assert.equal(parseEditSection("no blocks"), "no SEARCH/REPLACE blocks");
	assert.equal(parseEditSection("<<<<<<< SEARCH\na\n=======\nb"), "an unterminated SEARCH/REPLACE block");
});

test("parses a create section", () => {
	const parsed = parseCreateSection("Desc.\n\n````ts\nconst a = 1;\n````");
	assert.deepEqual(parsed, { content: "const a = 1;\n", description: "Desc." });
	assert.equal(parseCreateSection("````ts\nunterminated"), "an unterminated code block");
	assert.equal(parseCreateSection("nothing"), "no code block with the file content");
});

test("applies blocks only when each SEARCH matches exactly once", () => {
	assert.deepEqual(applyBlocks("a\nb\nc", [{ oldText: "b", newText: "B" }]), { text: "a\nB\nc" });
	assert.match(applyBlocks("a\nb", [{ oldText: "zzz", newText: "x" }]).error, /does not match/);
	assert.match(applyBlocks("a\na", [{ oldText: "a", newText: "b" }]).error, /not unique/);
	// Non-overlapping blocks all apply.
	assert.deepEqual(
		applyBlocks("a\nb\nc", [
			{ oldText: "a", newText: "x" },
			{ oldText: "b", newText: "y" },
		]),
		{ text: "x\ny\nc" },
	);
});

test("rejects paths outside the working directory", () => {
	assert.ok(insideCwd(CWD, "src/a.ts"));
	assert.equal(insideCwd(CWD, "../a.ts"), undefined);
	assert.equal(insideCwd(CWD, "~/a.ts"), undefined);
});

test("applies an edit and annotates the section", async () => {
	const fake = ops({ [at("src/a.ts")]: "line one\nline two\n" });
	const result = await autoApplyPlan(editPlan("line two", "line 2"), CWD, fake);
	assert.equal(fake.store.get(at("src/a.ts")), "line one\nline 2\n");
	assert.equal(result.files[0].status, "applied");
	assert.ok(result.plan.includes(`${AUTO_APPLIED}: Wrote`));
	assert.doesNotMatch(result.plan, /<<<<<<< SEARCH/);
});

test("keeps a section and its blocks when the SEARCH does not match", async () => {
	const fake = ops({ [at("src/a.ts")]: "line one\n" });
	const result = await autoApplyPlan(editPlan("missing", "x"), CWD, fake);
	assert.equal(fake.store.get(at("src/a.ts")), "line one\n");
	assert.equal(result.files[0].status, "skipped");
	assert.match(result.plan, /<<<<<<< SEARCH/);
});

test("preserves CRLF and BOM on edit", async () => {
	const fake = ops({ [at("src/a.ts")]: "\uFEFFone\r\ntwo\r\n" });
	await autoApplyPlan(editPlan("two", "2"), CWD, fake);
	assert.equal(fake.store.get(at("src/a.ts")), "\uFEFFone\r\n2\r\n");
});

test("creates, refuses existing files, and deletes", async () => {
	const create = `## Changes\n\n### \`src/new.ts\` — create\n\`\`\`\`ts\nx\n\`\`\`\`\n`;
	const fake = ops({});
	const created = await autoApplyPlan(create, CWD, fake);
	assert.equal(created.files[0].status, "applied");
	assert.equal(fake.store.get(at("src/new.ts")), "x\n");

	const again = await autoApplyPlan(create, CWD, fake);
	assert.equal(again.files[0].status, "skipped");
	assert.equal(again.plan, create);

	const remove = `## Changes\n\n### \`src/new.ts\` — delete\n`;
	const deleted = await autoApplyPlan(remove, CWD, fake);
	assert.equal(deleted.files[0].status, "applied");
	assert.equal(fake.store.has(at("src/new.ts")), false);
});

test("every SEARCH is matched against the original file, as the reference's edit tool does", () => {
	// A block never matches an earlier block's output...
	assert.match(applyBlocks("a\nb\n", [{ oldText: "a", newText: "x" }, { oldText: "x", newText: "y" }]).error, /block 2 does not match/);
	// ...and text an earlier block produces does not make a later SEARCH ambiguous.
	assert.deepEqual(applyBlocks("foo\nbar\n", [{ oldText: "foo", newText: "bar" }, { oldText: "bar", newText: "baz" }]), { text: "bar\nbaz\n" });
	// Ambiguity is judged on the original: "foo" occurs twice there, so the plan is not applied elsewhere.
	assert.match(applyBlocks("A foo\nB foo\n", [{ oldText: "A foo", newText: "A" }, { oldText: "foo", newText: "bar" }]).error, /block 2 is not unique/);
	// Blocks may come in any order; overlapping blocks are refused.
	assert.deepEqual(applyBlocks("a\nb\nc\n", [{ oldText: "c", newText: "C" }, { oldText: "a", newText: "A" }]), { text: "A\nb\nC\n" });
	assert.match(applyBlocks("a\nb\nc\n", [{ oldText: "a\nb", newText: "A\nB" }, { oldText: "b\nc", newText: "B\nC" }]).error, /blocks 1 and 2 overlap/);
	// A block that changes nothing is not reported as applied.
	assert.match(applyBlocks("a\n", [{ oldText: "a", newText: "a" }]).error, /no change/);
	assert.match(applyBlocks("a\n", [{ oldText: "", newText: "b" }]).error, /empty/);
});
