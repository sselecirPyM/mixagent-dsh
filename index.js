/**
 * MixAgent for DeepSeek Harness: cheap scout model explores the code, a flagship planner model
 * writes one Markdown change plan, and a cheap executor applies it in a fresh session.
 */

import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import Schema from "@deepseek-ai/schemastery";

import {
	AUTO_APPLIED,
	EXECUTOR_APPEND,
	PLANNER_SPLIT,
	PLANNER_SYSTEM,
	SCOUT_APPEND,
	buildExecutorKickoff,
	buildExecutorRetryNote,
	buildFullPlanNote,
	buildJoinTruncatedNote,
	buildJoinInstructions,
	buildSubPlannerInstructions,
} from "./prompts.js";
import {
	assembleJoinPlan,
	completedJoinSections,
	countPlanChanges,
	parseNeedContext,
	parseSubtasks,
	planSections,
	splitPlan,
} from "./plan.js";
import {
	DISCARD_TOOL,
	HANDOFF_TOOL,
	buildPlannerPackage,
	discardNote,
	extractCycle,
	prunableCalls,
	prunedNote,
	readCycle,
	toolResultSeqs,
} from "./transcript.js";
import { autoApplyPlan } from "./apply.js";
import { findWriteReason } from "./safety.js";
import { mapLimit, runExecutor, runPlanner } from "./pipeline.js";
import {
	TRACE_PLAN_CHARS,
	addStageUsage,
	addUsage,
	beginStage,
	clip,
	createTrace,
	endStage,
	finalizeTrace,
	firstLine,
	formatDuration,
	formatTokens,
	handoffTraces,
	isAbort,
	presentationMeta,
	renderTrace,
	sessionTotals,
	traceSummary,
	usageText,
	usageTotal,
} from "./trace.js";

export const name = "mixagent-dsh";
export const inject = ["tools", "systemPrompt", "commands", "agents", "subagents", "llm", "fs", "workingDirectory"];

const ROLES = ["scout", "planner", "executor"];

/** Key files beyond this many are ignored: the planner package must stay focused. */
const MAX_ATTACHED_FILES = 20;

/** Extra attempts for one fork-join sub-planner (a call may fail or return empty text); aborts are final. */
const MAX_SUBPLANNER_RETRIES = 2;

/** Extra attempts for one fork-join task executor that failed or stopped early; aborts are final. */
const MAX_TASK_RETRIES = 2;

/** Image key files are stored as attachments and sent to the planner as images. */
const IMAGE_MEDIA_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };


/**
 * Every field is settings-editable and volatile: the plugin page writes them live through the profile
 * Settings form, and `apply` reads them through their refs, so a change needs no restart (and keeps the
 * in-memory per-session mode state).
 */
const int = (fallback, min, max, description) =>
	Schema.natural().min(min).max(max).default(fallback).volatile().description(description);
const bool = (fallback, description) => Schema.boolean().default(fallback).volatile().description(description);

export const Config = Schema.object({
	/** Whether a new session starts in MixAgent mode; normal conversations get no prompt otherwise. */
	enabled: bool(false, "Start new sessions in MixAgent mode. Off keeps every conversation normal until /mix on is used."),
	presets: Schema.array(Schema.string())
		.default(["mix"])
		.volatile()
		.description("Agent preset ids whose sessions start in MixAgent mode; empty disables preset activation."),
	scoutModel: Schema.string()
		.default("")
		.volatile()
		.description("provider/modelId the scout explores with; empty follows the session model."),
	plannerModel: Schema.string()
		.default("")
		.volatile()
		.description("provider/modelId the planner writes the plan with; empty uses the session model."),
	executorModel: Schema.string()
		.default("")
		.volatile()
		.description("provider/modelId the executor applies the plan with; empty inherits the scout route."),
	scoutThinking: Schema.string()
		.default("off")
		.volatile()
		.description("Reasoning effort for the scout (e.g. low, medium, high); off uses the model default."),
	plannerThinking: Schema.string()
		.default("high")
		.volatile()
		.description("Reasoning effort for the planner (e.g. low, medium, high); off uses the model default."),
	executorThinking: Schema.string()
		.default("off")
		.volatile()
		.description("Reasoning effort for the executor (e.g. low, medium, high); off uses the model default."),
	plannerMaxTokens: int(32000, 256, 1_000_000, "Max output tokens for the planner call."),
	maxToolOutputChars: int(20000, 1000, 10_000_000, "Per tool-output character cap inside the planner package."),
	maxFileChars: int(60000, 1000, 10_000_000, "Per attached-file character cap inside the planner package."),
	maxPackageChars: int(600000, 1000, 10_000_000, "Total character cap for the planner package."),
	maxContextRounds: int(3, 0, 20, "How many times the planner may send the scout back for more context per request."),
	scoutBashGuard: bool(true, "Block shell commands that look like they modify state while scouting."),
	autoApply: bool(true, "Apply the plan's exact file changes directly before the executor starts."),
	forkJoin: bool(true, "Let the planner split large work into sub-planners and parallel executors."),
	maxParallelPlanners: int(4, 1, 16, "At most this many sub-planners run at once."),
	maxParallelExecutors: int(4, 1, 16, "At most this many task executors run at once."),
	planDir: Schema.string()
		.default("~/.dsh/mixagent/plans")
		.volatile()
		.description("Directory for saved plan Markdown files; empty disables saving. ~ is expanded, relative paths use the session cwd."),
	pruneScoutHistory: bool(true, "Replace a finished cycle's scout tool results in the scout's context with a one-line note."),
	maxPlannerImages: int(10, 0, 100, "At most this many images go to the planner."),
	discardRewritesContext: bool(true, "Replace discarded tool results in the scout's own context as well as the planner package."),
});

const DEFAULTS = {
	/** Whether a new session starts in MixAgent mode. Normal conversations stay unaffected while off. */
	enabled: false,
	/** Agent preset ids whose sessions start in MixAgent mode. The bundle declares the `mix` preset. */
	presets: ["mix"],
	/** "provider/modelId" of the model that explores the code; empty keeps the session model. */
	scoutModel: "",
	/** "provider/modelId" of the model that writes the plan; empty uses the model the user chose. */
	plannerModel: "",
	/** "provider/modelId" of the model that applies the plan; empty inherits the scout's route. */
	executorModel: "",
	/** Reasoning effort for each role, or "off" to use the adapter default. */
	scoutThinking: "off",
	plannerThinking: "high",
	executorThinking: "off",
	/** Max output tokens for the planner call. */
	plannerMaxTokens: 32000,
	/** Per tool-output character cap inside the planner package. */
	maxToolOutputChars: 20000,
	/** Per attached-file character cap inside the planner package. */
	maxFileChars: 60000,
	/** Total character cap for the planner package. */
	maxPackageChars: 600000,
	/** How many times the planner may send the scout back for more context per request. */
	maxContextRounds: 3,
	/** Block shell commands that look like they modify state while scouting. */
	scoutBashGuard: true,
	/** Apply the plan's exact file changes directly before the executor starts. */
	autoApply: true,
	/** Let the planner split large work and the join planner split execution across tasks. */
	forkJoin: true,
	maxParallelPlanners: 4,
	maxParallelExecutors: 4,
	/** Directory for saved plan Markdown files; empty disables saving. "~" is expanded, relative paths use the session cwd. */
	planDir: "~/.dsh/mixagent/plans",
	/** Replace a finished cycle's scout tool results in the scout's context with a one-line note. */
	pruneScoutHistory: true,
	/** At most this many images (user attachments, image reads, image key files) go to the planner. */
	maxPlannerImages: 10,
	/** Replace discarded tool results in the scout's own context as well as the planner package. */
	discardRewritesContext: true,
};

const TRUE_VALUES = new Set([true, "true", "1", "yes", "on"]);
const FALSE_VALUES = new Set([false, "false", "0", "no", "off"]);

function boolOf(value, fallback) {
	if (TRUE_VALUES.has(value)) return true;
	if (FALSE_VALUES.has(value)) return false;
	return fallback;
}

