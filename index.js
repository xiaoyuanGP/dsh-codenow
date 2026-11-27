/**
 * dsh-codenow — 多角色 AI 协同工作台（Host half）。
 *
 * 把 Origin CodeNow 的组织法接进 dsh：19 个岗位模板（1 首席 + 18 专家），
 * 并把 dsh 自己已有的运行数据（会话、团队动作、各 agent 用量与缓存）
 * 汇总成一个只读视图 + 一个供 Lead 编排用的 `codenow` 工具。
 *
 * 会话与账本只读；项目状态、接续入箱、安装和隔离区管理各有明确写入边界。
 */
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  AUTONOMY_VERSION,
  addQuestion,
  answerQuestion,
  clearStop,
  currentProject,
  decideContinuation,
  deliveryNeedsRetry,
  deliveryReceipts,
  deliverBlockers,
  emptyState,
  legacyStorePath,
  markDelivery,
  migrateLegacy,
  noteFor,
  openProject,
  openQuestions,
  projectView,
  readState,
  receiptForChild,
  reconcileDeliveries,
  recordVerification,
  refreshArtifacts,
  requestContinuation,
  safeRoot,
  setStop,
  stageOfTask,
  storePath,
  upsertTask,
  writeState,
} from './lib/autonomy.js'
import { zstdDecompressSync } from 'node:zlib'

export const name = 'codenow'
export const inject = ['connection', 'webServer']

const HERE = dirname(fileURLToPath(import.meta.url))
const ROLES_DIR = join(HERE, 'assets', 'roles')
// 公共分析与实施规范：不是岗位，不进岗位列表，由 roleText 前置到每份岗位全文之前。
const COMMON_ROLE_FILE = join(ROLES_DIR, '_common.md')
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const RPC_PREFIX = '/codenow'
const ENDPOINT_PATTERN = /^[A-Za-z0-9_$.-]+$/
const ZSTD_MAGIC = 4247762216 // zstd 帧起始 0xFD2FB528，落盘即 28 B5 2F FD（小端）
const ZSTD_MAGIC_BYTES = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const HEAD_BYTES = 64 * 1024
const TAIL_BYTES = 64 * 1024
const BOOT_LOG = join(DSH_HOME, 'codenow-boot.log')
const TRASH_ROOT = join(DSH_HOME, 'codenow-trash')
// 隔离区保留期：搬进去的子会话目录在这里放 30 天，过期才真删（删除不可逆）。
const SWEEP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** 启动/加载诊断：宿主吞掉插件错误，写一份可读的落盘日志。 */
function trace(line) {
  try {
    appendFileSync(BOOT_LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // 日志写不进去也不能影响插件本身
  }
}

// 直接 `node index.js` 跑自检时不写这行：诊断日志只该记宿主的真实加载。
// invokedDirectly 是函数声明，会提升，这里可以直接用。
if (!invokedDirectly()) trace(`module evaluated from ${HERE}`)

/** 岗位 MD：取 frontmatter 标量 + can_handoff_to，正文原样保留。 */
function parseRole(file) {
  const raw = readFileSync(file, 'utf8')
  const split = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  const front = split ? split[1] : ''
  const body = split ? split[2] : raw
  const scalar = (key) => {
    const hit = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(front)
    return hit ? hit[1].trim() : ''
  }
  const list = (key) => {
    // 这些列表嵌在 collaboration: 之下，允许前导缩进。
    const hit = new RegExp(`^\\s*${key}:\\s*\\r?\\n((?:\\s+-\\s*.+\\r?\\n?)+)`, 'm').exec(front)
    return hit
      ? hit[1]
          .split(/\r?\n/)
          .map((line) => line.replace(/^\s*-\s*/, '').trim())
          .filter(Boolean)
      : []
  }
  return {
    id: scalar('role_id') || file.split(/[\\/]/).pop().replace(/\.md$/i, ''),
    displayName: scalar('display_name') || scalar('role_id'),
    level: scalar('level'),
    version: scalar('role_version'),
    summary: scalar('summary'),
    canHandoffTo: list('can_handoff_to'),
    canReceiveFrom: list('can_receive_from'),
    body: body.trim(),
    // 岗位全文读取原文件，保留 frontmatter 中的执行约束和交接契约。
    file,
  }
}

function listRoles() {
  if (!existsSync(ROLES_DIR)) return []
  return readdirSync(ROLES_DIR)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
    .sort()
    .map((f) => parseRole(join(ROLES_DIR, f)))
}

/**
 * 按 zstd 帧结构定位每一帧（与宿主 scanZstdFrames 同算法），不用 magic 搜索切帧：
 * 压缩块内部完全可能出现 28 B5 2F FD 字节序列，magic 搜索会把它误判成帧边界。
 * 帧结构 = magic + frameHeaderDescriptor + 变长帧头 + 若干 3 字节 blockHeader 数据块 + 可选 4 字节 checksum。
 * 尾部被追加写了半帧/损坏时返回已定位的完整帧 + torn 偏移，交给调用方按需处理。
 */
function zstdFrameRanges(buffer) {
  const ranges = []
  let offset = 0
  while (buffer.length - offset >= 4) {
    const start = offset
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return { ranges, torn: start }
    offset += 4
    if (offset >= buffer.length) return { ranges, torn: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) return { ranges, torn: start } // 保留位必须为 0
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const headerBytes = (singleSegment ? 0 : 1) + (dictionaryFlag === 3 ? 4 : dictionaryFlag) + contentSizeBytes
    if (buffer.length - offset < headerBytes) return { ranges, torn: start }
    offset += headerBytes
    for (;;) {
      if (buffer.length - offset < 3) return { ranges, torn: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      if (blockType === 3) return { ranges, torn: start } // 保留块类型
      const payloadBytes = blockType === 1 ? 1 : blockHeader >>> 3 // RLE 块只占 1 字节
      if (buffer.length - offset < payloadBytes) return { ranges, torn: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { ranges, torn: start }
      offset += 4
    }
    ranges.push({ start, end: offset })
  }
  // 循环只因「剩下的字节不够一个 magic」退出：剩余 1–3 字节是写了一半的帧头，必须报 torn，
  // 否则调用方会把「正在追加的文件」当成「已完整收尾的日志」。
  if (offset < buffer.length) return { ranges, torn: offset }
  return { ranges }
}

/**
 * 逐帧解压（宽松）：返回已解出的文本 + torn 偏移（undefined 表示整条都解开了）。
 * 头部/尾部只读一段的调用方用这个——那两处必然切在帧中间，属于正常现象。
 */
function decodeSessionFrames(buffer) {
  const { ranges, torn } = zstdFrameRanges(buffer)
  const frames = []
  for (const { start, end } of ranges) {
    try {
      frames.push(zstdDecompressSync(buffer.subarray(start, end)))
    } catch (error) {
      // 帧边界合法但解不开＝内容损坏：按 torn 上报，不静默少一段。
      return { text: Buffer.concat(frames).toString('utf8'), torn: start, reason: errorMessage(error) }
    }
  }
  return { text: Buffer.concat(frames).toString('utf8'), torn }
}

/** 会话日志是多帧 zstd 串联：逐帧解压后拼成 UTF-8 文本。整条读的调用方用这个（严格）。 */
function decodeSession(buffer) {
  const { text, torn, reason } = decodeSessionFrames(buffer)
  if (torn !== undefined) {
    throw new Error(`session 日志在字节 ${torn} 处断裂（已解出 ${text.length} 字符）${reason ? `：${reason}` : ''}`)
  }
  return text
}

/** 读文件 [from, from+bytes) 一段（绝不整文件读进来）：读不动返回 null。 */
function readWindow(file, from, bytes) {
  let fd
  try {
    fd = openSync(file, 'r')
    const want = Math.max(0, Math.min(bytes, statSync(file).size - from))
    const buffer = Buffer.allocUnsafe(want)
    const read = readSync(fd, buffer, 0, want, from)
    return buffer.subarray(0, read)
  } catch (error) {
    trace(`read window FAILED ${file}@${from}: ${errorMessage(error)}`)
    return null
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // 关不掉没有补救手段，进程退出会回收。
      }
    }
  }
}

/** 首事件（type==='session'）：头部切片必然落在帧中间，用宽松解码。 */
function parseFirstEvent(text) {
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line)
      return parsed?.type === 'session' ? parsed : {}
    } catch {
      return {}
    }
  }
  return {}
}

/** 只读文件头 64KB 解首帧：会话再大也不整文件读进来。 */
function readSessionHead(file) {
  const view = readWindow(file, 0, HEAD_BYTES)
  if (!view) return {}
  const first = zstdFrameRanges(view).ranges[0]
  if (first) {
    const text = decodeSessionFrames(view.subarray(first.start, first.end)).text
    // 首条完整记录通常独占首帧；跨帧或尚未写完时仍走原有窗口解码。
    if (text.trimStart().includes('\n')) return parseFirstEvent(text)
  }
  return parseFirstEvent(decodeSessionFrames(view).text)
}

/**
 * 子会话自身带的是 subagent/descriptor（subagent/catalog 记在父会话里）：
 * mode==='continuable' 说明宿主还能续跑它，回收必须放过。找不到返回 ''（未知）。
 */
function readSubagentMode(file) {
  const view = readWindow(file, 0, HEAD_BYTES)
  if (!view) return ''
  for (const line of decodeSessionFrames(view).text.split('\n')) {
    if (line.trim() === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue // 头部末行可能半截
    }
    const type = String(event?.type ?? '')
    if (type === 'subagent/descriptor' || type === 'subagent/catalog') return String(event?.data?.mode ?? '')
  }
  return ''
}

/**
 * 读文件尾部，返回最后一条事件（判断子会话是否「还在半路」）。
 * 多帧 zstd 只能从帧边界起解，尾部切片必然切在帧中间：从每个 magic 出现处试起，
 * 取第一条能一路解到文件末尾的链。尾部正在追加（半帧）时找不到合法链 → event=null，
 * 调用方按「未收尾」保守处理。
 */
function readSessionTail(file, bytes = TAIL_BYTES) {
  let size = 0
  try {
    size = statSync(file).size
  } catch (error) {
    trace(`session tail stat FAILED ${file}: ${errorMessage(error)}`)
    return { event: null, size: 0 }
  }
  const view = readWindow(file, Math.max(0, size - bytes), bytes)
  if (!view) return { event: null, size }
  for (let at = view.indexOf(ZSTD_MAGIC_BYTES); at !== -1; at = view.indexOf(ZSTD_MAGIC_BYTES, at + 1)) {
    const { text, torn } = decodeSessionFrames(view.subarray(at))
    if (torn !== undefined) continue // 这条起点接不到文件末尾
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i].trim() === '') continue
      try {
        return { event: JSON.parse(lines[i]), size }
      } catch {
        return { event: null, size } // 末行是半截，按未收尾处理
      }
    }
    return { event: null, size }
  }
  return { event: null, size }
}

/** 从窗口里挑「覆盖字节最多」的那条帧链：窗口起点几乎必然切在帧中间，试错很便宜（起点不对第一次解析就退出）。 */
function bestFrameChain(view) {
  let best = null
  let attempts = 0
  for (let at = view.indexOf(ZSTD_MAGIC_BYTES); at !== -1 && attempts < 64; at = view.indexOf(ZSTD_MAGIC_BYTES, at + 1)) {
    attempts += 1
    const { ranges, torn } = zstdFrameRanges(view.subarray(at))
    if (ranges.length === 0) continue
    const covered = ranges[ranges.length - 1].end
    if (!best || covered > best.covered) best = { at, ranges, covered, torn }
    if (torn === undefined) break // 帧链正好收在窗口末尾，不用再试
  }
  return best
}

/**
 * 从文件尾部往前解帧，攒够 needMessages 条消息就停（chat 首开专用）。
 * 一段窗口不够就继续往前扩（每段 maxBytes），最多扩到文件开头——
 * 所以一个文件只会解一遍，不存在「尾部解一遍、不够再整份解一遍」的双倍开销。
 * 返回 { events, complete }：events 按时间正序；complete 表示已解到文件开头，与全量解码等价。
 * beforeSeq 给「往更早翻页」用：seq >= beforeSeq 的消息（比游标新的）跳过且不计数，
 * 攒够就停，不会为了一个很老的游标把整份日志解一遍。
 * 读不动、帧解不开、尾部正在被追加（半帧）都返回 null，让调用方回落全量路径。
 */
function decodeSessionTail(file, needMessages, size, { maxBytes = CHAT_TAIL_MAX_BYTES, beforeSeq = null } = {}) {
  const events = [] // 倒序攒，出口再翻正
  let end = size
  let first = true
  for (;;) {
    const from = Math.max(0, end - maxBytes)
    const view = readWindow(file, from, end - from)
    if (!view) return null
    const chain = bestFrameChain(view)
    if (!chain) return null
    if (first && chain.torn !== undefined) {
      // 末尾有半帧＝宿主正在追加：按规格回落全量路径，不拿半截结果冒充完整。
      trace(`chat tail decode FAILED ${file}: 尾部字节 ${from + chain.torn} 处半帧`)
      return null
    }
    first = false
    for (let i = chain.ranges.length - 1; i >= 0; i -= 1) {
      let text
      try {
        const { start, end: stop } = chain.ranges[i]
        text = zstdDecompressSync(view.subarray(chain.at + start, chain.at + stop)).toString('utf8')
      } catch (error) {
        // 帧边界合法却解不开＝这段窗口不可信：整段作废，别拿半截结果冒充完整。
        trace(`chat tail decode FAILED ${file}@${from}: ${errorMessage(error)}`)
        return null
      }
      const lines = text.split('\n')
      for (let j = lines.length - 1; j >= 0; j -= 1) {
        if (lines[j].trim() === '') continue
        let event
        try {
          event = JSON.parse(lines[j])
        } catch {
          continue // 链条最前面那一帧可能接着上一帧的半行，按现有口径跳过
        }
        // 与 toMessages 同一口径，攒够的条数才算数。
        const message = messageOf(event)
        if (!message) continue
        // 游标：只要 seq 严格小于 before 的消息。
        if (beforeSeq !== null && !(Number(message.seq) < beforeSeq)) continue
        events.push(event)
      }
      // 一帧最多一条消息（实测最大会话 11,708 帧无一例外），+1 是给「一帧多条」留的余量。
      if (events.length >= needMessages + 1) return { events: events.reverse(), complete: false }
    }
    const nextEnd = from + chain.at
    if (nextEnd >= end) return null // 没往前推进：防御死循环
    if (nextEnd === 0) return { events: events.reverse(), complete: true }
    end = nextEnd
  }
}

const sessionCache = new Map()
// 缓存的是整份事件数组，大会话解压后上百 MB（实测最大会话解出 70 MB 文本）：
// 单条超 4M 字符直接不缓存，总量超 8M 字符淘汰最旧，条数上限沿用 4（一次请求最多同时要三条会话）。
const SESSION_CACHE_MAX_CHARS = 4_000_000
const SESSION_CACHE_TOTAL_CHARS = 8_000_000
const SESSION_CACHE_MAX_ENTRIES = 4

function readSessionEvents(file) {
  const stamp = statSync(file).mtimeMs
  const cached = sessionCache.get(file)
  if (cached && cached.stamp === stamp) return cached.events
  const text = decodeSession(readFileSync(file))
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // 半截行只可能出现在尾部追加，跳过即可。
    }
  }
  if (text.length > SESSION_CACHE_MAX_CHARS) {
    sessionCache.delete(file) // 这次变大到不该缓存了，别留着上次那份旧数组
    return events
  }
  sessionCache.set(file, { stamp, events, chars: text.length })
  let total = 0
  for (const entry of sessionCache.values()) total += entry.chars
  while (sessionCache.size > 1 && (sessionCache.size > SESSION_CACHE_MAX_ENTRIES || total > SESSION_CACHE_TOTAL_CHARS)) {
    const oldest = [...sessionCache.entries()].sort((a, b) => a[1].stamp - b[1].stamp)[0]
    if (!oldest) break
    sessionCache.delete(oldest[0])
    total -= oldest[1].chars
  }
  return events
}

// 结果级缓存：只留「已经算好的出口结果」，不再留事件数组。
// 大会话（最大 21.8 MB、解出 70.9M 字符）超出 SESSION_CACHE_MAX_CHARS 就永远进不了 sessionCache，
// 于是每次 chat/tasks 都要整份重解一遍（实测 577 / 617 ms）。这两张表把这笔重复开销摊平成一次。
// key = `${id}:${mtimeMs}:${size}`：文件一被追加 stamp 必变，旧条目自然不再命中。
const RESULT_CACHE_MAX_ENTRIES = 8
const recentCache = new Map()
const coordinationCache = new Map()

// 大文件 chat 首开走尾部解码：只回读最后一段帧，攒够条数就停。
// 4 MB 以下整解也就几十毫秒，没必要折腾；8 MB 是回读上限。
// 实测最大会话（21.8 MB）取最后 500 条消息只需回读到 4.1 MB，所以 8 MB 够用。
const CHAT_TAIL_MIN_BYTES = 4 * 1024 * 1024
const CHAT_TAIL_MAX_BYTES = 8 * 1024 * 1024

/** 一次 statSync 拿到 mtime+size 印迹（会话文件一被追加，stamp 就变）。 */
function stampOf(file) {
  const stat = statSync(file)
  return { stamp: `${stat.mtimeMs}:${stat.size}`, size: stat.size }
}

/** 命中即算「最近用过」（delete+set 重排插入序）；未命中返回 null。 */
function cacheGet(cache, key) {
  if (!cache.has(key)) return null
  const value = cache.get(key)
  cache.delete(key)
  cache.set(key, value)
  return value
}

/** 写入并按插入序淘汰最旧；两张结果缓存共用这个上限（各 8 条）。 */
function cachePut(cache, key, value) {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > RESULT_CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value)
}

/**
 * projcache 的文件名有两种并存写法：带 `session-` 前缀 与 裸 uuid（实测 84 / 80），入参两种形态都出现过。
 * 所以返回**两个候选**而不是归一成一个——只补前缀会让裸 uuid 命名的会话读不到标题（静默空标题）。
 */
function projectionCandidates(sessionId) {
  const raw = String(sessionId ?? '').trim()
  if (!raw) return []
  const bare = raw.startsWith('session-') ? raw.slice('session-'.length) : raw
  return [`session-${bare}`, bare]
}

const projectionCache = new Map()

/**
 * 标题与模型名同出一份 projcache 投影（模型名不在 rows.model 上，在 modelSelection / costUsage 里），
 * 一次读盘一次解析；按 mtime 判新旧，重复轮询（live 每 4s）不再重复解析几 MB JSON。
 */
/**
 * 投影结构从 v1 一路改到 v7，字段还可能继续变（rc.5 起按版本号演进）。
 * 这里只认两件事：先试 `record.rows.*.val`（v7+），再退回顶层同名字段（旧版），
 * 版本号本身不参与判断——只认形状，未来加版本也不会读不到标题。
 */
function projectionValue(raw) {
  const record = raw?.record ?? raw ?? {}
  const rows = record?.rows && typeof record.rows === 'object' ? record.rows : {}
  const pick = (...candidates) => {
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate !== '') return candidate
    }
    return ''
  }
  const title = pick(rows?.title?.val, rows?.title, record?.title)
  const model = pick(
    rows?.modelSelection?.val?.lastUsed?.model,
    rows?.modelSelection?.val?.model,
    rows?.model?.val,
    rows?.model,
    rows?.costUsage?.val?.model,
    record?.model,
  )
  return { title: String(title), model: String(model) }
}

/**
 * 宿主能力快照：rc 版本之间服务会改名/删方法，插件不能等崩了才发现。
 * 只读、无副作用；启动时打一行日志，也经 setup 端点暴露给面板。
 */
