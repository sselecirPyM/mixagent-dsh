/**
 * Auto-apply: before the executor starts, MixAgent applies the plan's exact file changes itself
 * (SEARCH/REPLACE edits, new files, deletions), so the executor does not spend its first turns
 * copying them into tool calls.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileSections, mapFileSections, REVISIONS_NOTE } from "./plan.js";
import { AUTO_APPLIED, AUTO_APPLY_FAILED } from "./prompts.js";

const SEARCH = /^<{5,9} ?SEARCH\s*$/;
const DIVIDER = /^={5,9}\s*$/;
const REPLACE = /^>{5,9} ?REPLACE\s*$/;
const FENCE = /^(`{3,})(.*)$/;

/** Splits lines into the text outside code fences and the content of each fence. */
function splitFences(lines) {
	const outside = [];
	const fences = [];
	let open = 0;
	for (const line of lines) {
		const ticks = line.match(FENCE);
		const fence = fences[fences.length - 1];
		if (open > 0) {
			if (ticks && ticks[1].length >= open && !ticks[2].trim()) {
				open = 0;
				fence.closed = true;
			} else {
				fence.lines.push(line);
			}
		} else if (ticks) {
			open = ticks[1].length;
			fences.push({ lines: [], closed: false });
		} else {
			outside.push(line);
		}
	}
	return { outside, fences };
}

/**
 * Parses an edit section into its SEARCH/REPLACE blocks and the description around them, or returns
 * why it is not plainly that: malformed or unterminated blocks, an empty SEARCH, a block with two
 * dividers (ambiguous), or code outside the blocks.
 */
export function parseEditSection(body) {
	const blocks = [];
	const rest = [];
	let search;
	let replace;
	for (const line of body.split("\n")) {
		if (!search) {
			if (SEARCH.test(line)) search = [];
			else if (DIVIDER.test(line) || REPLACE.test(line)) return "malformed SEARCH/REPLACE markers";
			else rest.push(line);
		} else if (!replace) {
			if (DIVIDER.test(line)) replace = [];
			else if (SEARCH.test(line) || REPLACE.test(line)) return "malformed SEARCH/REPLACE markers";
			else search.push(line);
		} else if (REPLACE.test(line)) {
			if (!search.some((l) => l.trim())) return "an empty SEARCH block";
			blocks.push({ oldText: search.join("\n"), newText: replace.join("\n") });
			search = undefined;
			replace = undefined;
		} else if (DIVIDER.test(line)) {
			return "a block with two dividers (ambiguous)";
		} else if (SEARCH.test(line)) {
			return "malformed SEARCH/REPLACE markers";
		} else {
			replace.push(line);
		}
	}
	if (search) return "an unterminated SEARCH/REPLACE block";
	if (blocks.length === 0) return "no SEARCH/REPLACE blocks";
	const { outside, fences } = splitFences(rest);
	if (fences.some((f) => f.lines.some((l) => l.trim()))) return "code outside the SEARCH/REPLACE blocks";
	return { blocks, description: outside.join("\n").trim() };
}

/** Parses a create section: exactly one closed code block (the file content) and an optional description. */
export function parseCreateSection(body) {
	const { outside, fences } = splitFences(body.split("\n"));
	if (fences.length !== 1) return fences.length === 0 ? "no code block with the file content" : "more than one code block";
	const { lines, closed } = fences[0];
	if (!closed) return "an unterminated code block";
	if (lines.some((l) => SEARCH.test(l)) && lines.some((l) => REPLACE.test(l))) return "SEARCH/REPLACE blocks in a new file";
	// As in Markdown, every line of the code block ends with a newline.
	return { content: lines.map((l) => `${l}\n`).join(""), description: outside.join("\n").trim() };
}

/** Absolute path of a plan path inside cwd; undefined outside it and for ~ or @ paths (the tools expand those). */
export function insideCwd(cwd, path) {
	if (/^[~@]/.test(path)) return undefined;
	const abs = resolve(cwd, path);
	const rel = relative(cwd, abs);
	return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? abs : undefined;
}

/**
 * Applies blocks to LF-normalized text; returns the new text or a failure reason.
 * Like the reference's edit tool, every SEARCH is matched against the original file (never against an
 * earlier block's output): it must occur exactly once there, and no two blocks may overlap.
 */
