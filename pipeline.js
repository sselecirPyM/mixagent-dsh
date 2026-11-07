/**
 * Transport for the two remote roles: one tool-less, single-message flagship planner call, and one
 * fresh child session for the executor.
 *
 * The services are injected so both calls can be unit-tested with stubs.
 */

import { randomUUID } from "node:crypto";
import { textOf } from "./transcript.js";
import { sessionStats } from "./trace.js";

/** An Error DSH recognizes as cancellation rather than as a tool failure. */
function abortError(message) {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

/** The provider failure identity worth showing: code, HTTP status and request id. */
function failureOf(failure) {
	if (!failure || typeof failure !== "object") return undefined;
	const out = {};
	if (failure.code !== undefined && failure.code !== null) out.code = String(failure.code);
	if (typeof failure.status === "number") out.status = failure.status;
	if (failure.requestId) out.requestId = String(failure.requestId);
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * One planner completion: a single user message (the scout package) and no tools.
 *
 * A failure is thrown as an Error that also carries what the call reported before it failed —
 * `usage`, `chars` (generated length), `stopReason` and the provider `failure` identity — so the
 * handoff trace can show the cost and cause of a failed call.
 * @param {{ llm: any }} deps
 * @param {object} options
 */
export async function runPlanner(deps, options) {
	const { provider, model, reasoningEffort, system, text, extra, images, maxTokens, signal, sessionId } = options;

	// Resolve capabilities first: omit an effort the route does not offer and never exceed its
	// advertised output cap, so one shared config works across providers.
	let info;
	try {
		info = await deps.llm.resolveModelInfo(provider, model, signal);
	} catch {
		info = undefined;
	}
	const efforts = info?.reasoning?.efforts?.map((entry) => entry.id) ?? [];
	const effort = reasoningEffort && efforts.includes(reasoningEffort) ? reasoningEffort : undefined;
	const cap = maxTokens && info?.defaultMaxTokens ? Math.min(maxTokens, info.defaultMaxTokens) : maxTokens;

	// Every request control must be part of the prepared config: DSH's prepared call compares the
	// dispatch options field by field and rejects a changed config ("prepared LLM call config
	// changed before adapter dispatch"). In particular maxTokens cannot be added at dispatch time,
	// because prepareCall materialises the adapter's default into the prepared config.
	const config = {
		provider,
		model,
		...(effort ? { reasoningEffort: effort } : {}),
		...(cap ? { maxTokens: cap } : {}),
	};
	const prepared = await deps.llm.prepareCall(config, signal);
	const controls = prepared.config ?? config;
	const body = extra ? `${text}\n${extra}` : text;
	// Images follow the package text with their `[image N] label:` line, then the role instructions, as in
	// the reference. DSH sends a text-only planner the attachment's placeholder text instead of the image.
	const content = images?.length
		? [
				{ type: "text", text },
				...images.flatMap((image, index) => [
					{ type: "text", text: `[image ${index + 1}] ${image.label}:` },
					image.offloaded ? { ...image.block, offloaded: true } : image.block,
				]),
				...(extra ? [{ type: "text", text: extra }] : []),
			]
		: [{ type: "text", text: body }];

	const stream = prepared.stream({
		provider: controls.provider,
		model: controls.model,
		...(controls.reasoningEffort ? { reasoningEffort: controls.reasoningEffort } : {}),
		...(controls.maxTokens !== undefined ? { maxTokens: controls.maxTokens } : {}),
		system,
		messages: [{ role: "user", content }],
		...(sessionId ? { sessionId } : {}),
		signal,
	});

	let generated = "";
	let usage;
	let finish;
	for await (const chunk of stream) {
		switch (chunk.type) {
			case "text-delta":
				generated += chunk.text;
				break;
			case "block-end":
				if (chunk.block?.type === "text" && !generated) generated = chunk.block.text;
				break;
			case "usage":
				usage = chunk.usage;
				break;
			case "finish":
				finish = chunk.reason;
				break;
			default:
				break;
		}
	}

	const fail = (error, failure) => {
		if (usage) error.usage = usage;
		error.chars = generated.length;
		// What the model wrote before it stopped: a truncated join review can still guide the executor.
		error.partialText = generated;
		if (finish?.kind) error.stopReason = finish.kind;
		const identity = failureOf(failure);
		if (identity) error.failure = identity;
		return error;
	};

	// A failed finish must never reach the pipeline as a plan: an error, a cancellation, an unexpected
	// tool call and a token-limit truncation are all failures, even when some text was generated first.
	if (finish?.kind === "error") throw fail(new Error(finish.failure?.message ?? "planner request failed"), finish.failure);
	if (finish?.kind === "aborted") throw fail(abortError("planner request aborted"));
	if (finish?.kind === "tool-calls") throw fail(new Error("planner requested tool calls, but no tools were sent"));
	if (finish?.kind === "max-tokens") {
		// Partial text is not a plan: a truncated SEARCH/REPLACE block can corrupt files when applied.
		throw fail(new Error(`planner output hit the token limit after ${generated.length} characters`));
	}
	if (!generated.trim()) throw fail(new Error("planner returned an empty response"));

	return {
		text: generated.trim(),
		usage,
		stopReason: finish?.kind ?? "stop",
		...(controls.reasoningEffort ? { reasoningEffort: controls.reasoningEffort } : {}),
		...(controls.maxTokens !== undefined ? { maxTokens: controls.maxTokens } : {}),
	};
}

/** The child's tool calls, steps and usage; undefined when its session cannot be read. */
function childStats(agent) {
	const session = agent?.session;
	if (!session || typeof session.snapshotEvents !== "function") return undefined;
	try {
		const events = session.snapshotEvents();
		// A forked child starts from inherited parent events; count only the child's own.
		const inherited = Number(session.header?.inheritedEventCount) || 0;
		return sessionStats(inherited > 0 ? events.filter((event) => !(event?.seq < inherited)) : events);
	} catch {
		return undefined;
	}
}

/**
 * Run the plan in a brand-new child session on the executor model.
 * The child gets a fresh context: the normal system prompt plus the executor appendix and the plan.
 * The result also reports how long the child ran and, read from its session before disposal, its
 * tool calls, model steps, retries and token usage (`stats`).
 * @param {{ subagents: any, agents?: any, onChildStart?: (id: string) => void, onChildEnd?: (id: string) => void }} deps
 */
export async function runExecutor(deps, options) {
	const { parent, providerName, cwd, selection, kickoff, label, signal } = options;
	const childId = randomUUID();
	const startedAt = Date.now();
	deps.onChildStart?.(childId);
	let activation;
	let child;
	const lookup = () => {
		try {
			return deps.agents?.get?.(childId);
		} catch {
			return undefined;
		}
	};
	try {
		activation = await deps.subagents.startActivation({
			provider: providerName,
			label: label ?? "MixAgent executor",
			childId,
			request: {
				parent,
				prompt: [{ type: "text", text: kickoff }],
				...(cwd ? { cwd } : {}),
				...(selection ? { agentOptions: selection } : {}),
			},
			signal,
			delivery: "caller",
		});
		// Hold the live child now: the registry may drop it once the activation settles.
		child = lookup();
		const result = await activation.result;
		const stats = childStats(child ?? lookup());
		return {
			childId,
			output: textOf(result.output).trim(),
			stopReason: result.stopReason,
			diagnostic: result.diagnostic,
			startedAt,
			durationMs: Date.now() - startedAt,
			...(stats ? { stats } : {}),
		};
	} finally {
		if (activation) {
			try {
				await activation.dispose();
			} catch {
				/* teardown failures do not change the captured result */
			}
		}
		deps.onChildEnd?.(childId);
	}
}

/** Run tasks with at most `limit` in flight; results keep input order. */
export async function mapLimit(items, limit, fn) {
	const results = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}
