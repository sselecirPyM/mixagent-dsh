# mixagent-dsh

**便宜模型查代码 → 旗舰模型只写修改方案 → 便宜模型在全新 session 里执行**，以减少旗舰模型的输入与输出 token。

```
用户提示词
   │
   ▼
① Scout（可配置的便宜模型，主 session）
   只读工具：grep / glob / read / pwsh（写操作被 guard 拦截）
   每个工具结果前会加上 [#N] 编号，可用 discard 丢弃无关结果
   找到相关代码后调用 handoff
   │  handoff 把「用户提示词 + 本次全部工具调用及结果 + 关键文件全文 + Scout 备注」
   │  打包成一份 Markdown；用户消息里的图片、read_image 读到的图片和图片关键文件作为图片一并发送
   ▼
② Planner（可配置的旗舰模型，单次调用、无工具）
   以 Markdown 输出所有修改（SEARCH/REPLACE 块 / 新文件全文 / 命令 / 回答）
   方案默认保存为 .md 文件（~/.dsh/mixagent/plans），包括只有回答的方案
   如果方案只有回答（没有修改和命令），直接显示回答，不启动 Executor
   大任务：Planner 只输出 ## Subtasks，子 Planner 并行写方案，再由 join Planner 合并；
   join 可以附带 ## Tasks，把文件分组交给多个 Executor 并行执行
   join 达到输出上限时不中止：用子方案和已写完的 join 段落继续执行，
   Executor 从保存的方案文件（含全部子方案和被截断的 join）补全其余部分
   ▼
③ Executor（可配置的便宜模型，全新的 subagent session）
   启动前，插件先用 DSH 的 fs 服务直接应用方案里明确的修改（自动应用），
   并在方案里注明每处的结果；Executor 只做剩下的部分
   有 ## Tasks 时：每组一个 Executor 并行执行，失败的组最多重试 2 次，全部完成后再运行 Commands
   │
   ▼
结果（执行报告或 Planner 的回答）显示在 handoff 工具结果里，并结束本轮；
本轮 Scout 的工具结果随后在 Scout 上下文里替换为一行说明（pruneScoutHistory）
```

## 安装

在 Harness 里用插件管理器安装本目录（绝对路径）：

```
plugin_manager install_bundle  target: C:\Users\Andy\Documents\deepseek-harness\default-workspace\mixagent-dsh
```

安装后本 profile 的普通会话保持原样：没有 MixAgent 提示词，也没有 `handoff` / `discard` 工具。
在 **插件** 页面确认 MixAgent 已启用；新建会话时选择 **MixAgent** 预设，或在要使用 MixAgent 的会话里发送
`/mix on` 进入模式，`/mix off` 退出。

插件通过 `@deepseek-ai/schemastery` 声明 Config（模型字段需要 `.volatile()`），目录里的 `node_modules` 已安装好；
如果它被删除或复制到别处，先在插件目录运行 `pnpm install`。

## 预设

插件随包声明一个 id 为 `mix` 的 Agent 预设（`cordis.patch.yml` 里的 `preset-mix`）：

- 新建会话时在预设控件里选择 **MixAgent**，这个会话从第一条消息起就处于 MixAgent 模式；
- 预设自带三个阶段需要的工具：`read` / `grep` / `glob` / `pwsh`（侦察用，写操作由 guard 拦截），
  `edit` / `write` / `pwsh`（执行器用），以及 compaction；不加载无关的工具；
- 预设不重复挂载插件：提示词、`handoff` / `discard`、只读 guard 和模型切换都由 Host 上的
  `mixagent-dsh` 行提供，所以插件页面里的模型设置对预设会话同样生效；
- 其他预设的会话保持原样，仍然可以用 `/mix on` 进入、`/mix off` 退出；
- 配置项 `presets`（默认 `["mix"]`）决定哪些预设 id 会开启 MixAgent 模式；改成 `[]` 即关闭预设触发。

