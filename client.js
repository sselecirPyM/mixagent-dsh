/**
 * MixAgent browser half: every config field on the plugin's page in Plugins, and the `handoff` tool
 * card in the conversation (live progress while it runs, the full run trace once it finishes).
 *
 * The Host plugin declares `scoutModel`, `plannerModel` and `executorModel` as volatile config, so the
 * settings form this page is bound to writes them live into the profile patch, without a restart.
 * The model list comes from the Host's Session model catalog; when it cannot be read the fields fall
 * back to a free-text `provider/modelId` input. Each role also has a volatile thinking level
 * (`scoutThinking`, `plannerThinking`, `executorThinking`) chosen next to its model. Every other
 * field (mode, planner, package limits, behavior) is volatile too and edited in the sections below.
 */

window.__ModuleLoader__.load({
	id: "mixagent-dsh",
	factory(require) {
		const React = require("react");
		const h = React.createElement;

		const NS = "mixagent";
		/** Host entry id of this bundle's plugin row; also the settings namespace of its form. */
		const ENTRY_ID = "mixagent-dsh";
		/** Slot key of a bundle-wide configuration page: the bundle's package name. */
		const BUNDLE_KEY = "mixagent-dsh";

		const ROLES = [
			{ key: "scoutModel", thinkingKey: "scoutThinking", thinkingDefault: "off", role: "scout", label: "scout", hint: "scoutHint", empty: "scoutEmpty" },
			{ key: "plannerModel", thinkingKey: "plannerThinking", thinkingDefault: "high", role: "planner", label: "planner", hint: "plannerHint", empty: "plannerEmpty" },
			{ key: "executorModel", thinkingKey: "executorThinking", thinkingDefault: "off", role: "executor", label: "executor", hint: "executorHint", empty: "executorEmpty" },
		];
		/** Thinking levels offered when the catalog does not say which ones a model supports. */
		const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

		/**
		 * The remaining config fields, grouped into sections. `def` and the bounds mirror the Host schema
		 * (index.js); a value equal to its default is saved as unset so a later default change still applies.
		 */
		const SECTIONS = [
			{
				title: "sectionMode",
				fields: [
					{ key: "enabled", kind: "bool", def: false },
					{ key: "presets", kind: "list", def: ["mix"] },
				],
			},
			{
				title: "sectionPlanner",
				fields: [
					{ key: "plannerMaxTokens", kind: "int", def: 32000, min: 256, max: 1000000 },
					{ key: "maxContextRounds", kind: "int", def: 3, min: 0, max: 20 },
					{ key: "forkJoin", kind: "bool", def: true },
					{ key: "maxParallelPlanners", kind: "int", def: 4, min: 1, max: 16 },
					{ key: "maxParallelExecutors", kind: "int", def: 4, min: 1, max: 16 },
				],
			},
			{
				title: "sectionPackage",
				fields: [
					{ key: "maxToolOutputChars", kind: "int", def: 20000, min: 1000, max: 10000000 },
					{ key: "maxFileChars", kind: "int", def: 60000, min: 1000, max: 10000000 },
					{ key: "maxPackageChars", kind: "int", def: 600000, min: 1000, max: 10000000 },
					{ key: "maxPlannerImages", kind: "int", def: 10, min: 0, max: 100 },
				],
			},
			{
				title: "sectionBehavior",
				fields: [
					{ key: "scoutBashGuard", kind: "bool", def: true },
					{ key: "autoApply", kind: "bool", def: true },
					{ key: "pruneScoutHistory", kind: "bool", def: true },
					{ key: "discardRewritesContext", kind: "bool", def: true },
					{ key: "planDir", kind: "text", def: "~/.dsh/mixagent/plans" },
				],
			},
		];

		/** Every field the page edits: the three model routes, their thinking levels, then the sections. */
		const FIELDS = [
			...ROLES.flatMap((role) => [
				{ key: role.key, kind: "model", def: "" },
				{ key: role.thinkingKey, kind: "thinking", def: role.thinkingDefault },
			]),
			...SECTIONS.flatMap((section) => section.fields),
		];

		/** The form (input) representation of a stored value: booleans stay booleans, everything else is text. */
		function toInput(field, value) {
			switch (field.kind) {
				case "bool":
					return typeof value === "boolean" ? value : field.def;
				case "int":
					return String(typeof value === "number" && Number.isFinite(value) ? value : field.def);
				case "list":
					return (Array.isArray(value) ? value : field.def).join(", ");
				case "thinking":
					return typeof value === "string" && value.trim() ? value.trim() : field.def;
				default:
					return typeof value === "string" ? value : field.def;
			}
		}

		/** The stored value of a form input, or `{ invalid: true }` for a number outside the schema bounds. */
		function fromInput(field, input) {
			switch (field.kind) {
				case "int": {
					const text = String(input).trim();
					if (!/^\d+$/.test(text)) return { invalid: true };
					const value = Number(text);
					if (value < field.min || value > field.max) return { invalid: true };
					return { value };
				}
				case "list":
					return {
						value: String(input)
							.split(/[,\s]+/)
							.map((entry) => entry.trim())
							.filter(Boolean),
					};
				case "text":
				case "model":
					return { value: String(input).trim() };
				default:
					return { value: input };
			}
		}

		const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

		const zh = {
			title: "模型",
			description: "选择 MixAgent 三个角色使用的模型和思考等级。模型留空时跟随当前会话的模型。保存后立即生效，无需重启。",
			scout: "侦察 Scout",
			scoutHint: "只读探查代码的便宜模型。",
			planner: "规划 Planner",
			plannerHint: "只写修改方案的旗舰模型。",
			executor: "执行 Executor",
			executorHint: "在全新会话里应用方案的便宜模型。",
			scoutEmpty: "跟随会话模型",
			plannerEmpty: "使用会话模型",
			executorEmpty: "继承侦察模型",
			thinking: "思考等级",
			thinkingOff: "模型默认",
			thinkingHint: "每个角色的思考（推理）等级；模型不支持所选等级时使用模型默认值。",
			save: "保存",
			discard: "撤销",
			saved: "已保存",
			saveFailed: "保存失败，请重试",
			saving: "正在保存…",
			unavailable: "当前配置不可编辑。",
			catalogLoading: "正在读取模型列表…",
			catalogFailed: "无法读取模型列表，请直接输入 provider/modelId。",
			placeholder: "provider/modelId",
			modeTitle: "MixAgent 模式",
			modeHint: "新建会话时选择 MixAgent 预设即可直接进入模式；普通对话不会收到 MixAgent 的提示词，也可以用 /mix on 进入、/mix off 退出。",
			invalid: "请输入 {min} 到 {max} 之间的整数",
			invalidSave: "有字段的值无效，请修正后再保存",
			sectionMode: "模式",
			sectionPlanner: "规划与并行",
			sectionPackage: "上下文包上限",
			sectionBehavior: "行为",
			"field.enabled": "新会话默认进入 MixAgent 模式",
			"field.enabled.hint": "关闭时普通对话完全不受影响，需要 /mix on 才进入（推荐关闭）。",
			"field.presets": "触发预设",
			"field.presets.hint": "这些 Agent 预设 id 的会话自动进入 MixAgent 模式，用逗号分隔；留空关闭预设触发。",
			"field.plannerMaxTokens": "Planner 输出上限",
			"field.plannerMaxTokens.hint": "Planner 单次调用的最大输出 token，超过模型上限时自动收敛。",
			"field.maxContextRounds": "补充上下文轮数",
			"field.maxContextRounds.hint": "Planner 每次请求最多能要求 Scout 补充上下文几次。",
			"field.forkJoin": "拆分子任务（fork-join）",
			"field.forkJoin.hint": "允许 Planner 拆分子任务、join 合并，并由多个 Executor 并行执行。",
			"field.maxParallelPlanners": "并行子 Planner 上限",
			"field.maxParallelPlanners.hint": "同时运行的子 Planner 数量上限。",
			"field.maxParallelExecutors": "并行 Executor 上限",
			"field.maxParallelExecutors.hint": "同时运行的任务 Executor 数量上限。",
			"field.maxToolOutputChars": "单个工具结果字符上限",
			"field.maxToolOutputChars.hint": "打包给 Planner 时每个工具结果的字符上限。",
			"field.maxFileChars": "单个关键文件字符上限",
			"field.maxFileChars.hint": "打包给 Planner 时每个关键文件的字符上限。",
			"field.maxPackageChars": "上下文包总字符上限",
			"field.maxPackageChars.hint": "发给 Planner 的整个上下文包的字符上限。",
			"field.maxPlannerImages": "图片数量上限",
			"field.maxPlannerImages.hint": "发给 Planner 的图片上限，超出的写为 [image omitted]。",
			"field.scoutBashGuard": "Scout shell 只读拦截",
			"field.scoutBashGuard.hint": "拦截 Scout 执行可能有写操作的 shell 命令。",
			"field.autoApply": "自动应用",
			"field.autoApply.hint": "启动 Executor 前直接应用方案里明确的修改。",
			"field.pruneScoutHistory": "交接后精简 Scout 上下文",
			"field.pruneScoutHistory.hint": "交接完成后，把本轮 Scout 的工具结果替换为一行说明。",
			"field.discardRewritesContext": "discard 同时改写上下文",
			"field.discardRewritesContext.hint": "discard 时同时替换 Scout 自己上下文里的工具结果。",
			"field.planDir": "方案保存目录",
			"field.planDir.hint": "方案 Markdown 的保存目录；留空不保存。~ 会展开，相对路径按会话工作目录解析。",
		};

		const en = {
			title: "Models",
			description: "Choose the model and thinking level each MixAgent role uses. Leave a model empty to follow the conversation's model. Changes apply immediately after saving.",
			scout: "Scout",
			scoutHint: "The cheap model that explores the code (read-only).",
			planner: "Planner",
			executor: "Executor",
			plannerHint: "The flagship model that writes the change plan.",
			executorHint: "The cheap model that applies the plan in a fresh session.",
			scoutEmpty: "Follow the conversation model",
			plannerEmpty: "Use the conversation model",
			executorEmpty: "Inherit the scout model",
			thinking: "Thinking level",
			thinkingOff: "Model default",
			thinkingHint: "The thinking (reasoning) level of each role; a level the model does not offer falls back to the model default.",
			save: "Save",
			discard: "Discard",
			saved: "Saved",
			saveFailed: "Could not save; try again",
			saving: "Saving…",
			unavailable: "This configuration cannot be edited.",
			catalogLoading: "Reading the model list…",
			catalogFailed: "The model list is unavailable; type provider/modelId.",
			placeholder: "provider/modelId",
			modeTitle: "MixAgent mode",
			modeHint: "Pick the MixAgent preset when starting a session to begin in MixAgent mode; normal conversations never receive the MixAgent prompt. You can also enter with /mix on and leave with /mix off.",
			invalid: "Enter a whole number from {min} to {max}",
			invalidSave: "Some fields are invalid; fix them before saving",
			sectionMode: "Mode",
			sectionPlanner: "Planning and parallelism",
			sectionPackage: "Context package limits",
			sectionBehavior: "Behavior",
			"field.enabled": "Start new sessions in MixAgent mode",
			"field.enabled.hint": "Off keeps every conversation normal until /mix on is used (recommended).",
			"field.presets": "Activating presets",
			"field.presets.hint": "Sessions from these agent preset ids start in MixAgent mode, comma-separated; empty disables preset activation.",
			"field.plannerMaxTokens": "Planner output limit",
			"field.plannerMaxTokens.hint": "Max output tokens of one planner call; clamped to the model's limit.",
			"field.maxContextRounds": "Context rounds",
			"field.maxContextRounds.hint": "How many times the planner may send the scout back for more context per request.",
			"field.forkJoin": "Split into subtasks (fork-join)",
			"field.forkJoin.hint": "Let the planner split large work, join the sub-plans, and run executors in parallel.",
			"field.maxParallelPlanners": "Parallel sub-planners",
			"field.maxParallelPlanners.hint": "At most this many sub-planners run at once.",
			"field.maxParallelExecutors": "Parallel executors",
			"field.maxParallelExecutors.hint": "At most this many task executors run at once.",
			"field.maxToolOutputChars": "Tool result character limit",
			"field.maxToolOutputChars.hint": "Per tool-result character cap inside the planner package.",
			"field.maxFileChars": "Key file character limit",
			"field.maxFileChars.hint": "Per key-file character cap inside the planner package.",
			"field.maxPackageChars": "Package character limit",
			"field.maxPackageChars.hint": "Total character cap of the package sent to the planner.",
			"field.maxPlannerImages": "Image limit",
			"field.maxPlannerImages.hint": "At most this many images go to the planner; the rest become [image omitted].",
			"field.scoutBashGuard": "Read-only scout shell",
			"field.scoutBashGuard.hint": "Block shell commands that look like they modify state while scouting.",
			"field.autoApply": "Auto-apply",
			"field.autoApply.hint": "Apply the plan's exact file changes directly before the executor starts.",
			"field.pruneScoutHistory": "Prune scout context after handoff",
			"field.pruneScoutHistory.hint": "Replace a finished cycle's scout tool results with a one-line note.",
			"field.discardRewritesContext": "Discard rewrites context",
			"field.discardRewritesContext.hint": "Replace discarded tool results in the scout's own context too.",
			"field.planDir": "Plan directory",
			"field.planDir.hint": "Where plan Markdown files are saved; empty disables saving. ~ is expanded, relative paths use the session cwd.",
		};

		/** Observe one settings form snapshot. */
		function useFormSnapshot(form) {
			const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot());
			React.useEffect(() => {
				setSnapshot(form.getSnapshot());
				return form.subscribe(() => setSnapshot(form.getSnapshot()));
			}, [form]);
			return snapshot;
		}

		/** Read the Host model catalog once; a missing remote or a failure leaves the fields as text inputs. */
		function useCatalog(sessionRemote) {
			const [catalog, setCatalog] = React.useState({ status: "loading", groups: [] });
			React.useEffect(() => {
				if (!sessionRemote) {
					setCatalog({ status: "error", groups: [] });
					return undefined;
				}
				let cancelled = false;
				sessionRemote.modelCatalog().then(
					(result) => {
						if (cancelled) return;
						if (result.ok) {
							const groups = Array.isArray(result.value?.groups) ? result.value.groups : [];
							setCatalog({ status: "ready", groups });
						} else {
							setCatalog({ status: "error", groups: [] });
						}
					},
					() => {
						if (!cancelled) setCatalog({ status: "error", groups: [] });
					},
				);
				return () => {
					cancelled = true;
				};
			}, [sessionRemote]);
			return catalog;
		}

		const styles = {
			section: { display: "flex", flexDirection: "column", gap: "12px", maxWidth: "640px" },
			title: { margin: 0, fontSize: "14px", fontWeight: 600, lineHeight: "22px", color: "var(--dsw-alias-label-primary)" },
			description: { margin: 0, fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" },
			row: { display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "12px 24px", padding: "10px 0", borderTop: "1px solid var(--dsw-alias-border-l1)" },
			rowText: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 },
			label: { fontSize: "13px", lineHeight: "20px", fontWeight: 500, color: "var(--dsw-alias-label-primary)" },
			hint: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" },
			control: {
				width: "260px",
				flex: "none",
				boxSizing: "border-box",
				padding: "5px 8px",
				fontSize: "13px",
				lineHeight: "20px",
				color: "var(--dsw-alias-label-primary)",
				background: "var(--dsw-alias-bg-layer-2)",
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: "6px",
			},
			footer: { display: "flex", alignItems: "center", gap: "12px", paddingTop: "12px", borderTop: "1px solid var(--dsw-alias-border-l1)" },
			status: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)", flex: "1" },
			button: {
				padding: "5px 14px",
				fontSize: "13px",
				lineHeight: "20px",
				borderRadius: "6px",
				cursor: "pointer",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-layer-2)",
				color: "var(--dsw-alias-label-primary)",
			},
			primary: {
				padding: "5px 14px",
				fontSize: "13px",
				lineHeight: "20px",
				borderRadius: "6px",
				border: "1px solid var(--dsw-alias-brand-primary)",
				background: "var(--dsw-alias-brand-primary)",
				color: "var(--dsw-alias-bg-base)",
			},
			controls: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
			thinking: {
				width: "130px",
				flex: "none",
				boxSizing: "border-box",
				padding: "5px 8px",
				fontSize: "13px",
				lineHeight: "20px",
				color: "var(--dsw-alias-label-primary)",
				background: "var(--dsw-alias-bg-layer-2)",
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: "6px",
			},
			mode: { marginTop: "4px", paddingTop: "12px", borderTop: "1px solid var(--dsw-alias-border-l1)" },
			sectionTitle: { margin: "12px 0 0", fontSize: "13px", fontWeight: 600, lineHeight: "20px", color: "var(--dsw-alias-label-primary)" },
			checkbox: { width: "16px", height: "16px", margin: 0, flex: "none", cursor: "pointer" },
			error: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-status-danger, #d93026)" },
		};

		/** Model routes reachable through the Host catalog, provider by provider, with the current value kept. */
		function catalogOptions(groups, current) {
			const providers = [];
			const known = new Set();
			for (const group of groups) {
				const list = Array.isArray(group.models) ? group.models : [];
				const models = list.map((model) => {
					const value = `${group.id}/${model.id}`;
					known.add(value);
					return { value, label: model.name && model.name !== model.id ? `${model.name} (${model.id})` : model.id };
				});
				if (models.length > 0) providers.push({ name: group.name || group.id, models });
			}
			const extra = typeof current === "string" && current && !known.has(current) ? current : undefined;
			return { providers, extra };
		}

		/**
		 * Thinking levels for one model route: the catalog's reasoning efforts when it lists them, else the
		 * common levels; the current value is always kept so a custom level set in the patch stays visible.
		 */
		function thinkingOptions(groups, route, current) {
			let levels = THINKING_LEVELS;
			const slash = typeof route === "string" ? route.indexOf("/") : -1;
			if (slash > 0) {
				const group = groups.find((entry) => entry.id === route.slice(0, slash));
				const model = Array.isArray(group?.models) ? group.models.find((entry) => entry.id === route.slice(slash + 1)) : undefined;
				const efforts = Array.isArray(model?.reasoning?.efforts)
					? model.reasoning.efforts.map((entry) => (typeof entry === "string" ? entry : entry?.id)).filter(Boolean)
					: [];
				if (efforts.length > 0) levels = efforts;
			}
			const list = levels.filter((level) => level !== "off");
			if (current && current !== "off" && !list.includes(current)) list.push(current);
			return list;
		}

		/**
		 * The bundle's configuration page. It is bound to the plugin entry's settings form, so every save
		 * goes through the profile's config editor and the volatile fields take effect in place.
		 */
		function ModelSettingsPage(props) {
			const t = props.t;
			const form = props.form;
			const sessionRemote = props.sessionRemote;
			const snapshot = useFormSnapshot(form);
			const catalog = useCatalog(sessionRemote);
			const accepted = snapshot.value ?? {};
			const [draft, setDraft] = React.useState(null);
			const [status, setStatus] = React.useState("idle");

			/** The saved value of a field in its form representation; an unset field shows its default. */
			const savedOf = (key) => toInput(FIELDS.find((field) => field.key === key), accepted[key]);
			const KEYS = FIELDS.map((field) => field.key);
			const values = Object.fromEntries(KEYS.map((key) => [key, draft?.[key] ?? savedOf(key)]));
			const changed = FIELDS.filter((field) => values[field.key] !== savedOf(field.key));
			const dirty = changed.length > 0;
			const invalid = new Set(FIELDS.filter((field) => fromInput(field, values[field.key]).invalid).map((field) => field.key));
			const editable = snapshot.status === "ready" && snapshot.writable;
			const saving = status === "saving";

			const change = (key, value) => {
				if (!editable || saving) return;
				setStatus("idle");
				setDraft({ ...values, [key]: value });
			};

			const save = async () => {
				if (!dirty || !editable || saving || invalid.size > 0) return;
				const ops = changed.map((field) => {
					const { value } = fromInput(field, values[field.key]);
					// A value equal to its default is unset, so a later default change still applies.
					return sameValue(value, field.def) ? { op: "unset", path: [field.key] } : { op: "set", path: [field.key], value };
				});
				if (ops.length === 0) return;
				setStatus("saving");
				let acceptedByHost = false;
				try {
					acceptedByHost = await form.mutate(ops, snapshot.revision);
				} catch {
					acceptedByHost = false;
				}
				if (acceptedByHost) {
					setDraft(null);
					setStatus("saved");
				} else {
					setStatus("error");
				}
			};

			const statusText = () => {
				if (snapshot.status === "unavailable") return t("unavailable");
				if (saving) return t("saving");
				if (status === "saved") return t("saved");
				if (status === "error") return t("saveFailed");
				if (dirty && invalid.size > 0) return t("invalidSave");
				return "";
			};

			const control = ({ key, empty }) => {
				const current = values[key];
				if (catalog.status === "ready") {
					const { providers, extra } = catalogOptions(catalog.groups, current);
					const options = [h("option", { key: "", value: "" }, t(empty))];
					if (extra) options.push(h("option", { key: extra, value: extra }, extra));
					for (const provider of providers) {
						options.push(
							h(
								"optgroup",
								{ key: provider.name, label: provider.name },
								provider.models.map((model) => h("option", { key: model.value, value: model.value }, model.label)),
							),
						);
					}
					return h(
						"select",
						{
							style: styles.control,
							value: current,
							disabled: !editable || saving,
							onChange: (event) => change(key, event.target.value),
						},
						options,
					);
				}
				return h("input", {
					style: styles.control,
					type: "text",
					value: current,
					disabled: !editable || saving,
					placeholder: t("placeholder"),
					onChange: (event) => change(key, event.target.value.trim()),
				});
			};

			const thinkingControl = ({ key, thinkingKey }) => {
				const current = values[thinkingKey];
				const levels = thinkingOptions(catalog.groups, values[key], current);
				return h(
					"select",
					{
						style: styles.thinking,
						value: current,
						title: t("thinking"),
						"aria-label": t("thinking"),
						"data-field": thinkingKey,
						disabled: !editable || saving,
						onChange: (event) => change(thinkingKey, event.target.value),
					},
					[h("option", { key: "off", value: "off" }, t("thinkingOff")), ...levels.map((level) => h("option", { key: level, value: level }, level))],
				);
			};

			/** One non-model field: a checkbox for a switch, a text or number input otherwise. */
			const fieldControl = (field) => {
				const disabled = !editable || saving;
				if (field.kind === "bool") {
					return h("input", {
						type: "checkbox",
						style: styles.checkbox,
						checked: values[field.key],
						disabled,
						"data-field": field.key,
						"aria-label": t(`field.${field.key}`),
						onChange: (event) => change(field.key, event.target.checked),
					});
				}
				const bad = invalid.has(field.key);
				return h("input", {
					type: field.kind === "int" ? "number" : "text",
					style: bad ? { ...styles.control, borderColor: "var(--dsw-alias-status-danger, #d93026)" } : styles.control,
					value: values[field.key],
					min: field.min,
					max: field.max,
					step: field.kind === "int" ? 1 : undefined,
					placeholder: field.kind === "list" ? "mix" : undefined,
					disabled,
					"data-field": field.key,
					"aria-label": t(`field.${field.key}`),
					"aria-invalid": bad || undefined,
					onChange: (event) => change(field.key, event.target.value),
				});
			};

			const fieldRow = (field) =>
				h(
					"div",
					{ key: field.key, style: styles.row },
					h(
						"div",
						{ style: styles.rowText },
						h("span", { style: styles.label }, t(`field.${field.key}`)),
						h("span", { style: styles.hint }, t(`field.${field.key}.hint`)),
						invalid.has(field.key) ? h("span", { style: styles.error }, t("invalid", { min: field.min, max: field.max })) : null,
					),
					fieldControl(field),
				);

			const catalogLine =
				catalog.status === "loading" ? t("catalogLoading") : catalog.status === "error" ? t("catalogFailed") : "";

			return h(
				"div",
				{ style: styles.section },
				h("h3", { style: styles.title }, t("title")),
				h("p", { style: styles.description }, t("description")),
				ROLES.map((role) =>
					h(
						"div",
						{ key: role.key, style: styles.row },
						h(
							"div",
							{ style: styles.rowText },
							h("span", { style: styles.label }, t(role.label)),
							h("span", { style: styles.hint }, t(role.hint)),
						),
						h("div", { style: styles.controls }, control(role), thinkingControl(role)),
					),
				),
				h("p", { style: styles.description }, t("thinkingHint")),
				catalogLine ? h("p", { style: styles.description }, catalogLine) : null,
				SECTIONS.map((section) =>
					h(
						React.Fragment,
						{ key: section.title },
						h("h4", { style: styles.sectionTitle }, t(section.title)),
						section.fields.map(fieldRow),
					),
				),
				h(
					"div",
					{ style: styles.footer },
					h("span", { style: styles.status, role: "status" }, statusText()),
					h(
						"button",
						{
							type: "button",
							style: styles.button,
							disabled: !dirty || saving,
							onClick: () => {
								setDraft(null);
								setStatus("idle");
							},
						},
						t("discard"),
					),
					h(
						"button",
						{
							type: "button",
							style: styles.primary,
							disabled: !dirty || !editable || saving || invalid.size > 0,
							onClick: save,
						},
						t("save"),
					),
				),
				h(
					"div",
					{ style: styles.mode },
					h("span", { style: styles.label }, t("modeTitle")),
					h("p", { style: styles.description }, t("modeHint")),
				),
			);
		}

		// ------------------------------------------------------------------ handoff card
		//
		// The `handoff` tool row in the conversation. While the call runs it shows the elapsed time and
		// the executor children as they appear in the session's subagent catalog (DSH has no tool progress
		// API, so the planner phase can only be shown as "planning"). Once the result arrives it reads the
		// trace the Host plugin attached as presentation metadata (never shown to the model): every planner
		// call, the auto-apply outcome per file, every executor child, the plan and the report.

		const Prim = require("@deepseek-ai/dsh-client-ui-primitives");

		/** Discriminator of the handoff presentation metadata (trace.js on the Host). */
		const TRACE_KIND = "mixagent/handoff";
		/** The Host plugin labels every executor child "MixAgent …". */
		const EXECUTOR_LABEL = "MixAgent";
		/** Catalog rows created this long before the call started still belong to it (clock skew). */
		const CHILD_SKEW_MS = 2000;
		const CSS_ID = "mixagent-dsh/handoff-card.css";
		const C = (name) => `mxa-${name}`;

		const CARD_CSS = [
			".mxa-card{display:flex;flex-direction:column;min-width:0}",
			".mxa-row{height:calc(24px + var(--dsh-content-font-delta,0px));min-width:0;color:var(--dsw-alias-label-tertiary);align-items:center;transition:color .1s;display:flex;position:relative;overflow:hidden}",
			"@media (hover:hover){.mxa-row:hover{color:var(--dsw-alias-label-secondary)}}",
			".mxa-row[data-expandable]{cursor:pointer}",
			".mxa-row:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px;border-radius:var(--dsw-radius-sm)}",
			".mxa-leading{width:calc(16px + var(--dsh-content-font-delta,0px));height:calc(16px + var(--dsh-content-font-delta,0px));color:inherit;flex:none;justify-content:center;align-items:center;margin-right:6px;display:inline-flex;position:relative}",
			".mxa-leading svg{width:calc(14px + var(--dsh-content-font-delta,0px));height:calc(14px + var(--dsh-content-font-delta,0px))}",
			".mxa-iconIdle{opacity:1;transition:opacity .1s;display:inline-flex}",
			".mxa-chevronHover{opacity:0;margin:auto;transition:opacity .1s;position:absolute;inset:0}",
			"@media (hover:hover){.mxa-row[data-expandable]:hover .mxa-iconIdle{opacity:0}.mxa-row[data-expandable]:hover .mxa-chevronHover{opacity:1}}",
			".mxa-title{font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));flex:none}",
			".mxa-sep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}",
			".mxa-summary{text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));flex:auto;overflow:hidden}",
			".mxa-summary[data-tone=error]{color:var(--dsw-alias-state-error-primary)}",
			".mxa-summary[data-tone=warn]{color:var(--dsw-alias-state-warn-label)}",
			".mxa-children{display:flex;flex-direction:column;gap:2px;min-width:0;padding:0 0 2px 22px}",
			".mxa-child{display:flex;align-items:center;gap:8px;min-width:0;height:calc(22px + var(--dsh-content-font-delta,0px));font-size:var(--dsh-content-font-size-secondary,13px);color:var(--dsw-alias-label-secondary)}",
			".mxa-dot{width:12px;flex:none;display:inline-flex;justify-content:center;align-items:center}",
			".mxa-childLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".mxa-childMeta{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}",
			".mxa-link{flex:none;background:0 0;border:0;padding:0 2px;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-link);cursor:pointer}",
			"@media (hover:hover){.mxa-link:hover{text-decoration:underline dotted;text-underline-offset:3px}}",
			".mxa-link:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px;border-radius:var(--dsw-radius-sm)}",
			".mxa-body{display:flex;flex-direction:column;min-width:0}",
			".mxa-section{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-markdown-code-block);flex-direction:column;margin:4px 0 4px 4px;display:flex;overflow:hidden;min-width:0}",
			".mxa-sectionHeader{box-sizing:border-box;width:100%;border:0;border-bottom:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-markdown-code-block-banner);color:var(--dsw-alias-label-caption);text-transform:uppercase;letter-spacing:.04em;flex:none;align-items:center;gap:6px;padding:8px 12px;font:inherit;font-size:11px;font-weight:500;line-height:16px;text-align:left;display:flex}",
			".mxa-section[data-collapsed] .mxa-sectionHeader{border-bottom:0}",
			"button.mxa-sectionHeader{cursor:pointer}",
			"@media (hover:hover){button.mxa-sectionHeader:hover{color:var(--dsw-alias-label-secondary)}}",
			"button.mxa-sectionHeader:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}",
			".mxa-sectionHeader svg{width:12px;height:12px;flex:none;transition:transform .12s}",
			".mxa-sectionHeader[aria-expanded=true] svg{transform:rotate(90deg)}",
			".mxa-sectionMeta{margin-left:auto;text-transform:none;letter-spacing:0;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}",
			".mxa-sectionBody{min-height:0;max-height:320px;overflow:auto;padding:8px 12px 10px}",
			".mxa-lines{display:flex;flex-direction:column;gap:3px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);min-width:0}",
			".mxa-line{display:flex;flex-direction:column;min-width:0}",
			".mxa-lineHead{display:flex;align-items:baseline;gap:6px;min-width:0}",
			".mxa-mark{flex:none;width:12px;text-align:center;color:var(--dsw-alias-label-tertiary)}",
			".mxa-mark[data-tone=error]{color:var(--dsw-alias-state-error-primary)}",
			".mxa-mark[data-tone=warn]{color:var(--dsw-alias-state-warn-label)}",
			".mxa-lineText{flex:1;min-width:0;overflow-wrap:anywhere}",
			".mxa-detail{padding-left:18px;color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;overflow-wrap:anywhere}",
			".mxa-detail[data-tone=error]{color:var(--dsw-alias-state-error-primary)}",
			".mxa-detail[data-tone=warn]{color:var(--dsw-alias-state-warn-label)}",
			".mxa-note{margin-top:6px;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
			".mxa-pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font:var(--dsw-font-markdown-code-block-small);color:var(--dsw-alias-label-secondary)}",
			".mxa-pre[data-error]{color:var(--dsw-alias-state-error-primary)}",
			".mxa-inspect{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);cursor:pointer;opacity:0;border-radius:999px;align-self:flex-start;align-items:center;gap:4px;margin:4px 0 2px 4px;padding:2px 8px;font-size:11px;line-height:16px;transition:opacity .1s;display:inline-flex}",
			".mxa-inspect:focus-visible{opacity:1}",
			"@media (hover:hover){.mxa-card:hover .mxa-inspect{opacity:1}.mxa-inspect:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}}",
			"@media (hover:none){.mxa-inspect{opacity:1}}",
			".mxa-hidden{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}",
			"@media (prefers-reduced-motion:reduce){.mxa-row,.mxa-iconIdle,.mxa-chevronHover,.mxa-inspect,.mxa-sectionHeader svg{transition:none}}",
		].join("\n");

		const cardZh = {
			"card.title": "MixAgent",
			"card.preparing": "正在准备交接",
			"card.running": "运行中",
			"live.planning": "规划中",
			"live.executing.one": "{count} 个执行器运行中",
			"live.executing.other": "{count} 个执行器运行中",
			"live.finishing": "正在汇总",
			"status.done": "已完成",
			"status.answered": "已回答",
			"status.need_context": "需要更多上下文",
			"status.partial": "部分完成",
			"status.error": "失败",
			"status.cancelled": "已取消",
			"status.running": "运行中",
			"status.interrupted": "已中断",
			"summary.changes.one": "{count} 处修改",
			"summary.changes.other": "{count} 处修改",
			"summary.executors.one": "{count} 个执行器",
			"summary.executors.other": "{count} 个执行器",
			"summary.failedFiles.one": "{count} 个文件应用失败",
			"summary.failedFiles.other": "{count} 个文件应用失败",
			"summary.failedRuns.one": "{count} 个执行器未完成",
			"summary.failedRuns.other": "{count} 个执行器未完成",
			"summary.tokens": "{value} tokens",
			"role.scout": "侦察",
			"role.planner": "规划",
			"role.executor": "执行",
			"section.trace": "运行轨迹",
			"section.plan": "规划方案",
			"section.report": "报告",
			"trace.package": "上下文包 {chars} 字符 · {steps} 条工具结果 · {files} 个关键文件",
			"trace.truncated": "已截断",
			"trace.images": "{count} 张图片",
			"trace.joinTruncated": "合并规划达到输出上限（{chars} 字符）：按子方案继续执行，执行器从保存的方案补全其余部分",
			"exec.attempt": "第 {count} 次尝试",
			"exec.superseded": "已重试",
			"trace.discarded": "{count} 条已丢弃",
			"trace.round": "第 {count} 轮上下文",
			"trace.planFile": "方案文件",
			"trace.needContext": "规划器需要更多上下文",
			"stage.planner": "规划",
			"stage.subplanner": "子规划 {id}",
			"stage.join": "合并规划",
			"stage.split": "拆分为 {count} 个子任务",
			"stage.attempts": "尝试 {count} 次",
			"stage.needContext": "请求更多上下文",
			"usage.text": "{input} 输入 / {output} 输出",
			"usage.cached": "（{value} 缓存）",
			"apply.summary": "自动应用：{applied} 个已应用 · {skipped} 个交给执行器 · {failed} 个失败",
			"apply.failed": "自动应用失败，未改动任何文件",
			"exec.toolCalls.one": "{count} 次工具调用",
			"exec.toolCalls.other": "{count} 次工具调用",
			"exec.toolErrors": "{count} 次失败",
			"exec.retries.one": "重试 {count} 次",
			"exec.retries.other": "重试 {count} 次",
			"exec.failedToStart": "启动失败",
			"child.running": "运行中",
			"child.completed": "已完成",
			"child.stopped": "已结束",
			"plan.chars": "{chars} 字符",
			"plan.truncated": "方案过长，只显示前 {chars} 字符；完整方案见方案文件。",
			"open": "打开",
			"open.label": "打开 {name}",
			inspect: "查看",
			"fallback.empty": "没有输出",
			"code.copy": "复制",
			"code.copied": "已复制",
			"code.title": "代码",
			"code.wrap": "自动换行",
			"code.unwrap": "取消换行",
			"markdown.footnotes": "脚注",
		};

		const cardEn = {
			"card.title": "MixAgent",
			"card.preparing": "Preparing the handoff",
			"card.running": "Running",
			"live.planning": "Planning",
			"live.executing.one": "{count} executor running",
			"live.executing.other": "{count} executors running",
			"live.finishing": "Wrapping up",
			"status.done": "Done",
			"status.answered": "Answered",
			"status.need_context": "Needs more context",
			"status.partial": "Partly done",
			"status.error": "Failed",
			"status.cancelled": "Cancelled",
			"status.running": "Running",
			"status.interrupted": "Interrupted",
			"summary.changes.one": "{count} change",
			"summary.changes.other": "{count} changes",
			"summary.executors.one": "{count} executor",
			"summary.executors.other": "{count} executors",
			"summary.failedFiles.one": "{count} file failed to apply",
			"summary.failedFiles.other": "{count} files failed to apply",
			"summary.failedRuns.one": "{count} executor did not complete",
			"summary.failedRuns.other": "{count} executors did not complete",
			"summary.tokens": "{value} tokens",
			"role.scout": "scout",
			"role.planner": "planner",
			"role.executor": "executor",
			"section.trace": "Run trace",
			"section.plan": "Plan",
			"section.report": "Report",
			"trace.package": "package {chars} chars · {steps} tool results · {files} key files",
			"trace.truncated": "truncated",
			"trace.images": "{count} image(s)",
			"trace.joinTruncated": "join planner hit its output limit ({chars} chars): continued with the sub-plans; the executor completes the rest from the saved plan",
			"exec.attempt": "attempt {count}",
			"exec.superseded": "retried",
			"trace.discarded": "{count} discarded",
			"trace.round": "context round {count}",
			"trace.planFile": "plan file",
			"trace.needContext": "The planner needs more context",
			"stage.planner": "planner",
			"stage.subplanner": "sub-planner {id}",
			"stage.join": "join planner",
			"stage.split": "split into {count} subtasks",
			"stage.attempts": "{count} attempts",
			"stage.needContext": "asked for more context",
			"usage.text": "{input} in / {output} out",
			"usage.cached": " ({value} cached)",
			"apply.summary": "auto-apply: {applied} applied · {skipped} left to the executor · {failed} failed",
			"apply.failed": "Auto-apply failed before changing anything",
			"exec.toolCalls.one": "{count} tool call",
			"exec.toolCalls.other": "{count} tool calls",
			"exec.toolErrors": "{count} failed",
			"exec.retries.one": "{count} retry",
			"exec.retries.other": "{count} retries",
			"exec.failedToStart": "failed to start",
			"child.running": "running",
			"child.completed": "completed",
			"child.stopped": "ended",
			"plan.chars": "{chars} chars",
			"plan.truncated": "The plan is long; only the first {chars} characters are shown. The plan file has all of it.",
			"open": "Open",
			"open.label": "Open {name}",
			inspect: "Inspect",
			"fallback.empty": "No output",
			"code.copy": "Copy",
			"code.copied": "Copied",
			"code.title": "Code",
			"code.wrap": "Wrap lines",
			"code.unwrap": "Don't wrap",
			"markdown.footnotes": "Footnotes",
		};

		const noHook = () => undefined;
		/** Selectors are module constants so the store hooks see a stable selector identity. */
		const selectById = (state) => state?.byId;
		const selectAll = (value) => value;

		const count = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0);

		/** An epoch-millisecond time from a number or an ISO string; anything implausible is ignored. */
		function toMs(value) {
			const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
			return Number.isFinite(ms) && ms > 1e12 ? ms : undefined;
		}

		function formatTokens(value) {
			const n = count(value);
			if (n < 1000) return String(n);
			const scaled = (x) => (x >= 100 ? String(Math.round(x)) : String(Math.round(x * 10) / 10));
			return n < 1_000_000 ? `${scaled(n / 1000)}k` : `${scaled(n / 1_000_000)}M`;
		}

		function formatDuration(ms) {
			const value = Math.max(0, Number(ms) || 0);
			if (value < 10_000) return `${(Math.round(value / 100) / 10).toFixed(1)}s`;
			const seconds = Math.round(value / 1000);
			if (seconds < 60) return `${seconds}s`;
			const minutes = Math.floor(seconds / 60);
			if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
			return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
		}

		/** Uncached input of a Host usage sample (`inputTokens`) or a DSH token-meter summary. */
		const uncachedInput = (usage) => count(usage.inputTokens ?? usage.uncachedInputTokens);

		function usageTotal(usage) {
			if (!usage || typeof usage !== "object") return 0;
			return uncachedInput(usage) + count(usage.outputTokens) + count(usage.cacheReadTokens) + count(usage.cacheWriteTokens);
		}

		function usageText(usage, t) {
			if (!usage || typeof usage !== "object") return "";
			const input = uncachedInput(usage) + count(usage.cacheReadTokens) + count(usage.cacheWriteTokens);
			const text = t("usage.text", { input: formatTokens(input), output: formatTokens(usage.outputTokens) });
			return usage.cacheReadTokens ? text + t("usage.cached", { value: formatTokens(usage.cacheReadTokens) }) : text;
		}

		function firstLine(text, max = 160) {
			const line = String(text ?? "").trim().split("\n")[0];
			return line.length > max ? `${line.slice(0, max - 1)}…` : line;
		}

		const plural = (t, key, n) => t(`${key}.${n === 1 ? "one" : "other"}`, { count: n });

		/** The tool result's model-visible text, flattened the way DSH's generic tool row does. */
		function resultText(block) {
			const parts = [];
			for (const item of Array.isArray(block?.content) ? block.content : []) {
				parts.push(item?.type === "text" ? item.text : JSON.stringify(item, null, 2));
			}
			if (parts.length === 0 && block?.error) parts.push(`${block.error.name ?? "Error"}: ${block.error.code ?? block.error.message ?? ""}`);
			return parts.join("\n").trim();
		}

		function traceOf(block) {
			const meta = block?.meta;
			return meta && meta.kind === TRACE_KIND && meta.trace && typeof meta.trace === "object" ? meta.trace : undefined;
		}

		function useLocalDisclosure() {
			const [expanded, setExpanded] = React.useState(false);
			return { expanded, setExpanded, toggle: () => setExpanded((value) => !value) };
		}

		/**
		 * MixAgent executor children in this session's subagent catalog, with their live status and
		 * tokens. With `since`, only children created after that time (this call's own children).
		 */
		function useExecutorChildren(props, since) {
			const useProjection = props.useProjection ?? noHook;
			const useSessions = props.useSessions ?? noHook;
			const useSessionStatus = props.useSessionStatus ?? noHook;
			const catalog = useProjection("subagentCatalog");
			const byId = useSessions(selectById);
			const statuses = useSessionStatus(selectAll);
			return React.useMemo(() => {
				const entries = Array.isArray(catalog) ? catalog : [];
				return entries
					.filter((entry) => typeof entry?.label === "string" && entry.label.startsWith(EXECUTOR_LABEL))
					.filter((entry) => since === undefined || !(toMs(entry.createdAt) < since - CHILD_SKEW_MS))
					.map((entry) => {
						const summary = byId?.[entry.id];
						const status = typeof statuses?.get === "function" ? statuses.get(entry.id) : undefined;
						return {
							id: entry.id,
							label: entry.label,
							mode: entry.mode,
							running: (status?.running ?? summary?.running) === true,
							completed: summary?.projectionValues?.subagentTiming?.lastTurnCompleted === true,
							tokens: usageTotal(summary?.projectionValues?.tokenUsage),
						};
					});
			}, [catalog, byId, statuses, since]);
		}

		/** Open one child session in the main pane; undefined when it cannot be opened. */
		function openAction(props, childId, mode) {
			if (typeof props.openSession !== "function" || !childId || !mode || mode === "external") return undefined;
			return () => props.openSession({ parentSessionId: props.sessionId, childSessionId: childId, mode });
		}

		function OpenButton({ t, label, onOpen }) {
			return h(
				"button",
				{
					type: "button",
					className: C("link"),
					"aria-label": t("open.label", { name: label ?? "" }),
					onClick: (event) => {
						event.stopPropagation();
						onOpen();
					},
				},
				t("open"),
			);
		}

		function Leading({ open, expandable }) {
			if (open) return h(Prim.IconChevronDownOutlineRegular, null);
			const icon = h(Prim.IconSparkleRegular, { size: 14 });
			if (!expandable) return icon;
			return h(
				React.Fragment,
				null,
				h("span", { className: C("iconIdle") }, icon),
				h(Prim.IconChevronDownOutlineRegular, { className: C("chevronHover") }),
			);
		}

		function HeaderRow({ t, open, expandable, onToggle, running, summary, tone, status }) {
			const disclosure = expandable
				? {
						role: "button",
						tabIndex: 0,
						"aria-expanded": open,
						onClick: onToggle,
						onKeyDown: (event) => {
							if (event.key !== "Enter" && event.key !== " ") return;
							event.preventDefault();
							onToggle();
						},
					}
				: {};
			return h(
				"div",
				{ className: C("row"), "data-expandable": expandable || undefined, ...disclosure },
				h("span", { className: C("leading") }, h(Leading, { open, expandable })),
				status ? h("span", { className: C("hidden") }, status) : null,
				h(
					Prim.TextShimmer,
					{ active: running },
					h("span", { className: C("title") }, h(Prim.TextShimmer, null, t("card.title"))),
					summary ? h("span", { className: C("sep"), "data-shimmer-decoration": true, "aria-hidden": true }) : null,
					summary ? h("span", { className: C("summary"), "data-tone": tone }, h(Prim.TextShimmer, null, summary)) : null,
				),
			);
		}

		function ChildRow({ t, child, onOpen }) {
			const meta = [child.running ? t("child.running") : child.completed ? t("child.completed") : t("child.stopped")];
			if (child.tokens) meta.push(t("summary.tokens", { value: formatTokens(child.tokens) }));
			return h(
				"div",
				{ className: C("child"), "data-child-id": child.id },
				h("span", { className: C("dot") }, h(Prim.StateDot, { state: child.running ? "ongoing" : child.completed ? "done" : "idle" })),
				h("span", { className: C("childLabel"), title: child.label }, child.label),
				h("span", { className: C("childMeta") }, meta.join(" · ")),
				onOpen ? h(OpenButton, { t, label: child.label, onOpen }) : null,
			);
		}

		function Section({ title, meta, collapsible = false, defaultOpen = true, children }) {
			const [open, setOpen] = React.useState(defaultOpen);
			const shown = !collapsible || open;
			const label = h("span", null, title);
			const metaNode = meta ? h("span", { className: C("sectionMeta") }, meta) : null;
			const header = collapsible
				? h(
						"button",
						{ type: "button", className: C("sectionHeader"), "aria-expanded": open, onClick: () => setOpen((value) => !value) },
						h(Prim.IconChevronRightOutlineRegular, null),
						label,
						metaNode,
					)
				: h("div", { className: C("sectionHeader") }, label, metaNode);
			return h(
				"section",
				{ className: C("section"), "aria-label": title, "data-collapsed": shown ? undefined : true },
				header,
				shown ? h("div", { className: C("sectionBody") }, children) : null,
			);
		}

		function stageTitle(stage, t) {
			if (stage.kind === "subplanner") return t("stage.subplanner", { id: stage.id ?? "" });
			if (stage.kind === "join") return t("stage.join");
			return t("stage.planner");
		}

		/** The trace as display lines: models, package, planner stages, auto-apply, executors, plan file. */
		function traceLines(trace, t, openFor) {
			const lines = [];
			const add = (line) => lines.push({ key: String(lines.length), ...line });

			const models = trace.models ?? {};
			add({
				mark: "·",
				text: [
					`${t("role.scout")} ${models.scout ?? "?"}`,
					`${t("role.planner")} ${models.planner ?? "?"}`,
					`${t("role.executor")} ${models.executor ?? "?"}`,
				].join(" · "),
			});

			const pkg = trace.package;
			if (pkg) {
				const files = Array.isArray(pkg.files) ? pkg.files : [];
				const missing = files.filter((file) => file.error);
				const parts = [t("trace.package", { chars: formatTokens(pkg.chars), steps: count(pkg.steps), files: files.length })];
				if (pkg.truncated) parts.push(t("trace.truncated"));
				if (pkg.images) parts.push(t("trace.images", { count: pkg.images }));
				if (pkg.discarded) parts.push(t("trace.discarded", { count: pkg.discarded }));
				if (pkg.round > 1) parts.push(t("trace.round", { count: pkg.round }));
				add({
					mark: "·",
					text: parts.join(" · "),
					detail: missing.length ? missing.slice(0, 8).map((file) => `✗ ${file.path}: ${file.error}`).join("\n") : undefined,
					detailTone: "warn",
				});
			}

			for (const stage of trace.stages ?? []) {
				const parts = [stageTitle(stage, t)];
				if (stage.model) parts.push(stage.model);
				if (stage.durationMs !== undefined) parts.push(formatDuration(stage.durationMs));
				if (stage.usage) parts.push(usageText(stage.usage, t));
				if (stage.subtasks) parts.push(t("stage.split", { count: stage.subtasks }));
				else if (stage.changes !== undefined) parts.push(plural(t, "summary.changes", stage.changes));
				if (stage.attempts > 1) parts.push(t("stage.attempts", { count: stage.attempts }));
				if (stage.needContext) parts.push(t("stage.needContext"));
				let text = parts.join(" · ");
				if (stage.goal) text += ` — ${firstLine(stage.goal, 80)}`;
				let detail;
				if (stage.error) {
					const codes = [stage.error.code, stage.error.status, stage.error.requestId && `request ${stage.error.requestId}`].filter(Boolean);
					detail = `${firstLine(stage.error.message, 300)}${codes.length ? ` (${codes.join(", ")})` : ""}`;
				}
				const ok = stage.status === "ok";
				add({
					mark: ok ? "✓" : stage.status === "running" ? "…" : "✗",
					tone: ok ? undefined : stage.status === "aborted" ? "warn" : stage.status === "running" ? undefined : "error",
					text,
					detail,
					detailTone: "error",
				});
			}

			const apply = trace.apply;
			if (apply) {
				if (apply.error) {
					add({ mark: "✗", tone: "error", text: t("apply.failed"), detail: firstLine(apply.error, 300), detailTone: "error" });
				} else {
					const files = Array.isArray(apply.files) ? apply.files : [];
					const by = (status) => files.filter((file) => file.status === status);
					const failed = by("failed");
					const skipped = by("skipped");
					const listed = [...failed, ...skipped].slice(0, 12);
					add({
						mark: failed.length ? "!" : "✓",
						tone: failed.length ? "warn" : undefined,
						text:
							t("apply.summary", { applied: by("applied").length, skipped: skipped.length, failed: failed.length }) +
							(apply.durationMs !== undefined ? ` · ${formatDuration(apply.durationMs)}` : ""),
						detail: listed.length
							? listed.map((file) => `${file.status === "failed" ? "✗" : "→"} ${file.path}: ${firstLine(file.message, 200)}`).join("\n")
							: undefined,
						detailTone: failed.length ? "warn" : undefined,
					});
				}
			}

			if (trace.joinTruncated) add({ mark: "!", tone: "warn", text: t("trace.joinTruncated", { chars: formatTokens(trace.joinTruncated.chars ?? 0) }) });

			for (const run of trace.executors ?? []) {
				const ok = !run.error && run.stopReason === "completed";
				const parts = [run.label ?? t("role.executor")];
				if (run.attempt) parts.push(t("exec.attempt", { count: run.attempt }) + (run.superseded && !ok ? ` (${t("exec.superseded")})` : ""));
				if (run.actualModel ?? run.model) parts.push(run.actualModel ?? run.model);
				parts.push(run.error ? t("exec.failedToStart") : run.stopReason === "completed" ? t("child.completed") : String(run.stopReason ?? "?"));
				if (run.durationMs !== undefined) parts.push(formatDuration(run.durationMs));
				if (run.toolCalls !== undefined) {
					parts.push(plural(t, "exec.toolCalls", run.toolCalls) + (run.toolErrors ? ` (${t("exec.toolErrors", { count: run.toolErrors })})` : ""));
				}
				if (run.retries) parts.push(plural(t, "exec.retries", run.retries));
				if (run.usage) parts.push(t("summary.tokens", { value: formatTokens(usageTotal(run.usage)) }));
				const problem = run.error ?? run.turnError?.message ?? run.diagnostic;
				add({
					mark: ok ? "✓" : run.superseded ? "↻" : "✗",
					tone: ok ? undefined : run.superseded ? "warn" : "error",
					text: parts.join(" · "),
					detail: problem ? firstLine(problem, 300) : undefined,
					detailTone: "error",
					open: run.childId ? openFor(run.childId) : undefined,
					openLabel: run.label,
				});
			}

			if (trace.plan?.path) add({ mark: "·", text: `${t("trace.planFile")}: ${trace.plan.path}` });
			if (trace.needContext) add({ mark: "?", tone: "warn", text: t("trace.needContext"), detail: trace.needContext });
			if (trace.error && trace.status === "error") add({ mark: "✗", tone: "error", text: firstLine(trace.error, 400) });
			return lines;
		}

		function TraceLines({ t, lines }) {
			return h(
				"div",
				{ className: C("lines") },
				lines.map((line) =>
					h(
						"div",
						{ key: line.key, className: C("line") },
						h(
							"div",
							{ className: C("lineHead") },
							h("span", { className: C("mark"), "data-tone": line.tone, "aria-hidden": true }, line.mark),
							h("span", { className: C("lineText") }, line.text),
							line.open ? h(OpenButton, { t, label: line.openLabel, onOpen: line.open }) : null,
						),
						line.detail ? h("div", { className: C("detail"), "data-tone": line.detailTone }, line.detail) : null,
					),
				),
			);
		}

		function PlanSection({ t, plan }) {
			const labels = React.useMemo(
				() => ({
					code: {
						copyLabel: t("code.copy"),
						copiedLabel: t("code.copied"),
						toolbarLabels: { codeLabel: t("code.title"), wrapLabel: t("code.wrap"), unwrapLabel: t("code.unwrap") },
					},
					footnotes: t("markdown.footnotes"),
				}),
				[t],
			);
			const meta = [plural(t, "summary.changes", count(plan.changes)), t("plan.chars", { chars: formatTokens(plan.chars) })].join(" · ");
			return h(
				Section,
				{ title: t("section.plan"), meta, collapsible: true, defaultOpen: false },
				h(Prim.MarkdownText, { text: plan.text, labels, variant: "compact" }),
				plan.truncated ? h("div", { className: C("note") }, t("plan.truncated", { chars: formatTokens(plan.text.length) })) : null,
			);
		}

		/** Header facts for a traced result: status, changes or the failure, duration and tokens. */
		function traceModel(trace, t) {
			const status = typeof trace.status === "string" ? trace.status : "done";
			const label = t(`status.${status}`);
			const tone = status === "cancelled" || trace.health === "warn" ? "warn" : trace.health === "error" ? "error" : undefined;
			const parts = [label];
			if (status === "error" || status === "cancelled") {
				if (trace.error) parts.push(firstLine(trace.error, 200));
			} else {
				if (trace.plan?.changes) parts.push(plural(t, "summary.changes", trace.plan.changes));
				const failedFiles = (trace.apply?.files ?? []).filter((file) => file.status === "failed").length;
				const failedRuns = (trace.executors ?? []).filter((run) => !run.superseded && (run.error || run.stopReason !== "completed")).length;
				if (trace.apply?.error) parts.push(t("apply.failed"));
				if (failedFiles) parts.push(plural(t, "summary.failedFiles", failedFiles));
				if (failedRuns) parts.push(plural(t, "summary.failedRuns", failedRuns));
				else if (trace.executors?.length) parts.push(plural(t, "summary.executors", trace.executors.length));
			}
			if (trace.durationMs !== undefined) parts.push(formatDuration(trace.durationMs));
			const tokens = usageTotal(trace.totals?.planner) + usageTotal(trace.totals?.executor);
			if (tokens) parts.push(t("summary.tokens", { value: formatTokens(tokens) }));
			return { state: tone === "error" ? "error" : status, summary: parts.join(" · "), tone, status: tone ? label : null };
		}

		/** Header facts for a result without a trace: an older handoff, or a call that threw. */
		function fallbackModel(block, report, t) {
			if (block?.error?.code === "interrupted") return { state: "stopped", summary: t("status.interrupted"), tone: "warn", status: t("status.interrupted") };
			if (block?.isError) return { state: "error", summary: firstLine(report, 200) || t("status.error"), tone: "error", status: t("status.error") };
			return { state: "ok", summary: firstLine(report, 200) || t("fallback.empty"), tone: undefined, status: null };
		}

		function PreparingHandoff({ t }) {
			return h(
				"div",
				{ className: C("card"), "data-tool": "handoff", "data-state": "preparing" },
				h(
					"div",
					{ className: C("row") },
					h("span", { className: C("leading") }, h(Prim.IconSparkleRegular, { size: 14 })),
					h("span", { className: C("hidden") }, t("card.preparing")),
					h(Prim.TextShimmer, { active: true, className: C("title") }, t("card.title")),
				),
			);
		}

		function LiveHandoff(props) {
			const { t, block } = props;
			const [mountedAt] = React.useState(() => Date.now());
			const since = toMs(block?.time) ?? mountedAt;
			const [now, setNow] = React.useState(() => Date.now());
			React.useEffect(() => {
				const timer = setInterval(() => setNow(Date.now()), 1000);
				return () => clearInterval(timer);
			}, []);
			const children = useExecutorChildren(props, since);
			const running = children.filter((child) => child.running).length;
			const stage = children.length === 0 ? t("live.planning") : running > 0 ? plural(t, "live.executing", running) : t("live.finishing");
			return h(
				"div",
				{ className: C("card"), "data-tool": "handoff", "data-state": "running" },
				h(HeaderRow, {
					t,
					open: false,
					expandable: false,
					running: true,
					summary: `${stage} · ${formatDuration(Math.max(0, now - since))}`,
					status: t("card.running"),
				}),
				children.length
					? h(
							"div",
							{ className: C("children") },
							children.map((child) => h(ChildRow, { key: child.id, t, child, onOpen: openAction(props, child.id, child.mode) })),
						)
					: null,
			);
		}

		function ResultHandoff(props) {
			const { t, block, inspect } = props;
			const trace = traceOf(block);
			const report = resultText(block);
			const useDisclosure = props.useDisclosure ?? useLocalDisclosure;
			const { expanded, toggle } = useDisclosure();
			const known = useExecutorChildren(props, undefined);
			const model = trace ? traceModel(trace, t) : fallbackModel(block, report, t);
			const expandable = Boolean(trace || report);
			const open = expanded && expandable;
			let body = null;
			if (open) {
				const modes = new Map(known.map((child) => [child.id, child.mode]));
				const openFor = (childId) => openAction(props, childId, modes.get(childId));
				body = h(
					"div",
					{ className: C("body") },
					trace
						? h(
								Section,
								{ title: t("section.trace"), meta: trace.startedAt ? new Date(trace.startedAt).toLocaleTimeString() : undefined },
								h(TraceLines, { t, lines: traceLines(trace, t, openFor) }),
							)
						: null,
					trace?.plan?.text ? h(PlanSection, { t, plan: trace.plan }) : null,
					report
						? h(
								Section,
								{ title: t("section.report"), collapsible: true, defaultOpen: !trace },
								h("pre", { className: C("pre"), "data-error": model.tone === "error" && !trace ? true : undefined }, report),
							)
						: null,
					inspect
						? h("button", { type: "button", className: C("inspect"), onClick: inspect }, h(Prim.IconInspectOutlineRegular, null), t("inspect"))
						: null,
				);
			}
			return h(
				"div",
				{ className: C("card"), "data-tool": "handoff", "data-state": model.state, "data-health": trace?.health },
				h(HeaderRow, { t, open, expandable, onToggle: toggle, running: false, summary: model.summary, tone: model.tone, status: model.status }),
				body,
			);
		}

		/** The keyed `handoff` tool view: one component per call stage so each keeps its own hooks. */
		function HandoffCard(props) {
			if (props.phase === "preparing") return h(PreparingHandoff, props);
			if (props.phase === "start") return h(LiveHandoff, props);
			return h(ResultHandoff, props);
		}

		return {
			inject: ["slots", "locale", "configForms", "remote", "remote.session"],
			apply(ctx) {
				ctx.effect(
					() => ctx.locale.register(NS, { zh: { ...zh, ...cardZh }, en: { ...en, ...cardEn } }),
					"mixagent: dictionaries",
				);

				ctx.effect(() => {
					if (typeof document === "undefined") return () => {};
					const tag = document.createElement("style");
					tag.dataset.plugin = ENTRY_ID;
					tag.dataset.pluginCss = CSS_ID;
					tag.textContent = CARD_CSS;
					document.head.appendChild(tag);
					return () => tag.remove();
				}, "mixagent: handoff card styles");

				// The workspace service is looked up when a child is opened, so the card never makes the
				// whole client (and its settings page) depend on it.
				const openSession = (target) => {
					const workspace = ctx.get?.("uiWorkspace");
					if (workspace && typeof workspace.openSession === "function") workspace.openSession(target);
				};
				ctx.effect(
					() =>
						ctx.slots.inject("tool.call.toolview", () =>
							ctx.slots.register(
								{ name: "tool.call.toolview", key: "handoff", locale: NS, inject: () => ({ openSession }) },
								HandoffCard,
							),
						),
					"mixagent: handoff card",
				);
				const form = ctx.configForms.get(ENTRY_ID);
				const sessionRemote = ctx.remote.session;

				const Page = (props) => h(ModelSettingsPage, { ...props, form, sessionRemote });

				ctx.effect(
					() =>
						ctx.slots.inject("plugins.bundle.config", () =>
							ctx.slots.register(
								{
									name: "plugins.bundle.config",
									key: BUNDLE_KEY,
									locale: NS,
								},
								Page,
							),
						),
					"mixagent: model settings page",
				);
			},
		};
	},
});
