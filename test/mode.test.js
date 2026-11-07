import { test } from "node:test";
import assert from "node:assert/strict";

import { Config, apply } from "../index.js";

/** Minimal Host context: records the registrations the plugin makes and nothing else. */
function fakeContext(options = {}) {
	const sections = [];
	const tools = [];
	const listeners = new Map();
	let command;
	const ctx = {
		effect: (callback) => callback(),
		logger: { warn() {}, error() {}, info() {} },
		get: (name) =>
			name === "agentPresets" && options.preset !== undefined
				? { presetForSession: () => options.preset }
				: undefined,
		systemPrompt: {
			section: (definition) => {
				sections.push(definition);
				return () => {};
			},
		},
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
		on: (name, listener) => {
			listeners.set(name, listener);
			return () => {};
		},
		llm: { resolveModelInfo: async () => ({}), prepareCall: async () => ({}) },
		subagents: { list: () => ["spawn"] },
		fs: {},
		workingDirectory: { get: () => "C:/work" },
	};
	const agent = {
		id: "session-1",
		session: { id: "session-1", header: options.header ?? {}, snapshotEvents: () => [] },
		model: { current: () => ({ provider: "deepseek-account", model: "deepseek-flash" }), select() {} },
	};
	const section = (name) => sections.find((entry) => entry.name === name);
	const tool = (name) => tools.find((entry) => entry.definition.name === name);
	return { ctx, agent, command: () => command, section, tool };
}

test("Config defaults to normal conversations and declares every field as volatile", () => {
	const resolved = Config["~standard"].validate({});
	assert.equal(resolved.value.enabled.get(), false);
	assert.deepEqual(resolved.value.presets.get(), ["mix"]);
	for (const field of ["scoutModel", "plannerModel", "executorModel", "scoutThinking", "plannerThinking", "executorThinking"]) {
		assert.equal(typeof resolved.value[field].get, "function");
	}
	assert.equal(resolved.value.plannerThinking.get(), "high");
	assert.equal(resolved.value.scoutThinking.get(), "off");
	const keys = Object.keys(resolved.value);
	for (const field of ["plannerMaxTokens", "maxContextRounds", "forkJoin", "maxParallelPlanners", "maxParallelExecutors", "maxToolOutputChars", "maxFileChars", "maxPackageChars", "maxPlannerImages", "scoutBashGuard", "autoApply", "pruneScoutHistory", "discardRewritesContext", "planDir"]) {
		assert.ok(keys.includes(field), field);
	}
	assert.equal(resolved.value.plannerMaxTokens.get(), 32000);
	assert.equal(resolved.value.planDir.get(), "~/.dsh/mixagent/plans");
	const json = JSON.stringify(Config.toJSON());
	assert.equal((json.match(/"volatile":true/g) ?? []).length, keys.length);
	assert.ok(Config["~standard"].validate({ maxParallelExecutors: 99 }).issues, "a value outside the bounds is rejected");
});

test("every volatile field takes effect without re-applying the plugin", () => {
	let autoApply = true;
	let presets = ["mix"];
	let enabled = false;
	const { ctx, agent, command, section } = fakeContext({ preset: "mix" });
	apply(ctx, { enabled: { get: () => enabled }, presets: { get: () => presets }, autoApply: { get: () => autoApply } });
	assert.match(command().handler({ agent, rawInput: "status" }).text, /autoApply: on/);
	autoApply = false;
	assert.match(command().handler({ agent, rawInput: "status" }).text, /autoApply: off/);
	assert.match(section("mixagent:scout").text({ agent }), /MixAgent scout mode/);
	presets = [];
	assert.equal(section("mixagent:scout").text({ agent }), "");
	enabled = true;
	assert.match(section("mixagent:scout").text({ agent }), /MixAgent scout mode/);
});

test("a normal conversation receives no prompt and no MixAgent tools", () => {
	const { ctx, agent, section, tool } = fakeContext();
	apply(ctx, { enabled: false });
	assert.equal(section("mixagent:scout").text({ agent }), "");
	assert.equal(tool("handoff").options.when({ agent }), false);
	assert.equal(tool("discard").options.when({ agent }), false);
});

test("/mix on enters MixAgent mode and /mix off leaves it", () => {
	const { ctx, agent, command, section, tool } = fakeContext();
	apply(ctx, { enabled: false });
	assert.equal(command().handler({ agent, rawInput: "on" }).kind, "success");
	assert.match(section("mixagent:scout").text({ agent }), /MixAgent scout mode/);
	assert.equal(tool("handoff").options.when({ agent }), true);
	assert.equal(tool("discard").options.when({ agent }), true);
	assert.equal(command().handler({ agent, rawInput: "off" }).kind, "success");
	assert.equal(section("mixagent:scout").text({ agent }), "");
	assert.equal(tool("handoff").options.when({ agent }), false);
});

test("a volatile model route takes effect without re-applying the plugin", () => {
	let stored = "deepseek-account/deepseek-flash";
	const { ctx, agent, command } = fakeContext();
	apply(ctx, {
		enabled: false,
		scoutModel: { get: () => stored },
		plannerModel: { get: () => "" },
		executorModel: { get: () => "" },
	});
	assert.match(command().handler({ agent, rawInput: "status" }).text, /scout: deepseek-account\/deepseek-flash/);
	stored = "code-gemini/gemini-4-argon";
	assert.match(command().handler({ agent, rawInput: "status" }).text, /scout: code-gemini\/gemini-4-argon/);
});