## 模式

MixAgent 模式是**按会话**的状态：

- 默认关闭。用 `mix` 预设创建的会话默认开启；`cordis.patch.yml` 里把 `enabled` 设为 `true` 可以让每个新会话默认进入模式（不推荐）。
- 进入模式后，本会话的系统提示词加入 Scout 说明，并注册 `handoff` / `discard` 工具，Scout 的模型切换在该会话生效。
- 退出模式后，提示词、工具、写操作 guard 和模型切换全部撤掉，会话恢复为普通对话。
- 模式状态由插件进程保存在内存里；Host 重启后回到默认值：普通会话关闭，`mix` 预设的会话仍然开启。

## 配置

### 在插件页面设置

打开侧边栏的 **插件**，在 **已安装插件** 里点开 **MixAgent**。页面上显示下表中的**全部**配置项，可以直接修改：

- 「模型」：三个角色的模型与思考等级（见下）；
- 「模式」：`enabled`、`presets`（逗号分隔）；
- 「规划与并行」：`plannerMaxTokens`、`maxContextRounds`、`forkJoin`、`maxParallelPlanners`、`maxParallelExecutors`；
- 「上下文包上限」：`maxToolOutputChars`、`maxFileChars`、`maxPackageChars`、`maxPlannerImages`；
- 「行为」：`scoutBashGuard`、`autoApply`、`pruneScoutHistory`、`discardRewritesContext`、`planDir`。

未设置的字段显示默认值；数字超出范围时标红并禁止保存；保存时与默认值相同的字段写为 unset，以后默认值变化仍然生效。

在「模型」一栏选择三个角色使用的模型：

- 侦察 Scout、规划 Planner、执行 Executor 各有一个下拉框，选项来自 Host 的模型列表；
- 留空（「跟随会话模型 / 使用会话模型 / 继承侦察模型」）表示不覆盖；
- 每个模型旁边还有一个「思考等级」下拉框（`scoutThinking` / `plannerThinking` / `executorThinking`）：
  「模型默认」即 `off`；模型列表里写明了可用等级时只列出这些等级，否则列出 minimal / low / medium / high / xhigh / max；
- 保存后写入 profile 的 patch，通过 volatile 配置立即生效，不需要重启 Host。

所有字段都声明为 `.volatile()`，插件在每次使用时读取当前值，因此保存后立即生效，不需要重启，也不会丢失各会话的 MixAgent 模式状态。
也可以继续写在 bundle 的 `cordis.patch.yml`（或 profile 的 patch 覆盖行）里：

