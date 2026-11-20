# dsh-codenow

把 [Origin CodeNow](../../Origin%20CodeNow) 的**多角色协同编排层**搬进 DSH：岗位库、群聊回放、任务重建、按模型统计缓存与用量。

装上即接管 Lead 的派活策略：主模型（首席工程师）收到任务后按岗位自行拉起子智能体（未声明的岗位不会被拉；`chief-engineer` 就是 Lead 本人），会话头部提供「AI 团队」入口查看每个正在干活的岗位。

不移植 CodeNow 的 FastAPI 后端与 SQLite 库——DSH 本身已经是协作运行时（Lead/teammate、共享任务板、群聊式会话），这里只补齐 CodeNow 有而 DSH 没有的那一层视图与提示词资产。

## 数据来源

| 数据 | 来源 | 说明 |
| --- | --- | --- |
| 岗位（18 个） | `assets/roles/*.md` | 沿用 Origin CodeNow 的 frontmatter 约定；分两层：1 名首席工程师 + 17 名专家工程师，均按资深工程师的分析、实施、验证和交接标准维护。版本：既有 12 份为 `2.2.0`，新增的 5 份（演示文稿、Word、Excel、GitHub 仓库、Blender 建模）为 `1.0.0` |
| 公共规范 | `assets/roles/_common.md` | 分析规范、实施规范、协作契约三节；不是岗位（`listRoles()` 跳过 `_` 前缀），由插件前置到每份岗位全文之前 |
| 会话与消息 | `~/.dsh/sessions/**/session[.vN].jsonl.zstd` | 多帧 zstd 串联，按帧结构（magic + 帧头 + block 遍历）逐帧切分后解压。**分代取名**：同一目录里可能同时躺着 v3 与 v4，取 N 最大的那一个（无代号按 v1）；行上带 `format`（`v4` / `v3`），本机 90 个会话里 v4 68 个、仅 v3 22 个 |
| 会话标题 | `~/.dsh/storages/session_projcache/sessions/<uuid>.json` | `record.rows.title.val`；磁盘上同时存在 `session-<uuid>.json` 与裸 `<uuid>.json` 两种命名，两个候选都试，不能只补前缀 |
| 各 AI 用量 / 缓存 | `~/.dsh/storages/cost-meter/ledger.json` | 按 provider/model 与按会话聚合；天级 `byProviderModel` 只在天级累加（它已经等于当日各字段之和，再叠会话级就是重复计数）；key 按**第一个**冒号切 provider / model；货币取 `config.currency`（缺省 USD） |
| 待办 | 会话日志 `todo/write` 事件 | 取最后一条快照 |
| 团队任务 | 会话日志 `team/task` 事件 | 权威快照，带 `status`；按 `task.id` 取 `revision` 最大的一条 |
| 任务归属（`stage` / `waitingOn`） | 插件现算，不落盘 | 只吃结构化事实：`team/task` 的 `status` / `blockedBy` / 事件时间 + 全局活跃成员数。**不读消息文本**。宿主不给「等人回答」「投递失败」这两个信号，那两种如实返回 `unknown`，不猜 |
| 成员存活 | 会话日志 `team/member` 事件 | `phase` = provisioning / active / ended |

## 岗位能力与使用

首席负责技术决策和交付闭环，可在授权范围亲自完成小任务；专业岗位沿完整调用链处理其职责内问题。模板强调真实契约、最小方案、失败与恢复、兼容性、独立验证及有证据的交接，不强制所有任务采用某种框架或新增基础设施。

Lead 在新任务开始时先通过 `codenow({ action: "role", id: "chief-engineer" })` 获取首席全文；派工前获取对应专业岗位全文。同一任务复用已读内容，模板变化后重新读取。既有 12 份岗位的 ID、显示名、组织层级、输出字段及执行预算保持兼容；新增的 4 份沿用同一约定与字段。

岗位全文的返回结构是 `# 显示名（id v版本 · 级别）` + `_common.md` 全文 + 岗位文件原文，三段按此顺序拼接（自检对每份岗位做**完整等值**校验，并用 5 类变异验证这条断言确实会拒绝错误输出）。因此公共方法只维护一份，各岗位文件只写自己的专业判断与交付要求；`_common.md` 缺失时自动降级为只返回岗位原文，不阻断派工。

