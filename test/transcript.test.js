import { test } from "node:test";
import assert from "node:assert/strict";

import {
	buildPlannerPackage,
	dedupeSteps,
	describeCall,
	extractCycle,
	prunableCalls,
	readCycle,
	truncateMiddle,
} from "../transcript.js";

const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const call = (id, name, args) => ({ role: "assistant", content: [{ type: "tool-call", id, name, arguments: JSON.stringify(args) }] });
const result = (id, text, isError = false) => ({ role: "tool", toolCallId: id, content: [{ type: "text", text }], isError });

test("extracts the current cycle: request, steps and results", () => {
	const messages = [
		user("make it friendly"),
		call("1", "grep", { pattern: "hi", path: "src" }),
		result("1", "src/a.ts:1:hi"),
		call("2", "read", { path: "src/a.ts", offset: 1, limit: 20 }),
		result("2", "hi"),
	];
	const cycle = extractCycle(messages);
	assert.deepEqual(cycle.requests, ["make it friendly"]);
	assert.equal(cycle.steps.length, 2);
	assert.deepEqual(cycle.steps[0].args, { pattern: "hi", path: "src" });
	assert.equal(cycle.steps[1].output, "hi");
});

test("skips handoff/discard calls and unfinished calls", () => {
	const messages = [
		user("x"),
		call("1", "grep", { pattern: "a" }),
		result("1", "out"),
		call("2", "handoff", { notes: "n" }),
		call("3", "discard", { ids: [1] }),
		call("4", "read", { path: "a" }),
	];
	const cycle = extractCycle(messages);
	assert.equal(cycle.steps.length, 1);
	assert.equal(cycle.plannerRequests.length, 0);
});

test("records an earlier Need context round", () => {
	const messages = [
		user("x"),
		call("1", "handoff", { notes: "n" }),
		result("1", "## Need context\n\n- read a.ts"),
		call("2", "read", { path: "a.ts" }),
		result("2", "content"),
	];
	const cycle = extractCycle(messages);
	assert.deepEqual(cycle.plannerRequests, ["## Need context\n\n- read a.ts"]);
});

test("marks discarded steps and strips the numbering prefix", () => {
	const messages = [user("x"), call("1", "grep", { pattern: "a" }), result("1", "[#4]\nmatch")];
	const cycle = extractCycle(messages, new Map([["1", { ref: 4, reason: "noise" }]]));
	assert.equal(cycle.steps[0].output, "match");
	assert.equal(cycle.steps[0].discarded, "noise");
});

test("dedupes repeated calls and reads of attached files", () => {
	const steps = [
		{ toolName: "read", args: { path: "a.ts" }, output: "x", isError: false },
		{ toolName: "grep", args: { pattern: "x" }, output: "1", isError: false },
		{ toolName: "grep", args: { pattern: "x" }, output: "2", isError: false },
	];
	const kept = dedupeSteps(steps, "/work", [{ path: "a.ts" }]);
	assert.deepEqual(kept.map((s) => s.output), ["2"]);
});

test("describes DSH tool calls written with file_path", () => {
	assert.equal(describeCall("read", { file_path: "src/a.ts", offset: 5, limit: 10 }), "read src/a.ts (offset 5, limit 10)");
	assert.equal(describeCall("read", { path: "src/a.ts" }), "read src/a.ts");
	assert.equal(describeCall("write", { file_path: "src/b.ts" }), "write src/b.ts");
	assert.equal(describeCall("edit", { file_path: "src/c.ts" }), "edit src/c.ts");
});

test("describes grep's include filter", () => {
	assert.equal(describeCall("grep", { pattern: "hi", path: "src", include: "*.ts" }), 'grep "hi" in src --include *.ts');
	assert.doesNotMatch(describeCall("grep", { pattern: "hi", glob: "*.ts" }), /--glob/);
});

test("dedupes reads of attached files written with file_path", () => {
	const steps = [
		{ toolName: "read", args: { file_path: "a.ts" }, output: "x", isError: false },
		{ toolName: "grep", args: { pattern: "x" }, output: "1", isError: false },
	];
	const kept = dedupeSteps(steps, "/work", [{ path: "a.ts" }]);
	assert.deepEqual(kept.map((s) => s.toolName), ["grep"]);
});

test("keeps a file_path read that reaches lines cut from an attached file", () => {
	const output = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
	const steps = [{ toolName: "read", args: { file_path: "a.ts", offset: 40, limit: 20 }, output, isError: false }];
	const kept = dedupeSteps(steps, "/work", [{ path: "a.ts", cut: { first: 10, last: 50 } }]);
	assert.equal(kept.length, 1);
});

test("truncates the middle of long text", () => {
	const text = "a".repeat(100) + "b".repeat(100);
	const cut = truncateMiddle(text, 50);
	assert.ok(cut.length < text.length);
	assert.match(cut, /chars omitted/);
});