function hostCapabilities() {
  const teams = TEAM_CTX?.agentTeams
  const agents = TEAM_CTX?.agents
  const probe = []
  if (!TEAM_CTX) probe.push('team-services')
  if (typeof teams?.isEnabled !== 'function') probe.push('agentTeams.isEnabled')
  if (typeof agents?.list !== 'function') probe.push('agents.list')
  return {
    services: { teamCtx: Boolean(TEAM_CTX), webServer: true, tools: true, systemPrompt: true },
    teams: {
      isEnabled: typeof teams?.isEnabled === 'function',
      tryMembership: typeof teams?.tryMembership === 'function',
      listMembers: typeof teams?.listMembers === 'function',
      createTask: typeof teams?.createTask === 'function',
    },
    agents: { list: typeof agents?.list === 'function' },
    missing: probe,
  }
}

function readProjection(sessionId) {
  const candidates = projectionCandidates(sessionId)
  if (candidates.length === 0) return { title: '', model: '' }
  let file = ''
  let stamp = ''
  for (const name of candidates) {
    const candidate = join(DSH_HOME, 'storages', 'session_projcache', 'sessions', `${name}.json`)
    try {
      const info = statSync(candidate)
      file = candidate
      // Windows 的文件时间刻度实测约 6ms，同一刻度内改写标题 mtimeMs 不变，
      // 只比 mtime 会把新标题永久吞掉，所以 stamp 必须带上 size。
      stamp = `${info.mtimeMs}:${info.size}`
      break
    } catch {
      // 这个命名不存在，试下一个
    }
  }
  if (!file) return { title: '', model: '' } // 投影还没生成
  const cacheKey = candidates[1] // 裸 uuid 作缓存键，两种入参命中同一条
  const cached = projectionCache.get(cacheKey)
  if (cached && cached.stamp === stamp) return cached.value
  let value = { title: '', model: '' }
  try {
    // 版本无关：只认形状（rows.*.val 优先，旧版顶层字段兜底）
    value = projectionValue(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    // 半写/损坏：按「无标题无模型」返回，UI 会显示为空。
  }
  projectionCache.set(cacheKey, { stamp, value })
  // 用「删最旧一条」而不是 clear()：会话数与上限接近时，clear() 会在每次新增 key 时
  // 把整个缓存清空再全量重解析（实测 64 个 projcache 重解析 185ms），退化成每次都冷启动。
  if (projectionCache.size > 96) projectionCache.delete(projectionCache.keys().next().value)
  return value
}

/**
 * 子会话的岗位名在**父会话**投影里（subagentCatalog.label），子会话自己是 subagent/descriptor。
 * 只解一份 JSON 的一部分，按 stamp 缓存，别为了一次取名把几 MB 投影反复解析。
 */
const catalogCache = new Map()

function readSubagentLabel(rootId, childId) {
  const root = normalizeSessionId(rootId)
  const child = normalizeSessionId(childId)
  if (!root || !child) return ''
  for (const name of projectionCandidates(root)) {
    const file = join(DSH_HOME, 'storages', 'session_projcache', 'sessions', `${name}.json`)
    let stamp = ''
    try {
      const info = statSync(file)
      stamp = `${info.mtimeMs}:${info.size}`
      const cached = catalogCache.get(root)
      if (cached && cached.stamp === stamp) return cached.labels.get(child) ?? ''
      const rows = JSON.parse(readFileSync(file, 'utf8'))?.record?.rows ?? {}
      const values = rows?.subagentCatalog?.val?.head?.values ?? []
      const labels = new Map()
      for (const row of Array.isArray(values) ? values : []) {
        const id = normalizeSessionId(row?.childId)
        if (id && row?.label) labels.set(id, String(row.label))
      }
      catalogCache.set(root, { stamp, labels })
      if (catalogCache.size > 64) catalogCache.delete(catalogCache.keys().next().value)
      return labels.get(child) ?? ''
    } catch {
      // 这个命名不存在，试下一个
    }
  }
  return ''
}

/**
 * 团队身份：新宿主的 Team 成员就是 subagent，`agentTeams.membership/tryMembership/listMembers`
 * 已整体移除（服务只剩 isEnabled/createTask/getTask/listTasks/updateTask），所以身份改由磁盘判据得出：
 * 会话 header 有 parentSession = teammate（名字取父会话投影里的 subagentCatalog.label），没有 = lead。
 * 旧宿主仍先试 tryMembership，取到就用 —— 两代宿主同一份代码都能跑。
 */
const memberCache = new Map()
const MEMBER_TTL_MS = 5000

// 团队协作开关读投影里的 agentTeam 行；只有开关被显式写过才有布尔值。
const teamModeCache = new Map()

function readTeamEnabled(rootId) {
  const root = normalizeSessionId(rootId)
  if (!root) return null
  for (const name of projectionCandidates(root)) {
    const file = join(DSH_HOME, 'storages', 'session_projcache', 'sessions', `${name}.json`)
    try {
      const info = statSync(file)
      const stamp = `${info.mtimeMs}:${info.size}`
      const cached = teamModeCache.get(root)
      if (cached && cached.stamp === stamp) return cached.enabled
      const rows = JSON.parse(readFileSync(file, 'utf8'))?.record?.rows ?? {}
      const value = rows?.agentTeam?.val?.enabled
      const enabled = typeof value === 'boolean' ? value : null
      teamModeCache.set(root, { stamp, enabled })
      if (teamModeCache.size > 128) teamModeCache.delete(teamModeCache.keys().next().value)
      return enabled
    } catch {
      // 这个命名不存在，试下一个
    }
  }
  return null
}

/**
 * 团队协作开关的真实取值：宿主服务优先（同步），退回投影，两边都读不到就算关闭。
 * 读不到时按关闭处理——宁可少强制，也不要凭猜测要求模型必须派活。
 */
function teamModeEnabled(agent) {
  try {
    const value = TEAM_CTX?.agentTeams?.isEnabled?.(agent)
    if (typeof value === 'boolean') return { enabled: value, source: 'service' }
  } catch {
    // 旧宿主没有 isEnabled，或传进来的不是活 agent
  }
  const sessionId = normalizeSessionId(agent?.session?.id ?? agent?.sessionId ?? agent?.id ?? '')
  const flagged = sessionId ? readTeamEnabled(rootOf(sessionId) || sessionId) : null
  if (typeof flagged === 'boolean') return { enabled: flagged, source: 'projection' }
  return { enabled: false, source: 'unknown' }
}

function memberOfAgent(agent) {
  const sessionId = rootOf(agent?.session?.id ?? agent?.sessionId ?? agent?.id ?? '')
  if (!sessionId) return null
  const fresh = memberCache.get(sessionId)
  if (fresh && Date.now() - fresh.at < MEMBER_TTL_MS) return fresh.value
  let value = null
  try {
    const legacy = TEAM_CTX?.agentTeams?.tryMembership?.(agent)
    if (legacy?.role) {
      value = {
        role: String(legacy.role),
        name: String(legacy.name ?? ''),
        rootSessionId: rootOf(legacy.root?.id) || sessionId,
        source: 'membership',
        agent,
      }
    }
  } catch {
    value = null
  }
  if (!value) {
    const row = findSession(sessionId)
    let parent = rootOf(agent?.session?.header?.parentSession ?? '')
    if (!parent && row?.file) {
      try {
        parent = rootOf(readSessionHead(row.file)?.parentSession ?? '')
      } catch {
        parent = ''
      }
    }
    if (parent) {
      value = { role: 'teammate', name: readSubagentLabel(parent, sessionId), rootSessionId: parent, source: 'disk', agent }
    } else if (row) {
      value = { role: 'lead', name: 'lead', rootSessionId: sessionId, source: 'disk', agent }
    } else {
      // 磁盘上根本没有这个会话，也没有 membership 记录：身份未知，不猜成 lead（否则陌生人拿 Lead 权限）。
      value = null
    }
  }
  memberCache.set(sessionId, { at: Date.now(), value })
  if (memberCache.size > 128) memberCache.delete(memberCache.keys().next().value)
  return value
}

/** 某个父会话名下、确实挂在它下面的子会话记录（替代已移除的 listMembers）。 */
function memberRecordOf(rootSessionId, childSessionId) {
  const child = rootOf(childSessionId)
  if (!child) return null
  const row = findSession(child)
  if (!row?.file) return null
  let parent = ''
  try {
    parent = rootOf(readSessionHead(row.file)?.parentSession ?? '')
  } catch {
    return null
  }
  if (parent !== rootOf(rootSessionId)) return null
  return { id: child, name: readSubagentLabel(rootSessionId, child), role: 'teammate' }
}

/**
 * 一个会话目录里可能同时躺着多代日志（真实磁盘：59 个只有 v4、22 个只有 v3、9 个并存），
 * 事件结构完全同构，取**最大分代**那份 —— 只认 v4 会漏掉 22 个会话（68 → 90）。
 * 返回 { file, generation }；目录里没有任何日志返回 null。
 */
function sessionLogOf(dir) {
  let entries = []
  try {
    entries = readdirSync(dir)
  } catch {
    return null
  }
  let best = null
  for (const name of entries) {
    const hit = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/.exec(name)
    if (!hit) continue
    const generation = hit[1] === undefined ? 1 : Number(hit[1])
    if (!best || generation > best.generation) best = { file: join(dir, name), generation }
  }
  return best
}

/** 分代标签（`v4` / `v3`）：前端要能看出这条是第几代日志。 */
const formatOf = (generation) => `v${generation}`

/** 会话元数据不读标题（listSessions 与 findSession 共用）；文件中途消失返回 null。 */
function sessionRowOf(workspace, dirName, log) {
  const file = log.file
  try {
    const stat = statSync(file)
    const head = readSessionHead(file)
    const id = String(head.id || dirName)
    return {
      id,
      workspace,
      cwd: String(head.cwd || ''),
      parentSession: head.parentSession ? String(head.parentSession) : null,
      preset: String(head.agentPreset || ''),
      createdAt: Number(head.createdAt) || 0,
      updatedAt: stat.mtimeMs,
      bytes: stat.size,
      format: formatOf(log.generation),
      file,
    }
  } catch (error) {
    trace(`session row FAILED ${file}: ${errorMessage(error)}`)
    return null
  }
}

function listSessions() {
  const root = join(DSH_HOME, 'sessions')
  const out = []
  let workspaces = []
  try {
    workspaces = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return out
  }
  for (const workspace of workspaces) {
    let entries = []
    try {
      entries = readdirSync(join(root, workspace), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      continue
    }
    for (const dirName of entries) {
      const log = sessionLogOf(join(root, workspace, dirName))
      if (!log) continue
      const row = sessionRowOf(workspace, dirName, log)
      if (row) out.push(row)
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

const EMPTY_USAGE = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0, cost: 0 })

const TREND_DAYS = 30

/** 账本日期键 `YYYY-MM-DD` → 当天 0 点毫秒（只用来自增日期，不参与时区换算）。 */
function dayKeyMs(key) {
  const hit = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key))
  if (!hit) return null
  const ms = Date.UTC(Number(hit[1]), Number(hit[2]) - 1, Number(hit[3]))
  return Number.isNaN(ms) ? null : ms
}

/** 本地日期键 `YYYY-MM-DD`：trend 的锚点必须是「用户眼里的今天」。 */
function localDayKey(now = Date.now()) {
  const at = new Date(now)
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
}

/**
 * 自然日窗口：以**本地今天**为锚往回数 30 个自然日，缺的那天标 missing:true。
 * 锚点不能用「账本里最新一天」—— 停用几天后折线右端会停在旧日子，看着像今天也在用；
 * 也不能只排出账本里存在的日期，那样断层看不出来（折线直接连过去）。
 */
function trendWindow(trend, days = TREND_DAYS, now = Date.now()) {
  const byDate = new Map(trend.map((day) => [day.date, day]))
  const anchorMs = dayKeyMs(localDayKey(now))
  if (anchorMs === null) return []
  const out = []
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(anchorMs - i * 86400000).toISOString().slice(0, 10)
    out.push(byDate.get(date) ?? { date, missing: true, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, cost: 0 })
  }
  return out
}

/** 账本 byProviderModel 的 key 是 `provider:model`，模型名自身可能带冒号 → 只按第一个冒号切。 */
function providerModelOf(key) {
  const at = key.indexOf(':')
  return at === -1 ? { provider: key, model: '' } : { provider: key.slice(0, at), model: key.slice(at + 1) }
}

/** 用量与缓存：直接复用 dsh-cost-meter 的账本，不自己数 token。 */
function readUsage() {
  const file = join(DSH_HOME, 'storages', 'cost-meter', 'ledger.json')
  const perSession = new Map()
  const byProviderModel = new Map()
  const trend = []
  const totals = EMPTY_USAGE()
  let totalsCostCny
  let ledgerFound = false
  let currency = 'USD'
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    ledgerFound = true
    currency = String(parsed?.config?.currency ?? 'USD') || 'USD'
    for (const [date, day] of Object.entries(parsed?.days ?? {})) {
      trend.push({
        date,
        input: Number(day?.input) || 0,
        output: Number(day?.output) || 0,
        cacheRead: Number(day?.cacheRead) || 0,
        cacheWrite: Number(day?.cacheWrite) || 0,
        calls: Number(day?.calls) || 0,
        cost: Number(day?.cost) || 0,
      })
      for (const key of Object.keys(totals)) {
        if (key === 'cost') totals.cost += Number(day?.cost) || 0
        else totals[key] += Number(day?.[key]) || 0
      }
      // costCny 只在账本真给了数值时才算：没见到就保持 undefined（序列化时字段消失），
      // 不能填 0 —— 有些 provider 只有 cost 没有 costCny，填 0 会把「花过钱」显示成 0.0000 CNY。
      if (typeof day?.costCny === 'number' && Number.isFinite(day.costCny)) totalsCostCny = (totalsCostCny ?? 0) + day.costCny
      for (const session of Array.isArray(day?.sessions) ? day.sessions : []) {
        const id = String(session?.id ?? '')
        if (!id) continue
        const acc = perSession.get(id) ?? { ...EMPTY_USAGE(), lastAt: 0, days: 0, cnyDays: 0 }
        for (const key of Object.keys(EMPTY_USAGE())) acc[key] += Number(session?.[key]) || 0
        acc.lastAt = Math.max(acc.lastAt, Number(session?.at) || 0)
        // 会话的 costCny 要「所有贡献它的日记录都带数值」才敢给（见循环后的收尾）：
        // 半截账本凑出来的金额比没有更危险，宁可让前端退回 cost。
        acc.days += 1
        if (typeof session?.costCny === 'number' && Number.isFinite(session.costCny)) {
          acc.costCny = (acc.costCny ?? 0) + session.costCny
          acc.cnyDays += 1
        }
        perSession.set(id, acc)
      }
      // 天级 byProviderModel 只按天累加：session 级里也有同名字段，再叠一次会把用量翻倍。
      // cost 是账本原币种（USD）；costCny 只在账本给了数值时透传累加，没给就不输出该字段。
      for (const [key, model] of Object.entries(day?.byProviderModel ?? {})) {
        const acc = byProviderModel.get(key) ?? { key, ...providerModelOf(key), ...EMPTY_USAGE() }
        for (const field of Object.keys(EMPTY_USAGE())) acc[field] += Number(model?.[field]) || 0
        if (typeof model?.costCny === 'number' && Number.isFinite(model.costCny)) acc.costCny = (acc.costCny ?? 0) + model.costCny
        byProviderModel.set(key, acc)
      }
    }
  } catch {
    // 账本缺失：返回空数据并标记，UI 会如实说明。
  }
  trend.sort((a, b) => a.date.localeCompare(b.date))
  // 收尾 perSession：只有「每个贡献它的日记录都带有限 costCny」才把 costCny 留在行里，
  // 顺手删掉两个内部计数器（不能让它们漏进出参）。
  for (const acc of perSession.values()) {
    const complete = acc.days > 0 && acc.cnyDays === acc.days
    delete acc.days
    delete acc.cnyDays
    if (!complete) delete acc.costCny
  }
  // totals 是**全量**（账本所有天），不是 trend 的 30 天窗口：两者口径不同，别混。
  if (totalsCostCny !== undefined) totals.costCny = totalsCostCny
  return {
    ledgerFound,
    currency,
    perSession,
    trend: trendWindow(trend, TREND_DAYS),
    totals,
    byProviderModel: [...byProviderModel.values()].sort((a, b) => b.cost - a.cost),
  }
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * 一条事件能变成哪条群聊消息（不能变返回 null）。
 * toMessages 与尾部解码共用这一份判定：两条路径的出口必须逐字节一致，口径不能各写一份。
 */
function messageOf(event) {
  if (event?.type === 'user/message') {
    // 只有真人输入（kind=user）进群聊；其余是 dsh 注入的指令/上下文/技能目录。
    if (event.data?.source?.kind !== 'user') return null
    // 用户消息的 content 直接在 data 上，assistant 的包在 data.message 里。
    const text = textOf(event.data?.content ?? event.data?.message?.content)
    return text === '' ? null : { seq: event.seq, time: event.time, role: 'user', text }
  }
  if (event?.type === 'assistant/message') {
    const text = textOf(event.data?.message?.content)
    if (text === '') return null
    return {
      seq: event.seq,
      time: event.time,
      role: 'assistant',
      text,
      model: String(event.data?.message?.source?.model ?? ''),
      provider: String(event.data?.message?.source?.provider ?? ''),
    }
  }
  return null
}

/** 群聊：会话日志里的 user / assistant 可见文本，reasoning 不展示。 */
function toMessages(events, limit) {
  const messages = []
  for (const event of events) {
    const message = messageOf(event)
    if (message) messages.push(message)
  }
  return limit > 0 ? messages.slice(-limit) : messages
}

const COORDINATION_TOOLS = /^(team_task_create|team_task_get|team_task_update|team_task_list|spawn_teammate|subagent|subagent_fork|send_message|wait_agent|interrupt_agent|list_agents)$/

/**
 * 任务「现在卡在谁身上」。只吃结构化字段：宿主 `team/task` 的 status / blockedBy / 事件时间，
 * 外加全局活跃成员数——**不碰消息文本**，签名也只有 (task, ctx) 两个参数。
 * 宿主不给「等人回答」「投递失败」这两个信号，那两种如实返回 unknown，不猜。
 */
function taskStageOf(task, ctx) {
  const status = String(task?.status ?? '')
  const blocked = Array.isArray(task?.blockedBy) && task.blockedBy.length > 0
  const liveCount = ctx?.liveCount ?? null
  const stallMs = Number(ctx?.stallMs ?? 0)
  const now = Number(ctx?.now ?? Date.now())
  const at = Number(task?.at ?? 0)
  if (status === 'completed') return { stage: 'review', waitingOn: 'person' }
  if (blocked) return { stage: 'blocked', waitingOn: 'agent' }
  if (status === 'pending') return { stage: 'queued', waitingOn: 'none' }
  if (status === 'in_progress') {
    // liveCount 为 null 表示 registry 拿不到：这种情况下不判停摆，宁可 working。
    const stalled = liveCount === 0 && stallMs > 0 && at > 0 && now - at > stallMs
    if (stalled) return { stage: 'stalled', waitingOn: 'unknown' }
    return { stage: 'working', waitingOn: 'agent' }
  }
  return { stage: 'unknown', waitingOn: 'unknown' }
}

/** 把 stage 叠到任务行上。stage 与时间、活跃成员数有关，所以不进协调缓存，每次请求现算。 */
function tasksWithStage(value, ctx) {
  const tasks = Array.isArray(value?.tasks) ? value.tasks : []
  return { ...value, tasks: tasks.map((task) => ({ ...task, ...taskStageOf(task, ctx) })) }
}

/** 停摆判定要用的全局事实：活跃成员数（拿不到就是 null）、当前时间、静默窗口。 */
function stageContext() {
  const liveIds = listLiveIds()
  return { liveCount: liveIds ? liveIds.size : null, now: Date.now(), stallMs: STALL_MS }
}

