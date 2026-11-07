import { test } from "node:test";
import assert from "node:assert/strict";

import { mapLimit, runExecutor, runPlanner } from "../pipeline.js";

function fakeLlm(chunks) {
	const calls = [];
	return {
		calls,
		async prepareCall(config) {
			calls.push({ config });
			return {
				config,
				async *stream(options) {
					calls.push({ options });
					for (const chunk of chunks) yield chunk;
				},
			};
		},
	};
}

test("planner sends one tool-less message with the system prompt", async () => {
	const llm = fakeLlm([
		{ type: "text-delta", index: 0, text: "## Summary\n" },
		{ type: "text-delta", index: 0, text: "ok" },
		{ type: "usage", usage: { inputTokens: 10, outputTokens: 2 } },
		{ type: "finish", reason: { kind: "stop" } },
	]);
	const result = await runPlanner(
		{ llm },
		{
			provider: "p",
			model: "m",
			reasoningEffort: "high",
			system: "SYS",
			text: "PKG",
			extra: "EXTRA",
			maxTokens: 1234,
			sessionId: "s1",
		},
	);
	assert.equal(result.text, "## Summary\nok");
	assert.equal(result.usage.outputTokens, 2);
	assert.equal(result.stopReason, "stop");
	const streamed = llm.calls[1].options;
	assert.equal(streamed.system, "SYS");
	assert.equal(streamed.maxTokens, 1234);
	assert.equal(streamed.messages.length, 1);
	assert.equal(streamed.messages[0].role, "user");
	assert.equal(streamed.messages[0].content[0].text, "PKG\nEXTRA");
	assert.equal(streamed.tools, undefined);
});

test("planner surfaces a model failure", async () => {
	const llm = fakeLlm([{ type: "finish", reason: { kind: "error", failure: { message: "boom", code: "X" } } }]);
	await assert.rejects(
		runPlanner({ llm }, { provider: "p", model: "m", system: "s", text: "t" }),
		/boom/,
	);
});

test("planner rejects an empty response", async () => {
	const llm = fakeLlm([
		{ type: "text-delta", index: 0, text: "  \n " },
		{ type: "finish", reason: { kind: "stop" } },
	]);
	await assert.rejects(
		runPlanner({ llm }, { provider: "p", model: "m", system: "s", text: "t" }),
		/planner returned an empty response/,
	);
});

test("planner rejects max-tokens even when partial text was generated", async () => {
	const llm = fakeLlm([
		{ type: "text-delta", index: 0, text: "## Summary\nparti" },
		{ type: "usage", usage: { inputTokens: 1, outputTokens: 2 } },
		{ type: "finish", reason: { kind: "max-tokens" } },
	]);
	await assert.rejects(
		runPlanner({ llm }, { provider: "p", model: "m", system: "s", text: "t" }),
		/token limit after 16 characters/,
	);
});

test("planner rejects an aborted request as an AbortError", async () => {
	const llm = fakeLlm([{ type: "finish", reason: { kind: "aborted" } }]);
	await assert.rejects(
		runPlanner({ llm }, { provider: "p", model: "m", system: "s", text: "t" }),
		(error) => {
			assert.equal(error.name, "AbortError");
			return true;
		},
	);
});

test("planner rejects unexpected tool calls", async () => {
	const llm = fakeLlm([{ type: "finish", reason: { kind: "tool-calls" } }]);
	await assert.rejects(
		runPlanner({ llm }, { provider: "p", model: "m", system: "s", text: "t" }),
		/no tools were sent/,
	);
});

