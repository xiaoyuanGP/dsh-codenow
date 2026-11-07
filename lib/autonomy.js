/**
 * 自主协作的项目状态与接续判定。
 *
 * 这里只做三件事：读写一份版本化的项目状态、按真实事件判断「该不该把主智能体接回来」、
 * 生成接续提示词。IO 细节（读会话、找 lead agent、发 wake）由 index.js 传入，
 * 好让判定逻辑可以在没有宿主的情况下被断言。
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const AUTONOMY_VERSION = 1

/** 任务板真实状态 + 内部复核记录 → 对外阶段。宿主只给 status，剩下的由我们记。 */
export const STAGE = {
  delivered: 'delivered', // 验收证据齐了，等人看
  needsUser: 'needs-user', // 缺业务定义/授权/外部动作
  blockedEnv: 'blocked-env', // 环境阻塞（缺凭据、依赖不可用）
  review: 'review', // 等内部复核
  working: 'working', // 团队在做
  queued: 'queued', // 未开始
  unknown: 'unknown',
}

export function storePath(dshHome) {
  return join(dshHome, 'storages', 'codenow-autonomy', 'state.v1.json')
}

export function emptyState() {
  return { version: AUTONOMY_VERSION, projects: [], deliveries: [], held: [], stop: null, savedAt: null }
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 旧文件、坏文件、缺字段都退化成空状态，并把原因带回去——不猜、不补写。 */
export function readState(dshHome) {
  const file = storePath(dshHome)
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    // 文件不存在是「还没用过」，不是异常；其它读取失败才算 problem。
    const missing = error?.code === 'ENOENT'
    return { state: emptyState(), file, present: false, problem: missing ? null : (error?.code ?? String(error)) }
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed?.version !== AUTONOMY_VERSION) {
      return { state: emptyState(), file, present: true, problem: `unsupported-version:${parsed?.version ?? 'none'}` }
    }
    return {
      state: {
        version: AUTONOMY_VERSION,
        projects: Array.isArray(parsed.projects) ? parsed.projects : [],
        deliveries: Array.isArray(parsed.deliveries) ? parsed.deliveries : [],
        held: Array.isArray(parsed.held) ? parsed.held : [],
        stop: parsed.stop ?? null,
        savedAt: parsed.savedAt ?? null,
      },
      file,
      present: true,
      problem: null,
    }
  } catch (error) {
    return { state: emptyState(), file, present: true, problem: `parse-error:${error?.message ?? error}` }
  }
}

/** 先写临时文件再改名：断电或并发读都不会看到半个 JSON。 */
export function writeState(dshHome, state) {
  const file = storePath(dshHome)
  mkdirSync(dirname(file), { recursive: true })
  const next = { ...state, version: AUTONOMY_VERSION, savedAt: new Date().toISOString() }
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  return next
}

export function currentProject(state) {
  const list = state?.projects ?? []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.status !== 'closed') return list[index]
  }
  return null
}

// 入参既可给数组也可给一段文本（模型常把验收条件写成多行字符串），这里统一成非空字符串数组。
function asList(value) {
  if (value === undefined || value === null || value === '') return []
  const rows = Array.isArray(value) ? value : String(value).split('\n')
  return rows.map((row) => String(row).trim()).filter(Boolean)
}

export function openProject(state, input) {
  const objective = String(input?.objective ?? '').trim()
  if (!objective) throw new Error('objective-required')
  const project = {
    id: input?.id ? String(input.id) : `p${(state.projects?.length ?? 0) + 1}`,
    objective,
    acceptance: asList(input?.acceptance),
    scope: input?.scope ? String(input.scope) : '',
    status: 'open',
    createdAt: new Date().toISOString(),
    tasks: [],
    runs: [],
    questions: [],
    verifications: [],
    nextAction: input?.nextAction ? String(input.nextAction) : '',
    deliveredAt: null,
  }
  state.projects = [...(state.projects ?? []), project]
  return project
}

export function upsertTask(project, input) {
  const id = String(input?.id ?? '').trim()
  if (!id) throw new Error('task-id-required')
  const tasks = project.tasks ?? []
  const at = tasks.findIndex((task) => task.id === id)
  const base = at >= 0 ? tasks[at] : { id, createdAt: new Date().toISOString(), verification: null }
  const next = {
    ...base,
    title: input?.title ?? base.title ?? '',
    owner: input?.owner ?? base.owner ?? null,
    status: input?.status ?? base.status ?? 'pending',
    dependsOn: input?.dependsOn ?? base.dependsOn ?? [],
    artifacts: input?.artifacts ?? base.artifacts ?? [],
    updatedAt: new Date().toISOString(),
  }
  project.tasks = at >= 0 ? tasks.map((task, index) => (index === at ? next : task)) : [...tasks, next]
  return next
}

/** 复核记录挂在任务上；产物变了就让旧结论失效（verifiedAt 早于 artifactAt 即视为过期）。 */
export function recordVerification(project, input) {
  const id = String(input?.taskId ?? '').trim()
  const task = (project.tasks ?? []).find((row) => row.id === id)
  if (!task) throw new Error('unknown-task')
  if (input?.reviewer === task.owner) throw new Error('reviewer-cannot-be-owner')
  const record = {
    taskId: id,
    reviewer: String(input?.reviewer ?? ''),
    verdict: String(input?.verdict ?? 'unknown'),
    evidence: String(input?.evidence ?? ''),
    artifactStamp: String(input?.artifactStamp ?? ''),
    at: new Date().toISOString(),
  }
  project.verifications = [...(project.verifications ?? []), record]
  task.verification = record
  task.status = record.verdict === 'pass' ? 'verified' : 'rework'
  return record
}

