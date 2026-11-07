/**
 * Packs the scout's work (user request + tool calls/results) into a compact Markdown document for
 * the planner.
 */

import { isAbsolute, resolve } from "node:path";

export const HANDOFF_TOOL = "handoff";
export const DISCARD_TOOL = "discard";

export function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c?.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
}

/** The current (unfinished) turn's surface messages, read from the durable session log. */
export function readCycle(session) {
	const events = session.snapshotEvents();
	let start = 0;
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i].type === "turn/end") {
			start = i + 1;
			break;
		}
	}
	const messages = [];
	for (const event of events.slice(start)) {
		if (event.type === "user/message") messages.push(event.data);
		else if (event.type === "assistant/message") messages.push(event.data.message);
		else if (event.type === "tool/result") messages.push(event.data.message);
	}
	return messages;
}

/** Tool call arguments are logged as JSON text; tolerate malformed input. */
export function parseArgs(raw) {
	if (raw === undefined || raw === null) return {};
	if (typeof raw === "object") return raw;
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

/** DSH's read/write/edit tools name the file `file_path`; earlier pi tools used `path`. */
function filePathOf(args) {
	return args.file_path ?? args.path;
}

function callBlocks(message) {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
	return message.content.filter((block) => block?.type === "tool-call");
}

/**
 * Whether a user-role message is the user's own input. DSH also writes runtime-context snapshots,
 * compaction checkpoints and other plugin injections as user messages, each tagged with its producer's
 * `source.kind`; only `kind: "user"` (or an untagged message) is a request.
 */
export function isUserInput(message) {
	if (message?.role !== "user") return false;
	const kind = message.source?.kind;
	return kind === undefined || kind === "user";
}

/** The image blocks of one message's content, in order (DSH images reference stored attachments). */
export function imagesOf(content) {
	if (!Array.isArray(content)) return [];
	return content.filter((block) => block?.type === "image" && block.attachment);
}

export function discardNote(ref, reason) {
	return `[#${ref} discarded${reason?.trim() ? `: ${reason.trim()}` : ""}]`;
}

export function extractCycle(messages, discarded = new Map()) {
	const results = new Map();
	for (const message of messages) {
		if (message.role === "tool" && message.toolCallId !== undefined) results.set(message.toolCallId, message);
	}

	const cycle = { requests: [], requestImages: [], steps: [], plannerRequests: [] };
	let ref = 0;
	for (const message of messages) {
		if (message.role === "user") {
			if (!isUserInput(message)) continue;
			const text = textOf(message.content).trim();
			if (text) cycle.requests.push(text);
			cycle.requestImages.push(...imagesOf(message.content));
			continue;
		}
		if (message.role !== "assistant") continue;
		for (const call of callBlocks(message)) {
			const result = results.get(call.id);
			if (call.name === HANDOFF_TOOL) {
				if (result && !result.isError && textOf(result.content).trim().startsWith("## Need context")) {
					cycle.plannerRequests.push(textOf(result.content).trim());
				}
				continue;
			}
			if (call.name === DISCARD_TOOL) continue;
			if (!result) continue;
			ref += 1;
			const hit = discarded.get(call.id);
			cycle.steps.push({
				ref,
				toolName: call.name,
				args: parseArgs(call.arguments),
				output: textOf(result.content).replace(/^\[#\d+\]\n?/, ""),
				isError: !!result.isError,
				discarded: hit ? (hit.reason?.trim() ?? "") : undefined,
				images: imagesOf(result.content),
			});
		}
	}
	return cycle;
}

/** 1-based step number -> tool call id for one cycle, matching extractCycle's numbering. */
export function cycleCallIds(messages) {
	const ids = new Map();
	let ref = 0;
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const call of callBlocks(message)) {
			if (call.name === HANDOFF_TOOL || call.name === DISCARD_TOOL) continue;
			ref += 1;
			ids.set(ref, call.id);
		}
	}
	return ids;
}

/** Tool-call id -> the seq of its committed `tool/result` event, for context replacement. */
export function toolResultSeqs(session) {
	const seqs = new Map();
	for (const event of session.snapshotEvents()) {
		if (event.type === "tool/result") seqs.set(event.data.message.source.callId, event.seq);
	}
	return seqs;
}

function normalizePath(cwd, p) {
	const stripped = p.replace(/^@/, "");
	return (isAbsolute(stripped) ? stripped : resolve(cwd, stripped)).replace(/\\/g, "/").toLowerCase();
}

function readLines(step) {
	const offset = Number(step.args.offset);
	const limit = Number(step.args.limit);
	const first = offset > 1 ? Math.floor(offset) : 1;
	const count = Math.min(step.output.split("\n").length, limit > 0 ? limit : Infinity);
	return { first, last: first + count - 1 };
}

/** Removes identical repeated calls (keeps the latest) and reads of files attached in full anyway. */
export function dedupeSteps(steps, cwd, attachedFiles) {
	const attached = new Map(attachedFiles.map((f) => [normalizePath(cwd, f.path), f.cut]));
	const seen = new Set();
	const kept = [];
	for (let i = steps.length - 1; i >= 0; i--) {
		const step = steps[i];
		const path = filePathOf(step.args);
		if (step.toolName === "read" && typeof path === "string" && !step.isError) {
			const normalized = normalizePath(cwd, path);
			if (attached.has(normalized)) {
				// A read that reaches into the lines cut from a truncated file is the package's only copy of them.
				const cut = attached.get(normalized);
				const read = readLines(step);
				if (!cut || read.last < cut.first || read.first > cut.last) continue;
			}
		}
		const key = `${step.toolName}\u0000${JSON.stringify(step.args)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		kept.push(step);
	}
	return kept.reverse();
}

const keptHead = (max) => Math.floor(max * 0.7);

export function truncateMiddle(text, max) {
	if (text.length <= max) return text;
	const head = keptHead(max);
	const tail = max - head;
	const omitted = text.length - head - tail;
	return `${text.slice(0, head)}\n… [${omitted} chars omitted] …\n${text.slice(text.length - tail)}`;
}

/** Lines that truncateMiddle(text, max) drops in whole or in part; undefined when nothing is dropped. */
function truncatedLines(text, max) {
	if (text.length <= max) return undefined;
	const head = keptHead(max);
	const tailStart = text.length - (max - head);
	const lineAt = (index) => text.slice(0, index).split("\n").length;
	return { first: lineAt(head), last: lineAt(tailStart - 1) };
}

export function describeCall(toolName, args) {
	switch (toolName) {
		case "bash":
		case "pwsh":
			return `$ ${args.command ?? ""}`;
		case "read": {
			const range =
				args.offset !== undefined || args.limit !== undefined
					? ` (offset ${args.offset ?? 1}, limit ${args.limit ?? "∞"})`
					: "";
			return `read ${filePathOf(args)}${range}`;
		}
		case "grep":
			return `grep ${JSON.stringify(args.pattern)}${args.path ? ` in ${args.path}` : ""}${args.include ? ` --include ${args.include}` : ""}`;
		case "glob":
			return `glob ${JSON.stringify(args.pattern)}${args.path ? ` in ${args.path}` : ""}`;
		case "ls":
			return `ls ${args.path ?? "."}`;
		case "write":
			return `write ${filePathOf(args) ?? ""}`;
		case "edit":
			return `edit ${filePathOf(args) ?? ""}`;
		default:
			return `${toolName} ${JSON.stringify(args)}`;
	}
}

/** Longest run of backticks in text, so fences can always be made longer than any content. */
function fenceFor(text) {
	let longest = 0;
	for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
	return "`".repeat(Math.max(3, longest + 1));
}

function fenced(text, lang = "") {
	const fence = fenceFor(text);
	return `${fence}${lang}\n${text.replace(/\n$/, "")}\n${fence}`;
}

const EXT_LANG = {
	ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", cjs: "js", py: "python", rs: "rust", go: "go",
	java: "java", kt: "kotlin", cs: "csharp", cpp: "cpp", cc: "cpp", c: "c", h: "c", hpp: "cpp",
	rb: "ruby", php: "php", swift: "swift", sh: "bash", json: "json", yaml: "yaml", yml: "yaml",
	toml: "toml", md: "markdown", html: "html", css: "css", scss: "scss", sql: "sql", vue: "vue", svelte: "svelte",
};

export function langFor(path) {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return EXT_LANG[ext] ?? "";
}

/**
 * Builds the Markdown document sent to the planner, plus the images it references as `[image N]`.
 * Images past `maxImages` are named `[image omitted]` so the planner still knows one existed.
 */
export function buildPlannerPackage(input) {
	const { cycle, notes, files, cwd } = input;
	const maxImages = input.maxImages ?? Infinity;
	const parts = [];
	const images = [];
	const attach = (list, label) =>
		list
			.map((block) => {
				if (images.length >= maxImages) return "[image omitted]";
				images.push({ block, label });
				return `[image ${images.length}]`;
			})
			.join(" ");

	const [request, ...followUps] = cycle.requests;
	parts.push(`# User request\n\n${request ?? "(empty)"}`);
	if (followUps.length > 0) {
		parts.push(`## Additional user messages\n\n${followUps.map((t) => `- ${t.replace(/\n/g, "\n  ")}`).join("\n")}`);
	}
	if (cycle.requestImages?.length > 0) {
		parts.push(`## Images attached by the user\n\n${attach(cycle.requestImages, "attached by the user")}`);
	}
	parts.push(`# Environment\n\nWorking directory: \`${cwd}\`\nPlatform: ${process.platform}`);

	if (notes.trim()) parts.push(`# Scout notes\n\n${notes.trim()}`);

	if (cycle.plannerRequests.length > 0) {
		parts.push(
			`# Your earlier context requests (already handled by the scout below)\n\n${cycle.plannerRequests.join("\n\n")}`,
		);
	}

	const steps = dedupeSteps(
		cycle.steps,
		cwd,
		files
			.filter((f) => f.content !== undefined || f.image)
			.map((f) => ({ path: f.path, cut: f.content === undefined ? undefined : truncatedLines(f.content, input.maxFileChars) })),
	);
	if (steps.length > 0) {
		const rendered = steps.map((step, i) => {
			if (step.discarded !== undefined) {
				const why = step.discarded ? `: ${step.discarded}` : "";
				return `## ${i + 1}. ${describeCall(step.toolName, step.args).split("\n")[0]}\n\n[discarded by the scout as irrelevant${why}]`;
			}
			const output = truncateMiddle(step.output || "(no output)", input.maxToolOutputChars);
			const label = step.isError ? " (error)" : "";
			const title = describeCall(step.toolName, step.args).split("\n")[0];
			const stepImages = step.images?.length ? `\n\n${attach(step.images, `step ${i + 1}: ${title}`)}` : "";
			return `## ${i + 1}. ${title}${label}\n\n${
				(step.toolName === "bash" || step.toolName === "pwsh") && step.args.command?.includes("\n")
					? `${fenced(step.args.command, "bash")}\n\n`
					: ""
			}${fenced(output)}${stepImages}`;
		});
		parts.push(`# Scout tool calls\n\n${rendered.join("\n\n")}`);
	}

	if (files.length > 0) {
		const rendered = files.map((f) => {
			if (f.image) return `## \`${f.path}\`\n\n${attach([f.image], `key file ${f.path}`)}`;
			if (f.content === undefined) return `## \`${f.path}\`\n\n(unavailable: ${f.error ?? "unknown error"})`;
			return `## \`${f.path}\`\n\n${fenced(truncateMiddle(f.content, input.maxFileChars), langFor(f.path))}`;
		});
		parts.push(`# Key files (current full content)\n\n${rendered.join("\n\n")}`);
	}

	return { text: truncateMiddle(parts.join("\n\n"), input.maxPackageChars), images };
}

/**
 * The tool results a finished cycle's pruning replaces: every completed scout step except the handoff
 * (its result is the record of what happened), discard results included. Returns call ids and titles.
 */
export function prunableCalls(messages) {
	const done = new Set();
	for (const message of messages) {
		if (message.role === "tool" && message.toolCallId !== undefined) done.add(message.toolCallId);
	}
	const calls = [];
	for (const message of messages) {
		for (const call of callBlocks(message)) {
			if (call.name === HANDOFF_TOOL || !done.has(call.id)) continue;
			calls.push({ callId: call.id, title: describeCall(call.name, parseArgs(call.arguments)).split("\n")[0] });
		}
	}
	return calls;
}

/** Stands in for a scout result once its cycle's handoff finished. */
export function prunedNote(title) {
	return `[pruned by MixAgent after the handoff finished: ${title.length > 200 ? `${title.slice(0, 200)}…` : title}]`;
}
