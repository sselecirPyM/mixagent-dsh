import { test } from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply } from "../index.js";
import { runExecutor, runPlanner } from "../pipeline.js";
import {
	TRACE_KIND,
	addUsage,
	finalizeTrace,
	createTrace,
	formatDuration,
	formatTokens,
	handoffTraces,
	presentationMeta,
	renderTrace,
	sessionStats,
	usageTotal,
} from "../trace.js";

const CWD = "C:/work";
/** Saved plans go to a scratch directory, never to the real ~/.dsh. */
const PLAN_DIR = mkdtempSync(join(tmpdir(), "mixagent-plans-"));
const flush = () => new Promise((resolve) => setImmediate(resolve));

const editPlan = (search, replace) => `## Summary
Rename the greeting.

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

const plannerChunks = (text, usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500 }) => [
	{ type: "text-delta", index: 0, text },
	{ type: "usage", usage },
	{ type: "finish", reason: { kind: "stop" } },
];

/** Session events of one executor child: two tool calls (one failed), a retried step and a final answer. */
function childEvents() {
	const source = { kind: "model", provider: "deepseek-account", model: "deepseek-flash" };
	return [
		{ type: "assistant/attempt", seq: 1, data: { turn: 1, step: 1, stream: [{ type: "chunk", chunk: { type: "usage", usage: { inputTokens: 50, outputTokens: 0 } } }] } },
		{ type: "llm/retry-started", seq: 2, data: { turn: 1, step: 1, retry: 1 } },
		{ type: "assistant/message", seq: 3, data: { turn: 1, step: 1, message: { role: "assistant", content: [], source }, usage: { inputTokens: 100, outputTokens: 20 } } },
		{ type: "tool/call", seq: 4, data: { turn: 1, step: 1, callId: "c1", name: "edit" } },
		{ type: "tool/result", seq: 5, data: { message: { role: "tool", toolCallId: "c1", isError: true, content: [] } } },
		{ type: "assistant/message", seq: 6, data: { turn: 1, step: 2, message: { role: "assistant", content: [], source }, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100 } } },
		{ type: "tool/call", seq: 7, data: { turn: 1, step: 2, callId: "c2", name: "edit" } },
		{ type: "tool/result", seq: 8, data: { message: { role: "tool", toolCallId: "c2", isError: false, content: [] } } },
		{ type: "assistant/message", seq: 9, data: { turn: 1, step: 3, message: { role: "assistant", content: [{ type: "text", text: "done" }], source }, usage: { inputTokens: 5, outputTokens: 7 } } },
	];
}

/**
 * A Host context that runs the whole handoff: scripted planner responses, an in-memory file system,
 * and a subagent service whose children report the given stop reason.
 */
function harness({ responses, files = {}, stopReason = "completed", config = {}, badRoutes = {}, attachments, images = {}, userContent } = {}) {
	const tools = [];
	const store = new Map(Object.entries(files).map(([path, text]) => [`${CWD}/${path}`, text]));
	const llmCalls = [];
	const starts = [];
	const children = new Map();
	const logs = [];
	let command;
	let responseIndex = 0;

	const abs = (path, cwd = CWD) => {
		const normalized = path.replace(/\\/g, "/");
		return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("/") ? normalized : `${cwd}/${normalized}`;
	};
	// Like dsh-sandbox-policy: a session's cwd is its workspace-write root; agentless calls fall back to the deployment root.
	const sandboxPolicy = { resolve: ({ session } = {}) => ({ mode: "workspace-write", workspaceRoot: session ? CWD : "/deployment-root" }) };
	// Like dsh-fs-sandbox: a mutation without the session's policy uses the fallback root and is denied in the project.
	const sandboxFence = (path, policy) => {
		const root = (policy ?? sandboxPolicy.resolve()).workspaceRoot;
		if (!path.startsWith(`${root}/`)) throw new Error(`cannot write "${path}": file access denied under workspace-write mode`);
	};
	const ctx = {
		effect: (callback) => callback(),
		logger: { warn: (line) => logs.push(["warn", line]), error: () => {}, info: (line) => logs.push(["info", line]) },
		get: (name) => (name === "attachments" ? attachments : name === "sandboxPolicy" ? sandboxPolicy : undefined),
		systemPrompt: { section: () => () => {} },
		tools: {
			register: (definition, options) => {
				tools.push({ definition, options });
				return () => {};
			},
			guard: () => () => {},
		},
		commands: {
			register: (definition) => {
				command = definition;
				return () => {};
			},
		},
		on: () => () => {},
		llm: {
			resolveModelInfo: async (provider, model) => {
				const reason = badRoutes[`${provider}/${model}`];
				if (reason) throw new Error(reason);
				return { provider, id: model, defaultMaxTokens: 64000, reasoning: { efforts: [{ id: "high" }] } };
			},
			prepareCall: async (config) => ({
				config,
				async *stream(options) {
					llmCalls.push(options);
					const chunks = responses[Math.min(responseIndex++, responses.length - 1)];
					for (const chunk of chunks) {
						if (chunk === "abort") {
							const error = new Error("aborted");
							error.name = "AbortError";
							throw error;
						}
						yield chunk;
					}
				},
			}),
		},
		subagents: {
			list: () => ["spawn"],
			async startActivation(spec) {
				starts.push(spec);
				children.set(spec.childId, { id: spec.childId, session: { header: {}, snapshotEvents: () => childEvents() } });
				// A list scripts the stop reason of each executor start in turn; the last one repeats.
				const reason = Array.isArray(stopReason) ? stopReason[Math.min(starts.length - 1, stopReason.length - 1)] : stopReason;
				return {
					childId: spec.childId,
					result: Promise.resolve({ output: [{ type: "text", text: "all done" }], stopReason: reason, ...(reason === "completed" ? {} : { diagnostic: "rate limited" }) }),
					async dispose() {},
				};
			},
		},
		agents: { get: (id) => children.get(id) },
		fs: {
			resolve: async (path, options) => abs(path, options?.cwd),
			stat: async (path) =>
				store.has(path) ? { type: "file", size: store.get(path).length } : images[path] ? { type: "file", size: images[path].length } : undefined,
			readBytes: async (path) => {
				if (!images[path]) throw new Error("ENOENT");
				return images[path];
			},
			readText: async (path) => {
				if (!store.has(path)) throw new Error("ENOENT");
				return store.get(path);
			},
			writeText: async (path, text, expected, signal, policy) => {
				sandboxFence(path, policy);
				store.set(path, text);
			},
			deleteFile: async (path, expected, signal, policy) => {
				sandboxFence(path, policy);
				store.delete(path);
			},
		},
		workingDirectory: { get: () => CWD },
	};

	const events = [
		{ type: "turn/end", seq: 1, data: {} },
		{ type: "user/message", seq: 2, data: { role: "user", content: userContent ?? [{ type: "text", text: "Rename the greeting in src/a.ts" }] } },
		{
			type: "assistant/message",
			seq: 3,
			data: { message: { role: "assistant", content: [{ type: "tool-call", id: "t1", name: "read", arguments: JSON.stringify({ file_path: "src/a.ts" }) }] } },
		},
		{ type: "tool/result", seq: 4, data: { message: { role: "tool", toolCallId: "t1", source: { callId: "t1" }, content: [{ type: "text", text: "[#1]\nhello" }], isError: false } } },
	];
	const agent = {
		id: "scout-1",
		session: {
			id: "scout-1",
			header: {},
			// Like DSH: the whole log, or the [start, end) seq range; append commits a new event at the end.
			snapshotEvents: (start, end) => (start === undefined ? events : events.filter((event) => event.seq >= start && event.seq < (end ?? Infinity))),
			append: (type, data, meta = {}) => {
				const event = { type, seq: events.length + 1, data, ...meta };
				events.push(event);
				return event;
			},
		},
		model: { current: () => ({ provider: "deepseek-account", model: "deepseek-flash" }), select() {} },
	};

	apply(ctx, { enabled: true, plannerModel: "code-gemini/gemini-4-argon", planDir: PLAN_DIR, ...config });
	const tool = (name) => tools.find((entry) => entry.definition.name === name).definition;

	let concluded = 0;
	const controller = new AbortController();
	const exec = { callId: "call-1", agent, signal: controller.signal, concludeTurn: () => concluded++ };
	const run = (args = { notes: "a.ts greets", files: ["src/a.ts"] }) => tool("handoff").execute(args, exec);
	/** Persist a handoff result the way DSH does: meta on the tool/result event. */
	const persist = (value) => {
		const meta = tool("handoff").output.presentationMeta({}, value);
		events.push({ type: "tool/result", seq: events.length + 1, data: { message: { role: "tool", source: { callId: "call-1" }, content: [] }, meta } });
	};
	const mix = (rawInput) => command.handler({ agent, rawInput });
	return { ctx, tool, run, exec, events, store, llmCalls, starts, logs, persist, mix, controller, concluded: () => concluded };
}

test("a handoff returns a lossless trace of the planner, auto-apply and executor", async () => {
	const h = harness({ responses: [plannerChunks(editPlan("hello", "hi"))], files: { "src/a.ts": "hello\n" } });
	const value = await h.run();

	assert.equal(value.status, "done");
	assert.equal(h.concluded(), 1);
	assert.equal(h.store.get(`${CWD}/src/a.ts`), "hi\n");
	assert.deepEqual(JSON.parse(JSON.stringify(value)), value, "DSH rejects values that are not lossless JSON");

	const trace = value.trace;
	assert.equal(trace.v, 1);
	assert.equal(trace.callId, "call-1");
	assert.equal(trace.status, "done");
	assert.equal(trace.health, "ok");
	assert.equal(trace.request, "Rename the greeting in src/a.ts");
	assert.deepEqual(trace.models, {
		scout: "deepseek-account/deepseek-flash",
		planner: "code-gemini/gemini-4-argon",
		executor: "deepseek-account/deepseek-flash (inherited)",
	});
	assert.equal(trace.package.steps, 1);
	assert.deepEqual(trace.package.files, [{ path: "src/a.ts", chars: 6 }]);

	const [planner] = trace.stages;
	assert.equal(planner.kind, "planner");
	assert.equal(planner.status, "ok");
	assert.equal(planner.model, "code-gemini/gemini-4-argon");
	assert.equal(planner.changes, 1);
	assert.equal(planner.effort, "high");
	assert.deepEqual(planner.usage, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500, cacheWriteTokens: 0 });
	assert.ok(planner.durationMs >= 0);

	assert.equal(trace.apply.files[0].status, "applied");
	assert.equal(trace.plan.changes, 1);
	assert.match(trace.plan.text, /<<<<<<< SEARCH/);

	const [executor] = trace.executors;
	assert.equal(executor.childId, h.starts[0].childId);
	assert.equal(executor.stopReason, "completed");
	assert.equal(executor.toolCalls, 2);
	assert.equal(executor.toolErrors, 1);
	assert.equal(executor.retries, 1);
	assert.equal(executor.actualModel, "deepseek-account/deepseek-flash");
	assert.deepEqual(executor.usage, { inputTokens: 165, outputTokens: 32, cacheReadTokens: 100, cacheWriteTokens: 0 });
	assert.deepEqual(trace.totals.planner, planner.usage);

	// The executor child is labeled after the request so the subagent catalog tells runs apart.
	assert.match(h.starts[0].label, /^MixAgent · Rename the greeting/);

	// The model only sees the report; the trace is presentation metadata.
	const rendered = h.tool("handoff").output.render({}, value);
	assert.equal(rendered.length, 1);
	assert.equal(rendered[0].text, value.report);
	assert.doesNotMatch(rendered[0].text, /"stages"/);
	assert.match(value.report, /auto-applied 1 of 1 file\(s\)/);
	assert.match(value.report, /executed · .* · 2 tool call\(s\) \(1 failed\) · 297 tokens/);
	assert.match(value.report, /MixAgent run: .* · planner 1\.7k tokens · executors 297 tokens/);

	const meta = h.tool("handoff").output.presentationMeta({}, value);
	assert.equal(meta.kind, TRACE_KIND);
	assert.equal(meta.status, "done");
	assert.deepEqual(meta.trace, trace);
	assert.equal(h.tool("discard").output.presentationMeta, undefined);
	assert.ok(h.logs.some(([level, line]) => level === "info" && /handoff call-1 done/.test(line)));
});

test("a planner failure is an error trace with the provider failure identity and usage", async () => {
	const failure = { message: "overloaded", code: "RATE_LIMIT", status: 429, requestId: "req-7" };
	const h = harness({
		responses: [[{ type: "usage", usage: { inputTokens: 900, outputTokens: 0 } }, { type: "finish", reason: { kind: "error", failure } }]],
		files: { "src/a.ts": "hello\n" },
	});
	const value = await h.run();
	assert.equal(value.status, "error");
	assert.equal(value.report, "Planner call failed: overloaded");
	assert.equal(h.concluded(), 1);
	assert.equal(h.starts.length, 0);
	assert.equal(value.trace.health, "error");
	assert.equal(value.trace.error, "Planner call failed: overloaded");
	const [stage] = value.trace.stages;
	assert.equal(stage.status, "error");
	assert.deepEqual(stage.error, { message: "overloaded", code: "RATE_LIMIT", status: 429, requestId: "req-7" });
	assert.equal(stage.usage.inputTokens, 900);
	assert.equal(h.tool("handoff").output.presentationMeta({}, value).status, "error");
	assert.ok(h.logs.some(([level, line]) => level === "warn" && /overloaded/.test(line)));
});

test("skipped files reach the report and a stopped executor makes the run a warning", async () => {
	const h = harness({ responses: [plannerChunks(editPlan("missing line", "x"))], files: { "src/a.ts": "hello\n" }, stopReason: "error" });
	const value = await h.run();
	assert.equal(value.status, "done");
	assert.equal(value.trace.apply.files[0].status, "skipped");
	assert.match(value.report, /→ src\/a\.ts: SEARCH block 1 does not match the file exactly/);
	assert.match(value.report, /stopped \(error\): rate limited/);
	assert.equal(value.trace.executors[0].diagnostic, "rate limited");
	assert.equal(value.trace.health, "warn");
});

test("a planner answer and a context request are traced without an executor", async () => {
	const answered = harness({ responses: [plannerChunks("## Answer\nIt prints hello.")] });
	const value = await answered.run();
	assert.equal(value.status, "answered");
	assert.equal(value.report, "It prints hello.");
	assert.equal(value.trace.executors.length, 0);
	assert.equal(value.trace.health, "ok");

	const context = harness({ responses: [plannerChunks("## Need context\nShow me src/b.ts")] });
	const need = await context.run();
	assert.equal(need.status, "need_context");
	assert.equal(context.concluded(), 0);
	assert.equal(need.trace.health, "info");
	assert.equal(need.trace.stages[0].needContext, true);
});

test("/mix last and /mix status read the handoff back from the session log", async () => {
	const h = harness({ responses: [plannerChunks(editPlan("hello", "hi"))], files: { "src/a.ts": "hello\n" } });
	assert.match(h.mix("last").text, /No handoff has run/);
	const value = await h.run();
	h.persist(value);

	const last = h.mix("last");
	assert.equal(last.kind, "success");
	assert.match(last.text, /^Last handoff: done/);
	assert.match(last.text, /✓ planner · code-gemini\/gemini-4-argon · .* · 1\.5k in \/ 200 out \(500 cached\) · 1 change\(s\)/);
	assert.match(last.text, /auto-apply: 1 applied · 0 left to the executor · 0 failed/);
	assert.match(last.text, /✓ MixAgent · Rename the greeting.* · completed · .* · 2 tool call\(s\), 1 failed · 1 retry · 297 tokens/);

	const status = h.mix("status").text;
	assert.match(status, /last handoff: done/);
	assert.match(status, /this session: 1 handoff\(s\) · planner 1\.5k in \/ 200 out \(500 cached\) · executors 265 in \/ 32 out \(100 cached\) · 2k tokens in all/);
});

test("a cancelled handoff is kept for /mix last although the log has no result", async () => {
	const h = harness({ responses: [["abort"]], files: { "src/a.ts": "hello\n" } });
	await assert.rejects(h.run(), (error) => error.name === "AbortError");
	const last = h.mix("last").text;
	assert.match(last, /^Last handoff: cancelled/);
	assert.match(last, /✗ planner · code-gemini\/gemini-4-argon/);
});

test("/mix status shows why a configured route is unavailable", async () => {
	const h = harness({ responses: [plannerChunks("x")], badRoutes: { "nope/missing": "unknown model nope/missing" }, config: { executorModel: "nope/missing" } });
	await flush();
	const status = h.mix("status").text;
	assert.match(status, /planner: code-gemini\/gemini-4-argon ✓/);
	assert.match(status, /executor: nope\/missing ✗ unavailable: unknown model nope\/missing → executor runs will fail/);
	assert.match(status, /scout: deepseek-account\/deepseek-flash \(session model\)/);
});

test("an unavailable planner route fails the handoff by name with the route's error", async () => {
	const h = harness({ responses: [plannerChunks("x")], badRoutes: { "code-gemini/gemini-4-argon": "no such provider" } });
	await flush();
	const value = await h.run();
	assert.equal(value.status, "error");
	assert.match(value.report, /configured planner model code-gemini\/gemini-4-argon is unavailable \(no such provider\)/);
	assert.equal(h.llmCalls.length, 0);
});

test("planner errors carry usage, generated length and the failure identity", async () => {
	const llm = {
		async resolveModelInfo() {
			return {};
		},
		async prepareCall(config) {
			return {
				config,
				async *stream() {
					yield { type: "text-delta", index: 0, text: "## Sum" };
					yield { type: "usage", usage: { inputTokens: 7, outputTokens: 3 } };
					yield { type: "finish", reason: { kind: "error", failure: { message: "boom", code: "X", status: 503, requestId: "r1" } } };
				},
			};
		},
	};
	await assert.rejects(runPlanner({ llm }, { provider: "p", model: "m", system: "s", text: "t" }), (error) => {
		assert.equal(error.message, "boom");
		assert.deepEqual(error.usage, { inputTokens: 7, outputTokens: 3 });
		assert.equal(error.chars, 6);
		assert.equal(error.stopReason, "error");
		assert.deepEqual(error.failure, { code: "X", status: 503, requestId: "r1" });
		return true;
	});
});

test("runExecutor reports duration and the child's statistics read before disposal", async () => {
	let disposed = false;
	const child = { session: { header: {}, snapshotEvents: () => (disposed ? [] : childEvents()) } };
	const subagents = {
		async startActivation(spec) {
			return {
				childId: spec.childId,
				result: Promise.resolve({ output: [{ type: "text", text: "ok" }], stopReason: "completed" }),
				async dispose() {
					disposed = true;
				},
			};
		},
	};
	const run = await runExecutor({ subagents, agents: { get: () => child } }, { parent: {}, providerName: "spawn", kickoff: "K" });
	assert.equal(disposed, true);
	assert.ok(run.durationMs >= 0);
	assert.equal(run.stats.toolCalls, 2);
	assert.equal(run.stats.steps, 3);

	const bare = await runExecutor({ subagents }, { parent: {}, providerName: "spawn", kickoff: "K" });
	assert.equal(bare.stats, undefined);
});

test("sessionStats folds usage like DSH's token meter: last sample per attempt, retries add up", () => {
	const stats = sessionStats(childEvents());
	assert.equal(stats.steps, 3);
	assert.equal(stats.retries, 1);
	assert.deepEqual(stats.tools, { edit: 2 });
	assert.deepEqual(stats.usage, { inputTokens: 165, outputTokens: 32, cacheReadTokens: 100, cacheWriteTokens: 0 });
	const failed = sessionStats([{ type: "turn/end", data: { reason: { kind: "error", error: { message: "429: overloaded", code: "RATE_LIMIT" } } } }]);
	assert.deepEqual(failed.error, { message: "429: overloaded", code: "RATE_LIMIT" });
});

test("trace helpers format, total and stay lossless", () => {
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1234), "1.2k");
	assert.equal(formatTokens(123_456), "123k");
	assert.equal(formatTokens(2_500_000), "2.5M");
	assert.equal(formatDuration(4200), "4.2s");
	assert.equal(formatDuration(42_000), "42s");
	assert.equal(formatDuration(192_000), "3m 12s");
	assert.equal(formatDuration(3_720_000), "1h 02m");
	assert.equal(usageTotal({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }), 10);
	assert.equal(addUsage(undefined, undefined), undefined);

	const trace = createTrace({ callId: undefined, request: "line one\nline two", models: { scout: "a/b", planner: undefined }, now: 1000 });
	const final = finalizeTrace(trace, { status: "done", now: 4000 });
	assert.deepEqual(JSON.parse(JSON.stringify(final)), final);
	assert.equal(final.request, "line one");
	assert.equal(final.durationMs, 3000);
	assert.equal("callId" in final, false);
	assert.deepEqual(final.models, { scout: "a/b" });
	assert.match(renderTrace(final), /^Last handoff: done · 3\.0s/);

	const meta = presentationMeta({ status: "done", report: "r", trace: final });
	const events = [
		{ type: "tool/result", seq: 1, data: { meta } },
		{ type: "tool/result", seq: 2, data: { meta: { cwd: "C:/" } } },
		{ type: "tool/result", seq: 3, data: { meta: { ...meta, trace: { ...final, callId: "x" } } } },
	];
	assert.equal(handoffTraces(events).length, 2);
});

test("an inherited executor runs on the scout route with the executor thinking level", async () => {
	const h = harness({ responses: [plannerChunks(editPlan("hello", "hi"))], files: { "src/a.ts": "hello\n" }, config: { executorThinking: "high" } });
	await h.run();
	assert.deepEqual(h.starts[0].request.agentOptions, { provider: "deepseek-account", model: "deepseek-flash", reasoningEffort: "high" });
});

test("an inherited executor without a thinking level keeps inheriting the scout selection", async () => {
	const h = harness({ responses: [plannerChunks(editPlan("hello", "hi"))], files: { "src/a.ts": "hello\n" } });
	await h.run();
	assert.equal(h.starts[0].request.agentOptions, undefined);
});

// ------------------------------------------------------------------ fixes: images, plan file, retries, join cut-off, pruning

const imageBlock = (id) => ({ type: "image", attachment: { attachmentId: id, mediaType: "image/png", bytes: 4, width: 1, height: 1 } });
const userContent = [{ type: "text", text: "Rename the greeting in src/a.ts" }, imageBlock("att-user")];

/** A fake attachment store that records what it saved. */
function attachmentStore() {
	const saved = [];
	return {
		saved,
		imageLimits: { mediaTypes: ["image/png", "image/jpeg"], maxImageBytes: 1000, maxMessageImageBytes: 1000 },
		saveImage: async (input) => {
			saved.push(input);
			return { attachmentId: `att-key-${saved.length}`, mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1, name: input.name };
		},
	};
}

test("the user's image and an image key file reach every planner call as images", async () => {
	const attachments = attachmentStore();
	const h = harness({
		responses: [plannerChunks(editPlan("hello", "hi"))],
		files: { "src/a.ts": "hello\n" },
		attachments,
		images: { [`${CWD}/mock.png`]: new Uint8Array([1, 2, 3, 4]) },
		userContent,
	});
	const value = await h.run({ notes: "see mock", files: ["src/a.ts", "mock.png"] });
	assert.equal(value.status, "done");
	assert.equal(attachments.saved[0].name, "mock.png");
	const content = h.llmCalls[0].messages[0].content;
	const sent = content.filter((block) => block.type === "image").map((block) => block.attachment.attachmentId);
	assert.deepEqual(sent, ["att-user", "att-key-1"]);
	assert.ok(content.some((block) => block.type === "text" && block.text === "[image 1] attached by the user:"));
	assert.ok(content.some((block) => block.type === "text" && block.text === "[image 2] key file mock.png:"));
	assert.equal(value.trace.package.images, 2);
	assert.deepEqual(value.trace.package.files[1], { path: "mock.png", image: true });
});

test("a route over its image budget gets the images again as placeholders", async () => {
	const h = harness({
		responses: [
			[{ type: "finish", reason: { kind: "error", failure: { code: "IMAGE_OFFLOAD_REQUIRED", message: "offload 1 image" } } }],
			plannerChunks(editPlan("hello", "hi")),
		],
		files: { "src/a.ts": "hello\n" },
		userContent,
	});
	const value = await h.run();
	assert.equal(value.status, "done");
	const retried = h.llmCalls[1].messages[0].content.find((block) => block.type === "image");
	assert.equal(retried.offloaded, true);
});

test("an image-only request still plans instead of failing the handoff", async () => {
	const h = harness({ responses: [plannerChunks(editPlan("hello", "hi"))], files: { "src/a.ts": "hello\n" }, userContent: [imageBlock("att-user")] });
	const value = await h.run();
	assert.equal(value.status, "done");
	assert.match(value.trace.request, /attached image/);
});

test("the plan is saved with its request header, also when the planner only answers", async () => {
	const done = await harness({ responses: [plannerChunks(editPlan("hello", "hi"))], files: { "src/a.ts": "hello\n" } }).run();
	const saved = readFileSync(done.trace.plan.path, "utf8");
	assert.match(saved, /^# MixAgent plan\n\n## Request\n\nRename the greeting in src\/a\.ts\n\n## Summary/);
	assert.match(done.report, /plan: .*mixagent-.*\.md/);

	const answered = await harness({ responses: [plannerChunks("## Answer\nIt already says hi.")] }).run();
	assert.equal(answered.status, "answered");
	assert.match(readFileSync(answered.trace.plan.path, "utf8"), /## Answer\nIt already says hi\./);
});

const fence = "````";
const block = (search, replace) => `${fence}text\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n${fence}`;
const twoTaskPlan = [
	"## Summary\nTwo files.",
	"## Changes",
	`### \`src/a.ts\` — edit\nA.\n\n${block("nope-a", "x")}`,
	`### \`src/b.ts\` — edit\nB.\n\n${block("nope-b", "y")}`,
	"## Tasks\n- T1: `src/a.ts` — edit a\n- T2: `src/b.ts` — edit b",
	"## Commands\nnpm test\n",
].join("\n\n");

