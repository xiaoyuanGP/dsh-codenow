// 项目级自主协作的纯逻辑层：状态形状、迁移、判据、门禁。不 import 宿主，也不碰网络。
// 所有函数要么是纯的（改传入对象），要么只读写自己的状态文件。
import { closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** v1 是单文件共享状态；v2 起按 rootSessionId 分目录，并把投递记录改成带状态的对象表。 */
export const AUTONOMY_VERSION = 2

export const STAGE = {
  delivered: 'delivered',
  needsUser: 'needs-user',
  blockedEnv: 'blocked-env',
  review: 'review',
  working: 'working',
  queued: 'queued',
  unknown: 'unknown',
}

/** 根会话 id 会被拼进路径，只接受安全字符；拿不到就不写文件（返回 null 由调用方拒绝）。 */
export function safeRoot(rootSessionId) {
  const id = String(rootSessionId ?? '').trim().replace(/^session-/, '')
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? `session-${id}` : null
}

export function storePath(dshHome, rootSessionId) {
  const root = safeRoot(rootSessionId)
  if (!root) return null
  const base = resolve(dshHome, 'storages', 'codenow-autonomy')
  const file = resolve(base, root, 'state.v1.json')
  const child = relative(base, file)
  return child.startsWith(`..${sep}`) || isAbsolute(child) ? null : file
}

/** v1 的单文件位置（所有主会话共用那一个），只用于迁移。 */
export function legacyStorePath(dshHome) {
  return join(dshHome, 'storages', 'codenow-autonomy', 'state.v1.json')
}

export function emptyState(rootSessionId) {
  const root = safeRoot(rootSessionId)
  return {
    version: AUTONOMY_VERSION,
    rootSessionId: root,
    projects: [],
    deliveries: {},
    held: [],
    stop: null,
    savedAt: null,
  }
}

export function asList(value) {
  if (value === undefined || value === null || value === '') return []
  const rows = Array.isArray(value) ? value : String(value).split('\n')
  return rows.map((row) => String(row).trim()).filter(Boolean)
}

function acceptanceRows(value) {
  const rows = Array.isArray(value) ? value : asList(value)
  return rows.map((row) => {
    if (typeof row === 'string' && row.trim()) return { text: row.trim(), evidence: '' }
    if (!row || typeof row.text !== 'string' || !row.text.trim() || (row.evidence !== undefined && typeof row.evidence !== 'string')) {
      throw new Error('acceptance-invalid:text/evidence 必须为文本')
    }
    return { text: row.text.trim(), evidence: row.evidence?.trim() ?? '' }
  })
}

/** 投递记录：去重键含 root，状态机 pending→sending→sent|failed|unknown。 */
export function deliveryKeyOf(rootSessionId, childSessionId, lastEventSeq) {
  return `${safeRoot(rootSessionId) ?? '?'}:${safeRoot(childSessionId) ?? '?'}:${lastEventSeq}`
}

function deliveryMap(rows, root) {
  const map = {}
  for (const [oldKey, row] of Object.entries(rows ?? {})) {
    if (!row || typeof row !== 'object') throw new Error('delivery-invalid')
    if (row.rootSessionId && safeRoot(row.rootSessionId) !== root) throw new Error('delivery-root-mismatch')
    const childSessionId = row.childSessionId ?? row.childId
    const lastEventSeq = row.lastEventSeq ?? row.seq
    const key = childSessionId && Number.isSafeInteger(lastEventSeq)
      ? deliveryKeyOf(root, childSessionId, lastEventSeq) : (row.key ?? oldKey)
    map[key] = { ...row, key, rootSessionId: root, childSessionId, lastEventSeq, status: row.status ?? 'unknown' }
  }
  return map
}

/** v1 的 deliveries 是数组且没有 root，迁移时补 root 并标成 sent（历史已投递过）。 */
function migrateShape(parsed, root) {
  return {
    version: AUTONOMY_VERSION,
    rootSessionId: root,
    projects: (Array.isArray(parsed?.projects) ? parsed.projects : []).map((project) => ({
      ...project,
      acceptance: Array.isArray(project?.acceptance)
        ? project.acceptance.map((row) => (typeof row === 'string' ? { text: row, evidence: '' } : { text: String(row?.text ?? ''), evidence: String(row?.evidence ?? '') }))
        : [],
      tasks: (project?.tasks ?? []).map((task) => ({ blocker: null, artifacts: [], ...task })),
      questions: project?.questions ?? [],
      verifications: project?.verifications ?? [],
    })),
    deliveries: deliveryMap(parsed?.deliveries, root),
    unmapped: parsed?.unmapped ?? [],
    reconciliationProblem: parsed?.reconciliationProblem ?? null,
    held: Array.isArray(parsed?.held) ? parsed.held : [],
    stop: parsed?.stop ?? null,
    savedAt: parsed?.savedAt ?? null,
  }
}

export function readRawState(dshHome, rootSessionId) {
  const file = storePath(dshHome, rootSessionId)
  const root = safeRoot(rootSessionId)
  if (!file) {
    return { state: emptyState(rootSessionId), file: null, present: false, problem: 'bad-root-session-id' }
  }
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    const missing = error?.code === 'ENOENT'
    return { state: emptyState(root), file, present: false, problem: missing ? null : (error?.code ?? String(error)) }
  }
  try {
    const parsed = JSON.parse(raw)
    // 未知版本不猜、不覆盖：把原因交出去，由调用方拒绝写入。
    if (parsed?.version !== AUTONOMY_VERSION) {
      return { state: emptyState(root), file, present: true, problem: `unsupported-version:${parsed?.version ?? 'none'}` }
    }
    if (safeRoot(parsed.rootSessionId) !== root) throw new Error('state-root-mismatch')
    if (!Array.isArray(parsed.projects)) throw new Error('projects-invalid')
    const state = migrateShape(parsed, root)
    state.savedAt = parsed.savedAt ?? null
    return { state, file, present: true, problem: null }
  } catch (error) {
    return { state: emptyState(root), file, present: true, problem: `parse-error:${error?.message ?? error}` }
  }
}