test("a session composed from the mix preset starts in MixAgent mode", () => {
	const { ctx, agent, command, section, tool } = fakeContext({ preset: "mix" });
	apply(ctx, { enabled: false });
	assert.match(section("mixagent:scout").text({ agent }), /MixAgent scout mode/);
	assert.equal(tool("handoff").options.when({ agent }), true);
	assert.equal(tool("discard").options.when({ agent }), true);
	assert.match(command().handler({ agent, rawInput: "status" }).text, /on \(MixAgent preset\)/);
});

test("the durable session header activates the preset when no registry is composed", () => {
	const { ctx, agent, section } = fakeContext({ header: { agentPreset: "mix" } });
	apply(ctx, { enabled: false });
	assert.match(section("mixagent:scout").text({ agent }), /MixAgent scout mode/);
});

test("/mix off leaves preset mode and /mix on re-enters it", () => {
	const { ctx, agent, command, section } = fakeContext({ preset: "mix" });
	apply(ctx, { enabled: false });
	command().handler({ agent, rawInput: "off" });
	assert.equal(section("mixagent:scout").text({ agent }), "");
	assert.match(command().handler({ agent, rawInput: "status" }).text, /is off/);
	command().handler({ agent, rawInput: "on" });
	assert.match(section("mixagent:scout").text({ agent }), /MixAgent scout mode/);
});

test("an empty presets list disables preset activation", () => {
	const { ctx, agent, section, tool } = fakeContext({ preset: "mix" });
	apply(ctx, { enabled: false, presets: [] });
	assert.equal(section("mixagent:scout").text({ agent }), "");
	assert.equal(tool("handoff").options.when({ agent }), false);
});

test("another preset leaves the conversation normal", () => {
	const { ctx, agent, section, tool } = fakeContext({ preset: "standard" });
	apply(ctx, { enabled: false });
	assert.equal(section("mixagent:scout").text({ agent }), "");
	assert.equal(tool("handoff").options.when({ agent }), false);
});

/** A context whose routes all resolve with the given thinking levels, and an agent that records selections. */
function thinkingContext(efforts = ["low", "medium", "high"]) {
	const fake = fakeContext();
	fake.ctx.llm.resolveModelInfo = async () => ({ reasoning: { efforts: efforts.map((id) => ({ id })) } });
	let current = { provider: "deepseek-account", model: "deepseek-flash" };
	const selected = [];
	fake.agent.model = {
		current: () => current,
		select: (selection) => {
			selected.push(selection);
			current = selection;
		},
	};
	return { ...fake, selected, current: () => current };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a volatile thinking level takes effect without re-applying the plugin", async () => {
	let stored = "low";
	const { ctx, agent, command } = thinkingContext();
	apply(ctx, { enabled: false, plannerThinking: { get: () => stored } });
	command().handler({ agent, rawInput: "status" });
	await tick();
	assert.match(command().handler({ agent, rawInput: "status" }).text, /planner: .* · thinking low/);
	stored = "";
	assert.match(command().handler({ agent, rawInput: "status" }).text, /planner: .* · thinking high/);
});

test("/mix thinking overrides one role for this session and default clears it", async () => {
	const { ctx, agent, command } = thinkingContext();
	apply(ctx, { enabled: false });
	assert.equal(command().handler({ agent, rawInput: "thinking executor medium" }).kind, "success");
	await tick();
	const status = command().handler({ agent, rawInput: "status" }).text;
	assert.match(status, /executor: .* · thinking medium \[\/mix override\]/);
	assert.match(command().handler({ agent, rawInput: "thinking executor xhigh" }).text, /thinking xhigh \(not offered by this model; it offers low, medium, high/);
	command().handler({ agent, rawInput: "thinking executor default" });
	assert.match(command().handler({ agent, rawInput: "status" }).text, /executor: .* · thinking off \(model default\)$/m);
	assert.equal(command().handler({ agent, rawInput: "thinking nobody high" }).kind, "error");
});

test("the scout thinking level applies to the session model and /mix off hands the session its own level back", async () => {
	const { ctx, agent, command, current } = thinkingContext();
	agent.model.select({ provider: "deepseek-account", model: "deepseek-flash", reasoningEffort: "low" });
	apply(ctx, { enabled: false, scoutThinking: "high" });
	command().handler({ agent, rawInput: "on" });
	await tick();
	assert.deepEqual(current(), { provider: "deepseek-account", model: "deepseek-flash", reasoningEffort: "high" });
	command().handler({ agent, rawInput: "off" });
	assert.deepEqual(current(), { provider: "deepseek-account", model: "deepseek-flash", reasoningEffort: "low" });
});

test("a scout thinking level the model does not offer leaves the session untouched", async () => {
	const { ctx, agent, command, selected } = thinkingContext(["low"]);
	apply(ctx, { enabled: false, scoutThinking: "max" });
	await tick();
	command().handler({ agent, rawInput: "on" });
	assert.equal(selected.length, 0);
});

test("a configured scout route gets its thinking level", async () => {
	const { ctx, agent, command, current } = thinkingContext();
	apply(ctx, { enabled: false, scoutModel: "code-gemini/gemini-4-argon", scoutThinking: "medium" });
	await tick();
	command().handler({ agent, rawInput: "on" });
	assert.deepEqual(current(), { provider: "code-gemini", model: "gemini-4-argon", reasoningEffort: "medium" });
	command().handler({ agent, rawInput: "thinking scout off" });
	assert.deepEqual(current(), { provider: "code-gemini", model: "gemini-4-argon" });
});