公共规范分三节：**分析规范**（可裁剪的分析环节，只给决策摘要与证据，不设强制轮次或逐步思维链）、**实施规范**（先读再改、改完整调用链、保持集中、失败先查现场、用真实材料验证、交付前重读结果、如实报告状态）、**协作契约**（派工五要素：目标与验收+真实输入来源 / 已完成的调查与成果 / 可改文件与不变量 / 前置依赖·交付对象·阻塞解除 / 交付时的验证证据；四条规则：按需分工、写入归属唯一、交接可接续、集成后再验收）。

模板是提供给模型的工作规范；`execution`、审批项和协作名单不会由本插件自动转换成运行时限制，权限和实际预算仍由宿主执行。岗位规范不改变模型、工具和环境本身的能力。

## 界面

侧边栏「协同工作台」，5 个页签：

- **协同** — 18 个岗位卡片（层级、职责、可交接对象）
- **群聊** — 选会话，看真人消息与助手回复的完整时间线，向上翻页加载更早（游标取当前已加载消息里最小的 `seq`，一次 50 条；切会话或刷新时在飞的旧请求会被丢弃，不会串进新列表）
- **会话头部** — 一个「AI 团队」按钮，点开看每个正在干活的岗位、所属主智能体及其模型；没人在跑时按钮隐藏
- **任务** — 当前待办快照 + 团队任务（带状态列与**归属列**，`deleted` 的不显示）+ 协同动作流水（spawn / send_message / 任务增删）。归属列回答「这件事现在卡在谁身上」：`等你验收` / `等上游` / `进行中` / `未开始` / `疑似停摆（推测）` / `未知`，`等你验收` 的行置顶加粗，标题上会顶出「等你处理 N」。它**只吃结构化字段**（见「数据来源」），不从消息文本猜；旧版 Host 没有这个字段时该列显示 `-`
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

### 重试语义

搬不动的会话不一律记「失败」，按错误码分两类：

| 错误码 | 记什么 | 会不会重试 |
|---|---|---|
| `EBUSY` / `EPERM` / `EACCES` / `ENOTEMPTY` | `sweep defer <id> <code>（下一轮重试）` | 会——宿主可能正开着这些文件，锁一松开，下一个 180 秒周期就能搬走 |
| 其它 | `sweep move FAILED <id> …` | 不会自动重试，需要人看 |

**不引入短退避**（比如 2 秒起、逐次翻倍、上限 1 分钟）：清扫是同步路径，睡在事件循环里会卡住宿主；180 秒的周期本身就已经是重试间隔。

同理，派活工具（`subagent`，旧宿主为 `spawn_teammate`）/ `send_message` 失败不做重试——名额已满、成员会话已被回收、名字已占用都是硬失败，重试只会重复失败。

### 插件重载会影响什么

改 `index.js` 后靠 `cordis.patch.yml` 的一行变动触发重载。重载时：

- **不会**取消、打断或重跑任何正在执行的会话——那些会话归宿主所有，插件只读它们的日志；
- **不会**立刻清扫：首扫仍等满 600 秒（`FIRST_SWEEP_DELAY_MS`，自检会断言它 ≥600 秒）；
- **会**清空进程内的三类缓存（事件、结果、协调），只影响下一次请求的速度，不影响结果正确性；
- 在跑的 teammate 若此刻没有活跃标记也不会被搬走：`agents.list()` 拿不到 id 时整轮跳过（记 `sweep SKIPPED`）。

## 自主协作

项目状态落盘在 `<dshHome>/storages/codenow-autonomy/state.v1.json`（任务与单次执行分开记录，换人、重试、宿主重启都不丢任务）。`state` 载荷里多一个 `autonomy` 字段，面板据此区分「等内部」和「等你」。

