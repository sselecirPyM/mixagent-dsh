import { test } from "node:test";
import assert from "node:assert/strict";

import { beginStage, createTrace, endStage, finalizeTrace, presentationMeta } from "../trace.js";

// ------------------------------------------------------------------ a minimal browser environment

const Fragment = Symbol("Fragment");
function createElement(type, props, ...children) {
	return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } };
}
/** Hooks for one synchronous render: state keeps its initial value, effects are collected. */
const effects = [];
const React = {
	createElement,
	Fragment,
	useState: (init) => [typeof init === "function" ? init() : init, () => {}],
	useEffect: (effect) => {
		effects.push(effect);
	},
	useMemo: (factory) => factory(),
	useCallback: (callback) => callback,
	useRef: (value) => ({ current: value }),
};
const Prim = new Proxy(
	{},
	{
		get(_target, name) {
			if (name === "MarkdownText") return (props) => createElement("div", { "data-markdown": true }, props.text);
			if (name === "StateDot") return (props) => createElement("i", { "data-state": props.state });
			if (name === "TextShimmer") return (props) => createElement("span", { "data-shimmer": props.active ? "on" : "off" }, props.children);
			return () => createElement("svg", { "data-icon": String(name) });
		},
	},
);
const modules = { react: React, "@deepseek-ai/dsh-client-ui-primitives": Prim };

let loaded;
globalThis.window = { __ModuleLoader__: { load: (definition) => (loaded = definition) } };
const styles = [];
globalThis.document = {
	createElement: () => {
		const tag = { dataset: {}, removed: false, remove: () => (tag.removed = true) };
		return tag;
	},
	head: { appendChild: (tag) => styles.push(tag) },
};
await import("../client.js");
const plugin = loaded.factory((name) => {
	if (!(name in modules)) throw new Error(`unexpected require(${name})`);
	return modules[name];
});

const registered = [];
const disposers = [];
const opened = [];
let dictionaries;
plugin.apply({
	effect: (callback) => disposers.push(callback()),
	locale: { register: (_ns, dicts) => ((dictionaries = dicts), () => {}) },
	configForms: { get: () => ({}) },
	remote: { session: undefined },
	slots: { inject: (_name, factory) => factory(), register: (options, component) => (registered.push({ options, component }), () => {}) },
	get: (name) => (name === "uiWorkspace" ? { openSession: (target) => opened.push(target) } : undefined),
});
const card = registered.find((entry) => entry.options.name === "tool.call.toolview");

const missing = new Set();
const translator = (language) => (key, params = {}) => {
	const template = dictionaries[language][key];
	if (template === undefined) missing.add(key);
	return String(template ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));
};

/** Expand function components into a host-element tree. */
function render(node) {
	if (node === null || node === undefined || node === false || node === true) return [];
	if (typeof node === "string" || typeof node === "number") return [String(node)];
	if (Array.isArray(node)) return node.flatMap(render);
	if (typeof node.type === "function") return render(node.type(node.props));
	if (node.type === Fragment) return render(node.props.children);
	const { children, ...props } = node.props;
	return [{ type: node.type, props, children: render(children) }];
}
const textOf = (nodes) => nodes.map((node) => (typeof node === "string" ? node : textOf(node.children))).join("");
function findAll(nodes, predicate, out = []) {
	for (const node of nodes) {
		if (typeof node === "string") continue;
		if (predicate(node)) out.push(node);
		findAll(node.children, predicate, out);
	}
	return out;
}
const byClass = (nodes, name) => findAll(nodes, (node) => String(node.props.className ?? "").split(" ").includes(`mxa-${name}`));

const T0 = Date.UTC(2026, 10, 6, 9, 0, 0);
const expanded = () => ({ expanded: true, setExpanded() {}, toggle() {} });

/** Render the card the way DSH's tool row does: owner props, standard props, `t` and the injected opener. */
function renderCard(owner, { catalog, byId = {}, statuses = new Map(), language = "en" } = {}) {
	effects.length = 0;
	const props = {
		callId: "call-1",
		toolName: "handoff",
		sessionId: "parent-1",
		t: translator(language),
		useDisclosure: expanded,
		useProjection: (key) => (key === "subagentCatalog" ? catalog : undefined),
		useSessions: (selector) => selector({ byId }),
		useSessionStatus: (selector) => selector(statuses),
		...card.options.inject("parent-1"),
		...owner,
	};
	return render(createElement(card.component, props));
}

