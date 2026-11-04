# dsh-codenow

把 [Origin CodeNow](../../Origin%20CodeNow) 的**多角色协同编排层**搬进 DSH：岗位库、群聊回放、任务重建、按模型统计缓存与用量。

装上即接管 Lead 的派活策略：主模型（首席工程师）收到任务后按岗位自行拉起子智能体（未声明的岗位不会被拉；`chief-engineer` 就是 Lead 本人），会话头部提供「AI 团队」入口查看每个正在干活的岗位。

不移植 CodeNow 的 FastAPI 后端与 SQLite 库——DSH 本身已经是协作运行时（Lead/teammate、共享任务板、群聊式会话），这里只补齐 CodeNow 有而 DSH 没有的那一层视图与提示词资产。

## 数据来源

| 数据 | 来源 | 说明 |
| --- | --- | --- |
| 岗位（12 个） | `assets/roles/*.md` | 沿用 Origin CodeNow 的 frontmatter 约定，当前岗位规范为 `2.2.0`；分两层：1 名首席工程师 + 11 名专家工程师，均按资深工程师的分析、实施、验证和交接标准维护 |
| 公共规范 | `assets/roles/_common.md` | 分析规范、实施规范、协作契约三节；不是岗位（`listRoles()` 跳过 `_` 前缀），由插件前置到每份岗位全文之前 |
| 会话与消息 | `~/.dsh/sessions/**/session[.vN].jsonl.zstd` | 多帧 zstd 串联，按帧结构（magic + 帧头 + block 遍历）逐帧切分后解压。**分代取名**：同一目录里可能同时躺着 v3 与 v4，取 N 最大的那一个（无代号按 v1）；行上带 `format`（`v4` / `v3`），本机 90 个会话里 v4 68 个、仅 v3 22 个 |
| 会话标题 | `~/.dsh/storages/session_projcache/sessions/<uuid>.json` | `record.rows.title.val`；磁盘上同时存在 `session-<uuid>.json` 与裸 `<uuid>.json` 两种命名，两个候选都试，不能只补前缀 |
| 各 AI 用量 / 缓存 | `~/.dsh/storages/cost-meter/ledger.json` | 按 provider/model 与按会话聚合；天级 `byProviderModel` 只在天级累加（它已经等于当日各字段之和，再叠会话级就是重复计数）；key 按**第一个**冒号切 provider / model；货币取 `config.currency`（缺省 USD） |
| 待办 | 会话日志 `todo/write` 事件 | 取最后一条快照 |
| 团队任务 | 会话日志 `team/task` 事件 | 权威快照，带 `status`；按 `task.id` 取 `revision` 最大的一条 |
| 成员存活 | 会话日志 `team/member` 事件 | `phase` = provisioning / active / ended |

## 岗位能力与使用

首席负责技术决策和交付闭环，可在授权范围亲自完成小任务；专业岗位沿完整调用链处理其职责内问题。模板强调真实契约、最小方案、失败与恢复、兼容性、独立验证及有证据的交接，不强制所有任务采用某种框架或新增基础设施。

Lead 在新任务开始时先通过 `codenow({ action: "role", id: "chief-engineer" })` 获取首席全文；派工前获取对应专业岗位全文。同一任务复用已读内容，模板变化后重新读取。12 份岗位的 ID、显示名、组织层级、输出字段及执行预算保持兼容。

岗位全文的返回结构是 `# 显示名（id v版本 · 级别）` + `_common.md` 全文 + 岗位文件原文，三段按此顺序拼接（自检对每份岗位做**完整等值**校验，并用 5 类变异验证这条断言确实会拒绝错误输出）。因此公共方法只维护一份，各岗位文件只写自己的专业判断与交付要求；`_common.md` 缺失时自动降级为只返回岗位原文，不阻断派工。

公共规范分三节：**分析规范**（可裁剪的分析环节，只给决策摘要与证据，不设强制轮次或逐步思维链）、**实施规范**（先读再改、改完整调用链、保持集中、失败先查现场、用真实材料验证、交付前重读结果、如实报告状态）、**协作契约**（派工五要素：目标与验收+真实输入来源 / 已完成的调查与成果 / 可改文件与不变量 / 前置依赖·交付对象·阻塞解除 / 交付时的验证证据；四条规则：按需分工、写入归属唯一、交接可接续、集成后再验收）。