自动接续走宿主真实的 agent 唤醒通道，不是往对话里定时追加：插件每 8 秒读一次项目状态与派生子会话的尾事件，当某个子会话的尾巴是 `turn/end` 且这条结果还没投递过，就用 `agent.followup({id, role:'user', content, source:{kind:'agent-message', form:'relay', senderSessionId}})` 让 Lead 开新一轮，并把 `<root>:<childId>:<lastSeq>` 作为键记进投递表（对象形态，带 messageId / attempts / status / retryAt）避免重复唤醒。投递状态机是 `sending → sent → consumed`（失败落 `unknown` 或 `failed`）：`sending` 超过 90 秒、`unknown`/`failed` 退避到期且尝试次数未满 3 次时会**复用同一个 messageId** 重试（宿主按 id 去重，重试不会变成第二次唤醒）；`sent` 只证入箱、`consumed` 只证宿主已领取，两者都不表示任务完成。以下情况一律不唤醒：没有开放项目、已被用户叫停、Lead 正在跑、没有新的子会话结果。

复核与返工也落在这份状态里：`verify` 记录复核人与结论，复核人等于任务负责人会被直接拒绝（自证不算独立复核）；结论为不通过则任务回到 `working`。

### 产物版本

每份产物登记为绝对路径或相对项目 `cwd` 的路径，校验时记录 `bytes` 与 `sha256`，任务级 `artifactStamp` 是整个清单的哈希。

- 同一路径改内容、删除、重建都会让 `artifactStamp` 变化，**旧复核自动失效**（`stale-artifact-stamp`），任务回到 `rework`。
- 目录不当作产物（`产物必须是文件`），不展开子文件；`%TEMP%` 这类未展开变量直接拒绝（`路径含未展开变量`）；相对路径没有项目 `cwd` 时拒绝（`缺少项目实际工作目录`）。
- 读取前后对比 `size/mtimeNs/ctimeNs/ino`，读的同时被改会拒绝（`读取期间产物变化`），不会把半新半旧的内容登记成"已复核"。
- 成本线性：本机 5×1MB 约 5ms、256MB 约 146ms、512MB 约 286ms。每次 `status`/`task`/`verify`/`deliver` 都会重算；产物很大时应把大文件移出产物清单或接受该开销，当前真实产物都是小文件，不做缓存。

## Agent 工具

`codenow`（供 Lead 取岗位全文）：