/** A finished trace built with the Host's own trace helpers. */
function doneTrace({ applyStatus = "applied", stopReason = "completed" } = {}) {
	const trace = createTrace({
		callId: "call-1",
		request: "Rename the greeting",
		models: { scout: "ds/flash", planner: "gm/argon", executor: "ds/flash (inherited)" },
		now: T0,
	});
	trace.package = { chars: 4200, truncated: false, steps: 3, discarded: 0, round: 1, files: [{ path: "src/a.ts", chars: 6 }, { path: "b.ts", error: "not found" }] };
	const stage = beginStage(trace, { kind: "planner", model: "gm/argon" }, T0 + 100);
	endStage(stage, { result: { text: "plan", usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500 }, stopReason: "stop" } }, T0 + 12_100);
	stage.changes = 1;
	trace.plan = { chars: 120, changes: 1, text: "## Summary\nRename.\n\n## Changes\n...", path: "/plans/p.md" };
	trace.apply = { files: [{ path: "src/a.ts", kind: "edit", status: applyStatus, message: applyStatus === "applied" ? "" : "SEARCH block 1 does not match" }], durationMs: 40 };
	trace.executors.push({
		kind: "single",
		label: "MixAgent · Rename the greeting",
		model: "ds/flash",
		childId: "child-1",
		startedAt: T0 + 13_000,
		durationMs: 45_000,
		stopReason,
		outputChars: 10,
		steps: 3,
		toolCalls: 2,
		toolErrors: 1,
		retries: 1,
		tools: { edit: 2 },
		usage: { inputTokens: 165, outputTokens: 32, cacheReadTokens: 100, cacheWriteTokens: 0 },
		...(stopReason === "completed" ? {} : { diagnostic: "rate limited" }),
	});
	return finalizeTrace(trace, { status: "done", now: T0 + 60_000 });
}

const resultBlock = (value, extra = {}) => ({
	kind: "tool-result",
	time: T0 + 60_000,
	callTime: T0,
	content: [{ type: "text", text: value.report }],
	isError: false,
	meta: presentationMeta(value),
	call: { name: "handoff", argsRaw: "{}" },
	...extra,
});

const catalog = [
	{ id: "old-child", createdAt: T0 - 600_000, mode: "continuable", label: "MixAgent · an earlier request" },
	{ id: "child-1", createdAt: T0 + 13_000, mode: "continuable", label: "MixAgent · Rename the greeting" },
	{ id: "other", createdAt: T0 + 14_000, mode: "one-shot", label: "explore the repo" },
];

// ------------------------------------------------------------------ tests