```yaml
- id: mixagent-dsh
  name: mixagent-dsh
  config:
    scoutModel: deepseek-account/deepseek-flash
    plannerModel: code-gemini/gemini-4-argon
    executorModel: deepseek-account/deepseek-flash
```

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 新会话是否默认进入 MixAgent 模式；普通对话在关闭时完全不受影响 |
| `presets` | `["mix"]` | 哪些 Agent 预设 id 的会话自动进入 MixAgent 模式；`[]` 关闭预设触发 |
| `scoutModel` / `plannerModel` / `executorModel` | `""` | `provider/modelId`，也可在插件页面设置。为空时：Scout 用 session 当前模型，Planner 用你选的原模型，Executor 继承 Scout |
| `scoutThinking` / `plannerThinking` / `executorThinking` | `off` / `high` / `off` | 各阶段的思考（推理）等级，也可在插件页面设置；`off` 表示用模型默认值。模型不提供所选等级时自动退回模型默认值（`/mix status` 会注明）。没有配置 Scout 模型时，Scout 的等级作用在会话模型上，`/mix off` 后恢复会话原来的等级；Executor 继承 Scout 路由时同样使用自己的等级 |
| `plannerMaxTokens` | `32000` | Planner 输出上限（超过模型上限时自动收敛） |
| `maxToolOutputChars` / `maxFileChars` / `maxPackageChars` | 2 万 / 6 万 / 30 万 | 打包时的字符上限 |
| `maxContextRounds` | `3` | Planner 最多能要求补充上下文几次 |
| `scoutBashGuard` | `true` | 拦截 Scout 执行可能有写操作的 shell 命令（bash 与 PowerShell：`Remove-Item`、`Set-Content`、`Out-File`、`del` 等；`2>$null` 这类重定向不拦截） |
| `autoApply` | `true` | 启动 Executor 前直接应用方案里明确的修改 |
| `forkJoin` | `true` | 允许 Planner 拆分子任务、join 合并、多 Executor 并行 |
| `maxParallelPlanners` / `maxParallelExecutors` | `4` / `4` | 并行子 Planner / 任务 Executor 数量上限 |
| `planDir` | `~/.dsh/mixagent/plans` | 方案 Markdown 保存目录；空表示不保存，`~` 会展开，相对路径按会话工作目录解析。文件包含请求、方案，fork-join 时还有 Lead 和 join 审阅 |
| `pruneScoutHistory` | `true` | handoff 完成（执行或回答）后，把本轮 Scout 的工具结果在其上下文里替换为一行说明，后续请求不再为旧的探查付费 |
| `maxPlannerImages` | `10` | 发给 Planner 的图片上限，超出的写为 `[image omitted]` |
| `discardRewritesContext` | `true` | discard 时同时改写 Scout 自己的上下文（通过 session surface 替换） |

## 命令

| 命令 | 作用 |
| --- | --- |
| `/mix` 或 `/mix status` | 查看当前模式、三个角色的模型与路由是否可用、正在进行的交接、上一次交接摘要和本会话累计 token |
| `/mix last` | 查看本会话上一次交接的完整轨迹（重启 Host 后仍可读取） |
| `/mix on` | 让当前会话进入 MixAgent 模式 |
| `/mix off` | 退出 MixAgent 模式，恢复普通对话 |
| `/mix model` | 列出当前模型 |
| `/mix model <role>` | 查看某个角色的模型及其路由状态 |
| `/mix model <scout\|planner\|executor> <provider/model>` | 临时切换某个角色的模型（只对当前会话生效） |
| `/mix model <role> default` | 清除临时覆盖，回到插件页面的配置值 |
| `/mix thinking <role>` | 查看某个角色的模型和思考等级 |
| `/mix thinking <scout\|planner\|executor> <level\|off>` | 临时设置某个角色的思考等级（只对当前会话生效） |
| `/mix thinking <role> default` | 清除临时覆盖，回到插件页面的配置值 |

## 自动应用

Executor 的前几轮通常只是把方案里的 SEARCH/REPLACE 块原样抄进 `edit` 调用，输出量和整个 diff 一样大。
所以在启动 Executor 之前，插件先解析方案，把其中明确的修改直接用 DSH 的 `fs` 服务应用掉：

- **edit**：段里只有 SEARCH/REPLACE 块，并且每个 SEARCH 都和**原文件**完全一致且唯一（不会在前一个块的结果里查找），块之间不能重叠、也不能完全不改动文件；同一文件的所有块合并成一次写入，行尾（CRLF）与 BOM 会保留
- **create**：段里只有一个代码块，并且文件还不存在
- **delete**：文件在工作目录内，直接删除

格式不规范、块外还有代码、SEARCH 不唯一/不匹配、同一文件既有 edit 又有 delete、路径在工作目录之外等情况都不自动应用，原样交给 Executor，
Executor 收到的方案里会写明「MixAgent could not apply this section」。

## 可观测性

每次 `handoff` 都会记录一份运行轨迹（trace），作为工具结果的 presentation meta 写进会话日志：
**模型永远看不到它**，只有界面和 `/mix` 命令会读取。轨迹包含：