test("a failed task executor is retried with the retry note, and the commands run once every task completed", async () => {
	// Executor starts run in order T1, T2 (parallel pool), then T1's retry, then the commands executor.
	const h = harness({
		responses: [plannerChunks(twoTaskPlan)],
		files: { "src/a.ts": "a\n", "src/b.ts": "b\n" },
		stopReason: ["error", "completed", "completed", "completed"],
	});
	const value = await h.run({ notes: "n", files: [] });
	assert.equal(value.status, "done");
	assert.equal(h.starts.length, 4);
	const retry = h.starts.find((start, index) => index > 1 && start.label.startsWith("MixAgent T1"));
	assert.match(retry.request.prompt[0].text, /a previous attempt at this task failed \(error: rate limited\)/);
	assert.match(value.report, /✓ T1 executed after 2 attempt\(s\)/);
	assert.match(value.report, /✓ commands executed/);
	const t1 = value.trace.executors.filter((run) => run.taskId === "T1");
	assert.deepEqual(
		t1.map((run) => [run.attempt, run.superseded === true]),
		[
			[1, true],
			[2, false],
		],
	);
	assert.equal(value.trace.health, "ok", "a retry that succeeded does not make the run a warning");
});

test("a task that fails every attempt skips the commands and says so", async () => {
	const h = harness({
		responses: [plannerChunks(twoTaskPlan)],
		files: { "src/a.ts": "a\n", "src/b.ts": "b\n" },
		stopReason: ["error", "completed", "error", "error"],
	});
	const value = await h.run({ notes: "n", files: [] });
	assert.equal(h.starts.length, 4, "T1 three times, T2 once, no commands executor");
	assert.match(value.report, /✗ T1 failed after 3 attempt\(s\): error: rate limited/);
	assert.match(value.report, /commands not run: a task failed/);
	assert.equal(value.trace.health, "warn");
});