/**
 * 任务：dsh 的任务板不在磁盘上，按会话日志里的团队动作如实重建。
 * `team/task` 是权威快照（带 status / revision，同一 task 会多次出现，取最大 revision），
 * 有它就以它为准；早期会话没有该事件时才退回用 `team_task_create` 的入参推断——推断出来的没有状态。
 */
function toCoordination(events) {
  const taskBoard = new Map()
  const inferred = []
  const actions = []
  const teammates = new Map()
  let todos = []
  for (const event of events) {
    if (event?.type === 'todo/write') {
      if (Array.isArray(event.data?.todos)) {
        todos = event.data.todos.map((todo) => ({
          content: String(todo?.content ?? ''),
          status: String(todo?.status ?? ''),
        }))
      }
      continue
    }
    if (event?.type === 'team/task') {
      const task = event.data?.task
      const id = String(task?.id ?? '')
      if (id) {
        const revision = Number(task?.revision ?? 0)
        const prev = taskBoard.get(id)
        if (!prev || revision >= prev.revision) {
          taskBoard.set(id, {
            id,
            revision,
            subject: String(task?.subject ?? '(未命名任务)'),
            description: String(task?.description ?? ''),
            status: String(task?.status ?? ''),
            blockedBy: Array.isArray(task?.blockedBy) ? task.blockedBy.map(String) : [],
            at: event.time,
            seq: event.seq,
          })
        }
      }
      continue
    }
    if (event?.type === 'team/member') {
      const member = event.data?.member
      const name = String(member?.name ?? '')
      if (name) {
        const prev = teammates.get(name)
        teammates.set(name, {
          name,
          description: String(member?.description ?? prev?.description ?? ''),
          phase: String(member?.phase ?? prev?.phase ?? ''),
          at: event.time,
        })
      }
      continue
    }
    if (event?.type !== 'tool/call') continue
    const toolName = String(event.data?.name ?? '')
    if (!COORDINATION_TOOLS.test(toolName)) continue
    let args = {}
    try {
      args = JSON.parse(String(event.data?.arguments ?? '{}'))
    } catch {
      args = {}
    }
    const action = {
      seq: event.seq,
      time: event.time,
      name: toolName,
      target: String(args.target ?? args.task_id ?? args.name ?? ''),
      summary: String(args.subject ?? args.description ?? args.message ?? '').slice(0, 240),
    }
    actions.push(action)
    if (toolName === 'spawn_teammate' || toolName === 'subagent' || toolName === 'subagent_fork') {
      const name = String(args.name ?? '')
      if (name && !teammates.has(name)) {
        teammates.set(name, { name, description: String(args.description ?? ''), phase: '', at: event.time })
      }
    }
    if (toolName === 'team_task_create') {
      inferred.push({
        id: '',
        revision: 0,
        subject: String(args.subject ?? '(未命名任务)'),
        description: String(args.description ?? ''),
        status: '',
        blockedBy: Array.isArray(args.blocked_by) ? args.blocked_by.map(String) : [],
        at: event.time,
        seq: event.seq,
      })
    }
  }
  return {
    // 宿主会保留已删除的任务（status='deleted'），它们不该占着任务板的位置。
    // inferred 兜底来自工具调用记录，status 为空，一律保留。
    tasks: (taskBoard.size > 0 ? [...taskBoard.values()] : inferred).filter((task) => String(task?.status ?? '') !== 'deleted'),
    actions: actions.slice(-60),
    teammates: [...teammates.values()],
    todos,
  }
}

/** 会话 id 在不同层可能带 `session-` 前缀，比较前统一去掉，避免因前缀差异串会话或漏匹配。 */
function normalizeSessionId(value) {
  return String(value ?? '').trim().replace(/^session-/, '')
}

function findSession(sessionId) {
  const target = normalizeSessionId(sessionId)
  if (target === '') return null
  // 快路径只拼安全字符：id 直接进路径，禁止客户端用 `..` 之类穿出去（怪 id 退回全扫，不报错）。
  if (/^[A-Za-z0-9_-]{1,128}$/.test(target)) {
    const root = join(DSH_HOME, 'sessions')
    let workspaces = []
    try {
      workspaces = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      workspaces = []
    }
    // 目录名就是 id（带或不带 `session-` 前缀），每工作区两次 stat 就命中，
    // 不用整盘 listSessions，避免为一次定位读取所有会话头部。
    for (const workspace of workspaces) {
      for (const dirName of [target, `session-${target}`]) {
        const log = sessionLogOf(join(root, workspace, dirName))
        if (!log) continue
        const row = sessionRowOf(workspace, dirName, log)
        // 目录名和首事件里的 id 都要对得上，否则宁可全扫也不串会话。
        if (row && normalizeSessionId(row.id) === target) return row
      }
    }
  }
  // 只回放扫描到的文件，不接受客户端传路径。
  return listSessions().find((session) => normalizeSessionId(session.id) === target) ?? null
}

/** 会话行：筛选、分页后才读取标题，避免扫描时解析不在当前页的投影。 */
function sessionRow(usage) {
  return (session) => ({
    id: session.id,
    title: readProjection(session.id).title,
    cwd: session.cwd,
    parentSession: session.parentSession,
    preset: session.preset,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    bytes: session.bytes,
    format: session.format,
    usage: usage.perSession.get(session.id) ?? null,
  })
}

function statePayload(rootSessionId) {
  const sessions = listSessions()
  const usage = readUsage()
  // 岗位只给元数据：正文（body）有 10+ KB、file 是绝对路径，都没必要进 state，取全文走 codenow 工具。
  const roles = listRoles().map(({ body, file, ...rest }) => rest)
  return {
    home: DSH_HOME,
    ledgerFound: usage.ledgerFound,
    currency: usage.currency,
    roles,
    totals: usage.totals,
    trend: usage.trend.slice(-TREND_DAYS),
    sessionsTotal: sessions.length,
    byProviderModel: usage.byProviderModel,
    sessions: sessions.slice(0, 40).map(sessionRow(usage)),
    // 新增（兼容：原有字段一个没动）：项目级自主状态，面板据此区分内部处理与需要用户。
    autonomy: (() => {
      const info = readProjectState(resolveRootSession(rootSessionId))
      return projectView(info.state, { problem: info.problem, present: info.present })
    })(),
  }
}

const SESSIONS_LIMIT_DEFAULT = 40
const SESSIONS_LIMIT_MAX = 200

/**
 * 会话分页（state.sessions 只有前 40 条）：q 匹配 id/title/cwd/preset，大小写不敏感子串。
 * 元数据只扫一次；标题仅在搜索或返回当前页时读取。
 */
function sessionsPayload(payload) {
  const usage = readUsage()
  let all = listSessions()
  // withUsage：只留账本里有用量记录的会话。total 必须是**过滤后**的总数，
  // 否则前端按 total 算出来的页数会包含实际不存在的页。
  if (payload?.withUsage === true) all = all.filter((session) => usage.perSession.has(session.id))
  const rawOffset = Number(payload?.offset)
  const offset = Number.isInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0
  const rawLimit = Number(payload?.limit)
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, SESSIONS_LIMIT_MAX) : SESSIONS_LIMIT_DEFAULT
  const needle = String(payload?.q ?? '').trim().toLowerCase()
  const matched =
    needle === ''
      ? all
      : all.filter((session) =>
          [session.id, session.cwd, session.preset].some((value) => String(value ?? '').toLowerCase().includes(needle)) ||
          readProjection(session.id).title.toLowerCase().includes(needle),
        )
  return { total: matched.length, offset, limit, items: matched.slice(offset, offset + limit).map(sessionRow(usage)) }
}

// 公共规范按 mtime+size 缓存：同一进程内多次派工只解析一次，文件被改后自动失效。
let commonRoleCache = { stamp: '', text: '' }

/** 读 _common.md。缺失或读不动时降级为空串——岗位原文照发，不因公共规范挡住派工。 */
function commonRoleText() {
  let info
  try {
    info = statSync(COMMON_ROLE_FILE)
  } catch {
    return ''
  }
  const stamp = `${info.mtimeMs}:${info.size}`
  if (commonRoleCache.stamp === stamp) return commonRoleCache.text
  try {
    const text = readFileSync(COMMON_ROLE_FILE, 'utf8').trim()
    commonRoleCache = { stamp, text }
    return text
  } catch (error) {
    trace(`common role FAILED ${COMMON_ROLE_FILE}: ${errorMessage(error)}`)
    return ''
  }
}

function roleText(roleId) {
  const role = listRoles().find((item) => item.id === roleId)
  if (!role) return `未找到岗位：${roleId}`
  // 派工需要完整 frontmatter 与正文，不能只发送解析后的摘要。
  let raw = ''
  try {
    raw = readFileSync(role.file, 'utf8')
  } catch (error) {
    trace(`role text FAILED ${role.file}: ${errorMessage(error)}`)
    return `读不到岗位原文：${roleId}（${errorMessage(error)}）`
  }
  // 标题 → 公共规范 → 岗位原文：公共方法只写一遍，岗位文件只写专业判断与交付要求。
  const common = commonRoleText()
  return [
    `# ${role.displayName}（${role.id} v${role.version || '?'}${role.level && !role.displayName.includes(role.level) ? ` · ${role.level}` : ''}）`,
    '',
    ...(common ? [common, ''] : []),
    raw.trim(),
  ].join('\n')
}

async function answer(args, exec) {
  const action = String(args?.action ?? 'roles')
  switch (action) {
    case 'roles': {
      const roles = listRoles()
      return roles
        .map((role) => `- ${role.id}：${role.displayName}${role.level && !role.displayName.includes(role.level) ? `（${role.level}）` : ''}${role.summary ? ` —— ${role.summary}` : ''}`)
        .join('\n')
    }
    case 'role':
      return roleText(String(args?.id ?? ''))
    case 'setup':
      // 只读：告诉调用方 blender 能力装没装、缺什么。装的动作留给面板按钮（用户点一次才算数）。
      return JSON.stringify(setupStatus(), null, 2)
    case 'project':
      // 项目状态：目标、验收、任务、复核、待用户问题与下一步。写操作也走这里。
      { const out = await projectOp(args?.project ?? args, callerOf(exec)); return out.message ?? JSON.stringify(out) }
    default:
      return `未知 action：${action}（可用：roles / role）`
  }
}

const TOOL_DEFINITION = {
  name: 'codenow',
  description: '列岗位/取岗位全文（只读）、查 Blender 能力（只读），或用 project 读写当前项目状态（open/task/verify/ask/answer/next/deliver/stop/resume/status）。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['roles', 'role', 'setup', 'project'],
        description: 'roles 列岗位；role 取岗位规范全文；setup 查 Blender 能力（只读）；project 读写项目状态。',
      },
      id: { type: 'string', description: '岗位 id（action=role）。' },
      project: {
        type: 'object',
        description: '项目状态操作（action=project）。生命周期由 Lead 写入；verify 只能由实际独立 teammate 提交。按根会话串行。',
        properties: {
          op: {
            type: 'string',
            enum: ['status', 'open', 'task', 'verify', 'ask', 'answer', 'next', 'deliver', 'stop', 'resume', 'migrate'],
            description: 'status 只读；open 建项目；task 建/改任务；verify 独立成员提交复核；ask/answer 记录必要问题；next 写检查点；deliver 交付；stop/resume 停止恢复；migrate 显式迁移有归属证据的旧状态。',
          },
          objective: { type: 'string', description: 'open：项目目标（必填）。' },
          acceptance: {
            type: 'array',
            description: 'open：验收条件（必填，至少一条）。元素可以是字符串，或 {text, evidence}。',
            items: { type: ['string', 'object'] },
          },
          scope: { type: 'string', description: 'open：本次不做什么。' },
          nextAction: { type: 'string', description: 'open/next：下一步要做什么。' },
          task: {
            type: 'object',
            description: 'task：任务字段；taskId 单独给时也能定位任务。',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              owner: { type: 'string', description: '实际执行成员 name；Lead 自己执行时填 lead。关联子会话时必须与名册一致。' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'verified', 'rework', 'blocked'] },
              dependsOn: { type: 'array', items: { type: 'string' } },
              artifacts: { type: 'array', items: { type: 'string' }, description: '实际文件或验证报告路径；相对路径绑定建项时的真实工作目录，不展开变量。verify/deliver 重读内容 SHA256。' },
              blocker: {
                type: ['object', 'null'],
                description: '阻塞原因；kind=env 表示缺环境/凭据/授权。',
                properties: { kind: { type: 'string', enum: ['env', 'business'] }, detail: { type: 'string' } },
                additionalProperties: false,
              },
              childSessionId: { type: 'string', description: '该任务对应的子会话 id（自动接续据此把结果对回任务）。' },
            },
            additionalProperties: false,
          },
          taskId: { type: 'string', description: 'verify/ask：任务 id。' },
          verdict: { type: 'string', enum: ['pass', 'fail'], description: 'verify：复核结论。' },
           reviewer: { type: 'string', description: 'verify：可省略；传入时必须等于调用者在 Team 名册中的实际 name，不能代录或自证。' },
          evidence: { type: 'string', description: 'verify：复核证据（命令/文件/数字）。' },
          artifactStamp: { type: 'string', description: 'verify：被复核产物的版本戳，必须与任务当前戳一致。' },
          question: { type: 'string', description: 'ask：要用户回答的问题。' },
          kind: { type: 'string', enum: ['business', 'env'], description: 'ask：业务定义还是环境/凭据。' },
          impact: { type: 'string', description: 'ask：不回答的后果。' },
          questionId: { type: 'string', description: 'answer：问题 id。' },
          answer: { type: 'string', description: 'answer：用户原话回答。' },
          reason: { type: 'string', description: 'stop：叫停原因。' },
          acceptanceEvidence: {
            type: 'array',
            description: 'deliver：逐条验收条件的证据，元素为 {text, evidence}。',
            items: { type: 'object' },
          },
        },
        required: ['op'],
        additionalProperties: false,
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  // project 写操作共享一个状态文件，不能让宿主并发调起两笔；只读 action 不受影响。
  isConcurrencySafe: (args) => String(args?.action ?? '') !== 'project',
  output: {
    schema: { type: 'object', properties: { text: { type: 'string' } } },
    render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
  },
  execute: async (args, exec) => ({ text: await answer(args, exec) }),
}