模板是提供给模型的工作规范；`execution`、审批项和协作名单不会由本插件自动转换成运行时限制，权限和实际预算仍由宿主执行。岗位规范不改变模型、工具和环境本身的能力。

## 界面

侧边栏「协同工作台」，5 个页签：

- **协同** — 12 个岗位卡片（层级、职责、可交接对象）
- **群聊** — 选会话，看真人消息与助手回复的完整时间线，向上翻页加载更早（游标取当前已加载消息里最小的 `seq`，一次 50 条；切会话或刷新时在飞的旧请求会被丢弃，不会串进新列表）
- **会话头部** — 一个「AI 团队」按钮，点开看每个正在干活的岗位、所属主智能体及其模型；没人在跑时按钮隐藏
- **任务** — 当前待办快照 + 团队任务（带状态列，`deleted` 的不显示）+ 协同动作流水（spawn / send_message / 任务增删）
- **缓存** — 缓存读 / 写与命中率
- **用量** — 总览（`totals`，全量口径）、30 个自然日趋势、按 provider/model 明细（按 cost 降序，带 `costCny`）。趋势窗口以**本地今天**为锚回溯 30 个自然日，账本没记录的日子标 `missing` 留空（不连点作弊）——账本最后一条是昨天时，今天照样出现在窗口末尾并标 `missing`

## 子会话回收

后台自动做，无手动入口：每 3 分钟扫一次（启动 **10 分钟**后才跑第一遍，避开启动风），把「已结束的派生子会话」目录**搬进隔离区**——不直接删。

隔离区：`~/.dsh/codenow-trash/<yyyymmdd>/<workspace>/<session-id>/`（`yyyymmdd` = 搬迁当天，本地时区）。搬进去**满 30 天（720 小时）**后才真删，留出误判后的抢救窗口。计时从**桶日结束**那一刻起算（`yyyymmdd` + 1 天的本地 0 点），所以任何一条目录的实际隔离时长都不少于 720 小时（若从桶日 0 点起算，最早搬进去的那条只有 29 天 1 分钟就到期了）。

- **想找回**：把目录搬回 `~/.dsh/sessions/<workspace>/` 原位置即可，里面文件一字未动。
- **想立刻腾空间**：直接删 `~/.dsh/codenow-trash/` 下的东西，插件不依赖它。
- **超过 30 天**：`rmSync` 真删，**不可恢复**（没有回收站、没有版本历史）。所以别把隔离区当备份。

一条子会话要变成候选，必须**同时**满足下列全部条件（判据全部来自磁盘和本进程内存，不依赖 registry 之外的远端状态）。**认不出来的一律不动**——判据默认拒绝：

| 判据 | 为什么保留 |
| --- | --- |
| 10 分钟内没写过 | 可能还在跑 |
| 子会话自身的 `mode` **明确等于 `one-shot`** | 只有一次性派生的子会话才允许回收；`continuable` = 可续跑，读不到 descriptor（`mode` 为空串）也算「不知道」，一样不动 |
| 父会话目录已不在 `~/.dsh/sessions/` | 父还在 = 子可能被重新唤起接着干；父会话本身读不出来也算「不知道」，保留 |
| 尾部事件**明确已收尾**：只认 `turn/end` | 正在写的会话尾巴一定不是这一类；尾部事件读不出（半帧、目录里没有日志）同样按「未收尾」处理 |
| id 不在 `agents.list()`（语义即 All live agents）里 | 确实没在跑 |

排除理由按这个顺序首次命中：`live` → `grace` → `continuable` / `modeUnknown` → `parentAlive` / `parentUnknown` → `tailUnsettled`，干跑与自检都会打印分布。

尾部**收尾白名单**只有 `turn/end` 一种，其余全部按「未收尾」保留——包括 `session/end-seed`、`approval/policy`、`session/title`、`model/selection`、`command/done`、`job/registered`、`agent/inbox/spliced`。`session/end-seed` 名字像收尾，实际是**生命周期起点**：宿主在建会话、继承和恢复会话时都会写它（事件定义里带 `inherited?: true`），本机 90 个会话里有 28 个出现在日志中段、还有会话出现过 2 次——它证明不了任务完成，所以被剔除。本机真实库里 `job/registered` 作为尾巴只出现过 1 次、语义未确认，同样**不在白名单里**（宁可少清一个也不误删）；这类会话要么下次真收尾、要么永远留在磁盘上。