export function setStop(state, info) {
  state.stop = {
    at: new Date().toISOString(),
    reason: String(info?.reason ?? ''),
    by: String(info?.by ?? 'user'),
  }
  return state.stop
}

export function clearStop(state) {
  state.stop = null
  return state
}

/**
 * 任务阶段：优先用真实记录（复核结论、阻塞项、问题），宿主只提供 status。
 * 没有信号就返回 unknown——不把「不知道」说成「等你验收」。
 */
export function stageOfTask(task, project) {
  if (!task) return { stage: STAGE.unknown, waitingOn: 'unknown' }
  if (task.verification?.verdict === 'pass') {
    const delivered = project?.deliveredAt != null
    return { stage: delivered ? STAGE.delivered : STAGE.review, waitingOn: 'user' }
  }
  if (task.verification?.verdict === 'fail') return { stage: STAGE.working, waitingOn: 'agent' }
  if ((task.dependsOn ?? []).length > 0) return { stage: STAGE.working, waitingOn: 'agent' }
  const open = (project?.questions ?? []).filter((row) => row.taskId === task.id)
  if (open.length > 0) return { stage: STAGE.needsUser, waitingOn: 'user' }
  const blocked = (project?.questions ?? []).filter((row) => row.taskId === task.id && row.kind === 'env')
  if (blocked.length > 0) return { stage: STAGE.blockedEnv, waitingOn: 'unknown' }
  if (task.status === 'pending') return { stage: STAGE.queued, waitingOn: 'none' }
  if (task.status === 'in_progress') return { stage: STAGE.working, waitingOn: 'agent' }
  return { stage: STAGE.unknown, waitingOn: 'unknown' }
}

export function addQuestion(project, input) {
  const record = {
    id: `q${(project.questions?.length ?? 0) + 1}`,
    taskId: input?.taskId ? String(input.taskId) : null,
    kind: input?.kind === 'env' ? 'env' : 'business',
    question: String(input?.question ?? ''),
    impact: String(input?.impact ?? ''),
    askedAt: new Date().toISOString(),
    answeredAt: null,
  }
  project.questions = [...(project.questions ?? []), record]
  return record
}

/** 接续判定的唯一入口：调用方只把「看到的事实」传进来，这里只判断该不该唤醒。 */
export function decideContinuation(input) {
  const { state, project, children, leadTurnIdle, leadSeen } = input
  if (!project) return { deliver: false, reason: 'no-open-project' }
  if (state?.stop) return { deliver: false, reason: 'stopped' }
  if (!leadTurnIdle) return { deliver: false, reason: 'lead-busy' }
  const delivered = new Set((state?.deliveries ?? []).map((row) => row.key))
  for (const child of children ?? []) {
    if (!child?.id || !num(child.lastSeq)) continue
    if (child.tailType !== 'turn/end' && child.tailType !== 'session/end-seed') continue
    const key = `${child.id}:${child.lastSeq}`
    if (delivered.has(key)) continue
    const seenKey = `${child.id}:${child.lastEventAt ?? ''}`
    if (leadSeen?.has?.(seenKey)) continue
    return {
      deliver: true,
      reason: 'child-turn-end',
      key,
      childId: child.id,
      childName: child.name ?? child.id,
      lastSeq: child.lastSeq,
      tailType: child.tailType,
    }
  }
  return { deliver: false, reason: 'nothing-new' }
}

export function noteFor(input) {
  const { project, decision } = input
  const next = project?.nextAction ? `下一步：${project.nextAction}` : '下一步：按任务板继续（未记录时先核对磁盘产物，再决定）'
  return [
    `[codenow 自动接续] 子智能体 ${decision.childName} 的会话已产出新结果（seq ${decision.lastSeq}，尾部事件 ${decision.tailType}）。`,
    `当前目标：${project.objective}`,
    next,
    '要求：先核对磁盘真实产物与该子任务的复核记录，再决定继续分派、返工还是集成；不要请用户确认常规步骤；需要用户时把问题合并成一次。',
  ].join('\n')
}

export function rememberDelivery(state, decision, extra) {
  const row = {
    key: decision.key,
    childId: decision.childId,
    seq: decision.lastSeq,
    reason: decision.reason,
    at: new Date().toISOString(),
    ...extra,
  }
  state.deliveries = [...(state.deliveries ?? []), row].slice(-200)
  return row
}

export function projectView(state, extra) {
  const project = currentProject(state)
  return {
    version: AUTONOMY_VERSION,
    stopped: state?.stop ?? null,
    project: project
      ? {
          id: project.id,
          objective: project.objective,
          acceptance: project.acceptance,
          scope: project.scope,
          status: project.status,
          nextAction: project.nextAction,
          tasks: project.tasks ?? [],
          questions: project.questions ?? [],
          verifications: project.verifications ?? [],
          deliveredAt: project.deliveredAt ?? null,
        }
      : null,
    deliveries: (state?.deliveries ?? []).slice(-10),
    ...extra,
  }
}