const leadSplit = "## Summary\nSplit.\n\n## Subtasks\n- S1: `src/a.ts` — rename a\n- S2: `src/b.ts` — rename b\n";
const subPlan = (path, search, replace) => `## Changes\n\n### \`${path}\` — edit\nRename.\n\n${block(search, replace)}\n`;

test("a join cut off at its output limit still runs the executor, which completes the plan from the saved file", async () => {
	const truncatedJoin = "## Summary\nBoth renamed.\n\n## Revisions\n### `src/a.ts`\nKeep the export name.\n\n## Commands\nnpm te";
	const h = harness({
		responses: [
			plannerChunks(leadSplit),
			plannerChunks(subPlan("src/a.ts", "hello", "hi")),
			plannerChunks(subPlan("src/b.ts", "bye", "ciao")),
			[
				{ type: "text-delta", index: 0, text: truncatedJoin },
				{ type: "finish", reason: { kind: "max-tokens" } },
			],
		],
		files: { "src/a.ts": "hello\n", "src/b.ts": "bye\n" },
	});
	const value = await h.run({ notes: "n", files: [] });
	assert.equal(value.status, "done");
	// The complete sub-plans are still auto-applied; a file with a finished join revision is left to the executor.
	assert.equal(h.store.get(`${CWD}/src/b.ts`), "ciao\n");
	assert.equal(h.store.get(`${CWD}/src/a.ts`), "hello\n");
	assert.equal(h.starts.length, 1);
	const kickoff = h.starts[0].request.prompt[0].text;
	assert.match(kickoff, /the join planner, .* stopped at its output limit/);
	assert.ok(kickoff.includes(`saved at ${value.trace.plan.path}`), "the executor is pointed at the saved plan");
	assert.match(kickoff, /Keep the export name\./, "the review sections that finished are kept");
	assert.doesNotMatch(kickoff, /npm te\b/, "the section that was being written is not executed");
	const saved = readFileSync(value.trace.plan.path, "utf8");
	assert.match(saved, /## Sub-plans\n\n### S1: rename a/);
	assert.match(saved, /## Join review \(cut off at the planner's output limit\)\n\n[\s\S]*npm te/);
	assert.deepEqual(value.trace.joinTruncated, { chars: truncatedJoin.length });
	assert.equal(value.trace.health, "warn");
	assert.match(value.report, /join stopped at its output limit/);
});

test("a join that fails for another reason still fails the handoff", async () => {
	const h = harness({
		responses: [
			plannerChunks(leadSplit),
			plannerChunks(subPlan("src/a.ts", "hello", "hi")),
			plannerChunks(subPlan("src/b.ts", "bye", "ciao")),
			[{ type: "finish", reason: { kind: "error", failure: { message: "overloaded" } } }],
		],
		files: { "src/a.ts": "hello\n", "src/b.ts": "bye\n" },
	});
	const value = await h.run({ notes: "n", files: [] });
	assert.equal(value.status, "error");
	assert.match(value.report, /Join planner call failed: overloaded/);
	assert.equal(h.starts.length, 0);
});

test("a finished handoff prunes the cycle's scout results from the scout's context", async () => {
	const h = harness({ responses: [plannerChunks(editPlan("hello", "hi"))], files: { "src/a.ts": "hello\n" } });
	await h.run();
	const replacement = h.events.find((event) => event.type === "tool/result" && event.surfaceOp?.op === "replace");
	assert.ok(replacement, "the read result was replaced");
	assert.equal(replacement.surfaceOp.startSeq, 4);
	assert.deepEqual(replacement.sourceEventSeqs, [4]);
	assert.equal(replacement.data.message.content[0].text, "[pruned by MixAgent after the handoff finished: read src/a.ts]");
	assert.equal(replacement.data.message.toolCallId, "t1", "the call stays paired with its result");
});

test("pruning is off with pruneScoutHistory: false, and a context request never prunes", async () => {
	const off = harness({ responses: [plannerChunks(editPlan("hello", "hi"))], files: { "src/a.ts": "hello\n" }, config: { pruneScoutHistory: false } });
	await off.run();
	assert.equal(
		off.events.some((event) => event.surfaceOp),
		false,
	);
	const asking = harness({ responses: [plannerChunks("## Need context\nShow b.ts")] });
	await asking.run();
	assert.equal(
		asking.events.some((event) => event.surfaceOp),
		false,
	);
});