「活着」以 `agents.list()` 为准，**不是** `agentTeams.membership()`——后者对非 Team 的子智能体返回 `undefined`，会把正在跑的 subagent 误判成已结束。若一条存活 id 都取不到（registry 一时为空、或宿主换了 Agent 形状），本轮直接跳过并记一行 `sweep SKIPPED`，宁可不清理也不误动。

`~/.dsh/codenow-boot.log` 里能看到每一步：

- `sweep first run` — 首次扫描真正开始（插件加载后等满 600 秒才写这一行，之后每 180 秒一次不再写）
- `sweep moved <id> <bytes>B <src> -> <dst>` — 搬进隔离区成功，一行一个
- `sweep move FAILED <id> <src> -> <dst>: <原因>` — **搬不动就留在原地**，绝不退化成删除
- `trash purge <id> <bytes>` / `trash purged=N bytes=M` — 隔离区超期清理
- 没动手的轮次不写日志

只搬磁盘上的会话目录；dsh 原生「子智能体」下拉读的是父会话日志里的 `subagent/catalog` 事件，那部分由 dsh 自己追加，插件不改写。

## Agent 工具

`codenow`（供 Lead 取岗位全文）：

```
codenow({ action: "roles" })                    # 全部岗位摘要（frontmatter 解析后的字段）
codenow({ action: "role", id: "security-engineer" })   # 岗位全文：标题行 + `_common.md` + 整份 MD 原文（含 YAML frontmatter 里的 execution / 审批项等），首行是 `# 显示名（id v版本 · 级别）`
```

`state` 里的 `roles` 只有元数据（不含正文、不含磁盘路径），要全文就调 `role`——别把 12 份全文塞进一次 `state`。

## 安装

```bash
# 1. 放进 profile
cd ~/.dsh/profiles/desktop
# dependencies 增加 "dsh-codenow": "link:<本目录绝对路径>"
# dsh.profile.bundles 增加 "dsh-codenow"
# 2. 建 junction / 符号链接到 node_modules
```

Host 端 RPC 前缀 `/codenow`，端点 `state` / `live` / `chat` / `tasks` / `sessions`。Client 通过 `connection.rpc.call` 调用，也可同源 POST 回退。

- `sessions` 入参 `{offset, limit, q, withUsage}`：`limit` 1–200（默认 40），`q` 对 `id` / `title` / `cwd` / `preset` 做大小写不敏感子串匹配，`withUsage: true` 只返回账本里有用量记录的会话（筛选在分页之前，`total` 也是筛选后的总数）；返回 `{total, offset, limit, items}`（`total` 是过滤后的总数，不是本页条数）。
- `chat` 入参 `{sessionId, limit, before}`：`limit` 1–500（默认 **50**）；返回 `{messages, hasMore, oldestSeq}`——`hasMore` 表示更早还有消息，翻页把 `oldestSeq` 当下一轮的 `before` 传回来即可（`before` 是事件 seq，语义是「只要 seq 比它小的消息」）。`messages` 结构与早先版本完全一致。

## 自检

```bash
node index.js
```

跑 12 条真断言，每条落三态 `ok` / `skip` / `FAIL`：岗位 MD 全文与交接契约、公共规范 `_common.md` 逐字节前置到每份岗位全文（等值校验，外加 5 类变异必须被拒且拒绝位置要对；并断言它没混进岗位列表）、按帧切分与旧 magic 切分逐字节一致（会话正在被追加时降级为 `skip`，不当失败）、截断到第二帧头必须报「断帧」、清扫判据（**用真实磁盘上的派生子会话驱动，不再伪造任何样本**）、干跑真实数据打印候选数与排除理由分布、`session/end-seed` 不算收尾证据（挑一个**真实**以它收尾的会话断言 `tailSettled === false`）、岗位标签精确匹配、`sessions` / `chat` 入参契约、大文件尾部解码与全量解码逐字节一致、`state` 载荷可构造、语言分段按身份分流（Lead 中文 / teammate 纯 ASCII 英文 / 其余不注入）。汇总行形如 `codenow 自检：12 通过 / 0 跳过 / 0 失败`，**只有判成 FAIL 才**让退出码非 0（skip 不计入分母）。全程只读，不移动任何目录、不写 boot log。

清扫判据那条只对**真实存在**的派生子会话做断言：真实候选里不允许出现「在跑 / 父会话还在 / 非 one-shot / 尾巴没收尾」的任何一条。真实数据碰不到的判据分支会单独打印 `未验证：<分支>（真实数据未覆盖）`，**既不算通过也不算失败**——它只说明这几条路径在当前机器上没法被真实样本验证，别当成已验证。

## 生效方式

- 改 `client.js`（bundle 内容）：**刷新页面**即可，不必重启 DSH。
- 改 `index.js`（Host 半边）：profile 的 `patchReload: live` 会**重新 import 并重跑 `apply()`**，触发方式是在 `cordis.patch.yml` 里留一行改动（该文件末尾已有一串 `# reload …` 注释，就是这个用途）。否则要等下次重启 DSH。
- 改 `package.json` / `cordis.patch.yml` 的结构（`dsh.profile.bundles`、`insert` 名单）：属启动图，需重启。