function intOf(value, fallback, min, max) {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function stringOf(value, fallback) {
	return typeof value === "string" ? value : fallback;
}

/**
 * Read one config field that may be a volatile ref (written live by the plugin page) or a plain value
 * (written in cordis.patch.yml). Volatile refs expose `get()`; plain fields are returned as they are.
 */
function liveValue(input, key) {
	const value = input?.[key];
	if (value !== null && typeof value === "object" && typeof value.get === "function") {
		try {
			return value.get();
		} catch {
			return undefined;
		}
	}
	return value;
}

/** Trim a configured model route and drop a malformed one, so a typo never strands a session. */
function modelSpecOf(value) {
	const spec = stringOf(value, "").trim();
	return spec && parseModelSpec(spec) ? spec : "";
}

export function parseModelSpec(spec) {
	if (typeof spec !== "string") return undefined;
	const slash = spec.indexOf("/");
	if (slash <= 0 || slash === spec.length - 1) return undefined;
	return { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
}

/** A reasoning effort id, or "off" for the model default; an empty or non-string value keeps the fallback. */
function thinkingOf(value, fallback) {
	const level = stringOf(value, "").trim().toLowerCase();
	return level || fallback;
}

function presetsOf(value) {
	return Array.isArray(value)
		? value.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim())
		: DEFAULTS.presets;
}

/**
 * Every field may be volatile (written live by the plugin page), so each one is read lazily through
 * a getter: a saved change takes effect on the next read, without re-applying the plugin.
 */
function normalizeConfig(raw) {
	const input = raw && typeof raw === "object" ? raw : {};
	const live = (key) => liveValue(input, key);
	const readers = {
		enabled: () => boolOf(live("enabled"), DEFAULTS.enabled),
		presets: () => presetsOf(live("presets")),
		scoutModel: () => modelSpecOf(live("scoutModel")),
		plannerModel: () => modelSpecOf(live("plannerModel")),
		executorModel: () => modelSpecOf(live("executorModel")),
		scoutThinking: () => thinkingOf(live("scoutThinking"), DEFAULTS.scoutThinking),
		plannerThinking: () => thinkingOf(live("plannerThinking"), DEFAULTS.plannerThinking),
		executorThinking: () => thinkingOf(live("executorThinking"), DEFAULTS.executorThinking),
		plannerMaxTokens: () => intOf(live("plannerMaxTokens"), DEFAULTS.plannerMaxTokens, 256, 1_000_000),
		maxToolOutputChars: () => intOf(live("maxToolOutputChars"), DEFAULTS.maxToolOutputChars, 1000, 10_000_000),
		maxFileChars: () => intOf(live("maxFileChars"), DEFAULTS.maxFileChars, 1000, 10_000_000),
		maxPackageChars: () => intOf(live("maxPackageChars"), DEFAULTS.maxPackageChars, 1000, 10_000_000),
		maxContextRounds: () => intOf(live("maxContextRounds"), DEFAULTS.maxContextRounds, 0, 20),
		scoutBashGuard: () => boolOf(live("scoutBashGuard"), DEFAULTS.scoutBashGuard),
		autoApply: () => boolOf(live("autoApply"), DEFAULTS.autoApply),
		forkJoin: () => boolOf(live("forkJoin"), DEFAULTS.forkJoin),
		maxParallelPlanners: () => intOf(live("maxParallelPlanners"), DEFAULTS.maxParallelPlanners, 1, 16),
		maxParallelExecutors: () => intOf(live("maxParallelExecutors"), DEFAULTS.maxParallelExecutors, 1, 16),
		planDir: () => stringOf(live("planDir"), DEFAULTS.planDir).trim(),
		pruneScoutHistory: () => boolOf(live("pruneScoutHistory"), DEFAULTS.pruneScoutHistory),
		maxPlannerImages: () => intOf(live("maxPlannerImages"), DEFAULTS.maxPlannerImages, 0, 100),
		discardRewritesContext: () => boolOf(live("discardRewritesContext"), DEFAULTS.discardRewritesContext),
	};
	const config = {};
	for (const [key, read] of Object.entries(readers)) Object.defineProperty(config, key, { get: read, enumerable: true });
	return config;
}

function effortOf(value, selection) {
	if (!selection || !value || value === "off") return selection;
	return { ...selection, reasoningEffort: value };
}

function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/** An Error DSH recognizes as cancellation rather than as a tool failure. */
function abortError(message) {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

function shortModel(selection) {
	return selection ? `${selection.provider}/${selection.model}` : "(session model)";
}

/** " · 12.1k in / 3.4k out tokens (8k cached)" for the model-facing report; empty without usage. */
function usageSuffix(usage) {
	const text = usageText(usage);
	return text ? ` · ${text.replace(" out", " out tokens")}` : "";
}

/** The session's current model selection; undefined when the agent cannot report it. */
function currentModel(agent) {
	try {
		return agent?.model?.current?.();
	} catch {
		return undefined;
	}
}

/** Executor child labels name the request, so the subagent catalog tells runs apart. */
function executorLabel(kind, request, task) {
	if (kind === "task") return `MixAgent ${task.id} · ${firstLine(task.goal, 48)}`;
	if (kind === "commands") return `MixAgent commands · ${firstLine(request, 40)}`;
	return `MixAgent · ${firstLine(request, 48)}`;
}

/** At most this many per-file auto-apply lines go into the model-facing report. */
const REPORT_FILE_LINES = 8;

/**
 * File operations for auto-apply. Mutations carry the session's sandbox policy, as DSH's own write
 * tool does: without one, dsh-fs-sandbox falls back to the deployment root (not the session cwd) and
 * denies writes in the project under workspace-write.
 */
function fsOps(ctx, session, signal) {
	const policyService = typeof ctx.get === "function" ? ctx.get("sandboxPolicy") : undefined;
	const policy = () => (policyService && session ? policyService.resolve({ session }) : undefined);
	const read = async (path) => {
		try {
			const target = await ctx.fs.resolve(path);
			return await ctx.fs.readText(target);
		} catch {
			return undefined;
		}
	};
	const stat = async (path) => {
		try {
			const target = await ctx.fs.resolve(path);
			return await ctx.fs.stat(target);
		} catch {
			return undefined;
		}
	};
	return {
		read,
		exists: async (path) => (await stat(path)) !== undefined,
		isFile: async (path) => (await stat(path))?.type === "file",
		write: async (path, content, display) => {
			const target = await ctx.fs.resolve(path);
			await ctx.fs.writeText(target, content, undefined, signal, policy());
			return `Wrote ${display}.`;
		},
		remove: async (path, display) => {
			const target = await ctx.fs.resolve(path);
			const info = await ctx.fs.stat(target);
			if (info === undefined) throw new Error(`${display} does not exist`);
			if (info.type !== "file") throw new Error(`${display} is not a file`);
			await ctx.fs.deleteFile(target, undefined, signal, policy());
			return `Deleted ${display}.`;
		},
	};
}

/**
 * Register the MixAgent pipeline for every root session in this profile.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} rawConfig
 */
export function apply(ctx, rawConfig) {
	const config = normalizeConfig(rawConfig);

	/** Per-session scout state: model overrides, captured original model, discarded results. */
	const states = new Map();
	/** Child session ids whose system prompt carries the executor appendix. */
	const executorIds = new Set();
	/** Resolved availability of a "provider/model" route, so a typo never strands a session. */
	const routeStates = new Map();
	/** Why a route resolved as unavailable, for `/mix status`. */
	const routeErrors = new Map();
	/** Reasoning effort ids each resolved route offers; an effort a route does not offer is never selected. */
	const routeEfforts = new Map();
	/** The pending check of each route, so a selection waiting on it can run once it settles. */
	const routeChecks = new Map();
	/** Host log; DSH plugins log through `ctx.logger.<level>(...)`. */
	const log = ctx.logger;

	const stateOf = (agent) => {
		let state = states.get(agent.id);
		if (!state) {
			state = {
				enabled: undefined,
				original: undefined,
				models: {},
				/** Per-session thinking overrides set with `/mix thinking`. */
				thinking: {},
				/** The session's own thinking level while the scout level is applied to the session model. */
				ownThinking: undefined,
				discarded: new Map(),
				ref: 0,
				refByCallId: new Map(),
				/** The newest handoff trace, including a cancelled one the session log never records. */
				lastTrace: undefined,
				/** The running handoff: when it started and what it is doing now. */
				activity: undefined,
			};
			states.set(agent.id, state);
		}
		return state;
	};

	const isRoot = (agent) => agent !== undefined && agent.session.header.origin !== "subagent";

	/**
	 * The agent preset this session runs. The preset registry projection reflects a preset chosen
	 * before the first turn; the durable header covers a deployment that composes no registry.
	 */
	const presetOf = (agent) => {
		try {
			const registry = typeof ctx.get === "function" ? ctx.get("agentPresets") : undefined;
			const id = registry?.presetForSession?.(agent.session);
			if (typeof id === "string" && id) return id;
		} catch {
			/* a missing registry or projection falls back to the header */
		}
		return agent.session?.header?.agentPreset;
	};

	/** Whether this session was composed from one of the configured MixAgent presets. */
	const presetStarts = (agent) => {
		const id = presetOf(agent);
		return typeof id === "string" && config.presets.includes(id);
	};

	const enabledFor = (agent) => stateOf(agent).enabled ?? (presetStarts(agent) || config.enabled);
	const isScout = (agent) => agent !== undefined && isRoot(agent) && enabledFor(agent);

	const specFor = (agent, role) => {
		const override = stateOf(agent).models[role];
		if (override) return override;
		if (role === "scout") return config.scoutModel;
		if (role === "planner") return config.plannerModel;
		return config.executorModel;
	};

	/** The reasoning effort a role asks for: a `/mix thinking` override, else the live config. */
	const thinkingFor = (agent, role) => {
		const override = stateOf(agent).thinking[role];
		if (override) return override;
		if (role === "scout") return config.scoutThinking;
		if (role === "planner") return config.plannerThinking;
		return config.executorThinking;
	};

	/**
	 * The effort to send for a role on a resolved route, or undefined to keep the model default:
	 * "off", a route that is not resolved yet and an effort the route does not offer all send none.
	 */
	const effortFor = (agent, role, selection) => {
		const level = thinkingFor(agent, role);
		if (!level || level === "off" || !selection) return undefined;
		const spec = shortModel(selection);
		ensureRoute(spec);
		return routeEfforts.get(spec)?.includes(level) ? level : undefined;
	};

	const selectionFor = (agent, role) => {
		const spec = specFor(agent, role);
		if (spec) return parseModelSpec(spec);
		if (role === "planner") return stateOf(agent).original ?? agent.model.current();
		return undefined;
	};

	/** Resolve whether a route exists; unknown routes are never selected, so a typo cannot strand a session. */
	const ensureRoute = (spec) => {
		if (!spec || routeStates.has(spec)) return;
		routeStates.set(spec, "checking");
		routeErrors.delete(spec);
		const selection = parseModelSpec(spec);
		const check = ctx.llm.resolveModelInfo(selection.provider, selection.model).then(
			(info) => {
				const efforts = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts.map((entry) => entry?.id).filter(Boolean) : [];
				routeEfforts.set(spec, efforts);
				routeStates.set(spec, "ok");
			},
			(error) => {
				routeStates.set(spec, "bad");
				routeErrors.set(spec, messageOf(error));
				log?.warn?.(`mixagent: model ${spec} is unavailable; keeping the session model (${messageOf(error)})`);
			},
		);
		routeChecks.set(spec, check);
		check.finally(() => routeChecks.delete(spec));
	};

	/** Wait for a route's check to settle, so the efforts it offers are known. */
	const routeReady = async (spec) => {
		ensureRoute(spec);
		await routeChecks.get(spec);
	};

	/** Resolve a route again, e.g. after the user re-selects it once the provider is fixed. */
	const recheckRoute = (spec) => {
		if (!spec) return;
		if (routeStates.get(spec) === "bad") routeStates.delete(spec);
		ensureRoute(spec);
	};

	/** Switch a scout session to its configured model before the next step begins. */
	const selectScoutModel = (agent) => {
		const state = stateOf(agent);
		const spec = specFor(agent, "scout");
		if (!spec) {
			applyScoutThinking(agent);
			return;
		}
		ensureRoute(spec);
		if (routeStates.get(spec) !== "ok") return;
		if (state.original === undefined) state.original = agent.model.current();
		state.ownThinking = undefined;
		const selection = parseModelSpec(spec);
		try {
			agent.model.select(effortOf(effortFor(agent, "scout", selection), selection));
		} catch (error) {
			log?.warn?.(`mixagent: cannot select scout model: ${messageOf(error)}`);
		}
	};

	/**
	 * Without a scout route the session keeps the model the user chose; only the thinking level changes.
	 * The session's own level is remembered so clearing the scout level (or /mix off) hands it back.
	 */
	const applyScoutThinking = (agent) => {
		const state = stateOf(agent);
		const current = currentModel(agent);
		if (!current) return;
		const route = shortModel(current);
		ensureRoute(route);
		if (routeStates.get(route) === "checking") {
			// The session model is checked on first use; apply the level as soon as its efforts are known.
			routeChecks.get(route)?.then(() => {
				if (isScout(agent) && routeStates.get(route) === "ok") applyScoutThinking(agent);
			});
			return;
		}
		if (routeStates.get(route) !== "ok") return;
		const effort = effortFor(agent, "scout", current);
		if (effort) {
			if (current.reasoningEffort === effort) return;
			if (state.ownThinking?.route !== route) state.ownThinking = { route, own: current.reasoningEffort };
			try {
				agent.model.select(effortOf(effort, current));
			} catch (error) {
				log?.warn?.(`mixagent: cannot set the scout thinking level: ${messageOf(error)}`);
			}
			return;
		}
		releaseScoutThinking(agent);
	};

	/** Give the session back its own thinking level after the scout level was applied to it. */
	const releaseScoutThinking = (agent) => {
		const state = stateOf(agent);
		const applied = state.ownThinking;
		state.ownThinking = undefined;
		const current = currentModel(agent);
		if (!applied || !current || shortModel(current) !== applied.route) return;
		const { reasoningEffort: _scout, ...rest } = current;
		try {
			agent.model.select(applied.own ? { ...rest, reasoningEffort: applied.own } : rest);
		} catch {
			/* the session keeps its current selection */
		}
	};

	const restoreModel = (agent) => {
		const state = stateOf(agent);
		if (state.original) {
			try {
				agent.model.select(state.original);
			} catch {
				/* the session keeps its current selection */
			}
			state.ownThinking = undefined;
			return;
		}
		releaseScoutThinking(agent);
	};

	// ------------------------------------------------------------------ prompt sections

	ctx.effect(
		() =>
			ctx.systemPrompt.section({
				name: "mixagent:scout",
				order: 8000,
				interpolate: false,
				text: (context) => (isScout(context.agent) ? SCOUT_APPEND : ""),
			}),
		"mixagent scout prompt",
	);

	ctx.effect(
		() =>
			ctx.systemPrompt.section({
				name: "mixagent:executor",
				order: 8001,
				interpolate: false,
				text: (context) => (context.agent && executorIds.has(context.agent.id) ? EXECUTOR_APPEND : ""),
			}),
		"mixagent executor prompt",
	);

	// ------------------------------------------------------------------ tool guard

	ctx.effect(
		() =>
			ctx.tools.guard((exec) => {
				if (!isScout(exec.agent)) return undefined;
				if (exec.name === "write" || exec.name === "edit" || exec.name === "apply_patch" || exec.name === "str_replace_editor") {
					return "MixAgent scout mode is read-only: do not modify files. Call handoff when you have the context the planner needs.";
				}
				if (config.scoutBashGuard && (exec.name === "pwsh" || exec.name === "bash")) {
					const command = exec.arguments?.command;
					if (typeof command === "string") {
						const reason = findWriteReason(command);
						if (reason) return `MixAgent scout mode blocks state-changing commands: ${reason}. Use read-only inspection instead.`;
					}
				}
				return undefined;
			}),
		"mixagent scout guard",
	);

	// ------------------------------------------------------------------ context helpers

	/** One image key file as an attachment-backed image block, or an "unavailable" entry naming why. */
	const readImageFile = async (path, mediaType, cwd, signal) => {
		const attachments = typeof ctx.get === "function" ? ctx.get("attachments") : undefined;
		if (!attachments?.saveImage) return { path, error: "no attachment service is mounted, so the image cannot be sent; describe it in notes" };
		try {
			const limits = attachments.imageLimits ?? {};
			if (Array.isArray(limits.mediaTypes) && !limits.mediaTypes.includes(mediaType)) {
				return { path, error: `${mediaType} images are not accepted by this deployment` };
			}
			const target = await ctx.fs.resolve(path, { cwd });
			const info = await ctx.fs.stat(target);
			if (!info) return { path, error: "not found" };
			if (info.type === "directory") return { path, error: "is a directory" };
			const cap = Math.min(limits.maxImageBytes ?? 20_000_000, limits.maxMessageImageBytes ?? 20_000_000);
			const data = await ctx.fs.readBytes(target, signal, cap);
			const ref = await attachments.saveImage({ data, mediaType, name: basename(path) });
			return { path, image: { type: "image", attachment: ref } };
		} catch (error) {
			return { path, error: `the image cannot be sent (${messageOf(error)}); describe it in notes` };
		}
	};

	const readKeyFiles = async (paths, cwd, signal) => {
		const out = [];
		// Scouts often write "@src/a.ts": strip one leading @ and cap the list so the package stays focused.
		for (const raw of paths.slice(0, MAX_ATTACHED_FILES)) {
			if (typeof raw !== "string" || !raw.trim()) continue;
			const path = raw.trim().replace(/^@/, "");
			if (!path) continue;
			const mediaType = IMAGE_MEDIA_TYPES[extname(path).toLowerCase()];
			if (mediaType) {
				// An image key file is stored as an attachment, the way read_image does, and sent as an image.
				out.push(await readImageFile(path, mediaType, cwd, signal));
				continue;
			}
			try {
				const target = await ctx.fs.resolve(path, { cwd });
				const info = await ctx.fs.stat(target);
				if (!info) {
					out.push({ path, error: "not found" });
				} else if (info.type === "directory") {
					out.push({ path, error: "is a directory" });
				} else if ((info.size ?? 0) > 5_000_000) {
					out.push({ path, error: "file is larger than 5 MB" });
				} else {
					out.push({ path, content: await ctx.fs.readText(target) });
				}
			} catch (error) {
				out.push({ path, error: messageOf(error) });
			}
		}
		return out;
	};

	/**
	 * Save the plan as Markdown, as the reference does: a request header, the final plan, and for a
	 * fork-join run a "# Planning (fork-join)" appendix with the lead split and the join review. When the
	 * join was cut off, the appendix also keeps every sub-plan in full, so an executor can fill in the gaps.
	 */
	const savePlan = async (plan, { request, cwd, lead, joinReview, subPlans, joinTruncated } = {}) => {
		if (!config.planDir) return undefined;
		const spec = config.planDir;
		const dir =
			spec === "~" ? homedir() : /^~[\\/]/.test(spec) ? join(homedir(), spec.slice(2)) : resolve(cwd ?? process.cwd(), spec);
		await mkdir(dir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const file = join(dir, `mixagent-${stamp}.md`);
		let planning = "";
		if (lead !== undefined) {
			planning = `\n---\n\n# Planning (fork-join)\n\n## Lead\n\n${lead}\n\n`;
			if (joinTruncated && subPlans?.length) {
				planning += `## Sub-plans\n\n${subPlans.map((sub) => `### ${sub.id}: ${sub.goal}\n\n${sub.plan}`).join("\n\n")}\n\n`;
			}
			planning += `## Join review${joinTruncated ? " (cut off at the planner's output limit)" : ""}\n\n${joinReview ?? ""}\n`;
		}
		await writeFile(file, `# MixAgent plan\n\n## Request\n\n${request ?? ""}\n\n${plan}\n${planning}`, "utf8");
		return file;
	};

	const executorDeps = {
		subagents: ctx.subagents,
		agents: ctx.agents,
		onChildStart: (id) => executorIds.add(id),
		onChildEnd: (id) => executorIds.delete(id),
	};

	const providerName = () => {
		const providers = ctx.subagents.list();
		return providers.includes("spawn") ? "spawn" : providers[0];
	};

	/** A route that cannot take this many image bytes asks for some to be offloaded, by code or by message. */
	const isImageBudgetError = (error) =>
		[error?.code, error?.failure?.code].includes("IMAGE_OFFLOAD_REQUIRED") || /IMAGE_OFFLOAD_REQUIRED/.test(messageOf(error));

	/**
	 * One planner call with the package's images. A route whose image budget the images exceed is asked
	 * once more with every image offloaded: DSH then sends each one's placeholder text instead of its bytes.
	 */
	const runPlannerText = async (agent, text, system, extra, signal, images) => {
		try {
			return await runPlannerOnce(agent, text, system, extra, signal, images);
		} catch (error) {
			if (!images?.length || !isImageBudgetError(error) || signal?.aborted) throw error;
			log?.warn?.(`mixagent: the planner route cannot take ${images.length} image(s); sending them as placeholders`);
			return runPlannerOnce(agent, text, system, extra, signal, images.map((image) => ({ ...image, offloaded: true })));
		}
	};

	const runPlannerOnce = async (agent, text, system, extra, signal, images) => {
		// A configured route already known to be unavailable must fail by name, before one model call.
		const spec = specFor(agent, "planner");
		ensureRoute(spec);
		if (spec && routeStates.get(spec) === "bad") {
			throw new Error(
				`the configured planner model ${spec} is unavailable (${routeErrors.get(spec) ?? "unknown error"}); pick another model with /mix model planner <provider/model>`,
			);
		}
		const selection = selectionFor(agent, "planner");
		if (!selection) throw new Error("no planner model is available");
		return runPlanner(
			{ llm: ctx.llm },
			{
				provider: selection.provider,
				model: selection.model,
				reasoningEffort: thinkingFor(agent, "planner") === "off" ? undefined : thinkingFor(agent, "planner"),
				system,
				text,
				extra,
				...(images?.length ? { images } : {}),
				maxTokens: config.plannerMaxTokens,
				sessionId: agent.session.id,
				signal,
			},
		);
	};

	/**
	 * One fork-join sub-planner with up to MAX_SUBPLANNER_RETRIES extra attempts: a thrown call and an
	 * empty response are both retried. An abort is re-thrown at once so the turn is cancelled, not reported.
	 * The optional trace stage records the attempts, their summed usage and the final outcome.
	 */
	const planSubtask = async (agent, packageText, system, instructions, signal, stage, images) => {
		let lastError;
		for (let attempt = 0; attempt <= MAX_SUBPLANNER_RETRIES; attempt++) {
			// A failed attempt's usage counts too: it is added once the next attempt starts.
			if (attempt > 0) addStageUsage(stage, lastError?.usage);
			if (stage) stage.attempts = attempt + 1;
			try {
				const result = await runPlannerText(agent, packageText, system, instructions, signal, images);
				if (result.text.trim()) {
					endStage(stage, { result });
					if (stage) stage.changes = countPlanChanges(result.text);
					return { plan: result.text, usage: result.usage };
				}
				lastError = Object.assign(new Error("planner returned an empty response"), { usage: result.usage });
			} catch (error) {
				if (isAbort(error) || signal?.aborted) {
					endStage(stage, { error });
					throw error;
				}
				lastError = error;
			}
			if (signal?.aborted) throw abortError("planner request aborted");
		}
		const error = lastError ?? new Error("planner returned an empty response");
		endStage(stage, { error });
		return { error: messageOf(error) };
	};

	// ------------------------------------------------------------------ handoff

	/** An abort must reach DSH as cancellation; wrapping it in a report would hide the cancellation. */
	const rethrowAbort = (error, exec) => {
		if (isAbort(error) || exec.signal?.aborted) throw error;
	};

	/** Log one finished handoff to the Host log: failures as warnings, everything else as info. */
	const logOutcome = (trace) => {
		const line = `mixagent: handoff ${trace.callId ?? ""} ${traceSummary(trace)}`.replace(/\s+/g, " ").trim();
		if (trace.health === "error" || trace.health === "warn") log?.warn?.(line);
		else log?.info?.(line);
	};

	/** Report lines for the auto-apply outcome: a summary plus the files the executor must handle. */
	const applyReportLines = (apply) => {
		if (!apply) return [];
		if (apply.error) return [`! auto-apply failed before changing anything: ${apply.error}`];
		const files = apply.files;
		const applied = files.filter((file) => file.status === "applied").length;
		const failed = files.filter((file) => file.status === "failed");
		const skipped = files.filter((file) => file.status === "skipped");
		const lines = [
			`${failed.length ? "!" : "✓"} auto-applied ${applied} of ${files.length} file(s)${failed.length ? ` · ${failed.length} failed` : ""}${skipped.length ? ` · ${skipped.length} left to the executor` : ""}`,
		];
		const listed = [...failed, ...skipped];
		for (const file of listed.slice(0, REPORT_FILE_LINES)) {
			lines.push(`  ${file.status === "failed" ? "✗" : "→"} ${file.path}: ${firstLine(file.message, 160)}`);
		}
		if (listed.length > REPORT_FILE_LINES) lines.push(`  … ${listed.length - REPORT_FILE_LINES} more`);
		return lines;
	};

	/** "58s · 9 tool calls (1 failed) · 35k tokens" for one executor run. */
	const runFacts = (run) => {
		const parts = [formatDuration(run.durationMs)];
		const stats = run.stats;
		if (stats) {
			parts.push(`${stats.toolCalls} tool call(s)${stats.toolErrors ? ` (${stats.toolErrors} failed)` : ""}`);
			if (stats.usage) parts.push(`${formatTokens(usageTotal(stats.usage))} tokens`);
		}
		return parts.join(" · ");
	};

	/**
	 * Replace one committed tool result in the scout's context with a single text block, the way DSH's own
	 * tool-result pruner does: a surface `replace` that cites the shadowed event, so the call stays paired.
	 */
	const replaceToolResult = (session, seq, text) => {
		const event = session.snapshotEvents(seq, seq + 1)[0];
		if (!event || event.type !== "tool/result") return false;
		const message = { ...event.data.message, content: [{ type: "text", text }] };
		session.append("tool/result", { ...event.data, message }, { surfaceOp: { op: "replace", startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] });
		return true;
	};

	/**
	 * After a handoff finished (done or answered), replace that cycle's scout results with one-line notes,
	 * as the reference's pruneFinishedCycles does: the handoff result keeps the record of what happened,
	 * and later requests stop paying for the old exploration.
	 */
	const pruneFinishedCycle = (agent) => {
		if (!config.pruneScoutHistory) return;
		const session = agent.session;
		try {
			const calls = prunableCalls(readCycle(session));
			if (calls.length === 0) return;
			const seqs = toolResultSeqs(session);
			let pruned = 0;
			for (const { callId, title } of calls) {
				const seq = seqs.get(callId);
				if (seq !== undefined && replaceToolResult(session, seq, prunedNote(title))) pruned += 1;
			}
			if (pruned > 0) log?.info?.(`mixagent: pruned ${pruned} scout result(s) of the finished cycle`);
		} catch (error) {
			log?.warn?.(`mixagent: cannot prune the finished scout cycle: ${messageOf(error)}`);
		}
	};

	const handoff = async (rawArgs, exec) => {
		const args = rawArgs ?? {};
		const agent = exec.agent;
		if (!agent || !isScout(agent)) throw new Error("handoff is only available to the MixAgent scout");
		const state = stateOf(agent);
		const session = agent.session;
		const cwd = ctx.workingDirectory.get(session);

		const messages = readCycle(session);
		const cycle = extractCycle(messages, state.discarded);
		// Every user message of the cycle is the request; an image-only message still has one.
		const request =
			cycle.requests.join("\n\n") || (cycle.requestImages.length > 0 ? "(see the attached image(s) and the scout notes)" : "(see the scout notes)");

		const scoutModel = shortModel(currentModel(agent));
		const executorSelection = selectionFor(agent, "executor");
		const executorModel = executorSelection ? shortModel(executorSelection) : `${scoutModel} (inherited)`;
		const trace = createTrace({
			callId: exec.callId,
			request,
			models: { scout: scoutModel, planner: shortModel(selectionFor(agent, "planner")), executor: executorModel },
		});
		const activity = { startedAt: trace.startedAt, phase: "packaging" };
		state.activity = activity;

		/** Close the trace and build the tool value; every non-abort exit goes through here. */
		const settle = (status, report, { conclude = true } = {}) => {
			if (conclude) exec.concludeTurn();
			if (status === "done" || status === "answered") pruneFinishedCycle(agent);
			const final = finalizeTrace(trace, { status, ...(status === "error" ? { error: report } : {}) });
			state.lastTrace = final;
			logOutcome(final);
			// The cost line lets the scout tell the user what the run took; the full trace stays model-hidden.
			const cost = [formatDuration(final.durationMs)];
			if (final.totals.planner) cost.push(`planner ${formatTokens(usageTotal(final.totals.planner))} tokens`);
			if (final.totals.executor) cost.push(`executors ${formatTokens(usageTotal(final.totals.executor))} tokens`);
			const body = status === "done" ? `${report}\n\nMixAgent run: ${cost.join(" · ")}` : report;
			return { status, report: body, trace: final };
		};
		/** End the turn on a terminal failure: the scout must not keep going after a failed handoff. */
		const failTurn = (report) => settle("error", report);

		try {
			const files = await readKeyFiles(Array.isArray(args.files) ? args.files : [], cwd, exec.signal);
			const pkg = buildPlannerPackage({
				cycle,
				notes: typeof args.notes === "string" ? args.notes : "",
				files,
				cwd,
				maxToolOutputChars: config.maxToolOutputChars,
				maxFileChars: config.maxFileChars,
				maxPackageChars: config.maxPackageChars,
				maxImages: config.maxPlannerImages,
			});
			const images = pkg.images;
			trace.package = {
				chars: pkg.text.length,
				truncated: pkg.text.length > config.maxPackageChars,
				steps: cycle.steps.length,
				discarded: cycle.steps.filter((step) => step.discarded !== undefined).length,
				round: cycle.plannerRequests.length + 1,
				...(images.length > 0 ? { images: images.length } : {}),
				files: files.map((file) =>
					file.image
						? { path: file.path, image: true }
						: file.content === undefined
							? { path: file.path, error: file.error ?? "unavailable" }
							: { path: file.path, chars: file.content.length },
				),
			};
			log?.info?.(
				`mixagent: handoff ${exec.callId ?? ""} started · package ${pkg.text.length} chars · ${files.length} key file(s)${images.length ? ` · ${images.length} image(s)` : ""}`,
			);

			const system = config.forkJoin ? PLANNER_SYSTEM + PLANNER_SPLIT : PLANNER_SYSTEM;
			const plannerModel = shortModel(selectionFor(agent, "planner"));

			/** One traced planner call; the stage records model, duration, usage and any failure. */
			const plannerCall = async (fields, extra) => {
				const stage = beginStage(trace, { ...fields, model: plannerModel });
				try {
					const result = await runPlannerText(agent, pkg.text, system, extra, exec.signal, images);
					endStage(stage, { result });
					return { result, stage };
				} catch (error) {
					endStage(stage, { error });
					throw error;
				}
			};

			activity.phase = "planning";
			let lead;
			try {
				lead = await plannerCall({ kind: "planner" });
			} catch (error) {
				rethrowAbort(error, exec);
				return failTurn(`Planner call failed: ${messageOf(error)}`);
			}

			const needContext = parseNeedContext(lead.result.text);
			if (needContext) {
				lead.stage.needContext = true;
				trace.needContext = clip(needContext, 4000);
				const rounds = cycle.plannerRequests.length;
				if (rounds >= config.maxContextRounds) {
					return failTurn(
						`## Need context\n\nThe planner asked for more context ${rounds + 1} time(s), reaching maxContextRounds (${config.maxContextRounds}). No executor was started: the scout must answer the user from what it has now.\n\n${needContext}`,
					);
				}
				return settle("need_context", `## Need context\n\n${needContext}\n\nLook this up, then call handoff again.`, { conclude: false });
			}

			let plan = lead.result.text;
			lead.stage.changes = countPlanChanges(plan);
			const plannerLines = [`✓ ${plannerModel} plan · ${countPlanChanges(plan)} file change(s)${usageSuffix(lead.result.usage)}`];
			/** What the saved plan file records about fork-join planning; undefined for a single plan. */
			let planning;

			// Fork-join planning: lead split -> parallel sub-planners -> one join planner.
			if (config.forkJoin) {
				const subtasks = parseSubtasks(plan);
				if (subtasks) {
					lead.stage.subtasks = subtasks.length;
					delete lead.stage.changes;
					plannerLines[0] = `✓ ${plannerModel} split into ${subtasks.length} subtask(s)${usageSuffix(lead.result.usage)}`;
					activity.phase = `sub-planning ${subtasks.length} subtask(s)`;
					let subPlans;
					try {
						// Catch inside the map callback: one failed sub-planner must not reject mapLimit while
						// its siblings keep running. Aborts still propagate so the turn is cancelled.
						subPlans = await mapLimit(subtasks, config.maxParallelPlanners, async (task, index) => {
							const instructions = buildSubPlannerInstructions(plan, task.id, index + 1, subtasks.length);
							const stage = beginStage(trace, { kind: "subplanner", id: task.id, goal: firstLine(task.goal, 160), model: plannerModel });
							const result = await planSubtask(agent, pkg.text, system, instructions, exec.signal, stage, images);
							return { task, ...result };
						});
					} catch (error) {
						rethrowAbort(error, exec);
						return failTurn(`Fork-join planning failed: ${messageOf(error)}`);
					}
					const failed = subPlans.find((sub) => sub.error !== undefined || !sub.plan?.trim());
					if (failed) {
						return failTurn(
							`Fork-join planning failed: sub-planner ${failed.task.id} (${failed.task.goal}) failed after ${MAX_SUBPLANNER_RETRIES + 1} attempt(s): ${failed.error ?? "planner returned an empty response"}. No executor was started.`,
						);
					}
					for (const sub of subPlans) plannerLines.push(`✓ ${sub.task.id} planned · ${sub.task.goal}${usageSuffix(sub.usage)}`);
					const references = subPlans.map((sub) => ({ id: sub.task.id, goal: sub.task.goal, plan: sub.plan }));
					activity.phase = "joining the sub-plans";
					let joinText;
					let joinTruncated = false;
					try {
						const join = await plannerCall({ kind: "join" }, buildJoinInstructions(plan, references));
						joinText = join.result.text;
						plan = assembleJoinPlan(joinText, references);
						join.stage.changes = countPlanChanges(plan);
						plannerLines.push(`✓ ${plannerModel} join · ${countPlanChanges(plan)} file change(s)${usageSuffix(join.result.usage)}`);
					} catch (error) {
						rethrowAbort(error, exec);
						// A join cut off at its output limit is not fatal: the sub-plans are complete, so the plan is
						// assembled from them and the review sections that finished, and the executor fills in the
						// rest from the saved plan file, which keeps the cut-off review and every sub-plan in full.
						if (error?.stopReason !== "max-tokens") return failTurn(`Join planner call failed: ${messageOf(error)}`);
						joinTruncated = true;
						joinText = typeof error.partialText === "string" ? error.partialText : "";
						plan = assembleJoinPlan(completedJoinSections(joinText), references);
						trace.joinTruncated = { chars: joinText.length };
						plannerLines.push(
							`! ${plannerModel} join stopped at its output limit after ${joinText.length} characters · continuing with the sub-plans (${countPlanChanges(plan)} file change(s)); the executor completes the rest from the saved plan${usageSuffix(error.usage)}`,
						);
					}
					planning = { lead: lead.result.text, joinReview: joinText, subPlans: references, joinTruncated };
					if (!plan.trim()) return failTurn("Join planner returned an empty plan; no executor was started.");
				}
			}

			const changes = countPlanChanges(plan);
			const sections = planSections(plan);
			const commands = sections.get("commands");
			trace.plan = {
				chars: plan.length,
				changes,
				...(commands ? { commands: true } : {}),
				text: clip(plan, TRACE_PLAN_CHARS),
				...(plan.length > TRACE_PLAN_CHARS ? { truncated: true } : {}),
			};

			// Save the plan before anything else, as the reference does: an answer is kept too, and every
			// executor below can look the full plan up.
			let planPath;
			try {
				planPath = await savePlan(plan, { request, cwd, ...(planning ?? {}) });
				if (planPath) trace.plan.path = planPath;
			} catch (error) {
				trace.plan.saveError = clip(messageOf(error), 500);
				plannerLines.push(`! could not save the plan: ${messageOf(error)}`);
			}
			const joinTruncated = planning?.joinTruncated === true;
			/** Appended to every executor kickoff: where the full plan is, and what to complete after a cut-off join. */
			const planNote = joinTruncated
				? buildJoinTruncatedNote(planPath, planning.joinReview)
				: (kind) => (planPath && kind !== "single" ? buildFullPlanNote(planPath) : "");
			const noteFor = (kind) => (typeof planNote === "function" ? planNote(kind) : planNote);

			if (changes === 0 && !commands && !joinTruncated) {
				const answer = (sections.get("answer") ?? plan).trim() || plan.trim();
				return settle("answered", answer);
			}

			let planForExecutor = plan;
			if (config.autoApply && changes > 0) {
				activity.phase = "auto-applying the plan";
				const appliedAt = Date.now();
				try {
					const result = await autoApplyPlan(plan, cwd, fsOps(ctx, session, exec.signal));
					planForExecutor = result.plan;
					trace.apply = {
						files: result.files.map((file) => ({ path: file.path, kind: file.kind, status: file.status, message: clip(file.message, 500) })),
					};
				} catch (error) {
					trace.apply = { files: [], error: clip(messageOf(error), 2000) };
				}
				trace.apply.durationMs = Date.now() - appliedAt;
			}

			const provider = providerName();
			if (!provider) return failTurn("No subagent provider is registered; cannot start the executor.");

			const reportLines = [`prompt: ${firstLine(request)}`, ...plannerLines, ...applyReportLines(trace.apply)];
			// An inherited executor still gets its own thinking level, on the scout's current route.
			const executorBase = executorSelection ?? currentModel(agent);
			if (executorBase && thinkingFor(agent, "executor") !== "off") await routeReady(shortModel(executorBase));
			const executorEffort = effortFor(agent, "executor", executorBase);
			const selection = executorSelection
				? effortOf(executorEffort, executorSelection)
				: executorEffort
					? effortOf(executorEffort, executorBase)
					: undefined;

			/** Record one executor run (or its start failure) in the trace. */
			const recordExecutor = (fields, run, error) => {
				const stats = run?.stats;
				trace.executors.push({
					...fields,
					model: executorModel,
					...(run
						? {
								childId: run.childId,
								startedAt: run.startedAt,
								durationMs: run.durationMs,
								stopReason: run.stopReason,
								...(run.diagnostic ? { diagnostic: clip(run.diagnostic, 2000) } : {}),
								outputChars: run.output.length,
							}
						: {}),
					...(error ? { error: clip(messageOf(error), 2000) } : {}),
					...(stats
						? {
								steps: stats.steps,
								toolCalls: stats.toolCalls,
								toolErrors: stats.toolErrors,
								retries: stats.retries,
								tools: stats.tools,
								...(stats.usage ? { usage: stats.usage } : {}),
								...(stats.model ? { actualModel: stats.model } : {}),
								...(stats.error ? { turnError: stats.error } : {}),
							}
						: {}),
				});
			};

			const startExecutor = (kickoff, label) =>
				runExecutor(executorDeps, { parent: agent, providerName: provider, cwd, selection, kickoff, label, signal: exec.signal });

			/** Why one executor run did not finish, for the retry note and the report. */
			const stopText = (run) => `${run.stopReason}${run.diagnostic ? `: ${run.diagnostic}` : ""}`;

			const split = config.forkJoin ? splitPlan(planForExecutor) : undefined;
			if (split) {
				trace.plan.tasks = split.tasks.length;
				activity.phase = `executing ${split.tasks.length} parallel task(s)`;
				// Each task gets up to MAX_TASK_RETRIES more attempts in a fresh session, told that the failed
				// attempt may have applied part of its plan already. Every attempt is recorded in the trace.
				const results = await mapLimit(split.tasks, config.maxParallelExecutors, async (task) => {
					const label = executorLabel("task", request, task);
					const attempts = [];
					let lastError;
					for (let attempt = 0; attempt <= MAX_TASK_RETRIES; attempt++) {
						const kickoff = buildExecutorKickoff(request, task.plan + noteFor("task")) + (lastError ? buildExecutorRetryNote(lastError) : "");
						try {
							const run = await startExecutor(kickoff, label);
							attempts.push({ run });
							if (run.stopReason === "completed") return { task, label, attempts, run };
							lastError = stopText(run);
						} catch (error) {
							rethrowAbort(error, exec);
							attempts.push({ error });
							lastError = messageOf(error);
						}
						if (exec.signal?.aborted) break;
					}
					return { task, label, attempts, failed: true, lastError };
				});
				reportLines.push(`✓ ${split.tasks.length} parallel task(s)`);
				let failedTask = false;
				for (const { task, label, attempts, run, failed, lastError } of results) {
					attempts.forEach((entry, index) =>
						recordExecutor(
							{
								kind: "task",
								taskId: task.id,
								goal: firstLine(task.goal, 160),
								label,
								// An attempt a retry replaced is history; only the last one counts toward the run's health.
								...(attempts.length > 1 ? { attempt: index + 1, ...(index < attempts.length - 1 ? { superseded: true } : {}) } : {}),
							},
							entry.run,
							entry.error,
						),
					);
					const tries = attempts.length > 1 ? ` after ${attempts.length} attempt(s)` : "";
					if (failed) {
						failedTask = true;
						reportLines.push(`✗ ${task.id} failed${tries}: ${lastError ?? "unknown error"} · ${task.goal}`);
						const partial = attempts[attempts.length - 1]?.run?.output;
						if (partial) reportLines.push("", partial);
						continue;
					}
					reportLines.push(`✓ ${task.id} executed${tries} · ${runFacts(run)} · ${task.goal}`);
					if (run.output) reportLines.push("", run.output);
				}
				if (split.joinPlan && failedTask) {
					reportLines.push("! commands not run: a task failed, so the plan's commands were skipped");
				} else if (split.joinPlan) {
					activity.phase = "running the plan's commands";
					const label = executorLabel("commands", request);
					try {
						const run = await startExecutor(buildExecutorKickoff(request, split.joinPlan + noteFor("commands")), label);
						recordExecutor({ kind: "commands", label }, run);
						reportLines.push(`${run.stopReason === "completed" ? "✓ commands executed" : `! commands stopped (${run.stopReason})${run.diagnostic ? `: ${run.diagnostic}` : ""}`} · ${runFacts(run)}`);
						if (run.output) reportLines.push("", run.output);
					} catch (error) {
						rethrowAbort(error, exec);
						recordExecutor({ kind: "commands", label }, undefined, error);
						reportLines.push(`✗ commands failed: ${messageOf(error)}`);
					}
				}
				if (planPath) reportLines.push("", `plan: ${planPath}`);
				return settle("done", reportLines.join("\n"));
			}

			activity.phase = "executing the plan";
			const label = executorLabel("single", request);
			let run;
			try {
				run = await startExecutor(buildExecutorKickoff(request, planForExecutor + noteFor("single")), label);
			} catch (error) {
				rethrowAbort(error, exec);
				recordExecutor({ kind: "single", label }, undefined, error);
				return failTurn(`Executor failed to start: ${messageOf(error)}`);
			}
			recordExecutor({ kind: "single", label }, run);

			if (run.stopReason === "completed") {
				reportLines.push(`✓ ${shortModel(executorSelection ?? currentModel(agent))} executed · ${runFacts(run)}`);
			} else {
				reportLines.push(`! ${shortModel(executorSelection ?? currentModel(agent))} stopped (${run.stopReason})${run.diagnostic ? `: ${run.diagnostic}` : ""} · ${runFacts(run)}`);
			}
			if (run.output) reportLines.push("", run.output);
			if (planPath) reportLines.push("", `plan: ${planPath}`);
			return settle("done", reportLines.join("\n"));
		} catch (error) {
			// A cancellation or an unexpected failure still leaves a record for /mix last.
			const final = finalizeTrace(trace, { status: isAbort(error) || exec.signal?.aborted ? "cancelled" : "error", error });
			state.lastTrace = final;
			logOutcome(final);
			throw error;
		} finally {
			if (state.activity === activity) state.activity = undefined;
		}
	};

	const discard = async (rawArgs, exec) => {
		const args = rawArgs ?? {};
		const agent = exec.agent;
		if (!agent || !isScout(agent)) throw new Error("discard is only available to the MixAgent scout");
		const state = stateOf(agent);
		const ids = Array.isArray(args.ids) ? args.ids.map((value) => Number(value)) : [];
		const reason = typeof args.reason === "string" ? args.reason : undefined;
		const session = agent.session;
		const messages = readCycle(session);
		const done = new Set(messages.filter((message) => message.role === "tool").map((message) => message.toolCallId));
		const seqs = toolResultSeqs(session);

		const discarded = [];
		const invalid = [];
		const notes = [];
		for (const ref of new Set(ids)) {
			const callId = state.refByCallId.get(ref);
			if (!callId || !done.has(callId)) {
				invalid.push(ref);
				continue;
			}
			state.discarded.set(callId, { ref, reason });
			discarded.push(ref);
			notes.push(discardNote(ref, reason));
			const seq = seqs.get(callId);
			if (!config.discardRewritesContext || seq === undefined) continue;
			try {
				replaceToolResult(session, seq, discardNote(ref, reason));
			} catch (error) {
				notes.push(`[#${ref} stays in your context: this session cannot rewrite it (${error instanceof Error ? error.message : String(error)})]`);
			}
		}

		const parts = [];
		if (discarded.length > 0) parts.push(`Discarded from the planner package: ${notes.join(" ")}`);
		if (invalid.length > 0) parts.push(`Not discarded (no completed result with that number): ${invalid.map((id) => `#${id}`).join(", ")}`);
		if (parts.length === 0) parts.push("Nothing was discarded.");
		return { status: invalid.length === 0 ? "done" : "partial", report: parts.join("\n") };
	};

	// ------------------------------------------------------------------ tools

	/**
	 * Canonical output of both tools. Only `report` is model-visible. The handoff's `trace` becomes
	 * its presentation metadata: DSH persists it on the `tool/result` event for the client card and
	 * for `/mix last`, and never renders it to the model.
	 */
	const toolOutput = (description, { traced = false } = {}) => ({
		schema: {
			type: "object",
			properties: {
				status: { type: "string", description: "done, answered, need_context, partial or error." },
				report: { type: "string", description: description },
				...(traced ? { trace: { type: "object", description: "Observability record of the handoff (model-hidden)." } } : {}),
			},
			required: ["status", "report"],
			additionalProperties: false,
		},
		render: (_args, value) => [{ type: "text", text: value.report }],
		...(traced ? { presentationMeta: (_args, value) => presentationMeta(value) } : {}),
	});

	ctx.effect(
		() =>
			ctx.tools.register(
				{
					name: HANDOFF_TOOL,
					description:
						"Hand the gathered context to the flagship planner and run the resulting plan. Call this exactly once, when you have found the code the task touches: it packages the user request, this turn's tool calls and the files you name, asks the planner for a Markdown change plan, applies the exact changes, and runs a fresh executor session. The result is the executor's report, or the planner's answer when nothing needs to change. Do not answer the user yourself.",
					parameters: {
						type: "object",
						properties: {
							notes: {
								type: "string",
								description:
									"Concise findings for the planner: where the relevant code is, how it works, constraints, and any earlier-conversation context it needs (it does not see this conversation).",
							},
							files: {
								type: "array",
								items: { type: "string" },
								description: "Paths of files the planner must see in full to write exact edits (usually the files that will change).",
							},
						},
						required: ["notes"],
						additionalProperties: false,
					},
					output: toolOutput("Markdown result: the executor's report, the planner's answer, or a request for more context.", { traced: true }),
					execute: (args, exec) => handoff(args, exec),
				},
				{ when: (context) => isScout(context.agent) },
			),
		"mixagent handoff tool",
	);

	ctx.effect(
		() =>
			ctx.tools.register(
				{
					name: DISCARD_TOOL,
					description:
						"Discard tool results from this turn that are entirely unrelated to the task so they cost no planner tokens. `ids` are the 1-based numbers in front of each tool result in this turn (handoff and discard calls are not numbered). Never discard anything the planner might need, including useful output that is merely long.",
					parameters: {
						type: "object",
						properties: {
							ids: {
								type: "array",
								items: { type: "integer" },
								description: "Step numbers to discard, e.g. [3, 5].",
							},
							reason: { type: "string", description: "Short reason, e.g. \"only matches in node_modules\"." },
						},
						required: ["ids"],
						additionalProperties: false,
					},
					output: toolOutput("A short note naming what was discarded and anything that could not be discarded."),
					execute: (args, exec) => discard(args, exec),
				},
				{ when: (context) => isScout(context.agent) },
			),
		"mixagent discard tool",
	);

	// ------------------------------------------------------------------ lifecycle events

	ctx.effect(
		() =>
			ctx.on("tools/post-execute", async (exec, result, next) => {
				const decision = await next();
				if (!isScout(exec.agent)) return decision;
				if (exec.name === HANDOFF_TOOL || exec.name === DISCARD_TOOL) return decision;
				if (decision.kind !== "accept") return decision;
				const state = stateOf(exec.agent);
				state.ref += 1;
				state.refByCallId.set(exec.callId, state.ref);
				const content = decision.content ?? result.content;
				return { kind: "accept", content: [{ type: "text", text: `[#${state.ref}]` }, ...content] };
			}),
		"mixagent step numbering",
	);

	ctx.effect(
		() =>
			ctx.on("agent/inbox/inserted", ({ agent, message }) => {
				if (message?.role !== "user" || !isScout(agent)) return;
				// A new user request starts a new scout cycle.
				const state = stateOf(agent);
				state.discarded.clear();
				state.refByCallId.clear();
				selectScoutModel(agent);
			}),
		"mixagent scout wake",
	);

	ctx.effect(
		() =>
			ctx.on("agent/disposed", ({ agent }) => {
				states.delete(agent.id);
			}),
		"mixagent state cleanup",
	);

	// ------------------------------------------------------------------ /mix command

	/** Every handoff recorded in the session log, plus a newer in-memory one (a cancelled run). */
	const sessionTraces = (agent) => {
		let traces = [];
		try {
			traces = handoffTraces(agent.session.snapshotEvents());
		} catch {
			traces = [];
		}
		const memory = stateOf(agent).lastTrace;
		if (memory && !traces.some((trace) => trace.callId !== undefined && trace.callId === memory.callId)) traces.push(memory);
		return traces;
	};

	/** One role's model with its route health: whether the configured route resolved, and what is used instead. */
	const routeLine = (agent, role) => {
		const state = stateOf(agent);
		const spec = specFor(agent, role);
		const override = state.models[role] ? " [/mix override]" : "";
		const session = shortModel(currentModel(agent));
		if (!spec) {
			if (role === "scout") return `scout: ${session} (session model)`;
			if (role === "planner") return `planner: ${shortModel(selectionFor(agent, "planner"))} (session model)`;
			return `executor: ${session} (inherits the scout)`;
		}
		// A route set live on the plugin page may not have been checked yet; start that check now.
		ensureRoute(spec);
		const route = routeStates.get(spec);
		let health = "";
		if (route === "ok") health = " ✓";
		else if (route === "checking") health = " (checking the route…)";
		else if (route === "bad") {
			const fallback =
				role === "scout" ? " → the session model is used" : role === "planner" ? " → handoff fails until this is fixed" : " → executor runs will fail";
			health = ` ✗ unavailable: ${firstLine(routeErrors.get(spec) ?? "unknown error", 200)}${fallback}`;
		}
		let line = `${role}: ${spec}${health}${override}`;
		if (role === "scout" && route === "ok" && enabledFor(agent) && session !== spec) line += ` (the session is on ${session} until the next message)`;
		return line;
	};

	/** The route a role actually runs on, so its thinking level can be checked against what it offers. */
	const runningSelection = (agent, role) => {
		const selection = selectionFor(agent, role);
		return selection ?? currentModel(agent);
	};

	/** " · thinking high", with whether the role's route offers that effort. */
	const thinkingSuffix = (agent, role) => {
		const level = thinkingFor(agent, role);
		const override = stateOf(agent).thinking[role] ? " [/mix override]" : "";
		if (!level || level === "off") return ` · thinking off (model default)${override}`;
		const selection = runningSelection(agent, role);
		const spec = selection ? shortModel(selection) : "";
		if (spec) ensureRoute(spec);
		const efforts = spec ? routeEfforts.get(spec) : undefined;
		let note = "";
		if (efforts && !efforts.includes(level)) {
			note = efforts.length > 0 ? ` (not offered by this model; it offers ${efforts.join(", ")} → model default)` : " (this model has no thinking levels → model default)";
		}
		return ` · thinking ${level}${note}${override}`;
	};

	const roleLine = (agent, role) => `${routeLine(agent, role)}${thinkingSuffix(agent, role)}`;

	const statusText = (agent) => {
		const state = stateOf(agent);
		const on = enabledFor(agent);
		const fromPreset = on && state.enabled === undefined && presetStarts(agent);
		const lines = [
			`MixAgent mode is ${on ? "on" : "off"}${fromPreset ? " (MixAgent preset)" : ""}.`,
			...ROLES.map((role) => roleLine(agent, role)),
			`autoApply: ${config.autoApply ? "on" : "off"} · forkJoin: ${config.forkJoin ? "on" : "off"} · discard rewrite: ${config.discardRewritesContext ? "on" : "off"}${config.planDir ? ` · plans saved to ${config.planDir}` : ""}`,
		];
		if (state.original) lines.push(`saved model: ${shortModel(state.original)}`);
		if (state.activity) lines.push(`running: ${state.activity.phase} · ${formatDuration(Date.now() - state.activity.startedAt)} so far`);
		const traces = sessionTraces(agent);
		if (traces.length > 0) {
			lines.push(`last handoff: ${traceSummary(traces[traces.length - 1])} (/mix last for details)`);
			const totals = sessionTotals(traces);
			const total = usageTotal(addUsage(totals.planner, totals.executor));
			lines.push(
				`this session: ${totals.handoffs} handoff(s) · planner ${usageText(totals.planner) || "no tokens"} · executors ${usageText(totals.executor) || "no tokens"}${total ? ` · ${formatTokens(total)} tokens in all` : ""}`,
			);
		}
		return lines.join("\n");
	};

	const USAGE =
		"Usage: /mix [status|last|on|off|model <scout|planner|executor> [provider/model|default]|thinking <scout|planner|executor> [level|off|default]]";

	ctx.effect(
		() =>
			ctx.commands.register({
				name: "mix",
				description: "Enter or leave MixAgent mode (scout -> planner -> executor), show or change its models and thinking levels, and inspect the last handoff",
				handler: (invocation) => {
					const agent = invocation.agent;
					const state = stateOf(agent);
					const [verb, role, spec] = invocation.rawInput.trim().split(/\s+/).filter(Boolean);

					if (!verb || verb === "status") return { kind: "success", text: statusText(agent) };

					if (verb === "last") {
						const traces = sessionTraces(agent);
						if (traces.length === 0) return { kind: "success", text: "No handoff has run in this conversation yet." };
						return { kind: "success", text: renderTrace(traces[traces.length - 1]) };
					}
					if (verb === "on") {
						state.enabled = true;
						state.discarded.clear();
						if (enabledFor(agent)) selectScoutModel(agent);
						return { kind: "success", text: `MixAgent mode is on for this conversation.\n${statusText(agent)}` };
					}
					if (verb === "off") {
						state.enabled = false;
						restoreModel(agent);
						return { kind: "success", text: "MixAgent mode is off; this conversation is a normal conversation again." };
					}
					if (verb === "model") {
						if (!role) return { kind: "success", text: statusText(agent) };
						if (!ROLES.includes(role)) return { kind: "error", text: `Usage: /mix model <${ROLES.join("|")}> [provider/model|default]` };
						if (!spec) return { kind: "success", text: roleLine(agent, role) };
						if (spec === "default") {
							delete state.models[role];
						} else {
							const parsed = parseModelSpec(spec);
							if (!parsed) return { kind: "error", text: "Model must be written as provider/modelId." };
							state.models[role] = spec;
							// Re-selecting a route that failed before checks it again, e.g. after the provider is fixed.
							recheckRoute(spec);
						}
						if (role === "scout") {
							if (spec === "default" && state.original) restoreModel(agent);
							else selectScoutModel(agent);
						}
						return { kind: "success", text: `Updated.\n${statusText(agent)}` };
					}
					if (verb === "thinking") {
						const level = spec?.toLowerCase();
						if (!role) return { kind: "success", text: statusText(agent) };
						if (!ROLES.includes(role)) return { kind: "error", text: `Usage: /mix thinking <${ROLES.join("|")}> [level|off|default]` };
						if (!level) return { kind: "success", text: roleLine(agent, role) };
						if (level === "default") delete state.thinking[role];
						else state.thinking[role] = level;
						if (role === "scout" && enabledFor(agent)) selectScoutModel(agent);
						return { kind: "success", text: `Updated.
${statusText(agent)}` };
					}
					return { kind: "error", text: USAGE };
				},
			}),
		"mixagent command",
	);

	// Warm every configured route so the first user turn already finds its role ready.
	ensureRoute(config.scoutModel);
	ensureRoute(config.plannerModel);
	ensureRoute(config.executorModel);
}