```
codenow({ action: "roles" })                    # 全部岗位摘要（frontmatter 解析后的字段）
codenow({ action: "role", id: "security-engineer" })   # 岗位全文：标题行 + `_common.md` + 整份 MD 原文（含 YAML frontmatter 里的 execution / 审批项等），首行是 `# 显示名（id v版本 · 级别）`
codenow({ action: "setup" })                    # 只读检测：内置技能 / MCP 桥 / Blender addon 装没装
codenow({ action: "project", op: "status" })    # 项目状态；op 另有 open / task / verify / ask / next / deliver / stop / resume
```

`state` 里的 `roles` 只有元数据（不含正文、不含磁盘路径），要全文就调 `role`——别把 18 份全文塞进一次 `state`。

## 安装

```bash
# 1. 放进 profile
cd ~/.dsh/profiles/desktop
# dependencies 增加 "dsh-codenow": "link:<本目录绝对路径>"
# dsh.profile.bundles 增加 "dsh-codenow"
# 2. 建 junction / 符号链接到 node_modules
```

Host 端 RPC 前缀 `/codenow`，端点 `state` / `live` / `chat` / `tasks` / `sessions` / `autonomy` / `setup` / `install`（后两个只在用户点面板按钮时用）。Client 通过 `connection.rpc.call` 调用，也可同源 POST 回退。

- `sessions` 入参 `{offset, limit, q, withUsage}`：`limit` 1–200（默认 40），`q` 对 `id` / `title` / `cwd` / `preset` 做大小写不敏感子串匹配，`withUsage: true` 只返回账本里有用量记录的会话（筛选在分页之前，`total` 也是筛选后的总数）；返回 `{total, offset, limit, items}`（`total` 是过滤后的总数，不是本页条数）。
- `chat` 入参 `{sessionId, limit, before}`：`limit` 1–500（默认 **50**）；返回 `{messages, hasMore, oldestSeq}`——`hasMore` 表示更早还有消息，翻页把 `oldestSeq` 当下一轮的 `before` 传回来即可（`before` 是事件 seq，语义是「只要 seq 比它小的消息」）。`messages` 结构与早先版本完全一致。

## 宿主版本兼容

插件同时适配 2026-11 之前与之后的 DSH，判定都写在代码里，不靠配置：

| 能力 | 新宿主（2026-11 起） | 旧宿主 |
|---|---|---|
| 会话投影 | `{version:7, record:{identity, rows}}`，字段都在 `rows.<名字>.val` 下 | **只认形状不认版本号**：先取 `record.rows.*.val`，取不到退回顶层同名字段；v8/v9 只要还是这个形状就能读，实测 v7 / v9 / 旧版三种样本解析一致（自检第 21 条） |
| 团队身份 | 服务只剩 `isEnabled / createTask / getTask / listTasks / updateTask`，**没有** `membership / listMembers`；改为按会话 `parentSession` 判 teammate / lead，名字取父会话投影里的 `subagentCatalog.label` | 先用 `tryMembership` |
| 派活通道 | `subagent` / `subagent_fork`（`spawn_teammate` 服务端已不存在） | 若提供 `spawn_teammate` 则沿用 |
| 团队协作开关 | `agentTeam.isEnabled(caller)`（同步）；开＝注入「必须派活」，关＝注入「按需」，读不到按关闭处理 | 无此开关，一律按需 |
| 会话日志 | 仍为 `session.v3.jsonl.zstd` / `session.v4.jsonl.zstd`，帧格式未变 | 同 |
| 账本 | 仍是 `<dshHome>/storages/cost-meter/ledger.json`，顶层 `days` 累加 | 同 |

投影里现成可用的字段（插件按需读，缺失一律降级为空，不猜）：`title`、`modelSelection.lastUsed`、`agentPreset`、`workingDirectory`、`costUsage.totals`、`subagentCatalog.head.values[]`（含 `childId` / `label` / `mode`）。

身份判定的边界：磁盘上根本不存在的会话返回 `null`（不猜成 lead，避免陌生人拿 Lead 权限）；旧宿主的 `tryMembership` 若存在且返回身份，仍以它为准。

## 自检

```bash
node index.js
```

跑 21 条真断言，每条落三态 `ok` / `skip` / `FAIL`：岗位 MD 全文与交接契约、公共规范 `_common.md` 逐字节前置到每份岗位全文（等值校验，外加 5 类变异必须被拒且拒绝位置要对；并断言它没混进岗位列表）、按帧切分与旧 magic 切分逐字节一致（会话正在被追加时降级为 `skip`，不当失败）、截断到第二帧头必须报「断帧」、清扫判据（**用真实磁盘上的派生子会话驱动，不再伪造任何样本**）、干跑真实数据打印候选数与排除理由分布、`session/end-seed` 不算收尾证据（挑一个**真实**以它收尾的会话断言 `tailSettled === false`）、岗位标签精确匹配、`sessions` / `chat` 入参契约、大文件尾部解码与全量解码逐字节一致、`state` 载荷可构造、语言分段按身份分流（Lead 中文 / teammate 纯 ASCII 英文 / 其余不注入）、任务 stage 只吃结构化字段（7 类映射逐一断言、活跃成员数拿不到时不许判停摆、首扫间隔 ≥600 秒）、项目状态可读写且版本可识别（坏文件不猜）、自动接续只在该唤醒时唤醒（叫停 / 去重 / Lead 忙 / 无项目四种情况逐一断言）、复核结论与阶段映射来自真实记录而不是猜（并断言自证会被拒绝）、投递恢复只重试该重试的（`sending` 超窗 / 退避到期 / 尝试上限 / `sent` 与 `consumed` 永不重试，重试复用同一 messageId）、团队身份按会话父子判定（旧宿主先用 tryMembership；新宿主已移除该 API，改为「会话 header 有 parentSession → teammate，名字取父会话投影里的 subagentCatalog.label；没有 → lead；磁盘上不存在的会话返回 null，绝不猜成 lead」）、派活强度跟随团队协作开关（开＝必须至少派 1 个子智能体；关＝允许零个 teammate；除派活段外两版注入文本逐字相同）。汇总行形如 `codenow 自检：20 通过 / 0 跳过 / 0 失败`，**只有判成 FAIL 才**让退出码非 0（skip 不计入分母）。全程只读，不移动任何目录、不写 boot log、派活通道指向宿主真实提供的工具（`subagent` / `subagent_fork` / `wait_agent` 必须被识别，首选通道不能是旧宿主的 `spawn_teammate`）。

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
- 插件对会话内容是只读的：不改会话、不写 ledger、不碰 CodeNow 仓库。唯一的磁盘写入是把已结束的子会话目录**搬进** `~/.dsh/codenow-trash/`（见「子会话回收」），以及 30 天后清理隔离区。派活由模型调用宿主提供的 `subagent` / `subagent_fork`（旧宿主为 `spawn_teammate`）/ `team_task_*` 完成，插件只提供岗位全文与派活策略。
- 岗位是**静态快照**，CodeNow 侧更新后需手动同步 `assets/`。
- `chat` 走「尾部解码」：文件大于 4 MB 时从尾巴往前解压，攒够条数就停（一次最多回读 8 MB，攒不够就继续往前扩）；解压失败或撞上半帧会记一行 `chat tail decode FAILED` 并回落全量解码，结果一样、只是慢。日志的**消息密度**很低（本机最大那个会话 20.8 MB / 169 条消息），所以要一次取到很早的消息时仍然要读完整份文件——`limit` 给 50 是 150 ms 级，给 200 会退化到 500 ms 级。
- `chat` / `tasks` 有一次结果缓存（按 `mtime:size` 的 stamp 失效，各留 8 条，`before` 也进 key）。搬迁或清理隔离区后缓存整体清空，不会给出搬迁前的旧结果。

### 0.2.2-rc.5（已实测）

在 0.2.2-rc.5（@deepseek-ai/dsh-desktop-runtime@0.2.2-rc.5）上核对过的事实：

| 面 | rc.5 现状 | 插件处置 |
|---|---|---|
| 派活工具 | dsh-base 仍注册 `toolName: subagent` / `subagent_fork`，服务端无 spawn_teammate | 策略首选 subagent |
| 团队服务 | dsh-agent-team 仍有 isEnabled(caller)（写 	eam/mode 事件），仍无 membership/tryMembership/listMembers | isEnabled 优先，缺失时按 parentSession + 投影 subagentCatalog 判定 |
| 团队任务工具 | 	eam_task_create/list/get/update 四个 | 任务板仍解压日志 	eam/task，投影 gentTeam.val.tasks 作权威值 |
| 会话投影 | 仍为 {version:7, record:{identity{formatVersion:4}, rows}}（实测 284 份全是 v7） | projectionValue 只认形状 |
| Agent 通道 | gent-loop 的 ollowup/steer/inject 均在 | 自动接续继续用 ollowup |
| 插槽 | conversation.session.header.actions 仍在 slot-catalog 里 | 面板按钮不变 |

### 0.2.2-rc.5 及以后

RC 之间会改服务签名与包名，插件不靠版本号判断，只靠**能力探测**：

- 启动时 `apply` 打一行 `host caps teams.isEnabled=1 tryMembership=0 listMembers=0 missing=-`，升级后先看这行就知道缺什么。
- `setup` 端点（面板「环境」一节）附带 `host` 块：`services` / `teams{isEnabled, tryMembership, listMembers, createTask}` / `agents{list}` / `missing[]`。
- 团队身份：`isEnabled` 在就先用它；不在就按会话 `parentSession` 与投影 `subagentCatalog` 判定；磁盘上不存在的会话一律返回 `null`（不猜成 Lead）。
- 会话日志：`session[.v<N>].jsonl[.zstd]` 任意分代都认，自动取最大 N，新增 v5 不用改代码。
- 会话投影：见上表，形状兼容而非版本兼容。
- 宿主服务缺失时：`webServer` / `tools` / `systemPrompt` / `agentTeams` 全部 try/catch 包裹，缺哪个就少一块功能并留一行日志，不阻塞加载。