/**
 * 显式迁移：必须有旧文件自身的 root 归属，不能把第一位访问者当作所有者。
 * 坏文件、未知版本一律不动原文件，把 problem 带回去。
 */
export function migrateLegacy(dshHome, rootSessionId) {
  const target = storePath(dshHome, rootSessionId)
  const legacy = legacyStorePath(dshHome)
  if (!target || !existsSync(legacy)) return { migrated: false, problem: null }
  if (existsSync(target)) return { migrated: false, problem: null }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(legacy, 'utf8'))
  } catch (error) {
    return { migrated: false, problem: `legacy-parse-error:${error?.message ?? error}` }
  }
  if (parsed?.version !== 1 && parsed?.version !== AUTONOMY_VERSION) {
    return { migrated: false, problem: `legacy-unsupported-version:${parsed?.version ?? 'none'}` }
  }
  const root = safeRoot(rootSessionId)
  if (!root || safeRoot(parsed.rootSessionId) !== root) return { migrated: false, problem: 'legacy-owner-unverified' }
  try {
    const state = migrateShape(parsed, root)
    copyFileSync(legacy, `${legacy}.bak-${randomUUID()}`)
    writeState(dshHome, root, state)
    return { migrated: true, problem: null }
  } catch (error) {
    return { migrated: false, problem: `legacy-migrate-error:${error.message}` }
  }
}

export function readState(dshHome, rootSessionId) {
  const info = readRawState(dshHome, rootSessionId)
  // 查询永不触发迁移或落盘；旧文件待显式处理，不能被空状态覆盖。
  if (!info.present && !info.problem && existsSync(legacyStorePath(dshHome))) {
    return { ...info, problem: 'legacy-migration-required', migrated: false }
  }
  return { ...info, migrated: false }
}

export function writeState(dshHome, rootSessionId, state) {
  const file = storePath(dshHome, rootSessionId)
  if (!file) throw new Error('bad-root-session-id')
  if (safeRoot(state?.rootSessionId) !== safeRoot(rootSessionId)) throw new Error('state-root-mismatch')
  const current = readRawState(dshHome, rootSessionId)
  if (current.problem) throw new Error(current.problem)
  mkdirSync(dirname(file), { recursive: true })
  const payload = { ...state, version: AUTONOMY_VERSION, rootSessionId: safeRoot(rootSessionId), savedAt: new Date().toISOString() }
  const tmp = `${file}.tmp-${randomUUID()}`
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
  renameSync(tmp, file)
  return payload
}

export function currentProject(state) {
  const open = (state?.projects ?? []).filter((row) => row?.deliveredAt == null)
  return open.length > 0 ? open[open.length - 1] : null
}