test("builds the planner package with request, notes, steps and files", () => {
	const cycle = {
		requests: ["make it friendly", "also add tests"],
		steps: [{ ref: 1, toolName: "grep", args: { pattern: "hi" }, output: "src/a.ts:1:hi", isError: false }],
		plannerRequests: [],
	};
	const pkg = buildPlannerPackage({
		cycle,
		notes: "The greeting lives in src/a.ts.",
		files: [{ path: "src/a.ts", content: "hi\n" }, { path: "missing.ts", error: "not found" }],
		cwd: "/work",
		maxToolOutputChars: 1000,
		maxFileChars: 1000,
		maxPackageChars: 10000,
	});
	assert.match(pkg.text, /# User request\n\nmake it friendly/);
	assert.match(pkg.text, /## Additional user messages\n\n- also add tests/);
	assert.match(pkg.text, /# Scout notes\n\nThe greeting lives in src\/a\.ts\./);
	assert.match(pkg.text, /# Scout tool calls/);
	assert.match(pkg.text, /# Key files \(current full content\)/);
	assert.match(pkg.text, /\(unavailable: not found\)/);
});

test("reads the current turn from session events", () => {
	const events = [
		{ type: "turn/end", seq: 9, data: {} },
		{ type: "user/message", seq: 10, data: user("hello") },
		{ type: "assistant/message", seq: 11, data: { message: call("1", "grep", { pattern: "x" }) } },
		{ type: "tool/result", seq: 12, data: { message: result("1", "[#1]\nfound") } },
	];
	const session = { snapshotEvents: () => events };
	const messages = readCycle(session);
	assert.equal(messages.length, 3);
	assert.equal(messages[0].role, "user");
	assert.equal(messages[2].content[0].text, "[#1]\nfound");
});

const image = (id) => ({ type: "image", attachment: { attachmentId: id, mediaType: "image/png", bytes: 10, width: 2, height: 2 } });

test("only the user's own messages are requests: runtime context and compaction checkpoints are not", () => {
	const cycle = extractCycle([
		{ role: "user", source: { kind: "runtime-context", form: "snapshot" }, content: [{ type: "text", text: "Current date: 2026-11-07\nShell: pwsh" }] },
		{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "Fix the layout" }] },
		{ role: "user", source: { kind: "compaction" }, content: [{ type: "text", text: "Summary of the conversation so far" }] },
	]);
	assert.deepEqual(cycle.requests, ["Fix the layout"]);
	const pkg = buildPlannerPackage({ cycle, notes: "", files: [], cwd: "/w", maxToolOutputChars: 1000, maxFileChars: 1000, maxPackageChars: 100000 });
	assert.doesNotMatch(pkg.text, /Current date|Summary of the conversation/);
});

test("images from the user, from tool results and from key files reach the package in order, up to the cap", () => {
	const cycle = extractCycle([
		{ role: "user", content: [{ type: "text", text: "Match this design" }, image("u1")] },
		call("1", "read_image", { file_path: "shot.png" }),
		{ role: "tool", toolCallId: "1", content: [{ type: "text", text: "<type>image</type>" }, image("r1")], isError: false },
	]);
	assert.equal(cycle.requestImages.length, 1);
	assert.equal(cycle.steps[0].images.length, 1);
	const files = [{ path: "mock.png", image: image("k1") }];
	const input = { cycle, notes: "", files, cwd: "/w", maxToolOutputChars: 1000, maxFileChars: 1000, maxPackageChars: 100000 };
	const pkg = buildPlannerPackage(input);
	assert.deepEqual(pkg.images.map((entry) => entry.block.attachment.attachmentId), ["u1", "r1", "k1"]);
	assert.match(pkg.text, /## Images attached by the user\n\n\[image 1\]/);
	assert.match(pkg.text, /read_image .*\n\n[\s\S]*\[image 2\]/);
	assert.match(pkg.text, /## `mock.png`\n\n\[image 3\]/);
	const capped = buildPlannerPackage({ ...input, maxImages: 1 });
	assert.equal(capped.images.length, 1);
	assert.match(capped.text, /\[image omitted\]/);
});

test("an image-only message still counts as the user's request", () => {
	const cycle = extractCycle([{ role: "user", content: [image("u1")] }]);
	assert.deepEqual(cycle.requests, []);
	assert.equal(cycle.requestImages.length, 1);
});

test("pruning covers every finished scout result except the handoff", () => {
	const calls = prunableCalls([
		user("q"),
		call("1", "grep", { pattern: "x" }),
		result("1", "hits"),
		call("2", "discard", { ids: [1] }),
		result("2", "ok"),
		call("3", "handoff", { notes: "n" }),
		result("3", "done"),
		call("4", "read", { file_path: "a" }),
	]);
	assert.deepEqual(calls.map((entry) => entry.callId), ["1", "2"]);
	assert.match(calls[0].title, /^grep "x"/);
});