/** 请求体上限 1MB：RPC 载荷只有 sessionId/limit/action 这类小字段，超了直接掐连接。 */
const MAX_BODY_BYTES = 1024 * 1024

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function jsonResponse(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

let TEAM_CTX = null

function fail(code, message) {
  return { ok: false, error: { code, message } }
}

function errorMessage(error) {
  return String(error?.message ?? error)
}

let ROLES_CACHE = null

/** 界面上显示岗位名（如「前端设计工程师」），不显示「子智能体」。 */
function roleLabelOf(title) {
  try {
    const text = String(title ?? '').trim().toLowerCase()
    if (!text) return ''
    if (!ROLES_CACHE) ROLES_CACHE = listRoles()
    const keysOf = (role) =>
      [String(role.id ?? '').toLowerCase(), String(role.displayName ?? '').toLowerCase()].filter(Boolean)
    // 先精确命中：`backend-engineer` 不能被更长的 id 抢走。
    const exact = ROLES_CACHE.find((role) => keysOf(role).includes(text))
    if (exact) return exact.displayName
    // 再按「命中最长」取：短 id 不能盖过长 id（data-algorithm-engineer vs database-engineer 这类）。
    const longestHit = (test) => {
      let best = null
      let bestLen = 0
      for (const role of ROLES_CACHE) {
        for (const key of keysOf(role)) {
          if (key.length > bestLen && test(key)) {
            best = role
            bestLen = key.length
          }
        }
      }
      return best
    }
    const prefixed = longestHit((key) => text.startsWith(key))
    if (prefixed) return prefixed.displayName
    const anywhere = longestHit((key) => text.includes(key)) // 兜底：标题里夹带岗位于任意位置
    return anywhere ? anywhere.displayName : ''
  } catch {
    return ''
  }
}

/** 会话模型名：dsh 在不同层可能暴露 model，按已知路径依次取第一个非空字符串。 */
function pickModel(agent) {
  const session = agent?.session ?? {}
  const rows = session?.rows ?? {}
  const candidates = [
    rows?.modelSelection?.val?.lastUsed?.model,
    rows?.costUsage?.val?.model,
    session?.model,
    session?.header?.model,
    agent?.model,
    session?.lastModel,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  const id = session?.id ?? agent?.sessionId ?? agent?.id ?? ''
  return id ? readProjection(id).model : ''
}

/**
 * 「活着的会话」= registry 里所有存活 agent（agents.list 的语义就是 All live agents）。
 * 不能用 agentTeams.membership() 判活：它对非 Team 子智能体返回 undefined，
 * 会把正在跑的 subagent 误判成「已结束」，随后的 sweep 就会删掉活会话的日志。
 * 返回的 id 一律去掉 `session-` 前缀，与磁盘上的目录名同形。
 * 拿不到 id 时返回 null（而不是空集合）：空集合的含义是「没有活会话，可以全删」，
 * 宿主改了 Agent 形状时不能退化成这个语义，调用方见 null 直接跳过本轮回收。
 */
function listLiveIds() {
  const ids = new Set()
  if (!TEAM_CTX) return null
  const agents = TEAM_CTX.agents.list() ?? []
  for (const agent of agents) {
    const id = normalizeSessionId(agent?.id ?? agent?.sessionId)
    if (id) ids.add(id)
  }
  // 一条 id 都拿不到就按「未知」处理：空集合会被读成「没有活会话，可以全删」。
  // 宿主换 Agent 形状、registry 暂时为空都落在这里，宁可不回收也不误删。
  return ids.size === 0 ? null : ids
}

const SWEEP_INTERVAL_MS = 3 * 60 * 1000
const SWEEP_GRACE_MS = 10 * 60 * 1000
// 首次 sweep 等 10 分钟：插件刚加载时会话可能正被宿主接续，早扫没有收益只有风险。
const FIRST_SWEEP_DELAY_MS = 10 * 60 * 1000

/** 「推测停摆」的静默窗口：全局没有活跃成员、任务又超过这么久没动，才敢这么标。 */
const STALL_MS = 10 * 60 * 1000

/**
 * 搬目录时能靠「下一轮」解决的错误码：宿主可能正开着会话文件，锁一松开就好了。
 * 不在这个集合里的一律当失败记录，免得把真问题说成「稍后重试」。
 */
const RETRYABLE_SWEEP_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'])
// 只有 turn/end 能证明「这一轮真结束了」。session/end-seed 名字像收尾，实际是生命周期**起点**：
// 宿主在建会话、继承和恢复会话时都会写它（事件定义里带 inherited?: true），本机 90 个会话中有 28 个
// 出现在日志中段、还有会话出现过 2 次 —— 它不能证明任务完成，所以不在白名单里。
// 其它一切（end-seed、approval/policy、session/title、model/selection、job/registered、tool/call…）都不算证据。
const SETTLED_TAIL_TYPES = new Set(['turn/end'])

/**
 * 子会话尾巴「已收尾」：只认明确证据。
 * 反过来（白名单外一律算未收尾、读不出事件也算未收尾）是刻意的 —— 判错的代价是
 * 一个还能续跑的会话被搬进隔离区，宁可少回收，不可多回收。
 */
function tailSettled(file) {
  const { event } = readSessionTail(file)
  if (event === null) return false
  return SETTLED_TAIL_TYPES.has(String(event?.type ?? ''))
}

/** 全盘扫出派生子会话（只读首帧/尾部 + stat）：sweep 与自检共用这一份扫描。 */
function scanChildSessions() {
  const out = []
  const root = join(DSH_HOME, 'sessions')
  let workspaces = []
  try {
    workspaces = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return out // 还没有 sessions 目录
  }
  // 先收齐所有会话目录名（含 v3 老目录）：判「父会话目录还在不在」只看目录，不用读文件。
  const dirNames = new Set()
  const listings = new Map()
  let complete = true
  for (const workspace of workspaces) {
    let entries = []
    try {
      entries = readdirSync(join(root, workspace.name), { withFileTypes: true }).filter((entry) => entry.isDirectory())
    } catch {
      complete = false // 这个工作区读不动：父会话可能在里面，下面按「父位置未知」保守处理
      continue
    }
    listings.set(workspace.name, entries)
    for (const entry of entries) dirNames.add(entry.name)
  }
  for (const [workspace, entries] of listings) {
    for (const entry of entries) {
      const dir = join(root, workspace, entry.name)
      const log = sessionLogOf(dir)
      if (!log) continue
      const file = log.file
      const head = readSessionHead(file) // 内部已吞异常，解不出就是 {}
      if (!head.parentSession) continue // 顶层会话永远不在回收范围
      let stat
      try {
        stat = statSync(file)
      } catch {
        continue
      }
      const id = normalizeSessionId(head.id || entry.name)
      if (!id) continue
      const parent = normalizeSessionId(head.parentSession)
      const parentAlive = parent !== '' && (dirNames.has(parent) || dirNames.has(`session-${parent}`))
      out.push({
        id,
        dir,
        workspace,
        bytes: stat.size,
        updatedAt: stat.mtimeMs,
        parent,
        // 父目录状态：true=还在（别动）；false=确实不在；null=有工作区读不动、位置未知（也别动）
        parentDirExists: parentAlive ? true : complete ? false : null,
        // 原始 mode（''=读不到）：判定放行只认 one-shot，认不出来一律不放行。
        mode: readSubagentMode(file),
        tailSettled: tailSettled(file),
      })
    }
  }
  return out
}

/**
 * 纯函数：从派生子会话里挑出「可以进隔离区」的，只产出候选列表，不动任何文件。
 * rows 默认取真实扫描结果（自检也只用真实行，不造合成数据）。
 * 判据全部只用磁盘上读得到的证据，不依赖 registry（19 个会话就是这么被删掉的），
 * 且一律「默认拒绝」——认不出来就不动：
 *   1) 不在活会话集合里；2) 安静超过宽限期；
 *   3) mode 明确是 one-shot（continuable 或读不到 mode 都不动）；
 *   4) 父会话目录已不在磁盘；5) 尾巴已收尾（只认 turn/end；end-seed 是生命周期起点，不算收尾）。
 * 两侧都过 normalizeSessionId：registry 给的是 `session-<uuid>`，磁盘目录名是裸 uuid。
 */
function planSweep(liveIds, now = Date.now(), rows = scanChildSessions()) {
  const live = new Set()
  for (const id of liveIds ?? []) {
    const norm = normalizeSessionId(id)
    if (norm) live.add(norm)
  }
  const candidates = []
  const excludedBy = { live: 0, grace: 0, parentAlive: 0, parentUnknown: 0, continuable: 0, modeUnknown: 0, tailUnsettled: 0 }
  for (const row of rows) {
    if (live.has(row.id)) {
      excludedBy.live += 1
      continue
    }
    if (now - row.updatedAt < SWEEP_GRACE_MS) {
      excludedBy.grace += 1
      continue
    }
    if (row.mode !== 'one-shot') {
      // continuable＝宿主还能续跑；'' 等未知值同样不动（认不出来的证据不算证据）。
      if (row.mode === 'continuable') excludedBy.continuable += 1
      else excludedBy.modeUnknown += 1
      continue
    }
    if (row.parentDirExists === true) {
      excludedBy.parentAlive += 1
      continue
    }
    if (row.parentDirExists !== false) {
      excludedBy.parentUnknown += 1
      continue
    }
    if (!row.tailSettled) {
      excludedBy.tailUnsettled += 1
      continue
    }
    candidates.push({ ...row, reason: 'finished' })
  }
  return { candidates, scanned: rows.length, live: live.size, excludedBy }
}

const pad2 = (value) => String(value).padStart(2, '0')

/** 本地自然日的 yyyymmdd：隔离区按日分目录，和 `.codenow-backup-<stamp>` 同一套命名。 */
function dayStamp(now) {
  const date = new Date(now)
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`
}

/** yyyymmdd → 本地当天 0 点毫秒；不是合法日期返回 null。 */
function dayStartOf(stamp) {
  const hit = /^(\d{4})(\d{2})(\d{2})$/.exec(String(stamp))
  if (!hit) return null
  const month = Number(hit[2])
  const day = Number(hit[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const ms = new Date(Number(hit[1]), month - 1, day).getTime()
  return Number.isNaN(ms) ? null : ms
}

/**
 * 只负责搬：把候选目录 rename 进隔离区，失败只留痕、绝不回退成删除
 * （rename 失败＝多半被占用/跨卷，就地留着至少还能续跑）。
 */
function applySweep(plan, now = Date.now()) {
  let moved = 0
  const stamp = dayStamp(now)
  for (const candidate of plan?.candidates ?? []) {
    const target = join(TRASH_ROOT, stamp, String(candidate.workspace ?? '_'), candidate.id)
    try {
      mkdirSync(dirname(target), { recursive: true })
      renameSync(candidate.dir, target)
      moved += 1
      trace(`sweep moved ${candidate.id} ${candidate.bytes}B ${candidate.dir} -> ${target}`)
    } catch (error) {
      const code = String(error?.code ?? '')
      if (RETRYABLE_SWEEP_CODES.has(code)) {
        // 宿主可能正开着这些文件。搬不动不算失败：下一个 180 秒周期会自动重试。
        trace(`sweep defer ${candidate.id} ${code}（下一轮重试）`)
      } else {
        trace(`sweep move FAILED ${candidate.id} ${candidate.dir} -> ${target}: ${errorMessage(error)}`)
      }
    }
  }
  if (moved > 0) {
    // 搬走的会话不能从任何一层缓存里复活。
    sessionCache.clear()
    recentCache.clear()
    coordinationCache.clear()
  }
  return { moved, scanned: plan?.scanned ?? 0, live: plan?.live ?? 0 }
}

/** 目录体积（只用于日志里报回收了多少字节）。 */
function dirBytes(dir) {
  let total = 0
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const child = join(dir, entry.name)
    if (entry.isDirectory()) total += dirBytes(child)
    else if (entry.isFile()) {
      try {
        total += statSync(child).size
      } catch {
        // 文件刚被删掉，算 0 就行
      }
    }
  }
  return total
}

/**
 * 清隔离区：整个插件里**唯一**真正删除磁盘内容的地方。
 * 只清 `codenow-trash/<yyyymmdd>/...` 下满 30 天的子会话目录，每条都留痕。
 * 到期时刻从桶日的**结束**（次日 0 点）起算：目录是当天某时刻搬进来的，
 * 从当天 0 点起算会让实际保留期短到 29 天 1 分钟，凑不满「≥30×24 小时」。
 * 空的日期/工作区目录不删（rmSync 只此一处，不为了清理空壳再引一个删除 API）。
 */
function purgeTrash(now = Date.now()) {
  let purged = 0
  let bytes = 0
  let dates = []
  try {
    dates = readdirSync(TRASH_ROOT, { withFileTypes: true })
  } catch {
    return { purged, bytes } // 隔离区还没建，正常
  }
  for (const dateDir of dates) {
    if (!dateDir.isDirectory()) continue
    const dayStart = dayStartOf(dateDir.name)
    if (dayStart === null || now - (dayStart + 86400000) < SWEEP_RETENTION_MS) continue
    let workspaces = []
    try {
      workspaces = readdirSync(join(TRASH_ROOT, dateDir.name), { withFileTypes: true })
    } catch (error) {
      trace(`trash purge list FAILED ${dateDir.name}: ${errorMessage(error)}`)
      continue
    }
    for (const workspace of workspaces) {
      if (!workspace.isDirectory()) continue
      let items = []
      try {
        items = readdirSync(join(TRASH_ROOT, dateDir.name, workspace.name), { withFileTypes: true })
      } catch (error) {
        trace(`trash purge list FAILED ${dateDir.name}/${workspace.name}: ${errorMessage(error)}`)
        continue
      }
      for (const item of items) {
        if (!item.isDirectory()) continue
        const dir = join(TRASH_ROOT, dateDir.name, workspace.name, item.name)
        const size = dirBytes(dir)
        try {
          rmSync(dir, { recursive: true, force: true })
          purged += 1
          bytes += size
          trace(`trash purge ${item.name} ${size}`)
        } catch (error) {
          trace(`trash purge FAILED ${item.name}: ${errorMessage(error)}`)
        }
      }
    }
  }
  if (purged > 0) {
    // 隔离区里的副本刚被真删掉：结果缓存里若还留着它们的出口数据，等于让已删内容继续可见。
    recentCache.clear()
    coordinationCache.clear()
    trace(`trash purged=${purged} bytes=${bytes}`)
  }
  return { purged, bytes }
}

/** 定时任务入口：活会话以 registry 为准（含非 Team 子智能体），其余交给 planSweep 判定。 */
function sweepFinishedChildren() {
  if (!TEAM_CTX) return { moved: 0, scanned: 0, live: -1 }
  const liveIds = listLiveIds()
  if (!liveIds) {
    trace('sweep SKIPPED: agents.list() 拿不到会话 id，本轮一个目录都不动')
    return { moved: 0, scanned: 0, live: -1 }
  }
  const result = applySweep(planSweep(liveIds))
  // 只有真搬了东西才记一行，否则每 3 分钟一条纯噪声。
  if (result.moved > 0) trace(`sweep moved=${result.moved} scanned=${result.scanned} live=${result.live}`)
  const trashed = purgeTrash()
  return { ...result, purged: trashed.purged }
}

/** 纯函数：从全量名单里挑出属于某个会话的成员（自身 + 团队 + 父链）。sessionId 为空时返回空，绝不回退全量。 */
function pickTeamRows(roster, sessionId) {
  if (!sessionId) return []
  const mine = normalizeSessionId(sessionId)
  if (!mine) return []
  // 从子会话打开时，以它所属团队的 root 为锚点，才能看到同一团队的全部成员。
  const self = roster.find((row) => normalizeSessionId(row.id) === mine)
  const anchor = self ? normalizeSessionId(self.root ?? self.id) : mine
  const keep = new Set()
  for (const row of roster) if (row.root && normalizeSessionId(row.root) === anchor) keep.add(row.id)
  // 向上补父链：从子会话打开时也能看到主智能体。
  for (let changed = true; changed; ) {
    changed = false
    for (const row of roster) {
      if (keep.has(row.id) && row.parent && !keep.has(row.parent)) {
        keep.add(row.parent)
        changed = true
      }
    }
  }
  return roster.filter((row) => keep.has(row.id))
}

function livePayload(sessionId) {
  if (!TEAM_CTX) return fail('team-unavailable', 'agentTeams 服务尚未就绪')
  const unresolved = []
  const all = (TEAM_CTX.agents.list() ?? [])
  const roster = all
    .map((agent) => {
      const id = agent?.session?.id ?? agent?.sessionId ?? agent?.id ?? null
      const parent = agent?.session?.header?.parentSession ?? null
      const title = agent?.title ?? agent?.session?.title ?? (id ? readProjection(id).title : '') ?? null
      // membership().name 才是 spawn 时定的岗位 id；title 只是会话标题，不可靠。
      const member = memberOfAgent(agent)
      const memberName = member?.name ?? ''
      const memberRoot = member?.rootSessionId ?? ''
      const memberRole = member?.role ?? ''
      const label = roleLabelOf(memberName) || roleLabelOf(title) || null
      if (!memberName) unresolved.push({ id, title: title || null })
      return {
        id,
        title: title || null,
        name: memberName || null,
        label,
        model: pickModel(agent),
        parent: parent || null,
        root: memberRoot || null,
        role: memberRole || null,
      }
    })
    // 只保留真正在某个活跃 Team 里的 agent；registry 里其余的是历史遗留的孤儿会话。
    .filter((row) => row.id && row.role)
  const rows = pickTeamRows(roster, sessionId)
  const byId = new Map(rows.map((row) => [row.id, row]))
  const withParentModel = rows.map((row) => ({
    ...row,
    parentModel: row.parent ? byId.get(row.parent)?.model ?? '' : '',
  }))
  return { ok: true, value: { agents: withParentModel, unresolved } }
}

const CODENOW_POLICY = [
  '## 多 AI 协同（强制，按任务裁剪）',
  '',
  '本会话搭载 codenow 岗位矩阵：你 + 18 位专家工程师。**你是 Lead 时**你就是首席工程师，对技术决策和交付闭环负责；新任务开始时先用 `codenow({action:"role",id:"chief-engineer"})` 读取首席岗位全文，同一任务复用已读内容、模板变化后重新读取。岗位规范不能覆盖用户要求或宿主审批。',
  '',
  '**派活（默认必须）**：新任务默认至少派 1 个岗位并行推进；只有单文件小改、纯查询或用户明说不用子智能体时才单干，并在回复里写明理由。用本会话**实际提供**的派活工具——`subagent`（或 `subagent_fork`）；宿主要是另有 `spawn_teammate` 才用它。按规模选 1-3 个（跨领域 2、需独立验证 2-3），**一次把上下文给全、并行开出**，不要派一个等一个；禁止把全部岗位依次拉起，禁止为「显得在协同」而全量 spawn。进度优先：等待子智能体时自己推进不冲突的部分；说派了却没有真实调用＝假报进度；子智能体在跑时不要自己重复做它的活。',
  '',
  '路由：微信 H5/公众号网页/微信 JS-SDK→`wechat-h5-engineer`；UI/样式/交互/a11y→`frontend-design-engineer`；服务端/接口/业务/异步→`backend-engineer`；移动端/跨端→`mobile-client-engineer`；表结构/索引/迁移→`database-engineer`；数据清洗/指标/算法→`data-algorithm-engineer`；测试/缺陷复现→`test-engineer`；代码审查/质量门禁→`code-quality-reviewer`；构建/部署/环境→`devops-sre-engineer`；鉴权/加密/依赖漏洞→`security-engineer`；架构/模块边界/选型→`system-architect`；文档/README→`technical-writer`；PPT/演示/汇报材料→`pptx-engineer`；Word 长文档/样式与模板→`docx-engineer`；Excel/表格/数据透视→`xlsx-engineer`；GitHub 仓库/开源协作/发布→`github-repo-manager`；Blender 建模/3D 资产/引擎导出→`modeling-engineer`；SRC/众测/漏洞挖掘/Bug bounty→`vuln-researcher`。',
  '',
  '**断线必须恢复**：子智能体断掉（工具连错、`send_message` 被拒、`wait_agent` 无进展、会话报错）不许丢活：① 先 `send_message` 唤醒并补齐上下文；② 唤不醒就新建一个——`subagent` 的 name 重名时宿主会自动加后缀（`-2`、`-3`…），把已完成部分与原任务一起写进 prompt；③ 同岗位连败 2 次，换邻岗或自己做完，并在汇总写明。派活时交代「做到哪步、产出放哪」。',
  '',
  '写法：`subagent({name:"<role-id>", description:"<岗位名>", prompt:"<岗位全文+目标+验收标准+可改范围>", cwd:"<可选>"})`；只有需要继承当前对话上下文时才用 `subagent_fork`。子智能体是 fresh context，prompt 必须自带全部背景，不要写「如上所述」。岗位全文用 `codenow({action:"role", id:"<role-id>"})` 取（已含公共规范，prompt 里不用重复贴）。要并行就一次发多个调用；等结果用 `wait_agent`，追问或补料用 `send_message`。若宿主另提供 `spawn_teammate`，再配合 `team_task_create` 登记任务。',
  '',
  '派工五要素（缺一项接手人就得重新调查）：目标与验收、真实输入来源／已完成的调查与成果／可改文件与不能破坏的不变量／前置依赖、交付对象、阻塞解除／交付时要给的验证证据。',
  '',
  '**你是子智能体时**：只做本职，不再拉人；跨岗位决策找 Lead。',
  '',
  '**语言**：你用简体中文思考和回答用户；子智能体一律用英文（其系统提示词里已内置该要求），派工 prompt 末尾仍附一行 `Reply in English.` 作为兜底。',
  '',
   '**自主推进（项目级）**：用户给一次明确需求后，调查→计划→分派→复核→返工→集成连续做完，不要求逐批确认。用 `codenow({action:"project",project:{op:"status"}})` 恢复检查点；`open` 记录目标/验收/范围（同目标重试复用项目），`task` 记录实际成员 name、childSessionId、依赖及文件产物，`next` 保存下一步。复核派给独立 teammate：让它先读 status 核对当前 artifactStamp、实际文件，再亲自调用 `verify`，Lead 不得代录。`deliver` 会重读文件哈希；文件变更必须重验。`ask` 只记录缺少且无法查到的业务定义、凭据或授权，带 taskId 只阻塞该任务及后继，集中一次询问并继续其他任务；收到真实回答才 `answer`。内部复核通过后继续集成，不等用户说继续。**stop 后必须等用户明确要求才 resume**。接续仅以真实入箱和日志对账为准，端点失败、成员额度不足或独立复核缺失如实记录；不要重复已完成的副作用。',
].join('\n')

// 派活强度跟随新版 DSH 的「团队协作」开关：开了必须派人，关了只按需。
// 只有这一段随开关变，其余文本两种取值逐字相同。
const DISPATCH_PARAGRAPH = /^\*\*派活（默认必须）\*\*.*$/mu
const DISPATCH_ON = '**派活（强制）**：团队协作开关已打开——新任务**必须**至少派 1 个子智能体并行推进，不许自己一个人做完；只有用户本轮明确说不用子智能体才可例外，并在回复里写明理由。用 `subagent`（或 `subagent_fork`）；宿主要是另有 `spawn_teammate` 才用它。按规模选 1-3 个（跨领域 2、需独立验证 2-3），**一次把上下文给全、并行开出**，不要派一个等一个；禁止把全部岗位依次拉起，禁止为「显得在协同」而全量 spawn。进度优先：等待子智能体时自己推进不冲突的部分；说派了却没有真实调用＝假报进度；子智能体在跑时不要自己重复做它的活。'
const DISPATCH_OFF = '**派活（按需）**：团队协作开关未打开——允许零个 teammate：小改动、单文件、纯查询可以自己做完并写明理由；涉及跨领域、需要独立验证或独立视角时再派。用 `subagent`（或 `subagent_fork`）；宿主要是另有 `spawn_teammate` 才用它。要派就按规模选 1-3 个（跨领域 2、需独立验证 2-3），**一次把上下文给全、并行开出**，不要派一个等一个；禁止把全部岗位依次拉起，禁止为「显得在协同」而全量 spawn。进度优先：等待子智能体时自己推进不冲突的部分；说派了却没有真实调用＝假报进度；子智能体在跑时不要自己重复做它的活。'

function policyText(enabled) {
  return CODENOW_POLICY.replace(DISPATCH_PARAGRAPH, enabled === true ? DISPATCH_ON : DISPATCH_OFF)
}

/**
 * 子智能体的语言段：宿主全局分段对每个 agent 都生效，这里只在 role === 'teammate' 时返回。
 * 全文必须是纯 ASCII —— 预设 `sol-fable-general/agent.cordis.yml:52` 已经写了「使用简体中文沟通」，
 * 所以要显式声明覆盖，否则同一个系统提示词里会出现两条相反的语言指令。
 */
const TEAMMATE_LANGUAGE = [
  '## Language (codenow)',
  '',
  'You are a subagent on this team. Think and write in English: every message you send the Lead (reports, questions, blockers, summaries) must be English. This overrides any other language instruction in your prompt.',
  '',
  'Keep code identifiers and existing technical terms as they are; files and documents you write keep the language they already use.',
].join('\n')

/** 语言分段按身份分流：纯函数，方便自检直接断言四个分支。 */
function sectionTextForMembership(membership, enabled) {
  if (!membership) return ''
  if (membership.role === 'lead') return policyText(enabled)
  if (membership.role === 'teammate') return TEAMMATE_LANGUAGE
  return ''
}

const CHAT_LIMIT_DEFAULT = 50
const CHAT_LIMIT_MAX = 500
// recentCache 只留最后这么多条消息，必须 ≥ chat 的条数上限，否则热路径切不出够数的消息。
// 条目形状 { messages, total }：messages = 该游标下最后 RECENT_MESSAGES 条；total = 该游标下的消息总数，
// 只解到一半的尾部结果记 null（「不知道总共多少」）。total 的消费方是 hasMore，不进 chat 出参。
const RECENT_MESSAGES = CHAT_LIMIT_MAX

/** chat 的条数：不传给默认，非法值（负数/小数/空串）也退回默认，上限 500。 */
function chatLimit(value) {
  const requested = Number(value)
  return Number.isInteger(requested) && requested > 0 ? Math.min(requested, CHAT_LIMIT_MAX) : CHAT_LIMIT_DEFAULT
}

/**
 * chat 出口（所有路径共用，保证口径一致）：pool 是已按游标过滤、按时间正序的消息。
 * hasMore：total 已知就比条数；total=null（只解了尾部一段）则「切满了 limit」就认为更早还有。
 * oldestSeq：本次最早一条的 seq，下一次请求把它当 before 就能继续往前翻。
 */
function chatValue(pool, limit, total) {
  const messages = pool.slice(-limit)
  return {
    ok: true,
    value: {
      messages,
      hasMore: total === null ? messages.length >= limit : total > messages.length,
      oldestSeq: messages.length > 0 ? messages[0].seq : null,
    },
  }
}

// ---- 内置资源：技能 / MCP 桥 / Blender addon ------------------------------------
// 目标：别人装了插件就有 Blender 能力，不用自己去 clone 技能、不用装 Python 包。
// 技能与桥在插件包里，addon 也在包里；写用户目录只有两处（技能目录、Blender addon 目录），
// 都走幂等 + 显式触发，装了什么写在返回值里，不靠"没报错"猜。
const BUNDLED_SKILLS = join(HERE, 'assets', 'skills')
const BUNDLED_ADDON = join(HERE, 'assets', 'blender-addon', 'blender_mcp_addon')
const BRIDGE_FILE = join(HERE, 'bin', 'blender-mcp-server.mjs')
const SKILLS_ROOT = join(DSH_HOME, 'skills')
const SKILL_MANIFEST = join(SKILLS_ROOT, '.codenow-skills.json')
const MCP_CONFIG = join(DSH_HOME, 'mcp-manager.json')
const MCP_SERVER_NAME = 'codenow-blender'

function hashFile(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16)
  } catch {
    return ''
  }
}

function listDirs(root) {
  try {
    return readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJsonFile(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

function copyTree(from, to) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name)
    const dest = join(to, entry.name)
    if (entry.isDirectory()) copyTree(src, dest)
    else if (entry.isFile()) copyFileSync(src, dest)
  }
}

// 技能内容用 SKILL.md 的哈希判断版本：技能真正的正文就是它，改了就重装一次。
function bundledSkills() {
  return listDirs(BUNDLED_SKILLS)
    .map((name) => ({ name, src: join(BUNDLED_SKILLS, name), hash: hashFile(join(BUNDLED_SKILLS, name, 'SKILL.md')) }))
    .filter((skill) => skill.hash !== '')
}

function installBundledSkills() {
  const skills = bundledSkills()
  if (skills.length === 0) return { installed: [], skipped: [], reason: '插件包里没有内置技能' }
  const manifest = readJsonFile(SKILL_MANIFEST) ?? { version: 1, skills: {} }
  const installed = []
  const skipped = []
  for (const skill of skills) {
    const dest = join(SKILLS_ROOT, skill.name)
    const upToDate = manifest.skills?.[skill.name]?.hash === skill.hash && existsSync(join(dest, 'SKILL.md'))
    if (upToDate) {
      skipped.push(skill.name)
      continue
    }
    copyTree(skill.src, dest)
    manifest.skills = { ...(manifest.skills ?? {}), [skill.name]: { hash: skill.hash, at: new Date().toISOString() } }
    installed.push(skill.name)
  }
  if (installed.length > 0) writeJsonFile(SKILL_MANIFEST, manifest)
  return { installed, skipped }
}

// Blender 各版本的 addon 目录：只探测存在 blender_mcp_addon 的那些，没装过的不瞎猜。
function blenderAddonDirs() {
  const base = process.env.APPDATA ? join(process.env.APPDATA, 'Blender Foundation', 'Blender') : ''
  if (base === '') return []
  return listDirs(base)
    .map((version) => ({ version, dir: join(base, version, 'scripts', 'addons', 'blender_mcp_addon') }))
    .filter((row) => existsSync(join(row.dir, '__init__.py')))
}

function blenderVersions() {
  const base = process.env.APPDATA ? join(process.env.APPDATA, 'Blender Foundation', 'Blender') : ''
  return base === '' ? [] : listDirs(base)
}

function mcpEntry() {
  const config = readJsonFile(MCP_CONFIG)
  const servers = config?.servers
  if (!Array.isArray(servers)) return null
  return servers.find((row) => row?.serverName === MCP_SERVER_NAME) ?? null
}

// 只读：告诉面板"缺什么"，不改任何东西（Q3：装不装由用户点）。
function setupStatus() {
  // 宿主能力跟着一起吐，面板能直接看出当前 rc 缺了什么。
  const host = hostCapabilities()
  const entry = mcpEntry()
  return {
    skills: {
      root: SKILLS_ROOT,
      items: bundledSkills().map((skill) => ({
        name: skill.name,
        installed: existsSync(join(SKILLS_ROOT, skill.name, 'SKILL.md')),
      })),
    },
    mcp: {
      name: MCP_SERVER_NAME,
      bridge: existsSync(BRIDGE_FILE),
      registered: Boolean(entry),
      enabled: entry?.enabled === true,
    },
    blender: {
      versions: blenderVersions(),
      addons: blenderAddonDirs().map((row) => row.version),
      bundled: existsSync(join(BUNDLED_ADDON, '__init__.py')),
    },
    host,
  }
}

// 写操作 1：把 MCP 条目注册进 mcp-manager.json（先备份，结构不符就拒绝，不硬写）。
function installMcpEntry() {
  if (!existsSync(BRIDGE_FILE)) return fail('bridge-missing', '插件包里的 MCP 桥文件不存在，无法注册')
  const config = readJsonFile(MCP_CONFIG)
  if (!config || !Array.isArray(config.servers)) {
    return fail('mcp-config-unknown', `mcp-manager.json 不存在或 servers 不是数组：${MCP_CONFIG}`)
  }
  const command = /node(\.exe)?$/i.test(process.execPath) ? process.execPath : 'node'
  const entry = { serverName: MCP_SERVER_NAME, transport: 'stdio', command, args: [BRIDGE_FILE], env: {}, cwd: HERE, enabled: true }
  const index = config.servers.findIndex((row) => row?.serverName === MCP_SERVER_NAME)
  if (index >= 0) config.servers[index] = { ...config.servers[index], ...entry }
  else config.servers.push(entry)
  const backup = `${MCP_CONFIG}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  try {
    if (existsSync(MCP_CONFIG)) copyFileSync(MCP_CONFIG, backup)
    writeJsonFile(MCP_CONFIG, config)
  } catch (error) {
    return fail('mcp-write-failed', `写 mcp-manager.json 失败：${errorMessage(error)}`)
  }
  trace(`setup installed mcp entry ${MCP_SERVER_NAME}（备份 ${backup}）`)
  return { ok: true, value: { registered: true, backup, config: MCP_CONFIG } }
}

// 写操作 2：把 addon 拷进已检测到的 Blender 版本目录（不新建未知版本目录）。
function installBlenderAddon() {
  if (!existsSync(join(BUNDLED_ADDON, '__init__.py'))) return fail('addon-missing', '插件包里没有 Blender addon 文件')
  const versions = blenderVersions()
  if (versions.length === 0) {
    return fail('blender-missing', '没有找到 Blender 用户目录（先启动一次 Blender 再装）')
  }
  const installed = []
  const failed = []
  for (const version of versions) {
    const dest = join(process.env.APPDATA, 'Blender Foundation', 'Blender', version, 'scripts', 'addons', 'blender_mcp_addon')
    try {
      copyTree(BUNDLED_ADDON, dest)
      installed.push(version)
    } catch (error) {
      failed.push(`${version}: ${errorMessage(error)}`)
    }
  }
  if (installed.length === 0) return fail('addon-install-failed', `addon 没装成功：${failed.join('；')}`)
  trace(`setup installed blender addon → ${installed.join(', ')}`)
  return { ok: true, value: { installed, failed } }
}

// —— 自主接续：项目状态是插件的，唤醒动作走宿主真实接口 ——
// 宿主的 Agent 实例有 followup/steer/inject（dsh-agent-loop 的循环对象），
// followup 会往 next-turn 追加并唤醒驱动，这是「不需要用户打字也能继续」的真实通道。
// 插件的职责只是：判断该不该唤醒、唤醒时说清下一步、不重复唤醒。
const AUTONOMY_TICK_MS = 8 * 1000

function rootOf(sessionId) {
  return safeRoot(sessionId)
}

/** 面板可选子会话；沿真实 header 找根，不把子会话 id 当成项目存储目录。 */
function resolveRootSession(sessionId) {
  if (!rootOf(sessionId)) return null
  const seen = new Set()
  let row = findSession(sessionId)
  while (row && seen.size < 32) {
    const id = rootOf(row.id)
    if (!id || seen.has(id)) return null
    seen.add(id)
    if (!row.parentSession) return id
    row = findSession(row.parentSession)
  }
  return null
}

function readProjectState(rootSessionId) {
  const root = rootOf(rootSessionId)
  if (!root) return { state: emptyState(null), present: false, problem: 'no-root-session' }
  return readState(DSH_HOME, root)
}

function saveProjectState(rootSessionId, state) {
  const root = rootOf(rootSessionId)
  if (!root) throw new Error('no-root-session')
  return writeState(DSH_HOME, root, state)
}

/** 调用者身份只认 exec 里的真实会话与 Team 名册：参数里写的身份一概不采信。 */
function callerOf(exec) {
  const sessionId = rootOf(exec?.agent?.session?.id)
  if (!sessionId) return { ok: false, reason: 'no-session-id' }
  const agent = exec?.agent ?? null
  // 新宿主没有 membership API，身份由 memberOfAgent 走磁盘判据得出（旧宿主仍优先用 membership）。
  const membership = memberOfAgent(agent)
  const rootSessionId = rootOf(membership?.rootSessionId)
  if (!membership || !rootSessionId) return { ok: false, reason: 'no-team-membership' }
  // 工作目录按可信度降级：服务给出的 committed 目录 > 会话 header 记录的 cwd > 未知。
  // 都不猜：拿不到就交 null，让需要它的产物校验自己报「缺少项目实际工作目录」。
  let cwd = null
  let cwdSource = 'unknown'
  try {
    const fromService = agent.ctx?.get?.('workingDirectory')?.get?.(rootSessionId) ?? null
    if (fromService) { cwd = String(fromService); cwdSource = 'working-directory-service' }
  } catch {}
  if (!cwd) {
    try {
      const row = findSession(rootSessionId)
      if (row?.cwd) { cwd = String(row.cwd); cwdSource = 'session-header' }
    } catch {}
  }
  return { ok: true, sessionId, rootSessionId, role: membership.role, name: membership.name,
    agent, cwd, cwdSource, callId: exec?.callId ?? null }
}

/** 项目写操作串行：同一个 root 上一次只跑一笔，避免读改写互相覆盖。 */
const PROJECT_QUEUES = new Map()

function withProjectLock(root, fn) {
  const prev = PROJECT_QUEUES.get(root) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  const settled = next.then(() => {}, () => {}).then(() => {
    if (PROJECT_QUEUES.get(root) === settled) PROJECT_QUEUES.delete(root)
  })
  PROJECT_QUEUES.set(root, settled)
  return next
}

function projectStatusText(root) {
  const info = readProjectState(root)
  const project = currentProject(info.state)
  if (project) refreshArtifacts(project)
  const view = projectView(info.state, { problem: info.problem, present: info.present })
  return JSON.stringify({ rootSessionId: root, migrated: info.migrated ?? false, ...view }, null, 2)
}

/** 把 deliver 现给的验收证据贴到项目的验收条件上（只贴文本能对上的那些）。 */
function applyAcceptanceEvidence(project, rows) {
  const list = Array.isArray(rows) ? rows : []
  const merged = (project.acceptance ?? []).map((row) => {
    const hit = list.find((item) => String(item?.text ?? '').trim() === row.text)
    return hit ? { ...row, evidence: String(hit.evidence ?? '').trim() } : row
  })
  return merged
}

async function projectOp(input, caller) {
  const op = String(input?.op ?? '').trim()
  const root = caller?.rootSessionId ?? null
  if (!caller?.ok) return { ok: false, message: `拿不到当前会话身份，拒绝访问项目状态（${caller?.reason ?? 'unknown'}）` }
  if (op === 'status' || op === '') return { ok: true, message: projectStatusText(root) }
  // 复核只能由独立成员亲自提交；Lead 负责其余生命周期。
  if (op === 'verify' ? caller.role !== 'teammate' : caller.role !== 'lead') {
    return { ok: false, message: `${op === 'verify' ? '只有实际独立 teammate 能提交复核，Lead 不能代录' : '只有当前项目的 Lead 能执行此操作'}（${op}；当前身份：${caller.name ?? '未知'}）` }
  }
  return withProjectLock(root, async () => {
    if (op === 'migrate') {
      const result = migrateLegacy(DSH_HOME, root)
      return { ok: !result.problem, message: result.problem ?? (result.migrated ? '已迁移，原文件及备份保留。' : '无需迁移。') }
    }
    const info = readProjectState(root)
    // 坏文件、未知版本一律不写，避免把用户数据覆盖成空状态。
    if (info.problem) return { ok: false, message: `项目状态文件不可用（${info.problem}），已拒绝写入；请先备份并人工处理` }
    const state = info.state
    const guarded = (label, fn) => {
      try {
        return fn()
      } catch (error) {
        return { ok: false, message: `${label} 被拒绝：${errorMessage(error)}` }
      }
    }
    if (op === 'open') {
      return guarded('open', () => {
        const project = openProject(state, { ...input, cwd: caller.cwd, cwdSource: caller.cwdSource })
        saveProjectState(root, state)
        return { ok: true, message: `已建立项目 ${project.id}（验收 ${project.acceptance.length} 条）` }
      })
    }
    if (op === 'resume') {
      clearStop(state)
      const project = currentProject(state)
      if (project) requestContinuation(project, '已恢复，继续检查点')
      saveProjectState(root, state)
      return { ok: true, message: '已恢复自动接续。' }
    }
    const project = currentProject(state)
    // 早期项目可能没记 cwd：后续任一次带可信 cwd 的写操作补上并留痕，不改历史结论。
    if (project && !project.cwd && caller.cwd) {
      project.cwd = String(caller.cwd)
      project.cwdFilledAt = new Date().toISOString()
      project.cwdSource = caller.cwdSource ?? 'unknown'
    }
    if (!project) return { ok: false, message: '当前没有打开的项目，先用 op=open 建立' }
    if (op === 'stop') {
      setStop(state, { reason: input?.reason, by: caller.name ?? 'lead' })
      saveProjectState(root, state)
      return { ok: true, message: '已停止自动接续。恢复必须由用户明确要求，然后再调用 op=resume。' }
    }
    if (op === 'task') {
      return guarded('task', () => {
        const fields = { ...(input?.task ?? input) }
        const before = project.tasks.find((row) => row.id === fields.id)
        // 显式传 childSessionId:null 表示解绑：成员离开名册后仍要能接手/收尾，不然整条任务永久卡死。
        const clearing = fields.childSessionId === null
        const childId = clearing ? null : (fields.childSessionId ?? before?.childSessionId)
        if (clearing) {
          fields.childSessionId = null
        } else if (childId) {
          // 新宿主没有 listMembers：按「该子会话的 header.parentSession 是否就是本项目根会话」判定归属。
          const member = memberRecordOf(caller.rootSessionId, childId)
          if (!member) throw new Error('child-not-in-team')
          if (fields.owner && fields.owner !== member.name) throw new Error('owner-must-match-team-name')
          fields.owner = member.name
          fields.childSessionId = rootOf(member.id)
        }
        fields.ownerSessionId = fields.childSessionId ?? ((fields.owner ?? before?.owner) === 'lead' ? root : null)
        const task = upsertTask(project, fields)
        refreshArtifacts(project)
        if (!before || ['status', 'owner', 'childSessionId', 'artifactStamp'].some((key) => before[key] !== task[key])) requestContinuation(project, '任务检查点已更新', task.id)
        saveProjectState(root, state)
        return { ok: true, message: `任务 ${task.id}：${task.status}（artifactStamp ${task.artifactStamp}）` }
      })
    }
    if (op === 'verify') {
      const reviewer = caller.name
      if (input?.reviewer && input.reviewer !== reviewer) {
        return { ok: false, message: 'reviewer 与实际调用成员不一致，拒绝代录。' }
      }
      try {
        refreshArtifacts(project)
        const record = recordVerification(project, {
          taskId: input?.taskId ?? input?.task?.id,
          verdict: input?.verdict,
          reviewer,
          evidence: input?.evidence,
          artifactStamp: input?.artifactStamp,
          by: caller.name,
          reviewerSessionId: caller.sessionId,
          callId: caller.callId,
          source: 'team-tool',
        })
        saveProjectState(root, state)
        return { ok: true, message: `已记录复核：${record.taskId} ${record.verdict}（复核者 ${record.reviewer}，记录者 ${record.by}）` }
      } catch (error) {
        return { ok: false, message: `复核被拒绝：${errorMessage(error)}` }
      }
    }
    if (op === 'ask') {
      return guarded('ask', () => {
        const question = addQuestion(project, input)
        saveProjectState(root, state)
        return { ok: true, message: `已提问 ${question.id}：${question.question}（回答时用 op=answer questionId=${question.id}）` }
      })
    }
    if (op === 'answer') {
      try {
        const row = answerQuestion(project, { questionId: input?.questionId, answer: input?.answer, answeredBy: caller.name ?? 'user' })
        requestContinuation(project, '必要问题已回答，继续受影响任务', row.taskId)
        saveProjectState(root, state)
        return { ok: true, message: `已记录 ${row.id} 的回答（回答者 ${row.answeredBy}），自动接续恢复` }
      } catch (error) {
        return { ok: false, message: `回答被拒绝：${errorMessage(error)}` }
      }
    }
    if (op === 'next') {
      const nextAction = String(input?.nextAction ?? '').trim()
      if (nextAction !== project.nextAction) requestContinuation(project, '下一步已保存')
      project.nextAction = nextAction
      saveProjectState(root, state)
      return { ok: true, message: `下一步已更新：${project.nextAction || '（空）'}` }
    }
    if (op === 'deliver') {
      project.acceptance = applyAcceptanceEvidence(project, input?.acceptanceEvidence)
      refreshArtifacts(project)
      reconcileDeliveries(state, readLeadReceipts(root))
      const blockers = deliverBlockers(project, state)
      if (blockers.length > 0) {
        saveProjectState(root, state)
        return { ok: false, message: `交付被拒绝（项目保持打开）：${blockers.join('；')}` }
      }
      project.deliveredAt = new Date().toISOString()
      project.status = 'delivered'
      saveProjectState(root, state)
      return { ok: true, message: `项目 ${project.id} 已交付。` }
    }
    return { ok: false, message: `未知 op：${op}（可用：status/open/task/verify/ask/answer/next/deliver/stop/resume/migrate）` }
  })
}

function liveLeadAgents() {
  if (!TEAM_CTX) return []
  let list = []
  try {
    list = TEAM_CTX.agents?.list?.() ?? []
  } catch {
    return []
  }
  return list.filter((agent) => {
    try {
      return memberOfAgent(agent)?.role === 'lead' && typeof agent?.followup === 'function'
    } catch {
      return false
    }
  })
}

function childRowsOf(parentId) {
  return listSessions()
    .filter((row) => row.parentSession && rootOf(row.parentSession) === rootOf(parentId))
    .map((row) => {
      const tail = readSessionTail(row.file)
      return {
        id: row.id,
        name: readProjection(row.id).title || row.id,
        lastSeq: tail?.event?.seq ?? null,
        lastEventAt: tail?.event?.time ?? null,
        tailType: tail?.event?.type ?? null,
        endReason: tail?.event?.data?.reason?.kind ?? null,
      }
    })
    .filter((row) => Boolean(row.id))
}

const RECEIPT_CACHE = new Map()

/** 完整且稳定的日志才可用于证明消息缺席；只缓存小型收据，不常驻整份事件。 */
function readLeadReceipts(root) {
  try {
    const row = findSession(root)
    if (!row) return null
    const before = stampOf(row.file).stamp
    if (RECEIPT_CACHE.get(root)?.stamp === before) return RECEIPT_CACHE.get(root).receipts
    const events = decodeSession(readFileSync(row.file)).split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
    const receipts = deliveryReceipts(events)
    if (stampOf(row.file).stamp !== before) return null
    RECEIPT_CACHE.set(root, { stamp: before, receipts })
    while (RECEIPT_CACHE.size > 4) RECEIPT_CACHE.delete(RECEIPT_CACHE.keys().next().value)
    return receipts
  } catch {
    return null
  }
}

/** 与 projectOp 共用根锁：持久化消息 id 后投递，崩溃窗口由真实 inbox 对账恢复。 */
async function autonomyTickFor(root, lead, control) {
  return withProjectLock(root, async () => {
    if (control.disposed || lead.status !== 'idle') return
    const info = readProjectState(root)
    if (info.problem) return
    const state = info.state
    const project = currentProject(state)
    if (!project || state.stop) return
    const before = JSON.stringify(state)
    const receipts = readLeadReceipts(root)
    reconcileDeliveries(state, receipts)
    state.reconciliationProblem = receipts === null ? 'lead-log-unavailable' : null
    if (receipts === null) {
      if (JSON.stringify(state) !== before) saveProjectState(root, state)
      return
    }
    // 先做投递恢复：进程在 sending 中途挂掉、或上一轮 followup 抛错的，这里按退避重试；
    // 同一 messageId 复用，宿主侧按 id 去重，不会因为重试变成两次唤醒。
    const nowMs = Date.now()
    const due = Object.values(state.deliveries ?? {})
      .filter((row) => (row.projectId ?? project.id) === project.id && deliveryNeedsRetry(row, nowMs))
      .sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')))[0]
    if (due) {
      const attempt = Number(due.attempts ?? 0) + 1
      markDelivery(state, { ...due, text: due.text }, 'sending', null)
      saveProjectState(root, state)
      try {
        await lead.followup({
          id: due.messageId,
          role: 'user',
          content: [{ type: 'text', text: due.text ?? noteFor({ project, decision: due }) }],
          source: { kind: 'agent-message', form: 'relay', senderSessionId: due.childSessionId ?? lead.id },
        })
        markDelivery(state, { ...due }, 'sent', null)
        saveProjectState(root, state)
        trace(`autonomy retry ok message=${due.messageId} attempt=${attempt}`)
      } catch (error) {
        markDelivery(state, { ...due, retryAt: new Date(Date.now() + 60_000 * attempt).toISOString() }, 'unknown', errorMessage(error))
        saveProjectState(root, state)
        trace(`autonomy retry FAILED message=${due.messageId} attempt=${attempt}: ${errorMessage(error)}`)
      }
      return
    }
    const children = childRowsOf(lead.id)
    const taskOfChild = (child) => {
      const tasks = (project.tasks ?? []).filter((task) => task.childSessionId && rootOf(task.childSessionId) === rootOf(child.id))
      return tasks.length === 1 ? tasks[0].id : null
    }
    const decision = decideContinuation({
      state,
      project,
      children,
      leadTurnIdle: lead.status === 'idle',
      taskOfChild,
    })
    state.unmapped = decision.unmapped ?? []
    if (!decision.deliver) {
      if (JSON.stringify(state) !== before) saveProjectState(root, state)
      return
    }
    const child = children.find((row) => rootOf(row.id) === rootOf(decision.childId))
    const hostReceipt = child ? receiptForChild(receipts, child) : null
    if (hostReceipt) {
      markDelivery(state, { ...decision, messageId: hostReceipt.id, origin: 'host' }, hostReceipt.status === 'claimed' ? 'unknown' : hostReceipt.status)
      project.continuation = null
      saveProjectState(root, state)
      return
    }
    if (control.disposed || lead.status !== 'idle') return
    const noteText = noteFor({ project, decision })
    const delivery = markDelivery(state, { ...decision, text: noteText }, 'sending', null)
    saveProjectState(root, state)
    try {
      await lead.followup({
        id: delivery.messageId,
        role: 'user',
        content: [{ type: 'text', text: noteText }],
        source: { kind: 'agent-message', form: 'relay', senderSessionId: decision.childId ?? lead.id },
      })
      markDelivery(state, decision, 'sent', null)
      if (decision.childId) project.continuation = null
      saveProjectState(root, state)
      trace(`autonomy queued message=${delivery.messageId} project=${project.id} task=${decision.taskId ?? '-'} child=${decision.childId ?? '-'} seq=${decision.lastSeq ?? '-'}`)
    } catch (error) {
      markDelivery(state, decision, 'unknown', errorMessage(error))
      saveProjectState(root, state)
      trace(`autonomy wake FAILED for ${decision.childId} seq=${decision.lastSeq}: ${errorMessage(error)}`)
    }
  }).catch((error) => {
    trace(`autonomy tick FAILED: ${errorMessage(error)}`)
  })
}

async function autonomyTick(control) {
  for (const lead of liveLeadAgents()) {
    if (control.disposed) break
    const root = rootOf(lead?.id) ?? rootOf(lead?.session?.id)
    if (!root) continue
    await autonomyTickFor(root, lead, control)
  }
}
function startAutonomy() {
  const control = { disposed: false }
  let flight = null
  const timer = setInterval(() => {
    if (!control.disposed && !flight) flight = autonomyTick(control).finally(() => { flight = null })
  }, AUTONOMY_TICK_MS)
  if (typeof timer.unref === 'function') timer.unref()
  return async () => {
    control.disposed = true
    clearInterval(timer)
    await flight
  }
}

async function handle(endpoint, payload) {
  try {
    switch (endpoint) {
      case 'state':
        return { ok: true, value: statePayload(payload?.sessionId) }
      case 'setup':
        return { ok: true, value: setupStatus() }
      case 'autonomy': {
        const info = readProjectState(resolveRootSession(payload?.sessionId))
        return { ok: true, value: projectView(info.state, { problem: info.problem, present: info.present }) }
      }
      case 'install': {
        // 三个写操作都只由面板按钮触发，模型侧没有对应工具动作。
        const target = payload?.target
        if (target === 'skills') return { ok: true, value: installBundledSkills() }
        if (target === 'mcp') return installMcpEntry()
        if (target === 'addon') return installBlenderAddon()
        return fail('unknown-target', `install 的 target 只能是 skills / mcp / addon，收到：${String(target)}`)
      }
      case 'sessions':
        return { ok: true, value: sessionsPayload(payload) }
      case 'live':
        return livePayload(payload?.sessionId)
      case 'chat': {
        const session = findSession(payload?.sessionId)
        if (!session) return { ok: false, error: { code: 'unknown-session', message: '会话不存在' } }
        // 不传 limit 就给默认条数；传了就必须是正整数，别再把「<=0」读成全给。
        const limit = chatLimit(payload?.limit)
        // 游标：before 是排他上界（只要 seq < before 的消息），非法值当没传。
        const rawBefore = Number(payload?.before)
        const before = Number.isInteger(rawBefore) && rawBefore > 0 ? rawBefore : null
        const { stamp, size } = stampOf(session.file)
        // key 必须带 before：不同游标的消息池不同，共用一条缓存会互相污染。
        const key = `${session.id}:${stamp}:${before ?? ''}`
        const hot = cacheGet(recentCache, key)
        // 热路径：这份 stamp + 游标的消息池已经算过了，切一刀就返回，重复刷新 0 成本。
        if (hot) return chatValue(hot.messages, limit, hot.total)
        // 消息池：先按 messageOf 口径取出，再按游标过滤（tail 路径已经按 beforeSeq 过滤过，这里是幂等的）。
        const poolOf = (events) => {
          const all = toMessages(events, 0)
          return before === null ? all : all.filter((message) => Number(message.seq) < before)
        }
        // 大文件首开：只回头解尾部一段帧，不够再往前扩，一个文件只解一遍。
        if (size > CHAT_TAIL_MIN_BYTES) {
          const tail = decodeSessionTail(session.file, limit, size, { beforeSeq: before })
          if (tail) {
            const matching = poolOf(tail.events)
            const total = tail.complete ? matching.length : null
            // 解到文件头、或手上已经攒够 RECENT_MESSAGES 条，尾部结果就能当完整结果缓存。
            if (tail.complete || matching.length >= RECENT_MESSAGES) {
              cachePut(recentCache, key, { messages: matching.slice(-RECENT_MESSAGES), total })
            }
            // 尾部解码保证「够 limit 条」或「已到文件头」，两道保险都对不上才回落全量路径。
            if (matching.length >= limit || tail.complete) return chatValue(matching, limit, total)
          }
        }
        const matching = poolOf(readSessionEvents(session.file))
        cachePut(recentCache, key, { messages: matching.slice(-RECENT_MESSAGES), total: matching.length })
        return chatValue(matching, limit, matching.length)
      }
      case 'tasks': {
        const session = findSession(payload?.sessionId)
        if (!session) return { ok: false, error: { code: 'unknown-session', message: '会话不存在' } }
        const { stamp } = stampOf(session.file)
        const key = `${session.id}:${stamp}`
        // 热路径：toCoordination 的最终返回值是纯函数结果，命中就一条解码都不用做。
        // stage 与时间相关，不进缓存，命中缓存后照样现算一遍。
        const hot = cacheGet(coordinationCache, key)
        const base = hot ?? toCoordination(readSessionEvents(session.file))
        if (!hot) cachePut(coordinationCache, key, base)
        return { ok: true, value: tasksWithStage(base, stageContext()) }
      }
      default:
        return { ok: false, error: { code: 'unknown-endpoint', message: `unknown endpoint: ${String(endpoint)}` } }
    }
  } catch (error) {
    return { ok: false, error: { code: 'failed', message: String(error?.message ?? error) } }
  }
}

export async function apply(ctx) {
  trace('apply start')

  // 技能随插件走：装上插件就有 Blender 技能，不用自己 clone。装过什么记在 manifest 里，哈希一致就跳过。
  try {
    const skills = installBundledSkills()
    if (skills.installed.length > 0) trace(`setup skills installed: ${skills.installed.join(', ')}`)
  } catch (error) {
    trace(`setup skills install FAILED: ${errorMessage(error)}`)
  }

  const routeHandler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const endpoint = url.pathname.startsWith(`${RPC_PREFIX}/`) ? url.pathname.slice(RPC_PREFIX.length + 1) : ''
    if (!ENDPOINT_PATTERN.test(endpoint)) {
      res.writeHead(404)
      res.end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end()
      return
    }
    const rejection = ctx.connection?.requestRejection?.({ headers: req.headers })
    if (rejection !== undefined && rejection !== null) {
      res.writeHead(rejection)
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    if (String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      res.writeHead(415)
      res.end()
      return
    }
    let message
    try {
      message = JSON.parse(await readBody(req))
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request'
    const result = await handle(endpoint, message?.payload)
    jsonResponse(res, 200, { type: 'server-response', rpcId, result })
  }

  try {
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: RPC_PREFIX, handler: routeHandler }), 'codenow.route')
    trace(`route registered on ${RPC_PREFIX}`)
  } catch (error) {
    trace(`route register FAILED: ${error?.stack ?? error}`)
  }

  try {
    // 计划任务：定期把已结束的子会话搬进隔离区，不需要任何按钮。
    ctx.effect(() => {
      const run = () => {
        try {
          sweepFinishedChildren() // 自查有搬运/清理才写日志
        } catch (error) {
          trace('sweep FAILED: ' + errorMessage(error))
        }
      }
      // 周期定时器必须在首扫**跑完之后**才创建：早先两个句柄同时启动，setInterval 在 180s 就先跑，
      // 所谓「首次等 600s」根本不成立。两个句柄都 unref；卸载时一起清掉，
      // 若还没到 600s，周期定时器压根没被创建过，自然也不会残留。
      let timer = null
      const firstRun = () => {
        trace('sweep first run') // 每次进程启动只写一行，让「首扫确实等满了 600s」在真机上可观测
        run()
        timer = setInterval(run, SWEEP_INTERVAL_MS)
        if (typeof timer.unref === 'function') timer.unref()
      }
      const first = setTimeout(firstRun, FIRST_SWEEP_DELAY_MS)
      if (typeof first.unref === 'function') first.unref()
      trace('sweep timer armed (' + SWEEP_INTERVAL_MS / 1000 + 's) first=' + FIRST_SWEEP_DELAY_MS / 1000 + 's')
      return () => {
        clearTimeout(first)
        if (timer !== null) clearInterval(timer)
      }
    }, 'codenow.sweep')

    ctx.inject(['tools'], (toolCtx) => {
      toolCtx.effect(() => toolCtx.tools.register(TOOL_DEFINITION), 'codenow.tool')
      trace('tool registered')
    })
  } catch (error) {
    trace(`tool inject FAILED: ${error?.stack ?? error}`)
  }

  try {
    ctx.inject(['agents', 'agentTeams'], (teamCtx) => {
      TEAM_CTX = teamCtx
      trace('team services ready')
      const caps = hostCapabilities()
      trace('host caps teams.isEnabled=' + (caps.teams.isEnabled ? 1 : 0) + ' tryMembership=' + (caps.teams.tryMembership ? 1 : 0) + ' listMembers=' + (caps.teams.listMembers ? 1 : 0) + ' missing=' + (caps.missing.join(',') || '-'))
    })
  } catch (error) {
    trace(`team inject FAILED: ${error?.stack ?? error}`)
  }

  try {
    // 卸载时 clearInterval：旧回调不得在新版本卸载后继续派工。
    ctx.effect(() => startAutonomy(), 'codenow.autonomy')
    trace('autonomy armed')
  } catch (error) {
    trace(`autonomy start FAILED: ${errorMessage(error)}`)
  }

  // 自动分配：让主模型自己按任务拉岗位子智能体，不靠用户点按钮。
  try {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      promptCtx.effect(
        () =>
          promptCtx.systemPrompt.section({
            name: 'codenow:multi-agent',
            order: 3251,
            interpolate: false,
            text: (context) => {
              // 按身份分流：Lead 拿中文派活策略，teammate 拿英文语言段，其余（非本队 agent）不注入。
              // 判据必须走 tryMembership：它对「非 Team 子智能体」和「已失效的身份」返回 undefined，
              // 拿不到身份的（比如从名册掉出去）一律不注入——旧实现按 Lead 处理会把策略塞给子智能体。
              //
              // 宿主有时候不带 agent 调这个回调（官方 dsh-working-directory 也是先判 context.agent === undefined），
              // 那是正常情况、不是错误：直接不注入，别让 tryMembership(undefined) 抛错刷满 boot log。
              const agent = context?.agent
              if (agent === undefined || agent === null) return ''
              try {
                return sectionTextForMembership(memberOfAgent(agent), teamModeEnabled(agent).enabled)
              } catch (error) {
                trace(`policy membership FAILED: ${errorMessage(error)}`)
                return ''
              }
            },
          }),
        'codenow: multi-agent policy'
      )
      trace('system prompt section registered')
    })
  } catch (error) {
    trace(`systemPrompt inject FAILED: ${error?.stack ?? error}`)
  }
}