export function openProject(state, input) {
  const objective = String(input?.objective ?? '').trim()
  if (!objective) throw new Error('objective-required')
  const acceptance = acceptanceRows(input?.acceptance)
  if (acceptance.length === 0) throw new Error('acceptance-required')
  const current = currentProject(state)
  if (current) {
    if (current.objective === objective && current.scope === String(input?.scope ?? '')
      && JSON.stringify(current.acceptance.map((row) => row.text)) === JSON.stringify(acceptance.map((row) => row.text))) return current
    throw new Error('project-already-open:先接续当前项目，不能覆盖未交付工作')
  }
  const project = {
    id: input?.id ? String(input.id) : `p${(state.projects?.length ?? 0) + 1}`,
    objective,
    acceptance,
    scope: input?.scope ? String(input.scope) : '',
    cwd: input?.cwd ?? null,
    cwdSource: input?.cwdSource ?? null,
    status: 'open',
    createdAt: new Date().toISOString(),
    tasks: [],
    questions: [],
    verifications: [],
    nextAction: input?.nextAction ? String(input.nextAction) : '',
    deliveredAt: null,
  }
  state.projects = [...(state.projects ?? []), project]
  return project
}

let stampSeq = 0

/** 时间戳要能区分同一毫秒内的两次写入，否则「产物变了旧复核失效」判不出来。 */
function stampNow() {
  stampSeq += 1
  return `${new Date().toISOString()}#${stampSeq}`
}

/**
 * 任务写入。任何字段变化都会换 artifactStamp —— 旧复核因此自动过期，不需要额外清理。
 */
export function upsertTask(project, input) {
  const id = String(input?.id ?? '').trim()
  if (!id) throw new Error('task-id-required')
  const tasks = project.tasks ?? []
  const existing = tasks.find((row) => row.id === id)
  const status = String(input?.status ?? existing?.status ?? 'pending')
  const allowed = ['pending', 'in_progress', 'verified', 'rework', 'blocked']
  if (!allowed.includes(status)) throw new Error(`task-status-invalid:${status}`)
  if (status === 'verified' && existing?.status !== 'verified') throw new Error('verify-required')
  const next = {
    id,
    title: String(input?.title ?? existing?.title ?? id),
    owner: String(input?.owner ?? existing?.owner ?? ''),
    status,
    dependsOn: asList(input?.dependsOn ?? existing?.dependsOn),
    artifacts: asList(input?.artifacts ?? existing?.artifacts),
    childSessionId: input?.childSessionId ?? existing?.childSessionId ?? null,
    ownerSessionId: input?.ownerSessionId === undefined ? (existing?.ownerSessionId ?? existing?.childSessionId ?? null) : input.ownerSessionId,
    boundAt: !existing || (input?.childSessionId && safeRoot(input.childSessionId) !== safeRoot(existing.childSessionId))
      ? new Date().toISOString() : (existing.boundAt ?? existing.at),
    blocker: input?.blocker === undefined ? (existing?.blocker ?? null) : (input.blocker ?? null),
    at: stampNow(),
  }
  const changed = !existing
    || existing.title !== next.title
    || existing.owner !== next.owner
    || existing.status !== next.status
    || JSON.stringify(existing.dependsOn ?? []) !== JSON.stringify(next.dependsOn)
    || JSON.stringify(existing.artifacts ?? []) !== JSON.stringify(next.artifacts)
    || (existing.childSessionId ?? null) !== next.childSessionId
    || JSON.stringify(existing.blocker ?? null) !== JSON.stringify(next.blocker)
  next.artifactStamp = changed ? stampNow() : (existing?.artifactStamp ?? stampNow())
  if (next.dependsOn.some((dep) => dep === id || !tasks.some((task) => task.id === dep))) throw new Error('task-dependency-invalid')
  const reaches = (dep, seen = new Set()) => {
    if (dep === id) return true
    if (seen.has(dep)) return false
    seen.add(dep)
    return (tasks.find((task) => task.id === dep)?.dependsOn ?? []).some((parent) => reaches(parent, seen))
  }
  if (next.dependsOn.some((dep) => reaches(dep))) throw new Error('task-dependency-cycle')
  if (!changed && existing?.verification) next.verification = existing.verification
  project.tasks = existing ? tasks.map((row) => (row.id === id ? { ...existing, ...next } : row)) : [...tasks, next]
  return project.tasks.find((row) => row.id === id)
}

