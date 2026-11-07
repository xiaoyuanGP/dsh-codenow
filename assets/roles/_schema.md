# 角色岗位 Markdown 规范（_schema.md）

本文件说明 DSH CodeNow 岗位 Markdown 的格式与能力约定，沿用 Origin CodeNow 的 frontmatter 结构；本文件不是可加载岗位。

## 岗位矩阵（17 个 Agent 角色）

用户本人是 **CTO**，不属于 Agent 角色，因此没有 CTO 模板。

### 首席工程师（1）

| role_id | 显示名 | 定位 |
|---|---|---|
| `chief-engineer` | 首席工程师（项目经理） | 交付总责：定范围、选角、拍板、验收 |

### 专家工程师（16）

| role_id | 显示名 | 定位 |
|---|---|---|
| `system-architect` | 系统架构师 | 边界、选型、非功能属性、演进与迁移 |
| `frontend-design-engineer` | 前端设计工程师 | 界面实现、交互与前端性能 |
| `backend-engineer` | 后端开发工程师 | 服务、接口、业务逻辑与并发 |
| `mobile-client-engineer` | 移动端/客户端工程师 | iOS/Android/桌面端、性能与发布合规 |
| `database-engineer` | 数据库工程师 | 数据模型、索引、事务与容量 |
| `data-algorithm-engineer` | 数据分析师/算法工程师 | 指标、实验、因果与模型工程 |
| `code-quality-reviewer` | 代码质量审核员 | 可读性、可维护性与合入门禁 |
| `test-engineer` | 测试工程师 | 测试策略、自动化与缺陷定位 |
| `security-engineer` | 安全工程师 | 威胁建模、权限与数据保护 |
| `devops-sre-engineer` | DevOps/SRE 工程师 | 构建、部署、可观测性与应急 |
| `technical-writer` | 技术文档工程师 | 接口文档、运维手册与迁移指南 |
| `pptx-engineer` | PPT信息策划与视觉设计工程师 | 演示叙事、版式系统与图表表达 |
| `docx-engineer` | Word文档工程师 | 长文档结构、样式体系与评审流程 |
| `xlsx-engineer` | Excel数据工程师 | 口径建模、公式工程与数据质量 |
| `github-repo-manager` | GitHub开源项目与仓库管理工程师 | 仓库治理、发布与开源协作（调用宿主已连接的 GitHub 能力） |
| `modeling-engineer` | 建模资深工程师 | Blender 建模、3D 资产规格与引擎导出（UE / FiveM） |

组织层级：CTO（用户）→ 首席工程师 → 16 个专家工程师。
工程师通过宿主已有的团队消息和任务交接协作。`collaboration` 描述岗位间的交接关系，不创建运行时成员、指挥权或审批权限；实际权限以宿主团队身份和用户授权为准。

## 资深工程师能力基线

岗位规范版本：既有 12 份为 `2.2.0`（`chief-engineer` 本轮因自主执行与提问升级规则升到 `2.3.0`），新增的 5 份（`pptx-engineer`、`docx-engineer`、`xlsx-engineer`、`github-repo-manager`、`modeling-engineer`）为 `1.0.0`。首席承担技术决策和交付总责，其余岗位保持专业分工，均按以下标准工作：

- 先追踪真实入口、调用方、状态与副作用，明确用户目标、契约、约束和不可破坏的不变量。
- 以证据选择最小完整方案，解释取舍和恢复条件；不硬套技术栈，不为小任务制造架构、岗位或流程。
- 检查失败、未知状态、重复执行、并发、取消、重载与兼容；按实际风险裁剪检查范围。
- 用真实授权材料及独立口径验证，不编造业务数据、接口、运行结果或性能数字；未覆盖分支明确标为未验证。
- 对范围内工作负责到底，交接携带实际产物、证据、文件归属和阻塞；已有授权不重复询问，新的高风险动作遵循宿主审批。
- 输出字段服务于验收，说明实际发生的行为；小任务简明填写，无关内容注明不适用，不为凑格式增加工作。