重载成功时 `~/.dsh/codenow-boot.log` 会连续写出一串：`module evaluated` → `apply start` → `route registered on /codenow` → `sweep timer armed (180s) first=600s` → `tool registered` → `team services ready` → `system prompt section registered`。缺哪一行就是卡在哪一步。

## 语言

语言规则由插件注入的 `codenow:multi-agent` 系统提示词分段强制：

- **Lead**：简体中文思考和回答。分段本身是中文派活策略，末尾另有一条语言条款，要求派工 prompt 末尾附一行 `Reply in English.` 作为兜底。
- **子智能体**：只有 `role === 'teammate'` 的成员会拿到一段英文（367 字符、纯 ASCII），首句显式声明 "This overrides any other language instruction in your prompt."——因为预设 `sol-fable-general/agent.cordis.yml:52` 写的是「使用简体中文沟通」，不覆盖就会出现两条相反指令。落盘产物沿用文件既有语言，不受这条约束。
- **其余身份**（回调没带 `agent`、不是本队成员、角色不是 lead/teammate）：不注入任何语言段，不影响进程里其它 agent。

这是**指令，不是过滤器**：插件看不到模型输出流，无法校验子智能体是否真的用英文，也没法改写它的回答。能验证的只有「插件注入了什么」。

## 限制

- 团队任务与成员存活状态取自 `team/task` / `team/member` 事件——这是权威值，不是从工具入参推断的。只有早期没有这类事件的会话才退回按 `team_task_create` 入参重建，那种回退没有状态（显示为 `-`）。
- 插件对会话内容是只读的：不改会话、不写 ledger、不碰 CodeNow 仓库。唯一的磁盘写入是把已结束的子会话目录**搬进** `~/.dsh/codenow-trash/`（见「子会话回收」），以及 30 天后清理隔离区。派活由模型调用 DSH 内置 `spawn_teammate` / `team_task_*` 完成，插件只提供岗位全文与派活策略。
- 岗位是**静态快照**，CodeNow 侧更新后需手动同步 `assets/`。
- `chat` 走「尾部解码」：文件大于 4 MB 时从尾巴往前解压，攒够条数就停（一次最多回读 8 MB，攒不够就继续往前扩）；解压失败或撞上半帧会记一行 `chat tail decode FAILED` 并回落全量解码，结果一样、只是慢。日志的**消息密度**很低（本机最大那个会话 20.8 MB / 169 条消息），所以要一次取到很早的消息时仍然要读完整份文件——`limit` 给 50 是 150 ms 级，给 200 会退化到 500 ms 级。
- `chat` / `tasks` 有一次结果缓存（按 `mtime:size` 的 stamp 失效，各留 8 条，`before` 也进 key）。搬迁或清理隔离区后缓存整体清空，不会给出搬迁前的旧结果。