export function applyBlocks(text, blocks) {
	const edits = [];
	for (let i = 0; i < blocks.length; i++) {
		const search = blocks[i].oldText.replace(/\r\n?/g, "\n");
		if (!search) return { error: `SEARCH block ${i + 1} is empty` };
		const first = text.indexOf(search);
		if (first < 0) return { error: `SEARCH block ${i + 1} does not match the file exactly` };
		if (text.indexOf(search, first + search.length) >= 0) return { error: `SEARCH block ${i + 1} is not unique in the file` };
		edits.push({ index: i, start: first, end: first + search.length, replace: blocks[i].newText.replace(/\r\n?/g, "\n") });
	}
	edits.sort((a, b) => a.start - b.start);
	for (let k = 1; k < edits.length; k++) {
		if (edits[k].start < edits[k - 1].end) {
			const [a, b] = [edits[k - 1].index, edits[k].index].sort((x, y) => x - y);
			return { error: `SEARCH blocks ${a + 1} and ${b + 1} overlap in the file` };
		}
	}
	let out = "";
	let at = 0;
	for (const edit of edits) {
		out += text.slice(at, edit.start) + edit.replace;
		at = edit.end;
	}
	out += text.slice(at);
	if (out === text) return { error: "the SEARCH/REPLACE blocks make no change to the file" };
	return { text: out };
}

/**
 * Applies the plan's exact file changes in cwd.
 * @param plan - the planner's Markdown plan.
 * @param cwd - working directory; plan paths outside it are left to the executor.
 * @param ops - injected file operations: read(abs), exists(abs), isFile(abs), write(abs, text), remove(abs).
 * @returns {{ plan: string, files: { path: string, kind: string, status: string, message: string }[] }}
 */
export async function autoApplyPlan(plan, cwd, ops) {
	const sections = fileSections(plan);
	const byPath = new Map();
	sections.forEach((s, i) => byPath.set(s.path, [...(byPath.get(s.path) ?? []), i]));
	const files = [];
	/** Section index -> the executor's text for that section (only for applied or failed files). */
	const noted = new Map();

	for (const [path, indexes] of byPath) {
		const group = indexes.map((i) => sections[i]);
		const kind = group[0].kind;
		const abs = insideCwd(cwd, path);
		/** @type {{ descriptions: string[], run: () => Promise<string> } | string} */
		let prepared;

		if (new Set(group.map((s) => s.kind)).size > 1) {
			prepared = "several kinds of change for one file";
		} else if (group.some((s) => s.body.includes(REVISIONS_NOTE))) {
			prepared = "the join planner's revision notes need the executor";
		} else if (!abs) {
			prepared = "outside the working directory";
		} else if (kind === "edit") {
			const parsed = group.map((s) => parseEditSection(s.body));
			const error = parsed.find((p) => typeof p === "string");
			if (error !== undefined) {
				prepared = error;
			} else {
				const ok = parsed.filter((p) => typeof p !== "string");
				const blocks = ok.flatMap((p) => p.blocks);
				const content = await ops.read(abs);
				if (content === undefined) {
					prepared = "the file does not exist";
				} else {
					const bom = content.charCodeAt(0) === 0xfeff ? "\uFEFF" : "";
					const crlf = /\r\n/.test(content);
					const body = (bom ? content.slice(1) : content).replace(/\r\n?/g, "\n");
					const result = applyBlocks(body, blocks);
					if (result.error) {
						prepared = result.error;
					} else {
						const next = result.text + (crlf ? "" : "");
						prepared = {
							descriptions: ok.map((p) => p.description),
							run: async () => {
								const finalText = crlf ? `${bom}${next.replace(/\n/g, "\r\n")}` : `${bom}${next}`;
								return ops.write(abs, finalText, path);
							},
						};
					}
				}
			}
		} else if (kind === "create") {
			if (group.length > 1) {
				prepared = "more than one create section";
			} else {
				const parsed = parseCreateSection(group[0].body);
				if (typeof parsed === "string") {
					prepared = parsed;
				} else if (await ops.exists(abs)) {
					prepared = "the file already exists";
				} else {
					prepared = {
						descriptions: [parsed.description],
						run: () => ops.write(abs, parsed.content, path),
					};
				}
			}
		} else if (!(await ops.isFile(abs))) {
			prepared = "not a file";
		} else {
			prepared = {
				descriptions: group.map((s) => splitFences(s.body.split("\n")).outside.join("\n").trim()),
				run: () => ops.remove(abs, path),
			};
		}

		if (typeof prepared === "string") {
			files.push({ path, kind, status: "skipped", message: prepared });
			continue;
		}

		let file;
		try {
			file = { path, kind, status: "applied", message: await prepared.run() };
		} catch (err) {
			file = { path, kind, status: "failed", message: err instanceof Error ? err.message : String(err) };
		}
		files.push(file);
		const applied = file.status === "applied";
		group.forEach((s, k) => {
			const text = applied ? prepared.descriptions[k] : s.body.trim();
			const line = `${applied ? AUTO_APPLIED : AUTO_APPLY_FAILED}: ${file.message}`;
			noted.set(indexes[k], [s.heading, ...(text ? [text, ""] : []), line].join("\n"));
		});
	}

	return { plan: mapFileSections(plan, (_, i) => noted.get(i)), files };
}