test("the client registers the handoff card, its styles and matching zh/en dictionaries", () => {
	assert.ok(card, "tool.call.toolview entry");
	assert.equal(card.options.key, "handoff");
	assert.equal(card.options.locale, "mixagent");
	assert.ok(registered.some((entry) => entry.options.name === "plugins.bundle.config"), "settings page still registered");
	assert.equal(styles.length, 1);
	assert.equal(styles[0].dataset.pluginCss, "mixagent-dsh/handoff-card.css");
	assert.match(styles[0].textContent, /\.mxa-row\{/);
	assert.deepEqual(Object.keys(dictionaries.zh).sort(), Object.keys(dictionaries.en).sort());
	for (const dispose of disposers) if (typeof dispose === "function" && dispose.length === 0) dispose();
	assert.equal(styles[0].removed, true, "the style tag is removed on dispose");
});

test("preparing shows the shimmering title", () => {
	const tree = renderCard({ phase: "preparing", block: { phase: "preparing", name: "handoff" } });
	assert.equal(textOf(tree), "Preparing the handoffMixAgent");
	assert.equal(findAll(tree, (node) => node.props["data-shimmer"] === "on").length, 1);
});

test("a running handoff shows planning, then this call's executor children with an open action", () => {
	const realNow = Date.now;
	Date.now = () => T0 + 5_000;
	try {
		const planning = renderCard({ phase: "start", block: { phase: "start", time: T0, argsRaw: "{}" } }, { catalog: [] });
		assert.match(textOf(planning), /MixAgentPlanning · 5\.0s/);
		assert.equal(effects.length, 1, "one elapsed-time timer");

		const statuses = new Map([["child-1", { running: true }]]);
		const byId = { "child-1": { projectionValues: { tokenUsage: { uncachedInputTokens: 900, outputTokens: 300, cacheReadTokens: 800, cacheWriteTokens: 0 } } } };
		const executing = renderCard({ phase: "start", block: { phase: "start", time: T0, argsRaw: "{}" } }, { catalog, byId, statuses });
		assert.match(textOf(executing), /1 executor running · 5\.0s/);
		const children = byClass(executing, "child");
		assert.equal(children.length, 1, "older handoffs' children and unrelated subagents are left out");
		assert.match(textOf(children), /MixAgent · Rename the greetingrunning · 2k tokensOpen/);
		assert.equal(findAll(children, (node) => node.props["data-state"] === "ongoing").length, 1);
		byClass(children, "link")[0].props.onClick({ stopPropagation() {} });
		assert.deepEqual(opened.pop(), { parentSessionId: "parent-1", childSessionId: "child-1", mode: "continuable" });
	} finally {
		Date.now = realNow;
	}
});

test("a finished handoff shows its summary and, expanded, the full run trace", () => {
	const value = { status: "done", report: "✓ executed\n\nall done", trace: doneTrace() };
	let inspected = 0;
	const tree = renderCard({ phase: "result", block: resultBlock(value), inspect: () => inspected++ }, { catalog });
	const summary = byClass(tree, "summary");
	assert.equal(textOf(summary), "Done · 1 change · 1 executor · 1m 00s · 2k tokens");
	assert.equal(summary[0].props["data-tone"], undefined);

	const text = textOf(byClass(tree, "lines"));
	assert.match(text, /scout ds\/flash · planner gm\/argon · executor ds\/flash \(inherited\)/);
	assert.match(text, /package 4\.2k chars · 3 tool results · 2 key files/);
	assert.match(text, /✗ b\.ts: not found/);
	assert.match(text, /✓planner · gm\/argon · 12s · 1\.5k in \/ 200 out \(500 cached\) · 1 change/);
	assert.match(text, /auto-apply: 1 applied · 0 left to the executor · 0 failed · 0\.0s/);
	assert.match(text, /✓MixAgent · Rename the greeting · ds\/flash · completed · 45s · 2 tool calls \(1 failed\) · 1 retry · 297 tokensOpen/);
	assert.match(text, /plan file: \/plans\/p\.md/);

	const sections = findAll(tree, (node) => node.type === "section").map((node) => node.props["aria-label"]);
	assert.deepEqual(sections, ["Run trace", "Plan", "Report"]);
	assert.equal(findAll(tree, (node) => node.props["data-markdown"]).length, 0, "the plan starts collapsed");

	byClass(byClass(tree, "lines"), "link")[0].props.onClick({ stopPropagation() {} });
	assert.deepEqual(opened.pop(), { parentSessionId: "parent-1", childSessionId: "child-1", mode: "continuable" });
	byClass(tree, "inspect")[0].props.onClick();
	assert.equal(inspected, 1);
});

test("failed files and unfinished executors make the summary a warning", () => {
	const value = { status: "done", report: "r", trace: doneTrace({ applyStatus: "failed", stopReason: "error" }) };
	const tree = renderCard({ phase: "result", block: resultBlock(value) }, { catalog });
	const summary = byClass(tree, "summary");
	assert.equal(summary[0].props["data-tone"], "warn");
	assert.match(textOf(summary), /^Done · 1 change · 1 file failed to apply · 1 executor did not complete · /);
	const text = textOf(byClass(tree, "lines"));
	assert.match(text, /✗ src\/a\.ts: SEARCH block 1 does not match/);
	assert.match(text, /✗MixAgent · Rename the greeting · ds\/flash · error · .*rate limited/);
});

test("a failed handoff shows the failure, the provider identity and no executors", () => {
	const trace = createTrace({ callId: "call-1", request: "r", models: { scout: "a/b", planner: "c/d" }, now: T0 });
	const stage = beginStage(trace, { kind: "planner", model: "c/d" }, T0);
	const error = Object.assign(new Error("overloaded"), { usage: { inputTokens: 900, outputTokens: 0 }, failure: { code: "RATE_LIMIT", status: 429, requestId: "req-7" } });
	endStage(stage, { error }, T0 + 3_000);
	const value = { status: "error", report: "Planner call failed: overloaded", trace: finalizeTrace(trace, { status: "error", error: "Planner call failed: overloaded", now: T0 + 3_000 }) };
	const tree = renderCard({ phase: "result", block: resultBlock(value) });
	const summary = byClass(tree, "summary");
	assert.equal(summary[0].props["data-tone"], "error");
	assert.equal(textOf(summary), "Failed · Planner call failed: overloaded · 3.0s · 900 tokens");
	assert.match(textOf(byClass(tree, "lines")), /✗planner · c\/d · 3\.0s · 900 in \/ 0 out.*overloaded \(RATE_LIMIT, 429, request req-7\)/);
	assert.match(textOf(tree), /Failed/, "the state is spelled out for screen readers");
});

test("a result without a trace falls back to the report; thrown errors and interruptions keep their tone", () => {
	const plain = renderCard({ phase: "result", block: { kind: "tool-result", content: [{ type: "text", text: "first line\nmore" }], isError: false, call: null } });
	assert.equal(textOf(byClass(plain, "summary")), "first line");
	assert.match(textOf(findAll(plain, (node) => node.type === "pre")), /first line\nmore/);

	const thrown = renderCard({ phase: "result", block: { kind: "tool-result", content: [{ type: "text", text: "handoff is only available to the MixAgent scout" }], isError: true, call: null } });
	assert.equal(byClass(thrown, "summary")[0].props["data-tone"], "error");

	const stopped = renderCard({ phase: "result", block: { kind: "tool-result", content: [], isError: true, error: { name: "ToolError", code: "interrupted" }, call: null } });
	assert.equal(textOf(byClass(stopped, "summary")), "Interrupted");
	assert.equal(byClass(stopped, "summary")[0].props["data-tone"], "warn");
});

test("the Chinese dictionary renders the same card and every key the card uses exists", () => {
	const value = { status: "done", report: "r", trace: doneTrace() };
	const tree = renderCard({ phase: "result", block: resultBlock(value) }, { catalog, language: "zh" });
	assert.equal(textOf(byClass(tree, "summary")), "已完成 · 1 处修改 · 1 个执行器 · 1m 00s · 2k tokens");
	assert.match(textOf(byClass(tree, "lines")), /自动应用：1 个已应用/);
	assert.deepEqual([...missing], [], "no locale key is missing");
});

test("the settings page offers a thinking level next to each role's model", () => {
	const pages = [];
	const snapshot = { status: "ready", writable: true, revision: 1, value: { plannerModel: "p/m", plannerThinking: "medium", executorThinking: "custom" } };
	plugin.apply({
		effect: (callback) => callback(),
		locale: { register: () => () => {} },
		configForms: { get: () => ({ getSnapshot: () => snapshot, subscribe: () => () => {}, mutate: async () => true }) },
		remote: { session: undefined },
		slots: { inject: (_name, factory) => factory(), register: (options, component) => (pages.push({ options, component }), () => {}) },
		get: () => undefined,
	});
	const page = pages.find((entry) => entry.options.name === "plugins.bundle.config");
	missing.clear();
	const tree = render(createElement(page.component, { t: translator("en") }));
	assert.deepEqual([...missing], []);
	const select = (field) => findAll(tree, (node) => node.type === "select" && node.props["data-field"] === field)[0];
	const options = (node) => findAll(node.children, (child) => child.type === "option").map((child) => child.props.value);
	assert.equal(select("scoutThinking").props.value, "off", "an unset level shows its default");
	assert.equal(select("plannerThinking").props.value, "medium");
	assert.equal(select("executorThinking").props.value, "custom");
	assert.deepEqual(options(select("scoutThinking")), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	assert.ok(options(select("executorThinking")).includes("custom"), "a custom level from the patch stays selectable");
	assert.match(textOf(tree), /Model default/);
	for (const key of ["thinking", "thinkingOff", "thinkingHint"]) assert.ok(dictionaries.zh[key] && dictionaries.en[key], key);
});

/** Render the settings page with a saved snapshot and, optionally, an unsaved draft; returns the tree and the save ops. */
function renderSettings(value, draft) {
	const pages = [];
	const mutations = [];
	const snapshot = { status: "ready", writable: true, revision: 3, value };
	plugin.apply({
		effect: (callback) => callback(),
		locale: { register: () => () => {} },
		configForms: { get: () => ({ getSnapshot: () => snapshot, subscribe: () => () => {}, mutate: async (ops, revision) => (mutations.push({ ops, revision }), true) }) },
		remote: { session: undefined },
		slots: { inject: (_name, factory) => factory(), register: (options, component) => (pages.push({ options, component }), () => {}) },
		get: () => undefined,
	});
	const page = pages.find((entry) => entry.options.name === "plugins.bundle.config");
	// The page's third useState is its draft: hand it the given draft for this render.
	const original = React.useState;
	let calls = 0;
	React.useState = (init) => (++calls === 3 && draft ? [draft, () => {}] : original(init));
	try {
		missing.clear();
		return { tree: render(createElement(page.component, { t: translator("en") })), mutations };
	} finally {
		React.useState = original;
	}
}
const fieldOf = (tree, key) => findAll(tree, (node) => node.props["data-field"] === key)[0];
const saveButton = (tree) => findAll(tree, (node) => node.type === "button" && textOf(node.children) === "Save")[0];

test("the settings page shows every config field with its saved value or default", () => {
	const { tree } = renderSettings({ autoApply: false, maxFileChars: 12345, presets: ["mix", "fast"], planDir: "" });
	assert.deepEqual([...missing], []);
	const keys = ["enabled", "presets", "plannerMaxTokens", "maxContextRounds", "forkJoin", "maxParallelPlanners", "maxParallelExecutors", "maxToolOutputChars", "maxFileChars", "maxPackageChars", "maxPlannerImages", "scoutBashGuard", "autoApply", "pruneScoutHistory", "discardRewritesContext", "planDir"];
	for (const key of keys) assert.ok(fieldOf(tree, key), key);
	assert.equal(fieldOf(tree, "autoApply").props.checked, false);
	assert.equal(fieldOf(tree, "forkJoin").props.checked, true, "an unset switch shows its default");
	assert.equal(fieldOf(tree, "maxFileChars").props.value, "12345");
	assert.equal(fieldOf(tree, "plannerMaxTokens").props.value, "32000");
	assert.equal(fieldOf(tree, "presets").props.value, "mix, fast");
	assert.equal(fieldOf(tree, "planDir").props.value, "", "an explicitly empty plan directory stays empty");
	assert.match(textOf(tree), /Context package limits/);
	for (const key of keys) assert.ok(dictionaries.zh[`field.${key}`] && dictionaries.zh[`field.${key}.hint`], key);
});

test("saving the settings page sets changed fields and unsets values equal to their default", async () => {
	const saved = { maxFileChars: 12345, autoApply: false };
	const { tree: base } = renderSettings(saved);
	const draft = Object.fromEntries(findAll(base, (node) => node.props["data-field"]).map((node) => [node.props["data-field"], node.props.checked ?? node.props.value]));
	Object.assign(draft, { maxFileChars: "60000", autoApply: true, enabled: true, presets: "mix,  quick ", maxParallelExecutors: "8", planDir: " plans " });
	const { tree, mutations } = renderSettings(saved, draft);
	assert.equal(saveButton(tree).props.disabled, false);
	await saveButton(tree).props.onClick();
	assert.equal(mutations.length, 1);
	assert.equal(mutations[0].revision, 3);
	const ops = Object.fromEntries(mutations[0].ops.map((op) => [op.path[0], op]));
	assert.deepEqual(ops.maxFileChars, { op: "unset", path: ["maxFileChars"] });
	assert.deepEqual(ops.autoApply, { op: "unset", path: ["autoApply"] });
	assert.deepEqual(ops.enabled, { op: "set", path: ["enabled"], value: true });
	assert.deepEqual(ops.presets, { op: "set", path: ["presets"], value: ["mix", "quick"] });
	assert.deepEqual(ops.maxParallelExecutors, { op: "set", path: ["maxParallelExecutors"], value: 8 });
	assert.deepEqual(ops.planDir, { op: "set", path: ["planDir"], value: "plans" });
	assert.equal(mutations[0].ops.length, 6, "untouched fields are not written");
});

test("a number outside its bounds is flagged and blocks saving", async () => {
	const { tree: base } = renderSettings({});
	const draft = Object.fromEntries(findAll(base, (node) => node.props["data-field"]).map((node) => [node.props["data-field"], node.props.checked ?? node.props.value]));
	draft.maxParallelPlanners = "40";
	const { tree, mutations } = renderSettings({}, draft);
	assert.equal(fieldOf(tree, "maxParallelPlanners").props["aria-invalid"], true);
	assert.match(textOf(tree), /Enter a whole number from 1 to 16/);
	assert.equal(saveButton(tree).props.disabled, true);
	await saveButton(tree).props.onClick();
	assert.equal(mutations.length, 0);
});