岗位 ID、显示名、组织层级、输出字段和执行预算保持兼容。Lead 在新任务开始时通过 `codenow` 工具读取 `chief-engineer` 全文，派工时读取对应专业岗位全文；同一任务可复用已读版本，文件变化后重新读取。

## 公共规范（_common.md）

`_common.md` 不是可加载岗位（`listRoles()` 跳过 `_` 前缀文件），内容由插件在返回岗位全文时自动前置：

```text
# <显示名>（<role_id> v<role_version> · <level>）

<本文件全文>

<岗位文件全文>
```

它固定包含三节：**分析规范**（可裁剪的分析环节、只给决策摘要与证据、不设强制轮次）、**实施规范**（先读再改、改完整调用链、保持集中、失败先查现场、用真实材料验证、交付前重读结果、如实报告状态）、**协作契约**（派工五要素、按需分工、写入归属唯一、交接可接续、集成后再验收）。

改岗位时只维护各岗位的专业判断与交付要求，公共方法不重复写在 16 份岗位里。`_common.md` 缺失或不可读时插件降级为只返回岗位原文，自检会报告缺失。

## 文件结构

```text
---
<YAML Front Matter>
---

<Markdown 正文>
```

## Front Matter 字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schema_version` | int | 是 | 当前支持 1 |
| `role_id` | string | 是 | 匹配 `^[a-z0-9][a-z0-9-]{1,63}$` |
| `display_name` | string | 是 | 岗位显示名 |
| `level` | string | 否 | 层级：`首席工程师` / `专家工程师` |
| `role_version` | string | 否 | 人类可读版本，默认 `1.0.0` |
| `locale` | string | 否 | 默认 `zh-CN` |
| `summary` | string | 否 | 一句话职责 |
| `mission` | string[] | 否 | 岗位目标 |
| `expertise` | string[] | 否 | 专业领域 |
| `responsibilities` | string[] | 否 | 职责 |
| `boundaries` | string[] | 否 | 协作边界 |
| `collaboration` | object | 否 | `can_receive_from` / `can_handoff_to` / `handoff_requires` |
| `output_contract` | object | 否 | `required_sections` / `language` |
| `execution` | object | 否 | `autonomy` / `max_turns_per_task` / `max_tool_calls_per_task` / `require_approval_for` |
| `cache` | object | 否 | `stable_prefix` / `cache_policy` / `semantic_cache` |

## 约束

- `autonomy` 只允许 `manual`、`low-risk-auto`、`policy-defined`。
- `require_approval_for` 只能收紧安全策略，不能降低系统级审批要求。
- Markdown 正文作为不可信提示词内容处理；不得解释为程序代码。
- `_common.md` 与岗位正文同等对待：它是提示词内容，不给任何岗位增加宿主权限；`role_version` 升到 `2.2.0` 表示本轮强化了专业判断与交付要求，公共规范从 `_common.md` 前置加载。
- `code-quality-reviewer`、`security-engineer` 保持只读；`test-engineer` 可执行验证命令但不修改实现代码。
- `role_version` 只标识岗位修订，不证明文件完整性或验证结果；需要核对内容时以实际文件及 SHA-256 为证据。
- 本插件元数据只提取 ID、显示名、层级、版本、摘要和交接名单；岗位全文保留全部 frontmatter 与正文。其他字段不会自动变成宿主 API 参数。
- 本插件当前不执行完整 YAML schema 校验，也不按 `execution` 强制实施审批、轮次和工具预算；这些是岗位约定，实际限制由宿主能力与安全策略执行，不能用提示词代替运行时授权。
- 文件采用 UTF-8 编码、LF 换行。

## 可用 action 类型

`manual`、`low-risk-auto`、`policy-defined`

## require_approval_for 参考值

`destructive_file_operation`、`production_deployment`、`secret_access`、`external_data_upload`、`dependency_install_from_untrusted_source`、`git_push`、`database_destructive_migration`