export default { name, inject, apply }

/**
 * 自检里的「本机没有可测的真实数据」：打印出来，但不算通过也不算失败。
 */
class SkipCheck extends Error {}

/**
 * 自检：`node index.js` 跑，被宿主 import 时不跑。
 * 全程只读真实 ~/.dsh 数据，不动任何目录、不写 boot log。护住最容易悄悄坏掉的事：
 * zstd 分帧（半帧必须报 torn）、sweep 的回收判据、岗位标签匹配、各端点载荷。
 * 有 FAIL 时退出码非 0；skip 只表示本机缺可测数据。
 */
function selfCheck() {
  const results = []
  // 真实数据覆盖不到的分支：只打印，不进 results（不进分母，也不算通过）。
  const unverified = []
  const assert = (ok, message) => {
    if (!ok) throw new Error(message)
  }
  const skip = (message) => {
    throw new SkipCheck(message)
  }
  const check = (label, run) => {
    try {
      results.push({ state: 'ok', label, detail: String(run() ?? '') })
    } catch (error) {
      results.push({ state: error instanceof SkipCheck ? 'skip' : 'fail', label, detail: errorMessage(error) })
    }
  }
  /** 最大的会话最能逼出分帧问题；没有会话时返回 null。 */
  const biggestSession = () => {
    const sessions = listSessions()
    if (sessions.length === 0) return null
    return sessions.reduce((a, b) => (b.bytes > a.bytes ? b : a))
  }

  check('岗位 MD 全文与交接契约', () => {
    const roles = listRoles()
    assert(roles.length > 0, `${ROLES_DIR} 下没有岗位 MD`)
    const byId = new Map(roles.map((role) => [role.id, role]))
    assert(byId.size === roles.length && byId.has('chief-engineer'), '岗位 ID 重复或缺少首席岗位')
    assert(byId.get('wechat-h5-engineer')?.displayName === '微信H5开发工程师', '缺少微信 H5 岗位或显示名不匹配')
    for (const role of roles) {
      assert(role.id && role.body, '有岗位缺 role_id 或正文')
      const raw = readFileSync(role.file, 'utf8').trim()
      assert(roleText(role.id).endsWith(raw), `${role.id} 未透传完整岗位原文`)
      for (const target of role.canHandoffTo) {
        assert(byId.get(target)?.canReceiveFrom.includes(role.id), `${role.id} → ${target} 交接关系不一致`)
      }
      for (const source of role.canReceiveFrom) {
        assert(byId.get(source)?.canHandoffTo.includes(role.id), `${source} → ${role.id} 接收关系不一致`)
      }
    }
    return `${roles.length} 个岗位全文一致，ID 与交接关系通过`
  })

  check('公共规范 _common.md 逐字节前置（等值校验 + 变异必须被拒）', () => {
    const roles = listRoles()
    assert(!roles.some((role) => role.id === '_common'), '_common.md 混进了岗位列表')
    const common = commonRoleText()
    if (!common) skip(`读不到 ${COMMON_ROLE_FILE}`)
    for (const marker of ['## 一、分析规范', '## 二、实施规范', '## 三、协作契约']) {
      assert(common.includes(marker), `公共规范缺少「${marker}」`)
    }
    // 预期文本独立构造：只用约定格式（README「岗位全文的返回结构」）、真实岗位元数据与磁盘原文，
    // 不截取 roleText() 的返回值，否则等于用被测输出验证被测输出。
    const expectedOf = (role, raw) => {
      const tail = role.level && !role.displayName.includes(role.level) ? ` · ${role.level}` : ''
      return [`# ${role.displayName}（${role.id} v${role.version || '?'}${tail}）`, '', common, '', raw.trim()].join('\n')
    }
    // 正式校验逻辑：等值比较；不等值时给出首处差异位置与长度差。真实输出与变异文本都走这一套。
    const diffRoleText = (text, expected) => {
      if (text === expected) return null
      const limit = Math.min(text.length, expected.length)
      let at = 0
      while (at < limit && text[at] === expected[at]) at += 1
      return { at, delta: text.length - expected.length }
    }
    // 变异必须落在已知区域，才能核对「拒绝的理由对不对」——只判非等值，证明不了校验器有效。
    // 插入/等长替换的首处差异必然在插入点；删前缀则随内容重合程度落在 [0, 删除长度] 内，
    // 例如删掉标题后新文本以公共规范的「# 」开头，与前两个字符相同，首处差异就不是 0。
    const mutationsOf = (expected, version) => {
      const afterHeader = expected.indexOf('\n\n') + 2
      const afterCommon = afterHeader + common.length + 2
      const insert = (name, at, text) => ({ name, at, atMax: at, delta: text.length, text: `${expected.slice(0, at)}${text}${expected.slice(at)}` })
      const list = [
        { name: '删掉标题', at: 0, atMax: afterHeader, delta: -afterHeader, text: expected.slice(afterHeader) },
        insert('公共规范重复两遍', afterCommon, `${common}\n\n`),
        insert('中间多插入一段', afterCommon, '临时插入的段落\n\n'),
        insert('标题后多一个空行', afterHeader, '\n'),
      ]
      const wrong = String(version || '').replace(/\d/g, '9')
      const at = version ? expected.indexOf(`v${version}`) : -1
      if (wrong && wrong !== String(version) && at > 0 && at < afterHeader) {
        // 'v' 本身不改，首处差异落在版本号第一个数字上，所以是 at + 1。
        list.push({ name: '标题版本号写错（长度相同）', at: at + 1, atMax: at + 1, delta: 0, text: `${expected.slice(0, at)}v${wrong}${expected.slice(at + 1 + String(version).length)}` })
      }
      return list
    }
    let mutated = 0
    for (const role of roles) {
      const raw = readFileSync(role.file, 'utf8').trim()
      const expected = expectedOf(role, raw)
      const problem = diffRoleText(roleText(role.id), expected)
      if (problem) {
        throw new Error(`${role.id} 的全文不等于「标题+公共规范+岗位原文」：首处差异在 ${problem.at}，长度差 ${problem.delta}`)
      }
      for (const mutation of mutationsOf(expected, role.version)) {
        const rejected = diffRoleText(mutation.text, expected)
        assert(rejected, `${role.id}：${mutation.name} 没有被正式校验逻辑拒绝`)
        assert(rejected.delta === mutation.delta, `${role.id}：${mutation.name} 的长度差不对（${rejected.delta} 应为 ${mutation.delta}）`)
        assert(
          rejected.at >= mutation.at && rejected.at <= mutation.atMax,
          `${role.id}：${mutation.name} 的拒绝位置不对（首处差异 ${rejected.at}，应在 ${mutation.at}..${mutation.atMax}）`,
        )
        mutated += 1
      }
    }
    return `${roles.length} 个岗位全文等值通过；${mutated} 次变异全部在预期位置被拒（公共规范 ${common.length} 字符 / ${common.split('\n').length} 行）`
  })

  check('decodeSession 与旧 magic 切帧逐字节一致', () => {
    const target = biggestSession()
    if (!target) skip(`${DSH_HOME}/sessions 下没有会话`)
    const buffer = readFileSync(target.file)
    const { ranges, torn } = zstdFrameRanges(buffer)
    if (torn !== undefined) {
      // 会话正在被追加时尾部有半帧是正常现象（我们自己这个会话就在写），不当失败；
      // 安静了好几分钟的文件还断着，才是真损坏。
      const idleMs = Date.now() - statSync(target.file).mtimeMs
      if (idleMs < 120_000) skip(`最大的会话此刻正在追加（字节 ${torn} 处半帧，${Math.round(idleMs / 1000)}s 前刚写过）`)
      throw new Error(`帧结构在字节 ${torn} 处断裂（已 ${Math.round(idleMs / 1000)}s 没写过）`)
    }
    assert(ranges.length > 0, '没定位到任何帧')
    const legacy = []
    for (let start = 0; start < buffer.length; ) {
      const next = buffer.indexOf(ZSTD_MAGIC_BYTES, start + ZSTD_MAGIC_BYTES.length)
      const end = next === -1 ? buffer.length : next
      legacy.push(zstdDecompressSync(buffer.subarray(start, end)))
      start = end
    }
    const legacyText = Buffer.concat(legacy).toString('utf8')
    assert(legacyText === decodeSession(buffer), '新旧 decode 输出不一致')
    return `${target.bytes} B / ${ranges.length} 帧 / ${legacyText.length} 字符`
  })

  check('截断到第二帧头必须报 torn（半帧不能当成正常结尾）', () => {
    const target = biggestSession()
    if (!target) skip(`${DSH_HOME}/sessions 下没有会话`)
    const buffer = readFileSync(target.file)
    const { ranges } = zstdFrameRanges(buffer)
    if (ranges.length < 2) skip(`${target.bytes} B 的会话只有 ${ranges.length} 帧，切不出第二帧边界`)
    const cut = ranges[1].start
    for (const extra of [1, 2, 3]) {
      const truncated = buffer.subarray(0, cut + extra)
      assert(zstdFrameRanges(truncated).torn === cut, `截到 ${cut}+${extra} 字节时没报 torn=${cut}`)
      // 宽松解码要给出已解出的部分 + torn；严格 decodeSession 必须抛错，不能静默少一段。
      const decoded = decodeSessionFrames(truncated)
      assert(decoded.torn === cut && decoded.text.length > 0, `宽松解码没报 torn 或没解出内容（torn=${decoded.torn}）`)
      let thrown = ''
      try {
        decodeSession(truncated)
      } catch (error) {
        thrown = errorMessage(error)
      }
      assert(thrown.includes(String(cut)), `严格 decodeSession 没有抛断帧错（${thrown || '没有抛错'}）`)
    }
    return `第二帧头在字节 ${cut}，截断 1/2/3 字节全部报 torn`
  })

  check('sweep 判据（真实数据驱动，不移动任何目录）', () => {
    const rows = scanChildSessions()
    if (rows.length === 0) skip('没有派生子会话，判据无从验证')
    // 最坏情况：活集合给空集 + 时钟推过宽限期（此刻安静的会话都算超期）。
    // 这里没有合成行 —— 只用真实扫描出来的行，只操纵「时钟」和「活集合」这两个判据的输入。
    const worst = planSweep(new Set(), Date.now() + SWEEP_GRACE_MS + 60_000, rows)
    for (const candidate of worst.candidates) {
      assert(candidate.mode === 'one-shot', `候选不是 one-shot：${candidate.id} mode=${candidate.mode || '(读不到)'}`)
      assert(candidate.parentDirExists === false, `候选的父目录还在或位置未知：${candidate.id}`)
      assert(candidate.tailSettled === true, `候选的尾巴没看到收尾证据：${candidate.id}`)
    }
    // 活集合：把真实行全部当活会话，一条候选都不许出。
    const allLive = planSweep(new Set(rows.map((row) => row.id)), Date.now() + SWEEP_GRACE_MS + 60_000, rows)
    assert(allLive.candidates.length === 0 && allLive.excludedBy.live === rows.length, `活会话没被全部排除：${JSON.stringify(allLive.excludedBy)}`)
    // 宽限期：时钟压到最早一行的 1 秒后，所有真实行都该落在 grace。
    const quiet = planSweep(new Set(), Math.min(...rows.map((row) => row.updatedAt)) + 1000, rows)
    assert(quiet.candidates.length === 0 && quiet.excludedBy.grace === rows.length, `宽限期没拦住：${JSON.stringify(quiet.excludedBy)}`)
    // 逐行统计**每个判据**的真实覆盖（互不排斥，按谓词各算各的），
    // 某个判据一个真实样本都没有就明确打「未验证」，不计入通过。
    const seen = { parentAlive: 0, parentUnknown: 0, continuable: 0, modeUnknown: 0, tailUnsettled: 0, oneShot: 0 }
    for (const row of rows) {
      if (row.parentDirExists === true) seen.parentAlive += 1
      if (row.parentDirExists === null) seen.parentUnknown += 1
      if (row.mode === 'continuable') seen.continuable += 1
      else if (row.mode !== 'one-shot') seen.modeUnknown += 1
      else if (!row.tailSettled) seen.tailUnsettled += 1
      else if (row.parentDirExists === false) seen.oneShot += 1
    }
    for (const [branch, count] of Object.entries(seen)) {
      if (count === 0) unverified.push(`未验证：${branch}（真实数据未覆盖）`)
    }
    const summary = Object.entries(seen)
      .filter(([, count]) => count > 0)
      .map(([branch, count]) => `${branch}=${count}`)
      .join(' ')
    return `${rows.length} 个真实派生子会话：候选 ${worst.candidates.length}；分支分布 ${summary || '无'}`
  })

  check('干跑真实数据：候选与排除分布（不移动任何目录）', () => {
    const rows = scanChildSessions()
    if (rows.length === 0) skip('没有派生子会话')
    // 时钟往后推过宽限期＝最坏情况（此刻安静的子会话也算超期）；自检里 TEAM_CTX 为空，
    // 拿不到 registry，liveIds 只能给空集，同样是最坏情况。
    const worst = planSweep(new Set(), Date.now() + SWEEP_GRACE_MS + 60_000, rows)
    const real = planSweep(new Set(), Date.now(), rows)
    const dist = Object.entries(worst.excludedBy)
      .filter(([, count]) => count > 0)
      .map(([key, count]) => `${key}=${count}`)
      .join(' ')
    const parentsAlive = rows.filter((row) => row.parentDirExists === true).length
    return `扫到 ${rows.length} 个派生子会话（父目录仍在 ${parentsAlive}）；此刻候选 ${real.candidates.length}，忽略宽限期与活会话后候选 ${worst.candidates.length}（排除 ${dist || '无'}）`
  })

  check('session/end-seed 不算收尾证据（宿主建会话/恢复时都会写它）', () => {
    // 这个事件标记的是生命周期起点，不是完成：宿主建会话、继承、恢复时都会写，
    // 真实库里它出现在 28/90 个会话的日志中段。把它当收尾证据会误隔离还能续跑的会话。
    assert(SETTLED_TAIL_TYPES.has('session/end-seed') === false, 'session/end-seed 仍在收尾白名单里')
    assert(SETTLED_TAIL_TYPES.has('turn/end') === true, 'turn/end 被误删出白名单')
    const sample = listSessions().find((row) => String(readSessionTail(row.file).event?.type ?? '') === 'session/end-seed')
    if (!sample) skip('本机没有以 session/end-seed 收尾的会话，无法用真实数据验证')
    assert(tailSettled(sample.file) === false, `${sample.id} 的尾巴是 session/end-seed，却被判成已收尾`)
    return `${sample.id} 尾巴为 session/end-seed → tailSettled=false`
  })

  check('岗位标签精确匹配', () => {
    const roles = listRoles()
    for (const role of roles) {
      assert(roleLabelOf(role.id) === role.displayName, `${role.id} 未映射到自己的岗位名`)
    }
    const sample = roles[0]
    assert(roleLabelOf(`子智能体 ${sample.id}`) === sample.displayName, `夹带文本时未命中 ${sample.id}`)
    return `${roles.length} 个岗位 id 全部命中`
  })

  check('sessions / chat 的入参契约', () => {
    const page = sessionsPayload({ limit: 2 })
    assert(page.items.length <= 2 && page.total >= page.items.length, `分页切片不对：${page.items.length}/${page.total}`)
    assert(page.limit === 2 && page.offset === 0, `分页回显不对：${JSON.stringify({ limit: page.limit, offset: page.offset })}`)
    const clamped = sessionsPayload({ limit: 100000 })
    assert(clamped.limit === SESSIONS_LIMIT_MAX, `limit 没夹到上限：${clamped.limit}`)
    const fallback = sessionsPayload({ limit: -5, offset: -3 })
    assert(fallback.limit === SESSIONS_LIMIT_DEFAULT && fallback.offset === 0, '非法 limit/offset 没退回默认')
    const limits = [undefined, 0, -5, 3.7, '', 50, 700, '300'].map((value) => chatLimit(value))
    assert(String(limits) === String([50, 50, 50, 50, 50, 50, 500, 300]), `chatLimit 不合约：${limits}`)
    // withUsage 只是过滤，总数不能比全量还多。
    const withUsage = sessionsPayload({ withUsage: true, limit: 1 })
    assert(withUsage.total <= page.total, `withUsage 的 total 反而更大：${withUsage.total} > ${page.total}`)
    const title = String(page.items[0]?.title ?? '').trim()
    if (title !== '') {
      const hit = sessionsPayload({ q: title.slice(0, Math.min(8, title.length)).toLowerCase() })
      assert(hit.total >= 1, `q 搜不到已知标题：${title.slice(0, 8)}`)
    }
    return `total=${page.total} limit 上限 ${clamped.limit} / 非法 ${fallback.limit} / chat ${limits.join(',')}`
  })

  check('会话首事件快路径与完整头部窗口一致', () => {
    const rows = listSessions()
    if (rows.length === 0) skip('本机没有会话')
    for (const row of rows) {
      const view = readWindow(row.file, 0, HEAD_BYTES)
      assert(view, '会话头部读取失败')
      const expected = parseFirstEvent(decodeSessionFrames(view).text)
      assert(JSON.stringify(readSessionHead(row.file)) === JSON.stringify(expected), '首帧快路径与完整窗口不一致')
    }
    return `${rows.length} 个真实会话首事件逐字节一致`
  })

  check('会话扫描不加载标题投影，分页只读取返回行', () => {
    projectionCache.clear()
    const rows = listSessions()
    if (rows.length === 0) skip('本机没有会话')
    assert(projectionCache.size === 0, '元数据扫描提前加载了标题投影')
    const page = sessionsPayload({ limit: 2 })
    const ids = new Set(page.items.map((row) => normalizeSessionId(row.id)))
    assert([...projectionCache.keys()].every((id) => ids.has(id)), '分页读取了返回行之外的标题投影')
    for (const item of page.items) {
      assert(item.title === readProjection(item.id).title, '分页标题与真实投影不符')
    }
    return `${rows.length} 个会话扫描未读取标题，仅返回 ${page.items.length} 条时取标题`
  })

  check('任务 stage 只吃结构化字段（含停摆启发式与不可判定分支）', () => {
    assert(taskStageOf.length === 2, `taskStageOf 只能接收 (task, ctx) 两个参数，实际 ${taskStageOf.length}`)
    const ctx = { liveCount: 1, now: 1_000_000_000_000, stallMs: STALL_MS }
    const oldAt = ctx.now - STALL_MS - 1
    const cases = [
      [{ status: 'completed', blockedBy: [], at: ctx.now }, 1, 'review', 'person'],
      [{ status: 'in_progress', blockedBy: ['task-1'], at: ctx.now }, 1, 'blocked', 'agent'],
      [{ status: 'pending', blockedBy: [], at: ctx.now }, 0, 'queued', 'none'],
      [{ status: 'in_progress', blockedBy: [], at: ctx.now }, 1, 'working', 'agent'],
      [{ status: 'in_progress', blockedBy: [], at: oldAt }, 0, 'stalled', 'unknown'],
      [{ status: 'in_progress', blockedBy: [], at: oldAt }, 1, 'working', 'agent'],
      [{ status: '', blockedBy: [], at: ctx.now }, 1, 'unknown', 'unknown'],
    ]
    for (const [task, liveCount, stage, waitingOn] of cases) {
      const got = taskStageOf(task, { ...ctx, liveCount })
      assert(
        got.stage === stage && got.waitingOn === waitingOn,
        `${JSON.stringify(task)} @live=${liveCount} 期望 ${stage}/${waitingOn}，实际 ${got.stage}/${got.waitingOn}`,
      )
    }
    // registry 拿不到活跃成员数时不许判停摆：宁可说 working，也不误报「停摆」。
    const blind = taskStageOf({ status: 'in_progress', blockedBy: [], at: oldAt }, { ...ctx, liveCount: null })
    assert(blind.stage === 'working', `liveCount 未知时不应判停摆，实际 ${blind.stage}`)
    // 重载宿主不会打断在跑的工作：首扫必须等满 10 分钟。
    assert(FIRST_SWEEP_DELAY_MS >= 600_000, `首扫间隔必须 ≥600 秒，实际 ${FIRST_SWEEP_DELAY_MS}ms`)
    return `${cases.length} 类映射通过；活跃数未知时不判停摆；首扫 ${FIRST_SWEEP_DELAY_MS / 1000} 秒`
  })

  check('大文件尾部解码与全量解码逐字节一致', () => {
    const target = biggestSession()
    if (!target) skip(`${DSH_HOME}/sessions 下没有会话`)
    if (target.bytes <= CHAT_TAIL_MIN_BYTES) skip(`最大的会话只有 ${target.bytes} B，根本不走尾部解码`)
    let events = []
    try {
      events = readSessionEvents(target.file)
    } catch (error) {
      skip(`最大的会话此刻读不全（${errorMessage(error)}）`)
    }
    const size = stampOf(target.file).size
    const rounds = []
    for (const limit of [1, 50, RECENT_MESSAGES]) {
      const tail = decodeSessionTail(target.file, limit, size)
      if (!tail) {
        // 只有「窗口里攒不够这么多消息」才允许降级：那是性能回落，不是正确性问题。
        if (limit === 1) throw new Error('连 limit=1 都解不出来（末条消息离文件末尾超过 8 MB，或尾部帧解不开）')
        skip(`limit=${limit} 时 8 MB 尾部窗口攒不够 ${limit} 条消息（chat 会回落全量路径，功能不受影响）`)
      }
      const fast = toMessages(tail.events, limit)
      const full = toMessages(events, limit)
      assert(
        JSON.stringify(fast) === JSON.stringify(full),
        `limit=${limit} 时尾部解码与全量不一致（${fast.length} 条 / ${full.length} 条）`
      )
      rounds.push(`${limit}:${fast.length} 条`)
    }
    return `${target.bytes} B，${rounds.join(' / ')} 与全量逐字节一致`
  })

  check('state 载荷可构造', () => {
    const state = statePayload()
    assert(Array.isArray(state.roles) && Array.isArray(state.sessions), 'roles / sessions 不是数组')
    assert(Array.isArray(state.trend), 'trend 不是数组')
    assert(Number.isInteger(state.sessionsTotal) && state.sessionsTotal >= state.sessions.length, 'sessionsTotal 不对')
    assert(Array.isArray(state.byProviderModel), 'byProviderModel 不是数组')
    assert(typeof state.currency === 'string' && state.currency !== '', 'currency 缺失')
    assert(state.trend.length <= TREND_DAYS, `trend 超过 ${TREND_DAYS} 天`)
    return `${state.sessionsTotal} 个会话（列表 ${state.sessions.length}）/ ${state.roles.length} 个岗位 / 账本${state.ledgerFound ? '已找到' : '缺失'}（${state.currency}，${state.byProviderModel.length} 个 provider:model，trend ${state.trend.length} 天）`
  })

  check('语言分段按身份分流（Lead 中文 / teammate 英文 / 其余不注入）', () => {
    const lead = sectionTextForMembership({ role: 'lead' }, false)
    const mate = sectionTextForMembership({ role: 'teammate' })
    const none = sectionTextForMembership(undefined)
    const other = sectionTextForMembership({ role: 'spectator' })
    assert(lead === policyText(false) && lead.includes('简体中文'), 'Lead 分支没有拿到中文策略或缺少语言条款')
    assert(mate === TEAMMATE_LANGUAGE, 'teammate 分支没有拿到英文语言段')
    // 英文段里混进中文就等于给子智能体发了两条相反指令，用纯 ASCII 把它钉死。
    // eslint-disable-next-line no-control-regex
    assert(/^[\x09\x0A\x0D\x20-\x7E]*$/.test(mate), 'teammate 语言段含非 ASCII 字符')
    assert(!/[\u4e00-\u9fa5]/.test(mate), 'teammate 语言段含中文')
    assert(mate.includes('This overrides any other language instruction'), 'teammate 语言段没有声明覆盖预设的中文要求')
    assert(none === '' && other === '', '非本队身份不该被注入语言段')
    return `Lead ${lead.length} 字符（中文）/ teammate ${mate.length} 字符（纯 ASCII）/ 无身份与其它角色均不注入`
  })

  check('派活强度跟随团队协作开关（开=强制 / 关=按需）', () => {
    const on = policyText(true)
    const off = policyText(false)
    assert(sectionTextForMembership({ role: 'lead' }, true) === on, 'Lead 分段没有跟随开关打开')
    assert(sectionTextForMembership({ role: 'lead' }, false) === off, 'Lead 分段没有跟随开关关闭')
    assert(on.includes('**派活（强制）**') && on.includes('必须'), '开关打开时没有要求强制派活')
    assert(!on.includes('允许零个 teammate'), '开关打开时还留着「允许零个 teammate」')
    assert(off.includes('**派活（按需）**') && off.includes('允许零个 teammate'), '开关关闭时没有放宽为按需')
    // 只有派活段随开关变，其余必须逐字相同——否则开关会顺手改掉别的规则。
    const strip = (text) => text.replace(DISPATCH_ON, '').replace(DISPATCH_OFF, '')
    assert(strip(on) === strip(off), '除派活段以外还有文本随开关变化')
    assert(Math.abs(on.length - off.length) < 400, '两版长度差异过大，说明分叉失控')
    for (const id of ['frontend-design-engineer', 'wechat-h5-engineer', 'backend-engineer', 'test-engineer', 'modeling-engineer']) {
      assert(on.includes(id) && off.includes(id), `路由表缺 ${id}`)
    }
    const mode = teamModeEnabled(undefined)
    assert(typeof mode.enabled === 'boolean' && typeof mode.source === 'string', 'teamModeEnabled 没有返回可判定结果')
    return `开关开 ${on.length} 字符 / 开关关 ${off.length} 字符，除派活段外逐字相同`
  })

  check('派活通道指向宿主真实提供的工具', () => {
    const policy = CODENOW_POLICY
    assert(policy.includes('subagent'), '策略没有提到 subagent')
    assert(policy.includes('wait_agent') || policy.includes('send_message'), '策略没有说明如何等结果/追问')
    for (const name of ['subagent', 'subagent_fork', 'team_task_create', 'send_message']) {
      assert(COORDINATION_TOOLS.test(name), `协调工具正则漏了 ${name}`)
    }
    const dispatch = policy.split('\n').find((line) => line.startsWith('**派活（默认必须）**')) ?? ''
    assert(dispatch.includes('subagent'), '派活首选通道不是 subagent')
    const spawnAt = dispatch.indexOf('spawn_teammate')
    if (spawnAt >= 0) assert(spawnAt > dispatch.indexOf('subagent'), '派活首选通道仍写着 spawn_teammate')
  })

  check('项目状态按 root 隔离、迁移必须显式、坏文件不猜', () => {
    const home = join(tmpdir(), `cn-autonomy-${randomUUID()}`)
    const legacyHome = join(tmpdir(), `cn-autonomy-legacy-${randomUUID()}`)
    const noRootHome = join(tmpdir(), `cn-autonomy-noroot-${randomUUID()}`)
    try {
      assert(storePath(home, '../escape') === null, '非法 root 竟然拼出了路径')
      const rootA = 'session-a'
      const rootB = 'session-b'
      writeState(home, rootA, emptyState(rootA))
      const a = readState(home, rootA).state
      openProject(a, { objective: 'A 的项目', acceptance: ['a1'] })
      writeState(home, rootA, a)
      assert(readState(home, rootB).state.projects.length === 0, 'B 读到了 A 的项目（root 没隔离）')
      assert(readState(home, rootA).state.projects.length === 1, 'A 的项目没落盘')

      writeState(home, rootB, emptyState(rootB))
      writeFileSync(storePath(home, rootB), '{"version":99}', 'utf8')
      assert(readState(home, rootB).problem === 'unsupported-version:99', '未知版本没报出来')
      writeFileSync(storePath(home, rootB), 'not json', 'utf8')
      assert(String(readState(home, rootB).problem).startsWith('parse-error'), '坏 JSON 没被识别')

      mkdirSync(dirname(legacyStorePath(legacyHome)), { recursive: true })
      writeFileSync(legacyStorePath(legacyHome), JSON.stringify({
        version: 1,
        rootSessionId: 'session-old',
        stop: null,
        projects: [{ id: 'p1', objective: '旧项目', acceptance: ['旧验收'], tasks: [], questions: [], verifications: [], continuation: null }],
        deliveries: [{ key: 'c1:5', childId: 'c1', seq: 5 }],
      }), 'utf8')
      assert(readState(legacyHome, 'session-old').problem === 'legacy-migration-required', '读取时不该隐式迁移')
      const migrated = migrateLegacy(legacyHome, 'session-old')
      assert(migrated.migrated === true && migrated.problem === null, `显式迁移失败：${migrated.problem}`)
      const after = readState(legacyHome, 'session-old').state
      assert(after.projects[0].acceptance[0].text === '旧验收', '验收条目没转成 {text,evidence}')
      assert(Object.keys(after.deliveries).length === 1, '旧投递记录没转成对象表')

      mkdirSync(dirname(legacyStorePath(noRootHome)), { recursive: true })
      writeFileSync(legacyStorePath(noRootHome), JSON.stringify({ version: 1, projects: [], deliveries: [] }), 'utf8')
      const refused = migrateLegacy(noRootHome, 'session-new')
      assert(refused.migrated === false && refused.problem === 'legacy-owner-unverified', '没有归属的旧文件被强行迁移')
      assert(existsSync(legacyStorePath(noRootHome)), '被拒绝的旧文件被删了')
      return 'root 隔离、未知版本、坏 JSON、显式迁移、无归属拒绝，全部按预期'
    } finally {
      try { rmSync(home, { recursive: true, force: true }) } catch {}
      try { rmSync(legacyHome, { recursive: true, force: true }) } catch {}
      try { rmSync(noRootHome, { recursive: true, force: true }) } catch {}
    }
  })

  check('自动接续只认 turn/end、早于登记的结果标 lateBind 不丢、必须能对回任务', () => {
    const state = emptyState('session-1')
    const project = openProject(state, { objective: '验证接续判定', acceptance: ['真实通过'] })
    const task = upsertTask(project, { id: 't1', title: '子任务', owner: 'backend-engineer', ownerSessionId: 'session-owner', status: 'in_progress', childSessionId: 'session-c1' })
    const taskOfChild = (child) => (child.id === task.childSessionId ? 't1' : null)
    const child = { id: 'session-c1', lastSeq: 7, tailType: 'turn/end', lastEventAt: new Date(Date.now() + 1000).toISOString() }
    const base = { state, project, children: [child], leadTurnIdle: true, taskOfChild }
    const first = decideContinuation(base)
    assert(first.deliver === true && first.taskId === 't1', '有未处理的 turn/end 却没唤醒或没对回任务')
    assert(String(first.key).includes(':session-c1:'), `投递键没带归一化子会话 id：${first.key}`)
    // 早于登记时间的结果不丢弃：先完成后补登记真实存在，改成投递并标 lateBind 让 Lead 判断。
    const late = decideContinuation({ ...base, children: [{ ...child, lastEventAt: '2020-01-01T00:00:00Z' }] })
    assert(late.deliver === true && late.lateBind === true, `登记之前的结果被丢掉或没标 lateBind：${JSON.stringify({ deliver: late.deliver, lateBind: late.lateBind })}`)
    assert(decideContinuation({ ...base, children: [{ ...child, tailType: 'session/end-seed' }] }).deliver === false, 'session/end-seed 被当成完成信号')
    assert(decideContinuation({ ...base, taskOfChild: () => null }).reason === 'unmapped-child', '对不回任务的子会话仍然投递')
    markDelivery(state, first, 'sent', null)
    assert(decideContinuation(base).deliver === false, '同一个 seq 被重复唤醒')
    assert(state.deliveries[first.key]?.status === 'sent', '投递状态没落进状态表')
    assert(decideContinuation({ ...base, leadTurnIdle: false }).reason === 'lead-busy', 'Lead 正在跑时仍然唤醒')
    assert(decideContinuation({ ...base, project: null }).reason === 'no-open-project', '没有项目时仍然唤醒')
    addQuestion(project, { taskId: 't1', kind: 'business', question: '缺口径' })
    const blocked = decideContinuation({ ...base, children: [{ ...child, lastSeq: 8 }] })
    assert(blocked.deliver === false && blocked.reason === 'tasks-blocked', `任务级未答问题没挡住接续：`)
    answerQuestion(project, { questionId: project.questions[0].id, answer: '按 123' })
    setStop(state, { reason: '用户叫停' })
    assert(decideContinuation({ ...base, children: [{ ...child, lastSeq: 9 }] }).reason === 'stopped', '叫停后仍然唤醒')
    return '只认 turn/end 与登记之后的结果；end-seed、登记前结果、无映射、重复 seq、Lead 忙、无项目、待用户、叫停都不唤醒'
  })

  check('投递恢复只重试该重试的（退避、上限、状态机）', () => {
    const nowMs = Date.now()
    const base = { key: 'r:c:5', messageId: 'm1', attempts: 1, text: 'n' }
    const stale = { ...base, status: 'sending', at: new Date(nowMs - 120000).toISOString() + '#9' }
    const fresh = { ...base, status: 'sending', at: new Date(nowMs - 1000).toISOString() + '#9' }
    if (!deliveryNeedsRetry(stale, nowMs)) throw new Error('sending 超过窗口应重试')
    if (deliveryNeedsRetry(fresh, nowMs)) throw new Error('sending 刚发出不该重试')
    if (!deliveryNeedsRetry({ ...base, status: 'unknown', retryAt: new Date(nowMs - 1).toISOString() }, nowMs)) throw new Error('退避到期应重试')
    if (deliveryNeedsRetry({ ...base, status: 'unknown', retryAt: new Date(nowMs + 60000).toISOString() }, nowMs)) throw new Error('退避未到不该重试')
    if (deliveryNeedsRetry({ ...base, attempts: 3, status: 'unknown' }, nowMs)) throw new Error('跑满上限不该重试')
    if (deliveryNeedsRetry({ ...base, status: 'sent' }, nowMs)) throw new Error('sent 不该重试')
    if (deliveryNeedsRetry({ ...base, status: 'consumed' }, nowMs)) throw new Error('consumed 不该重试')
    if (deliveryNeedsRetry({ key: 'k', status: 'unknown' }, nowMs)) throw new Error('没有 messageId 不该重试')
    const st = emptyState('r')
    const row = markDelivery(st, { ...base, text: '正文' }, 'sending', null)
    if (row.attempts !== 1 || row.text !== '正文') throw new Error('sending 应记尝试与正文')
    markDelivery(st, { ...base }, 'sent', null)
    const again = markDelivery(st, { ...base }, 'sending', null)
    if (again.attempts !== 2 || again.messageId !== 'm1') throw new Error('重试应复用 messageId 并累加尝试')
    return 'sending/unknown/sent/consumed 8 种组合，重试复用同一 messageId'
  })

  check('交付门禁逐条可拒、复核不可伪造、产物变了旧复核失效', () => {
    const dir = join(tmpdir(), `cn-gate-${randomUUID()}`)
    try {
      mkdirSync(dir, { recursive: true })
      const artifact = join(dir, 'out.glb')
      writeFileSync(artifact, 'glTF-v1', 'utf8')
      const state = emptyState('session-2')
      const project = openProject(state, { objective: '门禁', acceptance: ['验收一'] })
      let blockers = deliverBlockers(project, state)
      assert(blockers.some((row) => row.includes('没有任何任务')), '没有任务时门禁没拦住')
      assert(blockers.some((row) => row.includes('缺证据')), '验收缺证据时门禁没拦住')
      const task = upsertTask(project, { id: 't1', title: 'x', owner: 'backend-engineer', ownerSessionId: 'session-owner', status: 'in_progress', artifacts: [artifact] })
      refreshArtifacts(project)
      assert(String(task.artifactStamp).startsWith('sha256:'), `产物版本没按内容算：${task.artifactStamp}`)
      assert(deliverBlockers(project, state).some((row) => row.includes('未通过复核')), '未复核就允许交付')
      const rej = (fn) => {
        try { fn(); return '' } catch (error) { return errorMessage(error) }
      }
      const stamp = task.artifactStamp
      const ok = { taskId: 't1', reviewer: 'code-quality-reviewer', verdict: 'pass', evidence: '真实跑过', artifactStamp: stamp, source: 'team-tool', reviewerSessionId: 'session-rev', callId: 'call-1' }
      assert(rej(() => recordVerification(project, { ...ok, taskId: 't9' })) === 'unknown-task', '未知任务没有被拦住')
      assert(rej(() => recordVerification(project, { ...ok, reviewer: 'backend-engineer' })) === 'reviewer-cannot-be-owner', '自证没有被拦住')
      assert(rej(() => recordVerification(project, { ...ok, reviewer: '' })) === 'reviewer-required', '空复核者没有被拦住')
      assert(rej(() => recordVerification(project, { ...ok, verdict: 'ok' })) === 'verdict-invalid:ok', '非法 verdict 没有被拦住')
      assert(rej(() => recordVerification(project, { ...ok, source: undefined })) === 'reviewer-provenance-required', '缺少调用来源没有被拦住')
      assert(rej(() => recordVerification(project, { ...ok, reviewerSessionId: 'session-owner' })) === 'reviewer-cannot-be-owner', '复核者与执行者同会话没有被拦住')
      assert(rej(() => recordVerification(project, { ...ok, artifactStamp: '' })) === 'artifact-stamp-required', '缺版本没有被拦住')
      assert(rej(() => recordVerification(project, { ...ok, artifactStamp: 'sha256:stale' })).startsWith('stale-artifact-stamp'), '旧版本没有被拦住')
      assert(rej(() => recordVerification(project, { ...ok, evidence: '  ' })) === 'evidence-required', '空证据没有被拦住')
      recordVerification(project, ok)
      const record = project.tasks.find((row) => row.id === 't1').verification
      assert(record.verdict === 'pass' && record.reviewerSessionId === 'session-rev' && record.callId === 'call-1', '复核来源没有记进记录')
      blockers = deliverBlockers(project, state)
      assert(blockers.length === 1 && blockers[0].includes('缺证据'), `复核过后应只剩验收缺证据，实际：${blockers.join('；')}`)
      project.acceptance[0].evidence = '导出文件 123 B'
      assert(deliverBlockers(project, state).length === 0, `验收证据补齐后门禁仍拦：${deliverBlockers(project, state).join('；')}`)
      writeFileSync(artifact, 'glTF-v2-内容变了', 'utf8')
      refreshArtifacts(project)
      const after = project.tasks.find((row) => row.id === 't1')
      assert(after.artifactStamp !== stamp, '同路径改内容后产物版本没变')
      assert(after.status === 'rework', `产物变了任务状态没退回返工：${after.status}`)
      const stale = deliverBlockers(project, state)
      assert(stale.some((row) => row.includes('未通过复核') || row.includes('复核早于当前产物')), `产物变了旧复核没有失效：${stale.join('；')}`)
      return '未知任务 / 自证 / 空复核者 / 非法 verdict / 缺来源 / 同会话 / 缺版本 / 旧版本 / 空证据 / 产物变更，十种都拦住'
    } finally {
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  })
  check('团队身份在无 membership API 时按会话父子判定（新版 DSH 已删 tryMembership）', () => {
    const rows = listSessions()
    let child = null
    let parentId = ''
    for (const row of rows) {
      let head = {}
      try {
        head = readSessionHead(row.file) ?? {}
      } catch {
        head = {}
      }
      const parent = rootOf(head?.parentSession ?? '')
      if (parent) {
        child = row
        parentId = parent
        break
      }
    }
    if (!child) return skip('磁盘上此刻没有派生子会话')
    const childId = normalizeSessionId(child.id)
    const asChild = memberOfAgent({ session: { id: childId } })
    assert(asChild?.role === 'teammate', `子会话没被判成 teammate：${asChild?.role}`)
    assert(asChild?.rootSessionId === parentId, `子会话的 root 不对：${asChild?.rootSessionId} != ${parentId}`)
    assert(asChild?.name === readSubagentLabel(parentId, childId), '子会话名字没取到父会话投影里的 label')
    const asLead = memberOfAgent({ session: { id: parentId } })
    assert(asLead?.role === 'lead', `根会话没被判成 lead：${asLead?.role}`)
    assert(asLead?.rootSessionId === parentId, '根会话的 root 不是自己')
    assert(memberRecordOf(parentId, childId)?.role === 'teammate', 'memberRecordOf 没认出真子会话')
    assert(memberRecordOf(parentId, 'not-a-child-of-this-root') === null, 'memberRecordOf 把陌生会话认成成员')
    assert(memberOfAgent({ session: { id: 'deadbeef-0000-0000-0000-000000000000' } }) === null, '磁盘上不存在的会话被猜成了 lead')
    return `真实子会话 ${childId} → teammate（root=${parentId}，name=${asChild.name || '（投影缺 label）'}）/ 根会话 → lead`
  })
  check('宿主版本兼容：投影形状无关解析 + 能力探测', () => {
    // 投影结构从 v1 演进到 v7，未来还可能加版本；解析只认形状，不认版本号。
    const rows = { title: { val: '标题A' }, modelSelection: { val: { lastUsed: { model: 'm1' } } } }
    const shapes = [
      ['v7', { version: 7, record: { rows } }],
      ['v9', { version: 9, record: { rows } }],
      ['legacy', { title: '标题A', model: 'm1' }],
    ]
    for (const [name, raw] of shapes) {
      const got = projectionValue(raw)
      assert(got.title === '标题A' && got.model === 'm1', name + ' 形状解析不符：' + JSON.stringify(got))
    }
    const empty = projectionValue({})
    assert(empty.title === '' && empty.model === '', '空投影应返回空串而不是猜值')
    const caps = hostCapabilities()
    assert(typeof caps.teams.isEnabled === 'boolean' && typeof caps.agents.list === 'boolean', '能力快照类型不对')
    assert(Array.isArray(caps.missing), '能力快照缺 missing 列表')
    return '投影 v7/v9/旧版三种形状一致；当前缺项 ' + caps.missing.length + '（' + (caps.missing.join(',') || '无') + '）'
  })
  for (const result of results) {
    const tag = result.state === 'ok' ? 'ok  ' : result.state === 'skip' ? 'skip' : 'FAIL'
    console.log(`${tag} ${result.label}${result.detail ? ` — ${result.detail}` : ''}`)
  }
  for (const line of unverified) console.log(line)
  const passed = results.filter((result) => result.state === 'ok').length
  const skipped = results.filter((result) => result.state === 'skip').length
  const failed = results.filter((result) => result.state === 'fail').length
  console.log(`codenow 自检：${passed} 通过 / ${skipped} 跳过 / ${failed} 失败（home=${DSH_HOME}）`)
  return failed
}

/** argv[1] 与自身路径一致 = 被 `node index.js` 直接执行（而不是被宿主 import）。 */
function invokedDirectly() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return pathToFileURL(entry).href === import.meta.url
  } catch {
    return false
  }
}

if (invokedDirectly()) process.exitCode = selfCheck() === 0 ? 0 : 1