test("executor starts one fresh child with the kickoff and caller delivery", async () => {
	const starts = [];
	const ends = [];
	const subagents = {
		async startActivation(spec) {
			starts.push(spec);
			return {
				childId: spec.childId,
				result: Promise.resolve({ output: [{ type: "text", text: "all done" }], stopReason: "completed" }),
				async dispose() {},
			};
		},
	};
	const parent = { id: "parent" };
	const result = await runExecutor(
		{ subagents, onChildStart: (id) => starts.push({ started: id }), onChildEnd: (id) => ends.push(id) },
		{
			parent,
			providerName: "spawn",
			cwd: "C:/work",
			selection: { provider: "p", model: "m" },
			kickoff: "KICK",
		},
	);
	assert.equal(result.output, "all done");
	assert.equal(result.stopReason, "completed");
	assert.deepEqual(ends, [result.childId]);

	const spec = starts[1];
	assert.equal(spec.provider, "spawn");
	assert.equal(spec.delivery, "caller");
	assert.equal(spec.request.parent, parent);
	assert.equal(spec.request.cwd, "C:/work");
	assert.deepEqual(spec.request.agentOptions, { provider: "p", model: "m" });
	assert.equal(spec.request.prompt[0].text, "KICK");
	assert.equal(starts[0].started, spec.childId);
});

/**
 * A stub that behaves like DSH's LlmRuntime.prepareCall: it materialises adapter defaults into
 * the prepared config and rejects any dispatch whose controls differ, field by field.
 */
function strictLlm({ defaultMaxTokens = 64000, efforts = ["low", "medium", "high"], defaultEffort = "medium" } = {}) {
	const calls = [];
	return {
		calls,
		async resolveModelInfo() {
			return {
				provider: "p",
				id: "m",
				name: "m",
				defaultMaxTokens,
				reasoning: { efforts: efforts.map((id) => ({ id, name: id })), defaultEffort },
			};
		},
		async prepareCall(config) {
			const resolved = {
				provider: config.provider,
				model: config.model,
				reasoningEffort: config.reasoningEffort ?? defaultEffort,
				maxTokens: config.maxTokens ?? defaultMaxTokens,
			};
			calls.push({ config, resolved });
			return {
				config: resolved,
				async *stream(options) {
					calls.push({ options });
					for (const key of ["provider", "model", "reasoningEffort", "maxTokens"]) {
						if (options[key] !== resolved[key]) throw new Error("prepared LLM call config changed before adapter dispatch");
					}
					yield { type: "text-delta", index: 0, text: "## Summary\nok" };
					yield { type: "finish", reason: { kind: "stop" } };
				},
			};
		},
	};
}

test("passes the output cap through prepareCall so dispatch matches the prepared config", async () => {
	const llm = strictLlm();
	const result = await runPlanner(
		{ llm },
		{ provider: "p", model: "m", reasoningEffort: "high", system: "S", text: "T", maxTokens: 32000 },
	);
	assert.equal(result.text, "## Summary\nok");
	assert.equal(llm.calls[0].config.maxTokens, 32000);
	assert.equal(llm.calls[1].options.maxTokens, 32000);
	assert.equal(llm.calls[1].options.reasoningEffort, "high");
});

test("lets prepareCall materialise the adapter default cap when none is configured", async () => {
	const llm = strictLlm();
	await runPlanner({ llm }, { provider: "p", model: "m", system: "S", text: "T" });
	assert.equal(llm.calls[0].config.maxTokens, undefined);
	assert.equal(llm.calls[1].options.maxTokens, 64000);
	assert.equal(llm.calls[1].options.reasoningEffort, "medium");
});

test("dispatches the adapter default effort when the requested one is unsupported", async () => {
	const llm = strictLlm({ efforts: ["low", "medium"], defaultEffort: "low" });
	await runPlanner({ llm }, { provider: "p", model: "m", reasoningEffort: "high", system: "S", text: "T", maxTokens: 1000 });
	assert.equal(llm.calls[0].config.reasoningEffort, undefined);
	assert.equal(llm.calls[1].options.reasoningEffort, "low");
	assert.equal(llm.calls[1].options.maxTokens, 1000);
});

test("mapLimit keeps order and respects the limit", async () => {
	let active = 0;
	let peak = 0;
	const out = await mapLimit([1, 2, 3, 4, 5], 2, async (value) => {
		active += 1;
		peak = Math.max(peak, active);
		await new Promise((resolve) => setTimeout(resolve, 5 - value));
		active -= 1;
		return value * 2;
	});
	assert.deepEqual(out, [2, 4, 6, 8, 10]);
	assert.ok(peak <= 2);
});
