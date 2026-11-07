/**
 * Observability for MixAgent handoffs.
 *
 * Every handoff records a JSON trace: the package it built, each planner call, the auto-apply
 * outcome per file, and each executor child. The handoff tool returns the trace as its presentation
 * metadata: DSH persists it on the `tool/result` event, never shows it to the model, and hands it to
 * the client's handoff card. `/mix last` and `/mix status` read it back from the session log, so the
 * record survives a Host restart.
 *
 * Everything here is pure, so it can be unit-tested without a Host.
 */

/** Discriminator of the handoff presentation metadata, so readers never mistake another tool's meta. */
export const TRACE_KIND = "mixagent/handoff";
export const TRACE_VERSION = 1;

/** The plan is kept in the trace for the card, capped so one session event stays reasonably small. */
export const TRACE_PLAN_CHARS = 100_000;

const USAGE_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];

const count = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0);

export function clip(text, max) {
	const value = String(text ?? "");
	return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

export function firstLine(text, max = 160) {
	return clip(String(text ?? "").trim().split("\n")[0], max);
}

/**
 * DSH tool values and metadata must be lossless JSON: an `undefined` field, NaN or -0 makes the
 * whole result invalid. A JSON round trip drops undefined fields and normalizes numbers.
 */
export function jsonClean(value) {
	return JSON.parse(JSON.stringify(value));
}

// ------------------------------------------------------------------ usage

/** One DSH TokenUsage sample as the four disjoint buckets; undefined when there is no sample. */
export function normalizeUsage(usage) {
	if (!usage || typeof usage !== "object") return undefined;
	const out = {};
	for (const key of USAGE_KEYS) out[key] = count(usage[key]);
	return out;
}

/** Bucket-wise sum; missing samples are skipped and a sum of nothing stays undefined. */
export function addUsage(...samples) {
	let total;
	for (const sample of samples) {
		const usage = normalizeUsage(sample);
		if (!usage) continue;
		total ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
		for (const key of USAGE_KEYS) total[key] += usage[key];
	}
	return total;
}

/** Billed tokens of one sample: uncached input, cache reads and writes, and output. */
export function usageTotal(usage) {
	const u = normalizeUsage(usage);
	return u ? u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.outputTokens : 0;
}

export function formatTokens(value) {
	const n = count(value);
	if (n < 1000) return String(n);
	const scaled = (x) => (x >= 100 ? String(Math.round(x)) : String(Math.round(x * 10) / 10));
	return n < 1_000_000 ? `${scaled(n / 1000)}k` : `${scaled(n / 1_000_000)}M`;
}

export function formatDuration(ms) {
	const value = Math.max(0, Number(ms) || 0);
	if (value < 10_000) return `${(Math.round(value / 100) / 10).toFixed(1)}s`;
	const seconds = Math.round(value / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** "12.1k in / 3.4k out (8k cached)": input counts every prompt token, cached ones included. */
export function usageText(usage) {
	const u = normalizeUsage(usage);
	if (!u) return "";
	const input = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
	const cached = u.cacheReadTokens ? ` (${formatTokens(u.cacheReadTokens)} cached)` : "";
	return `${formatTokens(input)} in / ${formatTokens(u.outputTokens)} out${cached}`;
}

// ------------------------------------------------------------------ errors

/** Message plus the provider failure identity a planner error carries (code, HTTP status, request id). */
export function errorDetail(error) {
	if (error === undefined || error === null) return undefined;
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : String(error?.message ?? error);
	const failure = error?.failure;
	const detail = { message: clip(message, 2000) };
	if (failure && typeof failure === "object") {
		if (failure.code !== undefined && failure.code !== null) detail.code = String(failure.code);
		if (typeof failure.status === "number") detail.status = failure.status;
		if (failure.requestId) detail.requestId = String(failure.requestId);
	}
	return detail;
}

export const isAbort = (error) => error instanceof Error && error.name === "AbortError";

// ------------------------------------------------------------------ trace building

/**
 * Start one handoff trace.
 * @param {{ callId?: string, request: string, models: Record<string, string>, now?: number }} input
 */
export function createTrace({ callId, request, models, now = Date.now() }) {
	return {
		v: TRACE_VERSION,
		...(callId ? { callId } : {}),
		request: firstLine(request),
		startedAt: now,
		status: "running",
		models,
		stages: [],
		executors: [],
	};
}

/** Open a planner stage: `planner` (the lead call), `subplanner` (S1..Sn) or `join`. */
export function beginStage(trace, fields, now = Date.now()) {
	const stage = { ...fields, status: "running", startedAt: now };
	trace.stages.push(stage);
	return stage;
}

/** Add one call's usage to a stage; sub-planner retries accumulate. */
export function addStageUsage(stage, usage) {
	if (!stage) return;
	const total = addUsage(stage.usage, usage);
	if (total) stage.usage = total;
}

/**
 * Close a stage from the planner call's result or error. A planner error carries the usage and the
 * characters it generated before failing (see pipeline.js), so a failed call still shows its cost.
 */
export function endStage(stage, { result, error } = {}, now = Date.now()) {
	if (!stage) return;
	stage.endedAt = now;
	stage.durationMs = Math.max(0, now - stage.startedAt);
	if (error !== undefined) {
		stage.status = isAbort(error) ? "aborted" : "error";
		stage.error = errorDetail(error);
		addStageUsage(stage, error?.usage);
		if (typeof error?.chars === "number") stage.chars = error.chars;
		if (error?.stopReason) stage.stopReason = error.stopReason;
		return;
	}
	stage.status = "ok";
	if (result) {
		addStageUsage(stage, result.usage);
		if (typeof result.text === "string") stage.chars = result.text.length;
		if (result.stopReason) stage.stopReason = result.stopReason;
		if (result.reasoningEffort) stage.effort = result.reasoningEffort;
		if (result.maxTokens) stage.maxTokens = result.maxTokens;
	}
}

/** The trace's overall tone for the card: a "done" run with failed files or executors is a warning. */
export function healthOf(trace) {
	if (trace.status === "error" || trace.status === "cancelled") return "error";
	if (trace.status === "need_context") return "info";
	const applyFailed = (trace.apply?.files ?? []).some((file) => file.status === "failed") || trace.apply?.error;
	const executorFailed = trace.executors.some((run) => !run.superseded && (run.error || run.stopReason !== "completed"));
	// A join cut off at its output limit ran on, but the plan it reviewed may be incomplete.
	return applyFailed || executorFailed || trace.joinTruncated ? "warn" : "ok";
}

/**
 * Close the trace with the handoff's outcome and return a lossless-JSON copy for the tool value.
 * @param {object} trace
 * @param {{ status: string, error?: unknown, now?: number }} outcome
 */
export function finalizeTrace(trace, { status, error, now = Date.now() }) {
	trace.status = status;
	trace.endedAt = now;
	trace.durationMs = Math.max(0, now - trace.startedAt);
	if (error !== undefined && error !== null) trace.error = clip(typeof error === "string" ? error : errorDetail(error).message, 4000);
	for (const stage of trace.stages) {
		if (stage.status !== "running") continue;
		stage.status = status === "cancelled" ? "aborted" : "error";
		stage.endedAt = now;
		stage.durationMs = Math.max(0, now - stage.startedAt);
	}
	const planner = addUsage(...trace.stages.map((stage) => stage.usage));
	const executor = addUsage(...trace.executors.map((run) => run.usage));
	trace.totals = { ...(planner ? { planner } : {}), ...(executor ? { executor } : {}) };
	trace.health = healthOf(trace);
	return jsonClean(trace);
}

/** The handoff's presentation metadata: never model-visible, persisted on its `tool/result` event. */
export function presentationMeta(value) {
	const meta = { kind: TRACE_KIND, v: TRACE_VERSION, status: value?.status ?? "done" };
	if (value?.trace && typeof value.trace === "object") meta.trace = value.trace;
	return meta;
}

// ------------------------------------------------------------------ child session statistics

function lastStreamUsage(stream) {
	if (!Array.isArray(stream)) return undefined;
	for (let i = stream.length - 1; i >= 0; i--) {
		const entry = stream[i];
		if (entry?.type === "chunk" && entry.chunk?.type === "usage") return entry.chunk.usage;
	}
	return undefined;
}

const slotOf = (data) => `${data?.turn ?? "?"}:${data?.step ?? "?"}`;

/**
 * Tool calls, model steps, retries and token usage of one executor child, folded from its session
 * events the way DSH's token meter folds them: one sample per (turn, step) attempt, last sample
 * wins, and a retry closes the slot so the retried attempt adds to the total.
 * @param {readonly any[]} events - the child's session events.
 */
export function sessionStats(events) {
	const stats = { steps: 0, toolCalls: 0, toolErrors: 0, retries: 0, tools: {} };
	if (!Array.isArray(events)) return stats;
	let settled;
	const open = new Map();
	for (const event of events) {
		const data = event?.data;
		switch (event?.type) {
			case "assistant/message": {
				stats.steps += 1;
				const source = data?.message?.source;
				if (source?.provider && source?.model) stats.model = `${source.provider}/${source.model}`;
				const sample = data?.usage ?? lastStreamUsage(data?.stream);
				if (sample) open.set(slotOf(data), sample);
				break;
			}
			case "assistant/attempt": {
				const sample = lastStreamUsage(data?.stream);
				if (sample) open.set(slotOf(data), sample);
				break;
			}
			case "llm/retry-started": {
				stats.retries += 1;
				const slot = slotOf(data);
				if (open.has(slot)) {
					settled = addUsage(settled, open.get(slot));
					open.delete(slot);
				}
				break;
			}
			case "tool/call": {
				stats.toolCalls += 1;
				const name = typeof data?.name === "string" && data.name ? data.name : "?";
				stats.tools[name] = (stats.tools[name] ?? 0) + 1;
				break;
			}
			case "tool/result":
				if (data?.message?.isError) stats.toolErrors += 1;
				break;
			case "turn/end":
				if (data?.reason?.kind === "error") {
					const failure = data.reason.error ?? {};
					stats.error = errorDetail({ message: failure.message ?? "the executor turn failed", failure });
				}
				break;
			default:
				break;
		}
	}
	const usage = addUsage(settled, ...open.values());
	if (usage) stats.usage = usage;
	return stats;
}

// ------------------------------------------------------------------ reading traces back

/** Every handoff trace recorded in one session's events, oldest first (one per tool call). */
export function handoffTraces(events) {
	const byCall = new Map();
	if (!Array.isArray(events)) return [];
	for (const event of events) {
		if (event?.type !== "tool/result") continue;
		const meta = event.data?.meta;
		if (!meta || meta.kind !== TRACE_KIND || !meta.trace || typeof meta.trace !== "object") continue;
		const key = meta.trace.callId ?? event.data?.message?.source?.callId ?? event.seq;
		byCall.delete(key);
		byCall.set(key, { ...meta.trace, status: meta.trace.status ?? meta.status });
	}
	return [...byCall.values()];
}

/** Planner and executor usage summed over a session's handoffs. */
export function sessionTotals(traces) {
	return {
		handoffs: traces.length,
		planner: addUsage(...traces.map((trace) => trace.totals?.planner)),
		executor: addUsage(...traces.map((trace) => trace.totals?.executor)),
	};
}

// ------------------------------------------------------------------ text renderings

const STATUS_MARK = { ok: "✓", error: "✗", aborted: "✗", running: "…" };

function stageTitle(stage) {
	if (stage.kind === "subplanner") return `sub-planner ${stage.id ?? ""}`.trim();
	if (stage.kind === "join") return "join planner";
	return "planner";
}

function stageLine(stage) {
	const parts = [`${STATUS_MARK[stage.status] ?? "·"} ${stageTitle(stage)}`];
	if (stage.model) parts.push(stage.model);
	if (stage.durationMs !== undefined) parts.push(formatDuration(stage.durationMs));
	if (stage.usage) parts.push(usageText(stage.usage));
	if (stage.subtasks) parts.push(`split into ${stage.subtasks} subtask(s)`);
	if (stage.changes !== undefined && !stage.subtasks) parts.push(`${stage.changes} change(s)`);
	if (stage.attempts > 1) parts.push(`${stage.attempts} attempts`);
	let line = parts.join(" · ");
	if (stage.goal) line += ` — ${firstLine(stage.goal, 80)}`;
	if (stage.error) {
		const codes = [stage.error.code, stage.error.status, stage.error.requestId && `request ${stage.error.requestId}`].filter(Boolean);
		line += `\n    ${firstLine(stage.error.message, 300)}${codes.length ? ` (${codes.join(", ")})` : ""}`;
	}
	return line;
}

function executorLine(run) {
	const ok = !run.error && run.stopReason === "completed";
	const parts = [`${ok ? "✓" : "✗"} ${run.label ?? "executor"}`];
	if (run.actualModel ?? run.model) parts.push(run.actualModel ?? run.model);
	parts.push(run.error ? "failed to start" : (run.stopReason ?? "?"));
	if (run.durationMs !== undefined) parts.push(formatDuration(run.durationMs));
	if (run.toolCalls !== undefined) parts.push(`${run.toolCalls} tool call(s)${run.toolErrors ? `, ${run.toolErrors} failed` : ""}`);
	if (run.retries) parts.push(`${run.retries} retr${run.retries === 1 ? "y" : "ies"}`);
	if (run.usage) parts.push(`${formatTokens(usageTotal(run.usage))} tokens`);
	let line = parts.join(" · ");
	const problem = run.error ?? run.turnError?.message ?? run.diagnostic;
	if (problem) line += `\n    ${firstLine(problem, 300)}`;
	return line;
}

/** One line per trace for `/mix status` and the Host log. */
export function traceSummary(trace) {
	const parts = [trace.status ?? "?"];
	if (trace.durationMs !== undefined) parts.push(formatDuration(trace.durationMs));
	if (trace.plan?.changes !== undefined) parts.push(`${trace.plan.changes} change(s)`);
	if (trace.executors?.length) parts.push(`${trace.executors.length} executor(s)`);
	const planner = usageTotal(trace.totals?.planner);
	const executor = usageTotal(trace.totals?.executor);
	if (planner) parts.push(`planner ${formatTokens(planner)} tokens`);
	if (executor) parts.push(`executors ${formatTokens(executor)} tokens`);
	if (trace.error) parts.push(firstLine(trace.error, 120));
	return parts.join(" · ");
}

/** The full multi-line trace for `/mix last`. */
export function renderTrace(trace) {
	const when = trace.startedAt ? new Date(trace.startedAt).toLocaleString() : "";
	const lines = [`Last handoff: ${traceSummary(trace)}${when ? ` · started ${when}` : ""}`];
	if (trace.request) lines.push(`request: ${trace.request}`);
	const models = trace.models ?? {};
	lines.push(`models: scout ${models.scout ?? "?"} · planner ${models.planner ?? "?"} · executor ${models.executor ?? "?"}`);
	const pkg = trace.package;
	if (pkg) {
		const files = pkg.files ?? [];
		const missing = files.filter((file) => file.error);
		lines.push(
			`package: ${formatTokens(pkg.chars)} chars${pkg.truncated ? " (truncated)" : ""} · ${pkg.steps ?? 0} tool result(s)${pkg.discarded ? ` (${pkg.discarded} discarded)` : ""} · ${files.length} key file(s)${missing.length ? ` (${missing.length} unavailable)` : ""}${pkg.round > 1 ? ` · context round ${pkg.round}` : ""}${pkg.images ? ` · ${pkg.images} image(s)` : ""}`,
		);
		for (const file of missing.slice(0, 8)) lines.push(`    ✗ ${file.path}: ${file.error}`);
	}
	for (const stage of trace.stages ?? []) lines.push(stageLine(stage));
	if (trace.joinTruncated) {
		lines.push(`! join hit its output limit after ${trace.joinTruncated.chars ?? 0} chars: continued with the sub-plans; the executor completes the rest from the saved plan`);
	}
	const apply = trace.apply;
	if (apply) {
		if (apply.error) {
			lines.push(`✗ auto-apply failed before changing anything: ${firstLine(apply.error, 300)}`);
		} else {
			const files = apply.files ?? [];
			const by = (status) => files.filter((file) => file.status === status);
			lines.push(`${by("failed").length ? "!" : "✓"} auto-apply: ${by("applied").length} applied · ${by("skipped").length} left to the executor · ${by("failed").length} failed`);
			for (const file of [...by("failed"), ...by("skipped")].slice(0, 12)) {
				lines.push(`    ${file.status === "failed" ? "✗" : "→"} ${file.path} (${file.kind}): ${firstLine(file.message, 200)}`);
			}
		}
	}
	for (const run of trace.executors ?? []) lines.push(`${executorLine(run)}${run.attempt ? ` [attempt ${run.attempt}${run.superseded ? ", retried" : ""}]` : ""}`);
	if (trace.plan) {
		lines.push(`plan: ${formatTokens(trace.plan.chars)} chars · ${trace.plan.changes ?? 0} change(s)${trace.plan.tasks ? ` · ${trace.plan.tasks} task(s)` : ""}${trace.plan.path ? ` · ${trace.plan.path}` : ""}`);
	}
	if (trace.error && trace.status === "error") lines.push(`error: ${firstLine(trace.error, 400)}`);
	return lines.join("\n");
}
