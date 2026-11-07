/**
 * Markdown plan parsing: `##` sections, `### \`path\` — edit|create|delete` file sections,
 * `## Tasks`/`## Subtasks` lists, and the fork-join assembly.
 */

const FILE_HEADING = /^###\s+`([^`]+)`\s*[—-]\s*(edit|create|delete)\b/i;

export function normalizePlanPath(p) {
	return p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Calls fn for every line; `outsideFence` is false for code fence lines and the lines inside them. */
function forEachLine(text, fn) {
	let fence = 0;
	for (const line of text.split(/\r?\n/)) {
		const ticks = line.match(/^(`{3,})(.*)$/);
		if (fence > 0) {
			if (ticks && ticks[1].length >= fence && !ticks[2].trim()) fence = 0;
		} else if (ticks) {
			fence = ticks[1].length;
		}
		fn(line, fence === 0 && !ticks);
	}
}

/** Splits a plan into its `##` sections and `### \`path\`` file sections, ignoring headings inside code fences. */
function parsePlanParts(plan) {
	const sections = new Map();
	const files = [];
	let current;
	forEachLine(plan, (line, outsideFence) => {
		const file = outsideFence && line.match(FILE_HEADING);
		const heading = outsideFence && line.match(/^##\s+(.+?)\s*$/);
		if (file) {
			current = [];
			files.push({ path: normalizePlanPath(file[1]), lines: current });
		} else if (heading) {
			current = [];
			sections.set(heading[1].toLowerCase(), current);
			return;
		}
		current?.push(line);
	});
	return {
		sections: new Map([...sections].map(([k, v]) => [k, v.join("\n").trim()])),
		files: files.map((f) => ({ path: f.path, text: f.lines.join("\n").trim() })),
	};
}

const TASK_LINE = { T: /^\s*[-*]\s*\**(T\d+)\**\s*[:：.)]\s*(.*)$/i, S: /^\s*[-*]\s*\**(S\d+)\**\s*[:：.)]\s*(.*)$/i };

/** Parses "- T1: `a.ts`, `b.ts` — goal" lines; only the leading backticked items are files. */
function parseTaskLines(body, prefix) {
	const tasks = [];
	for (const line of body.split("\n")) {
		const m = line.match(TASK_LINE[prefix]);
		if (!m) continue;
		const lead = m[2].match(/^(?:\s*`[^`]+`\s*[,，、]?)*/)?.[0] ?? "";
		const files = [...lead.matchAll(/`([^`]+)`/g)].map((f) => normalizePlanPath(f[1]));
		const goal = m[2].slice(lead.length).replace(/^[\s,，—–:-]+/, "").trim();
		tasks.push({ id: m[1].toUpperCase(), goal: goal || files.join(", "), files });
	}
	return tasks;
}

/**
 * Splits a plan with a valid `## Tasks` section into per-task sub-plans with disjoint files.
 * Returns undefined (run one executor) when there is no Tasks section, fewer than 2 tasks, or any
 * file is unassigned, assigned twice, or unknown.
 */
export function splitPlan(plan) {
	const { sections, files } = parsePlanParts(plan);
	const body = sections.get("tasks");
	if (!body) return undefined;
	const tasks = parseTaskLines(body, "T");
	if (tasks.length < 2 || tasks.some((t) => t.files.length === 0)) return undefined;
	if (new Set(tasks.map((t) => t.id)).size !== tasks.length) return undefined;
	const planned = [...new Set(files.map((f) => f.path))];
	const owner = new Map();
	for (let i = 0; i < tasks.length; i++) {
		for (const f of tasks[i].files) {
			if (owner.has(f) || !planned.includes(f)) return undefined;
			owner.set(f, i);
		}
	}
	if (planned.some((p) => !owner.has(p))) return undefined;

	const summary = sections.get("summary");
	const head = summary ? `## Summary\n${summary}\n\n` : "";
	// Text between "## Changes" and the first file section (shared notes) goes to every task.
	const preamble = sections.get("changes");
	const split = tasks.map((t, i) => ({
		...t,
		plan: `${head}## Task ${t.id} (${i + 1} of ${tasks.length})\n${t.goal}\n\nOther executors apply the rest of this plan in parallel: change only the files in the Changes below and do not touch any other file. Do not run build or test commands; they run once after all tasks finish.\n\n## Changes\n\n${preamble ? `${preamble}\n\n` : ""}${files
			.filter((f) => owner.get(f.path) === i)
			.map((f) => f.text)
			.join("\n\n")}`,
	}));
	const commands = sections.get("commands");
	const joinPlan = commands
		? `${head}## Already applied\nParallel executors already applied all file changes of this plan to: ${planned.map((p) => `\`${p}\``).join(", ")}. Do not re-apply them.\n\n## Commands\n${commands}`
		: undefined;
	return { tasks: split, joinPlan, answer: sections.get("answer") };
}

/**
 * If the lead planner split the planning ("## Subtasks" and no file changes), returns the subtasks.
 * Files may overlap: the join planner resolves overlaps.
 */
export function parseSubtasks(plan) {
	const { sections, files } = parsePlanParts(plan);
	const body = sections.get("subtasks");
	if (body === undefined || files.length > 0) return undefined;
	const seen = new Set();
	const subtasks = parseTaskLines(body, "S").filter((t) => !seen.has(t.id) && !!seen.add(t.id));
	return subtasks.length > 0 ? subtasks : undefined;
}

/** Rebuilds the plan with fn's replacement for each file section (heading included); undefined keeps the section. */
export function mapFileSections(plan, fn) {
	const out = [];
	let current;
	let index = 0;
	const flush = () => {
		if (!current) return;
		const { lines, ...section } = current;
		const replaced = fn({ ...section, body: lines.join("\n") }, index++);
		if (replaced === undefined) {
			out.push(section.heading, ...lines);
		} else {
			// Keep the blank lines that separate the section from the next one.
			let end = lines.length;
			while (end > 0 && !lines[end - 1].trim()) end--;
			out.push(replaced, ...lines.slice(end));
		}
		current = undefined;
	};
	forEachLine(plan, (line, outsideFence) => {
		const file = outsideFence && line.match(FILE_HEADING);
		if (file || (outsideFence && /^##\s+(.+?)\s*$/.test(line))) flush();
		if (file) {
			current = { heading: line, path: normalizePlanPath(file[1]), kind: file[2].toLowerCase(), lines: [] };
		} else if (current) {
			current.lines.push(line);
		} else {
			out.push(line);
		}
	});
	flush();
	return out.join("\n");
}

/** The plan's file sections, in order. */
export function fileSections(plan) {
	const sections = [];
	mapFileSections(plan, (section) => void sections.push(section));
	return sections;
}

/** The plan's top-level `## Name` sections, lowercased, without the file sections. */
export function planSections(plan) {
	return parsePlanParts(plan).sections;
}

/** Heads the join's notes in a file section; the executor only learns how to apply them from here. */
export const REVISIONS_NOTE = "Revisions by the join planner (notes, not exact edits: `read`/`grep` the code to find the exact places";

/** Parses the join planner's "## Revisions": one "### `path`" entry of notes per file. */
function parseRevisions(join) {
	const revisions = [];
	let inRevisions = false;
	let current;
	forEachLine(join, (line, outsideFence) => {
		const heading = outsideFence && line.match(/^##\s+(.+?)\s*$/);
		const file = outsideFence && inRevisions && line.match(/^###\s+`([^`]+)`\s*(?:[—-]\s*(edit|create|delete)\b)?/i);
		if (heading) {
			inRevisions = heading[1].toLowerCase() === "revisions";
			current = undefined;
		} else if (file) {
			current = [];
			revisions.push({ path: normalizePlanPath(file[1]), kind: file[2]?.toLowerCase(), lines: current });
		} else {
			current?.push(line);
		}
	});
	return revisions.map((r) => ({ path: r.path, kind: r.kind, notes: r.lines.join("\n").trim() })).filter((r) => r.notes);
}

/** A join placeholder heading that stands for a sub-plan's section: "### `path` — from S1" (or "from S1, S2"). */
const FROM_HEADING = /^###\s+`([^`]+)`\s*[—–-]\s*from\s+(S\d+(?:\s*(?:[,，、&+/]|and)\s*S\d+)*)/i;

/**
 * Replaces every "### `path` — from Sx" placeholder in a join that wrote its own "## Changes" with that
 * sub-plan's section(s) for the file, verbatim. If the named sub-plan has no section for the file, every
 * sub-plan's section for it is used; a placeholder no sub-plan can fill is left as is.
 */
function expandFromPlaceholders(join, subPlans) {
	const filesOf = new Map(subPlans.map((s) => [s.id.toUpperCase(), parsePlanParts(s.plan).files]));
	const sectionsFor = (path, ids) => {
		const pick = (id) =>
			(filesOf.get(id) ?? [])
				.filter((f) => f.path === path)
				.map((f) => {
					const [heading, ...body] = f.text.split("\n");
					return [`${heading} (${id})`, ...body].join("\n");
				});
		const named = ids.flatMap(pick);
		return named.length > 0 ? named : [...filesOf.keys()].flatMap(pick);
	};
	const out = [];
	forEachLine(join, (line, outsideFence) => {
		const from = outsideFence && line.match(FROM_HEADING);
		const parts = from ? sectionsFor(normalizePlanPath(from[1]), [...from[2].matchAll(/S\d+/gi)].map((m) => m[0].toUpperCase())) : [];
		out.push(parts.length > 0 ? parts.join("\n\n") : line);
	});
	return out.join("\n");
}

/**
 * Builds the final fork-join plan, so the join planner never copies sub-plans: every sub-plan file section as
 * written (grouped by file), followed by the join's revision notes for that file, then the join's Tasks, Commands
 * and Answer. A join that wrote its own "## Changes" anyway is used as is, except that its
 * "### `path` — from Sx" placeholders are replaced by the sub-plans' sections.
 */
export function assembleJoinPlan(join, subPlans) {
	const { sections } = parsePlanParts(join);
	if (sections.has("changes")) return expandFromPlaceholders(join, subPlans);
	const byPath = new Map();
	for (const s of subPlans) {
		for (const f of parsePlanParts(s.plan).files) {
			const [heading, ...body] = f.text.split("\n");
			byPath.set(f.path, [...(byPath.get(f.path) ?? []), [`${heading} (${s.id})`, ...body].join("\n")]);
		}
	}
	for (const r of parseRevisions(join)) {
		const parts = byPath.get(r.path);
		if (parts) parts.push(`${REVISIONS_NOTE}, they take precedence over the blocks above):\n${r.notes}`);
		else byPath.set(r.path, [`### \`${r.path}\` — ${r.kind ?? "edit"}\n${REVISIONS_NOTE}):\n${r.notes}`]);
	}
	const changes = [...byPath.values()].map((parts) => parts.join("\n\n")).join("\n\n");
	return [
		sections.get("summary") && `## Summary\n${sections.get("summary")}`,
		changes && `## Changes\n\n${changes}`,
		...["Tasks", "Commands", "Answer"].map((name) => sections.get(name.toLowerCase()) && `## ${name}\n${sections.get(name.toLowerCase())}`),
	]
		.filter(Boolean)
		.join("\n\n");
}

/**
 * The usable part of a join review that hit the output limit: its top-level sections minus the last one
 * (the section being written when the output stopped) and minus any "## Changes" of its own, whose
 * SEARCH/REPLACE blocks cannot be trusted. What is dropped stays in the saved plan for the executor.
 */
export function completedJoinSections(partial) {
	const sections = [];
	let current;
	forEachLine(partial ?? "", (line, outsideFence) => {
		const heading = outsideFence && line.match(/^##\s+(.+?)\s*$/);
		if (heading) {
			current = { name: heading[1].toLowerCase(), lines: [line] };
			sections.push(current);
		} else {
			current?.lines.push(line);
		}
	});
	sections.pop();
	return sections
		.filter((section) => section.name !== "changes")
		.map((section) => section.lines.join("\n").trimEnd())
		.join("\n\n");
}

/** If the planner asked for more context, returns the request body; otherwise undefined. */
export function parseNeedContext(plan) {
	const match = plan.match(/^#{1,3}\s*Need context\s*$/im);
	if (!match || match.index === undefined) return undefined;
	// Only treat it as a context request when no actual changes/answer were produced.
	if (/^#{1,3}\s*(Changes|Answer)\s*$/im.test(plan)) return undefined;
	return plan.slice(match.index + match[0].length).trim() || "(no details given)";
}

/** Rough count of file operations in a plan, for status display. */
export function countPlanChanges(plan) {
	return (plan.match(/^###\s+`[^`]+`\s*[—-]\s*(edit|create|delete)\b/gim) ?? []).length;
}