- 三个角色实际使用的模型；
- 上下文包的大小、工具结果条数、关键文件（读取失败的文件会注明原因）；
- 每一次 Planner 调用（主规划 / 子规划 / 合并规划）：模型、耗时、token（含缓存命中）、修改数、重试次数，失败时的错误码、HTTP 状态和 request id；
- 自动应用的逐文件结果：已应用、交给 Executor（附原因）、失败；
- 每个 Executor 子会话：标签、实际模型、停止原因、耗时、工具调用次数与失败次数、重试次数、token；
- 方案全文（上限 100k 字符）与方案文件路径。

**对话里的交接卡片**（替换了通用工具行）：

- 运行中：显示已用时间、当前阶段（规划中 / N 个执行器运行中），并实时列出本次交接启动的 Executor 子会话、它们的状态和 token，可以直接点「打开」进入子会话；
- 完成后：一行摘要（状态 · 修改数 · 执行器数 · 耗时 · 总 token），失败标红、部分失败（文件未应用、执行器未完成）标黄；
  展开后是完整轨迹、可折叠的方案（Markdown 渲染）和返回给 Scout 的报告，以及「查看」按钮（跳到 trajectory 视图）。

**命令**：`/mix last` 以文本形式输出上一次交接的完整轨迹；`/mix status` 会显示每个已配置模型路由是否可用
（不可用时给出原因和后果），交接进行中显示当前阶段，并汇总本会话所有交接的 Planner / Executor token。
重新设置一个角色的模型会立即重新检查路由。

**报告**：返回给 Scout 的报告里也写明了 Planner 的 token、自动应用失败或跳过的文件及原因、每个 Executor 的耗时 / 工具调用 / token，
以及整次运行的总耗时和成本，方便 Scout 向用户说明。

**Host 日志**：每次交接开始和结束各写一行到 Host 日志（失败或部分失败为 warn），路由检查失败也会记录。

限制：DSH 没有工具进度 API，所以 Planner 生成过程中卡片只能显示「规划中」和已用时间，不能流式显示方案；
Planner 的 token 不经过 DSH 自带的用量统计，只在卡片、报告和 `/mix` 中显示。

## 源码

```
index.js       Host 插件入口：Config（全部字段均为 volatile，实时读取）、模式、prompt section、handoff/discard 工具、/mix 命令、编排
client.js      浏览器半边：插件页面的配置表单（模型 / 思考等级与其余全部配置项，读写 volatile 配置，模型列表来自 Host）、对话里的 handoff 交接卡片
prompts.js     三个角色的提示词（Planner 逐字复制自 mixagent，Scout/Executor 适配 DSH 工具）
plan.js        方案 Markdown 解析、fork-join 拆分与合并
transcript.js  当前轮次提取、Planner 包打包、裁剪与去重
apply.js       自动应用
safety.js      Scout 的 shell 只读拦截
pipeline.js    Planner 单次调用、Executor 子 session（含子会话的工具调用与 token 统计）
trace.js       交接运行轨迹：记录、汇总、从会话日志读回、文本渲染（/mix last）
test/          单元测试（node --test --test-isolation=none test/*.test.js）
```

## 测试

```bash
cd mixagent-dsh
node --test --test-isolation=none test/*.test.js
```

单元测试覆盖：方案解析与 fork-join、SEARCH/REPLACE 应用、打包与裁剪（含 DSH `file_path` 参数）、
Planner 调用（空回复、max-tokens 截断、中止、意外工具调用、prepared config 与 dispatch 一致）、Executor 启动，
以及 MixAgent 模式的开关、`mix` 预设的自动开启、volatile 模型配置的实时读取；
可观测性（运行轨迹的内容与无损 JSON、失败 / 取消 / 部分失败的轨迹、`/mix last` 与 `/mix status` 从会话日志读回、路由不可用的提示、
子会话统计与 DSH token meter 一致的折叠方式），以及交接卡片在准备、运行、完成、失败各阶段的渲染（`test/client.test.js`）。