/** 产物以文件内容为版本，不展开环境变量，也不把自然语言标识猜成路径。 */
export function refreshArtifacts(project) {
  for (const task of project.tasks ?? []) {
    const manifest = []
    const problems = []
    for (const input of task.artifacts ?? []) {
      let fd
      try {
        if (/%[^%]+%|\$\{|^~/.test(input)) throw new Error('路径含未展开变量')
        if (!isAbsolute(input) && !isAbsolute(project.cwd ?? '')) throw new Error('缺少项目实际工作目录')
        const path = isAbsolute(input) ? resolve(input) : resolve(project.cwd, input)
        fd = openSync(path, 'r')
        const before = fstatSync(fd, { bigint: true })
        if (!before.isFile()) throw new Error('产物必须是文件')
        const hash = createHash('sha256')
        const buffer = Buffer.allocUnsafe(1024 * 1024)
        for (let bytes; (bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, bytes))
        const after = fstatSync(fd, { bigint: true })
        const current = statSync(path, { bigint: true })
        if ([after, current].some((s) => s.size !== before.size || s.mtimeNs !== before.mtimeNs || s.ctimeNs !== before.ctimeNs || s.ino !== before.ino)) throw new Error('读取期间产物变化')
        manifest.push({ path, bytes: Number(after.size), sha256: hash.digest('hex') })
      } catch (error) {
        problems.push(`${input}：${error.code ?? error.message}`)
      } finally {
        if (fd !== undefined) closeSync(fd)
      }
    }
    if (manifest.length === 0 && problems.length === 0) problems.push('尚未登记文件产物或验证报告')
    task.artifactManifest = manifest
    task.artifactProblems = problems
    task.artifactStamp = `sha256:${createHash('sha256').update(JSON.stringify({
      id: task.id, title: task.title, owner: task.owner, ownerSessionId: task.ownerSessionId, childSessionId: task.childSessionId, dependsOn: task.dependsOn, artifacts: task.artifacts, manifest, problems,
    })).digest('hex')}`
    if (task.status === 'verified' && task.verification?.artifactStamp !== task.artifactStamp) task.status = 'rework'
  }
}

export function requestContinuation(project, reason, taskId = null) {
  project.continuation = { revision: stampNow(), reason, taskId }
}

export function openQuestions(project, taskId) {
  return (project?.questions ?? []).filter((row) => !row.answeredAt && (taskId === undefined || row.taskId === taskId))
}

export function addQuestion(project, input) {
  const question = String(input?.question ?? '').trim()
  if (!question) throw new Error('question-required')
  const taskId = input?.taskId ? String(input.taskId) : null
  if (taskId && !(project.tasks ?? []).some((task) => task.id === taskId)) throw new Error('unknown-task')
  // 同一任务同一问题的重复提问合并，不要攒成一堆。
  const duplicate = openQuestions(project).find((row) => row.taskId === taskId && row.question === question)
  if (duplicate) return duplicate
  const record = {
    id: `q${(project.questions?.length ?? 0) + 1}`,
    taskId,
    kind: input?.kind === 'env' ? 'env' : 'business',
    question,
    impact: String(input?.impact ?? ''),
    askedAt: stampNow(),
    answeredAt: null,
    answeredBy: null,
    answer: null,
  }
  project.questions = [...(project.questions ?? []), record]
  return record
}

export function answerQuestion(project, input) {
  const id = String(input?.questionId ?? '').trim()
  const answer = String(input?.answer ?? '').trim()
  if (!id) throw new Error('question-id-required')
  if (!answer) throw new Error('answer-required')
  const row = (project.questions ?? []).find((item) => item.id === id)
  if (!row) throw new Error('unknown-question')
  if (row.answeredAt) throw new Error('already-answered')
  row.answeredAt = stampNow()
  row.answeredBy = String(input?.answeredBy ?? 'user')
  row.answer = answer
  return row
}

export function recordVerification(project, input) {
  const id = String(input?.taskId ?? '').trim()
  const task = (project.tasks ?? []).find((row) => row.id === id)
  if (!task) throw new Error('unknown-task')
  const verdict = String(input?.verdict ?? '')
  if (verdict !== 'pass' && verdict !== 'fail') throw new Error(`verdict-invalid:${verdict || 'empty'}`)
  const reviewer = String(input?.reviewer ?? '').trim()
  if (!reviewer) throw new Error('reviewer-required')
  if (reviewer === task.owner) throw new Error('reviewer-cannot-be-owner')
  const reviewerSessionId = safeRoot(input?.reviewerSessionId)
  if (input?.source !== 'team-tool' || !reviewerSessionId || !input?.callId) throw new Error('reviewer-provenance-required')
  if (!safeRoot(task.ownerSessionId ?? task.childSessionId)) throw new Error('task-owner-session-required')
  if (reviewerSessionId === safeRoot(task.ownerSessionId ?? task.childSessionId)) throw new Error('reviewer-cannot-be-owner')
  const evidence = String(input?.evidence ?? '').trim()
  if (!evidence) throw new Error('evidence-required')
  const artifactStamp = String(input?.artifactStamp ?? '')
  if (!artifactStamp) throw new Error('artifact-stamp-required')
  if (artifactStamp !== task.artifactStamp) throw new Error(`stale-artifact-stamp:${artifactStamp}!=${task.artifactStamp}`)
  if (verdict === 'pass' && (task.artifactProblems?.length || !task.artifactManifest?.length)) throw new Error('artifacts-unavailable')
  const record = {
    taskId: id,
    reviewer,
    verdict,
    evidence,
    artifactStamp,
    reviewerSessionId,
    source: 'team-tool',
    callId: String(input.callId),
    // by 由调用方从真实 exec 身份填入：参数里伪造不了「是谁记的这条复核」。
    by: input?.by ? String(input.by) : null,
    at: stampNow(),
  }
  project.verifications = [...(project.verifications ?? []), record]
  task.verification = record
  task.status = verdict === 'pass' ? 'verified' : 'rework'
  requestContinuation(project, verdict === 'pass' ? '复核通过，继续集成验收' : '复核未通过，继续返工', id)
  return record
}

export function setStop(state, input) {
  state.stop = { at: stampNow(), reason: String(input?.reason ?? ''), by: String(input?.by ?? 'lead') }
  return state.stop
}

export function clearStop(state) {
  state.stop = null
}

export function stageOfTask(task, project) {
  if (!task) return { stage: STAGE.unknown, waitingOn: 'unknown' }
  if (project?.deliveredAt) return { stage: STAGE.delivered, waitingOn: 'none' }
  const questions = openQuestions(project).filter((row) => !row.taskId || row.taskId === task.id)
  if (questions.length) return { stage: questions.some((row) => row.kind === 'env') ? STAGE.blockedEnv : STAGE.needsUser, waitingOn: 'user' }
  if (task.blocker || task.status === 'blocked') return { stage: STAGE.blockedEnv, waitingOn: 'agent' }
  if (task.verification?.verdict === 'pass' && task.artifactStamp === task.verification.artifactStamp) {
    return { stage: STAGE.review, waitingOn: 'agent' }
  }
  if (task.verification?.verdict === 'fail') return { stage: STAGE.working, waitingOn: 'agent' }
  if ((task.dependsOn ?? []).some((id) => project.tasks.find((row) => row.id === id)?.status !== 'verified')) return { stage: STAGE.working, waitingOn: 'agent' }
  if (task.status === 'pending') return { stage: STAGE.queued, waitingOn: 'none' }
  if (task.status === 'in_progress') return { stage: STAGE.working, waitingOn: 'agent' }
  return { stage: STAGE.unknown, waitingOn: 'unknown' }
}

/** 问题只阻塞所属任务及其后继；未指定 taskId 才是项目级问题。 */
export function blockedTaskIds(project) {
  const tasks = project?.tasks ?? []
  const questions = openQuestions(project)
  const blocked = new Set(questions.some((row) => !row.taskId) ? tasks.map((task) => task.id) : questions.map((row) => row.taskId))
  for (const task of tasks) if (task.blocker || task.status === 'blocked') blocked.add(task.id)
  for (let changed = true; changed;) {
    changed = false
    for (const task of tasks) if (!blocked.has(task.id) && (task.dependsOn ?? []).some((id) => blocked.has(id))) {
      blocked.add(task.id)
      changed = true
    }
  }
  return blocked
}

/** 交付门禁：返回全部阻塞原因；空数组才允许 deliver。 */
export function deliverBlockers(project, state) {
  const out = []
  const tasks = project?.tasks ?? []
  const acceptance = project?.acceptance ?? []
  if (acceptance.length === 0) out.push('验收条件为空')
  for (const row of acceptance) {
    if (!String(row?.evidence ?? '').trim()) out.push(`验收条件缺证据：${row?.text ?? '?'}`)
  }
  if (tasks.length === 0) out.push('没有任何任务')
  for (const task of tasks) {
    // env 阻塞（缺环境/凭据）不该让整条项目永不可交付：如实交付并把这些任务列出来。
    if (task?.status === 'blocked' && task?.blocker?.kind === 'env') continue
    if (task.status !== 'verified') out.push(`任务 ${task.id} 未通过复核（${task.status}）`)
    const record = task.verification
    if (!record) out.push(`任务 ${task.id} 没有复核记录`)
    else if (record.verdict !== 'pass') out.push(`任务 ${task.id} 复核未通过`)
    else if (record.artifactStamp !== task.artifactStamp) out.push(`任务 ${task.id} 的复核早于当前产物`)
    else if (record.source !== 'team-tool' || !record.reviewerSessionId || !record.callId
      || !safeRoot(task.ownerSessionId ?? task.childSessionId)
      || record.reviewer === task.owner || safeRoot(record.reviewerSessionId) === safeRoot(task.ownerSessionId ?? task.childSessionId)
      || safeRoot(record.reviewerSessionId) === safeRoot(state?.rootSessionId)) out.push(`任务 ${task.id} 缺少独立复核来源`)
    if (!task.artifactManifest?.length || task.artifactProblems?.length) out.push(`任务 ${task.id} 产物不可核验`)
    if (task.blocker) out.push(`任务 ${task.id} 阻塞尚未解除`)
    if ((task.dependsOn ?? []).some((id) => !tasks.some((row) => row.id === id && row.status === 'verified'))) out.push(`任务 ${task.id} 依赖尚未验收`)
  }
  const open = openQuestions(project)
  if (open.length > 0) out.push(`还有 ${open.length} 个未回答问题`)
  const pending = Object.values(state?.deliveries ?? {}).filter((row) => (!row.projectId || row.projectId === project?.id)
    && ['pending', 'sending', 'failed', 'unknown', 'canceled'].includes(row?.status))
  if (pending.length > 0) out.push(`还有 ${pending.length} 条投递未完成`)
  return out
}

export function decideContinuation(input) {
  const { state, project, children, leadTurnIdle, taskOfChild } = input
  if (!project) return { deliver: false, reason: 'no-open-project' }
  if (state?.stop) return { deliver: false, reason: 'stopped' }
  if (!leadTurnIdle) return { deliver: false, reason: 'lead-busy' }
  if (openQuestions(project).some((row) => !row.taskId)) return { deliver: false, reason: 'needs-user' }
  const blocked = blockedTaskIds(project)
  const deliveries = state?.deliveries ?? {}
  const unmapped = []
  const now = input.now ?? Date.now()
  const ready = (key) => {
    const row = deliveries[key]
    return !row || (row.status === 'failed' && row.retryable === true && (row.attempts ?? 0) < 3 && (row.retryAt ?? 0) <= now)
  }
  for (const child of children ?? []) {
    if (!child?.id || !Number.isSafeInteger(child.lastSeq) || child.lastSeq < 0) continue
    // 只认 turn/end：session/end-seed 是生命周期起点，不能当完成证据。
    if (child.tailType !== 'turn/end') continue
    const key = deliveryKeyOf(state?.rootSessionId, child.id, child.lastSeq)
    const taskId = typeof taskOfChild === 'function' ? taskOfChild(child) : null
    if (!taskId) {
      unmapped.push({ key, childId: child.id, lastSeq: child.lastSeq })
      continue
    }
    const task = project.tasks.find((row) => row.id === taskId)
    if (blocked.has(taskId) || task?.status === 'verified') continue
    // 结果是「子会话最后一次 turn/end」。登记晚于结果时不能丢：先完成后补登记的情况真实存在，
    // 因此不跳过，而是标 lateBind 让 Lead 自己判断还相不相关（同 seq 只会投递一次）。
    const boundAt = Date.parse(String(task?.boundAt ?? task?.at ?? '').split('#')[0])
    const endedAt = eventTime(child.lastEventAt)
    const lateBind = Number.isFinite(boundAt) && (!Number.isFinite(endedAt) || endedAt < boundAt)
    if (!ready(key)) continue
    return {
      deliver: true,
      reason: child.endReason === 'completed' ? 'child-turn-end' : 'child-turn-interrupted',
      key,
      projectId: project.id,
      childId: child.id,
      childName: child.name ?? child.id,
      lastSeq: child.lastSeq,
      taskId,
      lateBind,
      tailType: child.tailType,
      endReason: child.endReason ?? 'unknown',
      unmapped,
    }
  }
  const continuation = project.continuation
  if (continuation && (!continuation.taskId || !blocked.has(continuation.taskId))
    && (project.tasks ?? []).some((task) => !blocked.has(task.id))) {
    const key = `${state.rootSessionId}:${project.id}:continue:${continuation.revision}`
    if (ready(key)) return { deliver: true, reason: 'project-continuation', key, projectId: project.id, taskId: continuation.taskId, unmapped }
  }
  return { deliver: false, reason: blocked.size ? 'tasks-blocked' : unmapped.length ? 'unmapped-child' : 'nothing-new', unmapped }
}

export function noteFor(input) {
  const { project, decision } = input
  const task = (project?.tasks ?? []).find((row) => row.id === decision.taskId)
  return [
    decision.childId
      ? `[codenow 自动接续] 子会话 ${decision.childName ?? decision.childId} 本轮已结束（seq ${decision.lastSeq}，reason ${decision.endReason ?? 'unknown'}）；这不是完成验收的证明。`
      : `[codenow 自动接续] ${project.continuation?.reason ?? '恢复项目检查点'}。`,
    decision.taskId ? `对应任务：${decision.taskId}${task?.title ? `（${task.title}）` : ''}` : '继续项目内部验收。',
    `当前目标：${project?.objective ?? ''}`,
    `检查点：${(project.tasks ?? []).map((row) => `${row.id}=${row.status}（${row.owner || '未分派'}）`).join('；')}`,
    `下一步：${project?.nextAction || '先核对该子任务的磁盘产物，再决定复核、返工还是集成'}`,
    '先读 codenow({action:"project",project:{op:"status"}}) 恢复产物、复核与待解决问题；不要重复已完成的副作用。常规分派、返工、集成自行继续；真缺业务信息或授权时集中提问，仍可推进不受影响的任务。',
  ].join('\n')
}

/** 投递恢复判据：只有这三种状态值得重试，且必须没跑满次数、退避已到期。 */
export function deliveryNeedsRetry(row, nowMs, opts = {}) {
  const max = opts.maxAttempts ?? 3
  const staleMs = opts.staleMs ?? 90_000
  if (!row?.messageId || !row?.key) return false
  const attempts = Number(row.attempts ?? 0)
  if (attempts >= max) return false
  if (row.status === 'sending') {
    const at = Date.parse(String(row.at ?? '').split('#')[0])
    return Number.isFinite(at) ? nowMs - at > staleMs : true
  }
  if (row.status === 'failed' || row.status === 'unknown') {
    const due = row.retryAt ? Date.parse(row.retryAt) : 0
    return !Number.isFinite(due) || due <= nowMs
  }
  return false
}

export function markDelivery(state, row, status, error) {
  const key = row?.key
  if (!key) return null
  const deliveries = { ...(state.deliveries ?? {}) }
  const prev = deliveries[key] ?? {}
  deliveries[key] = {
    ...prev,
    key,
    rootSessionId: state.rootSessionId ?? null,
    projectId: row.projectId ?? prev.projectId ?? null,
    childSessionId: row.childId ?? row.childSessionId ?? prev.childSessionId ?? null,
    lastEventSeq: row.lastSeq ?? row.lastEventSeq ?? prev.lastEventSeq ?? null,
    taskId: row.taskId ?? prev.taskId ?? null,
    messageId: row.messageId ?? prev.messageId ?? randomUUID(),
    origin: row.origin ?? prev.origin ?? 'codenow',
    attempts: (prev.attempts ?? 0) + (status === 'sending' ? 1 : 0),
    retryable: row.retryable ?? false,
    retryAt: status === 'sending' ? null : (row.retryAt ?? prev.retryAt ?? null),
    status,
    at: stampNow(),
    text: row.text ?? prev.text ?? null,
    error: error ? String(error) : null,
  }
  state.deliveries = deliveries
  return deliveries[key]
}

function eventTime(value) {
  return typeof value === 'number' ? value : Date.parse(value)
}

/** 按宿主持久 inbox splice 回放；领取不等于消费，取消不得自动重放。 */
export function deliveryReceipts(events) {
  const queues = { 'next-turn': [], 'next-step': [] }
  const messages = new Map()
  for (const event of events) {
    if (event.type === 'agent/inbox/spliced') {
      const splice = event.data
      const queue = queues[splice?.target]
      const count = splice?.removedCount ?? 0
      if (!queue || !Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > queue.length
        || !Number.isSafeInteger(count) || count < 0 || splice.start + count > queue.length || !Array.isArray(splice.inserted)) throw new Error('invalid-inbox-history')
      for (const row of queue.splice(splice.start, count, ...splice.inserted)) {
        const old = messages.get(row.id)
        messages.set(row.id, { ...old, status: splice.outcome === 'canceled' ? 'canceled' : 'claimed' })
      }
      for (const row of splice.inserted) {
        if (typeof row.id !== 'string') throw new Error('invalid-inbox-message-id')
        messages.set(row.id, { id: row.id, source: row.source, time: eventTime(event.time), status: 'sent' })
      }
    } else if (event.type === 'user/message' && typeof event.data?.id === 'string') {
      const row = event.data
      messages.set(row.id, { id: row.id, source: row.source, time: eventTime(event.time), status: 'consumed' })
    }
  }
  return messages
}

export function receiptForChild(receipts, child) {
  const ended = eventTime(child.lastEventAt)
  if (!Number.isFinite(ended)) return null
  return [...receipts.values()].find((row) => row.source?.kind === 'subagent-settled'
    && safeRoot(row.source.senderSessionId) === safeRoot(child.id) && row.time >= ended) ?? null
}

/** 只有完整、稳定的宿主日志能证明未入箱；不确定时保留 unknown。 */
export function reconcileDeliveries(state, receipts, now = Date.now()) {
  for (const row of Object.values(state.deliveries ?? {})) {
    if (row.status === 'consumed' || row.status === 'canceled') continue
    const receipt = row.messageId ? receipts?.get(row.messageId) : null
    if (receipt) {
      row.status = receipt.status === 'claimed' ? 'unknown' : receipt.status
      row.retryable = false
      row.error = receipt.status === 'claimed' ? '宿主已领取，尚无 user/message；不自动重放' : null
    } else if (['pending', 'sending', 'unknown', 'failed'].includes(row.status)) {
      row.retryable = receipts !== null && !!row.messageId
      row.status = row.retryable ? 'failed' : 'unknown'
      row.retryAt ??= now + 8000 * Math.min(8, 2 ** (row.attempts ?? 0))
      row.error = row.retryable ? '完整日志中无入箱证据，可有限重试' : '缺少可靠入箱证据，等待对账'
    }
  }
}

export function projectView(state, extra) {
  const project = currentProject(state) ?? state?.projects?.at(-1) ?? null
  const deliveries = Object.values(state?.deliveries ?? {}).filter((row) => !row.projectId || row.projectId === project?.id)
  const tasks = project?.tasks ?? []
  const stages = tasks.map((task) => ({ id: task.id, ...stageOfTask(task, project) }))
  return {
    version: AUTONOMY_VERSION,
    rootSessionId: state?.rootSessionId ?? null,
    present: extra?.present ?? false,
    problem: extra?.problem ?? null,
    stopped: state?.stop ?? null,
    reconciliationProblem: state?.reconciliationProblem ?? null,
    project: project
      ? {
          id: project.id,
          objective: project.objective,
          scope: project.scope,
          nextAction: project.nextAction,
          createdAt: project.createdAt,
          cwd: project.cwd ?? null,
    cwdSource: project.cwdSource ?? null,
          deliveredAt: project.deliveredAt,
          acceptance: project.acceptance ?? [],
          tasks,
          stages,
          questions: project.questions ?? [],
          openQuestions: openQuestions(project),
          verifications: project.verifications ?? [],
          deliverBlockers: project.deliveredAt ? [] : deliverBlockers(project, state),
        }
      : null,
    deliveries: {
      total: deliveries.length,
      byStatus: deliveries.reduce((acc, row) => ({ ...acc, [row.status ?? 'unknown']: (acc[row.status ?? 'unknown'] ?? 0) + 1 }), {}),
      unresolved: deliveries.filter((row) => ['failed', 'unknown', 'canceled'].includes(row.status)),
    },
    unmapped: state?.unmapped ?? [],
  }
}
