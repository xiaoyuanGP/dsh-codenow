/**
 * dsh-codenow — Client half。
 *
 * 侧边栏新增「协同工作台」：岗位库、群聊回放、团队任务、
 * 各 agent 的缓存与用量。数据全部来自 Host 半边 `/codenow` RPC。
 */
window.__ModuleLoader__.load({
  id: 'dsh-codenow',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    /** Connection-service sender installed by apply(); null when unavailable. */
    let viaConnection = null

    function fetchRpc(endpoint, payload) {
      const rpcId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      return fetch(`/codenow/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload }),
      }).then((response) => {
        if (!response.ok) {
          return response.text().then((text) => ({
            ok: false,
            error: { code: `http-${response.status}`, message: text || response.statusText },
          }))
        }
        return response.json().then((body) =>
          body && body.type === 'server-response' && body.result ? body.result : { ok: true, value: body }
        )
      })
    }

    function callRpc(endpoint, payload) {
      return viaConnection
        ? Promise.resolve(viaConnection('/codenow', endpoint, payload)).catch(() => fetchRpc(endpoint, payload))
        : fetchRpc(endpoint, payload)
    }

    const EDGE = 'color-mix(in srgb, currentColor 16%, transparent)'
    const SOFT = 'color-mix(in srgb, currentColor 7%, transparent)'
    const MUTED = 'color-mix(in srgb, currentColor 62%, transparent)'
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

    const S = {
      root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden', fontSize: 13 },
      header: { display: 'flex', alignItems: 'flex-start', gap: 16, padding: '20px 24px 12px' },
      title: { fontSize: 17, fontWeight: 600, lineHeight: 1.3 },
      subtitle: { marginTop: 4, fontSize: 12, color: MUTED, lineHeight: 1.5 },
      spacer: { flex: 1 },
      tabs: {
        display: 'flex',
        gap: 4,
        padding: '0 24px',
        borderBottom: `1px solid ${EDGE}`,
      },
      tab: {
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        color: MUTED,
        padding: '9px 12px',
        fontSize: 12.5,
        cursor: 'pointer',
        fontFamily: 'inherit',
        borderBottom: '2px solid transparent',
        marginBottom: -1,
      },
      tabOn: { color: 'inherit', fontWeight: 600, borderBottom: '2px solid currentColor' },
      body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 24px 28px', display: 'flex', flexDirection: 'column', gap: 12 },
      btn: {
        appearance: 'none',
        border: `1px solid ${EDGE}`,
        background: SOFT,
        color: 'inherit',
        borderRadius: 8,
        padding: '6px 12px',
        fontSize: 12,
        lineHeight: '18px',
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      input: {
        appearance: 'none',
        boxSizing: 'border-box',
        width: '100%',
        border: `1px solid ${EDGE}`,
        background: SOFT,
        color: 'inherit',
        borderRadius: 8,
        padding: '5px 9px',
        fontSize: 12,
        fontFamily: 'inherit',
      },
      card: { border: `1px solid ${EDGE}`, borderRadius: 10, padding: '12px 14px' },
      cardTitle: { fontSize: 13.5, fontWeight: 600, lineHeight: 1.4 },
      meta: { marginTop: 3, fontSize: 11.5, color: MUTED, lineHeight: 1.5 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 },
      stat: { display: 'flex', gap: 18, flexWrap: 'wrap' },
      statBox: { minWidth: 108 },
      statLabel: { fontSize: 11, color: MUTED, marginBottom: 2 },
      statValue: { fontSize: 16, fontWeight: 600, fontFamily: MONO },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
      th: { textAlign: 'left', padding: '6px 8px', borderBottom: `1px solid ${EDGE}`, color: MUTED, fontWeight: 500, whiteSpace: 'nowrap' },
      td: { padding: '7px 8px', borderBottom: `1px solid ${EDGE}`, verticalAlign: 'top' },
      num: { fontFamily: MONO, whiteSpace: 'nowrap' },
      split: { display: 'flex', gap: 12, minHeight: 0, flex: 1 },
      list: { width: 240, flexShrink: 0, overflowY: 'auto', border: `1px solid ${EDGE}`, borderRadius: 10, padding: 6, display: 'flex', flexDirection: 'column', gap: 2 },
      item: {
        appearance: 'none',
        textAlign: 'left',
        border: '1px solid transparent',
        background: 'transparent',
        color: 'inherit',
        borderRadius: 7,
        padding: '7px 9px',
        fontSize: 12,
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      itemOn: { background: SOFT, border: `1px solid ${EDGE}` },
      stream: { flex: 1, minWidth: 0, overflowY: 'auto', border: `1px solid ${EDGE}`, borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 },
      msg: { display: 'flex', flexDirection: 'column', gap: 3 },
      msgHead: { fontSize: 11, color: MUTED, fontFamily: MONO },
      bubble: { whiteSpace: 'pre-wrap', lineHeight: 1.6, fontSize: 12.5, borderLeft: `2px solid ${EDGE}`, paddingLeft: 10 },
      bar: { height: 6, borderRadius: 3, background: SOFT, overflow: 'hidden', marginTop: 6 },
      barFill: { height: '100%', background: 'currentColor', opacity: 0.45 },
      notice: { fontSize: 11.5, color: MUTED, lineHeight: 1.6, borderLeft: `2px solid ${EDGE}`, paddingLeft: 10 },
      // 宿主用 --dsw-alias-label-error 表达错误文本（首方 CSS 既有用法）；缺令牌时退回原红。
      error: { fontSize: 12, color: 'var(--dsw-alias-label-error, #c0392b)' },
      empty: { padding: '24px 0', fontSize: 12, color: MUTED },
      tag: {
        display: 'inline-block',
        padding: '1px 6px',
        marginRight: 6,
        borderRadius: 4,
        fontSize: 10.5,
        border: `1px solid ${EDGE}`,
        color: MUTED,
      },
    }

    const TABS = [
      { id: 'team', label: '协同' },
      { id: 'chat', label: '群聊' },
      { id: 'tasks', label: '任务' },
      { id: 'cache', label: '缓存' },
      { id: 'usage', label: '用量' },
    ]

    // 会话列表每页条数：与 Host 端 state.sessions 首屏快照的 40 条上限保持一致。
    const SESSIONS_PAGE = 40

    // 群聊一次取多少条：Host 默认条数已从 200 收到 50，显式带上免得两端各记一份。
    const CHAT_PAGE = 50

    function fmtNum(value) {
      const n = Number(value) || 0
      if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
      if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
      return String(n)
    }

    function fmtPct(part, total) {
      if (!total) return '-'
      return `${((part / total) * 100).toFixed(1)}%`
    }

    // 花费：账本 cost 基准 USD，Host 给出 currency='CNY' 且行内带 costCny 时才按人民币显示。
    // 0 是有效值（真花过钱但记为零），只有缺字段或非有限数才算缺失。
    function fmtCost(row, currency) {
      const cny = currency === 'CNY' && row?.costCny != null ? Number(row.costCny) : NaN
      if (Number.isFinite(cny)) return `${cny.toFixed(4)} CNY`
      const usd = row?.cost == null ? NaN : Number(row.cost)
      return Number.isFinite(usd) ? `${usd.toFixed(4)} USD` : '-'
    }

    function fmtTime(ms) {
      if (!ms) return '-'
      const d = new Date(Number(ms))
      if (Number.isNaN(d.getTime())) return '-'
      const pad = (v) => String(v).padStart(2, '0')
      // 只写 MM-DD：跨年记录会有歧义，非本年补上年份。
      const year = d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}-`
      return `${year}${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    function shortSession(id) {
      const raw = String(id || '')
      return raw.length > 20 ? `${raw.slice(0, 10)}…${raw.slice(-6)}` : raw
    }

    function sessionName(session) {
      if (!session) return '未选择'
      return session.title || shortSession(session.id)
    }

    // 待办与团队任务共用一套状态词，避免两处各写一遍走样。
    function statusText(status) {
      if (status === 'completed') return '已完成'
      if (status === 'in_progress') return '进行中'
      if (status === 'pending') return '待办'
      return status || '-'
    }

    // <option> 用系统色：它会跟着下面设的 color-scheme 自动取深/浅调色板，且不透明，
    // 避免弹出列表透出白底。写死具体色值又会在另一套主题里刺眼，所以不写死。
    const OPTION_STYLE = { background: 'Canvas', color: 'CanvasText' }

    // 原生控件（<select> 的弹出列表、滚动条）只认 CSS color-scheme，作者写的 background 对它无效；
    // 面板其余部分靠 currentColor + color-mix 随主题自动反转，所以这里必须把主题**测出来**再声明，
    // 不能像早先那样写死 'dark'（浅色主题下会把滚动条和弹出层按深色画）。
    // 判法：深色主题下文字是浅色，取元素计算出的 color 亮度即可；取不到（无 DOM 的测试桩）返回 undefined，
    // 此时一个属性都不写，行为与改动前完全一致。
    function useHostScheme(ref) {
      const [scheme, setScheme] = useState(undefined)
      useEffect(() => {
        if (typeof getComputedStyle !== 'function' || typeof document === 'undefined') return undefined
        const measure = () => {
          const node = ref.current
          if (!node) return
          const match = /rgba?\(([^)]+)\)/.exec(getComputedStyle(node).color || '')
          if (!match) return
          const [r, g, b] = match[1].split(',').map((part) => Number(part))
          if (![r, g, b].every((value) => Number.isFinite(value))) return
          // 相对亮度：深色主题文字接近白（>0.5），浅色主题接近黑。
          const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
          setScheme(luminance > 0.5 ? 'dark' : 'light')
        }
        measure()
        // 宿主切主题通常是改 <html> 上的 class / style / data-theme；盯属性变化比轮询便宜。
        if (typeof MutationObserver !== 'function' || !document.documentElement) return undefined
        const observer = new MutationObserver(measure)
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
        return () => observer.disconnect()
      }, [ref])
      return scheme
    }

    // 四个页签共用一份会话列表：先问 Host 的 /codenow/sessions 分页端点，
    // Host 未更新（端点缺失 / 没有 value / 请求失败）时退回 state.sessions 快照，并把降级状态一起返回。
    function useSessionList({ q = '', offset = 0, limit = SESSIONS_PAGE, withUsage = false, state }) {
      const [list, setList] = useState({ rows: [], total: 0, offset, loading: true, error: '', degraded: false, reason: '' })

      const request = useCallback(
        (nextOffset) =>
          callRpc('sessions', withUsage ? { offset: nextOffset, limit, q, withUsage: true } : { offset: nextOffset, limit, q })
            .then((result) => {
              const value = result?.ok ? result.value : null
              if (!value || !Array.isArray(value.items)) {
                // unknown-endpoint 是「Host 还没这个端点」，不是故障，不给用户看内部错误码。
                const reason = result?.ok || result?.error?.code === 'unknown-endpoint' ? '' : (result?.error?.message ?? '')
                return { ok: false, reason }
              }
              const total = Number(value.total)
              return { ok: true, items: value.items, total: Number.isFinite(total) ? total : value.items.length }
            })
            // 网络/HTTP 失败也降级，但把原因带出来，别把故障说成「Host 未更新」。
            .catch((err) => ({ ok: false, reason: String(err?.message ?? err) || '' })),
        [q, limit, withUsage]
      )

      // 快照是降级时的唯一数据源；它随刷新变化，所以列表也会跟着重取，切页签不再是旧数据。
      const snapshot = state?.sessions
      useEffect(() => {
        let alive = true
        setList((prev) => ({ ...prev, loading: true, error: '' }))
        request(offset).then((result) => {
          if (!alive) return
          if (result.ok) {
            setList({ rows: result.items, total: result.total, offset, loading: false, error: '', degraded: false, reason: '' })
            return
          }
          // 降级：在快照上复刻 Host 的语义（搜索字段 id/title/cwd/preset，withUsage 只留有用量记录的会话）。
          const needle = String(q || '').trim().toLowerCase()
          let base = (Array.isArray(snapshot) ? snapshot : []).filter((row) => row)
          if (withUsage) base = base.filter((row) => row.usage)
          const matched = needle
            ? base.filter((row) =>
                [row.id, row.title, row.cwd, row.preset].some((value) => String(value ?? '').toLowerCase().includes(needle))
              )
            : base
          // 数据缩到当前页之前会停在空白页；夹回最后一页，别让界面自相矛盾。
          const used = offset > 0 && offset >= matched.length && matched.length ? Math.floor((matched.length - 1) / limit) * limit : offset
          setList({
            rows: matched.slice(used, used + limit),
            total: matched.length,
            offset: used,
            loading: false,
            error: result.reason || '',
            degraded: true,
            reason: result.reason || '',
          })
        }).catch((err) => {
          // 兜底：连降级渲染都出错时也要退出 loading，否则界面永远停在「加载中」。
          if (!alive) return
          setList((prev) => ({ ...prev, loading: false, error: String(err?.message ?? err) || '会话列表读取失败' }))
        })
        return () => {
          alive = false
        }
      }, [request, offset, limit, q, withUsage, snapshot])

      return list
    }

    // 翻页控件：四个页签共用一套，别各写一遍走样。
    function PagerNode({ offset, loaded, total, limit, loading, onJump }) {
      const small = { ...S.btn, padding: '3px 8px', fontSize: 11.5 }
      const hasPrev = offset > 0
      const hasNext = offset + limit < total
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
        h(
          'button',
          {
            style: hasPrev ? small : { ...small, opacity: 0.5 },
            disabled: !hasPrev || loading,
            onClick: () => onJump(Math.max(0, offset - limit)),
          },
          '上一页'
        ),
        h(
          'button',
          {
            style: hasNext ? small : { ...small, opacity: 0.5 },
            disabled: !hasNext || loading,
            onClick: () => onJump(offset + limit),
          },
          '下一页'
        ),
        // 加载中可能已经换了页：给读屏一个会播报的实时区域，别让它读到中间态。
        h('span', { style: S.meta, 'aria-live': 'polite' }, `已加载 ${offset + loaded} / 共 ${total}`)
      )
    }

    // 降级提示：Host 没有分页端点时列表只有首页快照，说清楚比装作正常好。
    function SessionsNotice({ degraded, reason }) {
      if (!degraded) return null
      return h('div', { style: S.notice }, `分页不可用（Host 未更新），最多只有首页 40 条快照${reason ? `：${reason}` : ''}`)
    }

    // v3 是早期会话格式：会话本身完整可读，只是格式不同，别让用户以为是残缺数据。
    function FormatBadge({ row }) {
      if (row?.format !== 'v3') return null
      return h(
        'span',
        { style: { ...S.tag, marginRight: 0, marginLeft: 6 }, title: '早期会话格式，内容完整可读', 'aria-label': '早期会话格式 v3' },
        'v3'
      )
    }

    // <option> 里塞不下元素，只能用文本后缀标注同一件事。
    function sessionLabel(session) {
      return `${sessionName(session)}${session?.format === 'v3' ? '（v3）' : ''}`
    }

    function SidebarEntry({ size = 20 }) {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', 'aria-hidden': true, style: { display: 'block' } },
        h('circle', { cx: 12, cy: 6.4, r: 2.3, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('circle', { cx: 5.6, cy: 16.6, r: 2.3, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('circle', { cx: 18.4, cy: 16.6, r: 2.3, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M10.6 8.3 6.9 14.6M13.4 8.3l3.7 6.3M7.9 16.6h8.2', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' })
      )
    }

    function CoordHeaderAction(props) {
      const sessionId = props?.sessionId ?? ''
      const [open, setOpen] = useState(false)
      const [agents, setAgents] = useState(null)
      const [error, setError] = useState('')

      useEffect(() => {
        let alive = true
        const load = () => {
          callRpc('live', { sessionId }).then((result) => {
            if (!alive) return
            if (result?.ok) {
              setAgents(result.value?.agents ?? [])
              setError('')
            } else {
              setError(result?.error?.message ?? '读取 AI 团队失败')
            }
          }).catch((err) => {
            if (alive) setError(String(err?.message ?? err) || '无法连接插件')
          })
        }
        load()
        // 弹层关着时只取一次，用来更新按钮上的岗位数；打开后才轮询，避免常驻 4 秒一次的空转。
        if (!open) {
          return () => {
            alive = false
          }
        }
        const timer = setInterval(load, 4000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [sessionId, open])

      useEffect(() => {
        if (!open) return
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [open])

      const all = agents ?? []
      const lead = all.find((item) => item.role === 'lead') ?? null
      // 只有 role=teammate 的才是本会话派出去的岗位；lead 是主智能体本身。
      const children = all.filter((item) => item.role === 'teammate')
      const labelOf = (item) => item.label || item.name || item.title || '未命名专家'
      // 模型名形如 cn:deepseek-v4.1-flash，去掉区域前缀更好读。
      const prettyModel = (value) => String(value || '').replace(/^[a-z]{2}:/i, '')

      const chips = h(
        'button',
        {
          style: { ...S.btn, height: 26, padding: '0 10px', fontSize: 12 },
          onClick: () => setOpen((value) => !value),
          title: '查看本会话的 AI 团队',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
        },
        children.length === 0 ? 'AI 团队' : `AI 团队 ${children.length}`
      )

      return h(
        'div',
        { style: { position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 4 } },
        chips,
        open
          ? h(
              'div',
              {
                style: { position: 'fixed', inset: 0, zIndex: 9998, background: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.35))' },
                onClick: () => setOpen(false),
              },
              h(
                'div',
                {
                  role: 'dialog',
                  'aria-modal': true,
                  'aria-label': 'AI 团队',
                  style: {
                    position: 'absolute',
                    right: 24,
                    top: 60,
                    width: 420,
                    maxHeight: '64vh',
                    overflow: 'auto',
                    background: 'var(--dsw-alias-bg-layer-2, #1b1b22)',
                    color: 'var(--dsw-alias-label-primary, #e8e8ef)',
                    border: '1px solid var(--dsw-alias-border-l2, #3a3a44)',
                    borderRadius: 12,
                    padding: 14,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    boxShadow: '0 18px 48px rgba(0,0,0,0.5)',
                  },
                  onClick: (event) => event.stopPropagation(),
                },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
                  h('div', { style: { ...S.cardTitle, fontSize: 13.5 } }, 'AI 团队'),
                  h('div', { style: S.meta }, `专家 ${children.length}`),
                  h('div', { style: { flex: 1 } }),
                  h('button', { style: { ...S.btn, height: 22 }, onClick: () => setOpen(false) }, '关闭')
                ),
                error ? h('div', { style: S.error }, error) : null,
                lead
                  ? h(
                      'div',
                      {
                        key: 'codenow-lead',
                        style: {
                          border: `1px solid ${EDGE}`,
                          borderRadius: 8,
                          padding: '8px 10px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 2,
                        },
                      },
                      h('div', { style: { fontSize: 12.5, fontWeight: 500 } }, '主智能体 · 首席工程师'),
                      h('div', { style: S.meta }, prettyModel(lead.model) || '未知模型')
                    )
                  : null,
                children.length === 0
                  ? h('div', { style: S.meta }, '本会话还没派出岗位。主模型接到任务后会自己拉起。')
                  : children.map((item) =>
                      h(
                        'div',
                        {
                          key: item.id,
                          style: {
                            border: `1px solid ${EDGE}`,
                            borderRadius: 8,
                            padding: '8px 10px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 2,
                          },
                        },
                        h('div', { style: { fontSize: 12.5, fontWeight: 500 } }, labelOf(item)),
                        h('div', { style: S.meta }, `${prettyModel(item.model) || '未知模型'} · ${item.name || '未分配岗位'}`)
                      )
                    )
              )
            )
          : null
      )
    }

    function TeamTab({ state }) {
      if (!state) return h('div', { style: S.empty }, '加载中…')
      const roles = state.roles ?? []
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
        h(
          'div',
          null,
          h('div', { style: S.cardTitle }, `岗位模板（${roles.length}）`),
          h('div', { style: S.meta }, '来自 Origin CodeNow 的内置岗位 MD。Lead 用 codenow(action=role) 取全文，再交给 spawn_teammate。'),
          h(
            'div',
            { style: { ...S.grid, marginTop: 10 } },
            roles.map((role) =>
              h(
                'div',
                { key: role.id, style: S.card },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
                  h('div', { style: S.cardTitle }, role.displayName),
                  role.level
                    ? h(
                        'div',
                        { style: { ...S.meta, padding: '1px 6px', border: `1px solid ${EDGE}`, borderRadius: 999, fontSize: 10.5 } },
                        role.level
                      )
                    : null
                ),
                h('div', { style: { ...S.meta, fontFamily: MONO } }, role.id + (role.version ? ` · v${role.version}` : '')),
                role.summary ? h('div', { style: { ...S.meta, marginTop: 6, color: 'inherit', opacity: 0.78 } }, role.summary) : null,
                role.canHandoffTo?.length
                  ? h('div', { style: S.meta }, `可交接给：${role.canHandoffTo.slice(0, 4).join('、')}${role.canHandoffTo.length > 4 ? ' 等' : ''}`)
                  : null
              )
            )
          )
        ),
      )
    }

    function ChatTab({ state, sessionId, onPick, tick }) {
      const [messages, setMessages] = useState([])
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(false)
      // 失败后点「重试」只递增计数，让下面的 effect 重跑同一份请求。
      const [attempt, setAttempt] = useState(0)
      // 会话列表分页 / 搜索：query 是输入框的即时值，applied 是防抖后才生效的值。
      const [query, setQuery] = useState('')
      const [applied, setApplied] = useState('')
      const [offset, setOffset] = useState(0)
      // 列表数据与降级判断统一交给共用 hook：Host 未更新时它退回 state.sessions 快照。
      const list = useSessionList({ q: applied, offset, limit: SESSIONS_PAGE, withUsage: false, state })
      const rows = list.rows
      // 更早的消息：hasMore 为 null 表示 Host 没返回这个字段（旧版），那时不显示「加载更早」。
      const [hasMore, setHasMore] = useState(null)
      const [loadingOlder, setLoadingOlder] = useState(false)
      const streamRef = useRef(null)
      // 头部前插会把视口顶下去：先记下距底距离，插完再回填 scrollTop。
      const pendingScroll = useRef(null)
      const aliveRef = useRef(true)
      // 请求代次：切会话、刷新、重试都会 +1。同一个 sessionId 刷新时 sessionId 本身比不出新旧，
      // 只有代次能判断「这个响应还是不是当前这一轮的」。
      const genRef = useRef(0)

      useEffect(() => () => {
        aliveRef.current = false
      }, [])

      useEffect(() => {
        if (!sessionId) {
          setMessages([])
          setHasMore(null)
          return
        }
        let alive = true
        setLoading(true)
        setError('')
        setHasMore(null)
        // 新的一代：历史加载状态与滚动补偿一起复位，否则上一轮在飞的「加载更早」会把按钮永久卡在 disabled。
        genRef.current += 1
        setLoadingOlder(false)
        pendingScroll.current = null
        callRpc('chat', { sessionId, limit: CHAT_PAGE }).then((result) => {
          if (!alive) return
          setLoading(false)
          if (result?.ok) {
            setMessages(result.value?.messages ?? [])
            setHasMore(result.value?.hasMore === true ? true : result.value?.hasMore === false ? false : null)
          } else {
            setMessages([])
            setError(result?.error?.message ?? '读取失败')
          }
        }).catch((err) => {
          if (!alive) return
          setLoading(false)
          setMessages([])
          setError(String(err?.message ?? err) || '读取消息失败')
        })
        return () => {
          alive = false
        }
      }, [sessionId, attempt, tick])

      // 往头部前插一页更早的消息：以当前最小 seq 作 before 游标，按 seq 去重，重叠的不要。
      const loadOlder = useCallback(() => {
        const seqs = messages.map((message) => Number(message.seq)).filter((value) => Number.isFinite(value))
        if (!seqs.length) return
        const before = Math.min(...seqs)
        const sid = sessionId
        const gen = genRef.current
        const el = streamRef.current
        const keep = el ? el.scrollHeight - el.scrollTop : null
        setLoadingOlder(true)
        callRpc('chat', { sessionId: sid, limit: CHAT_PAGE, before }).then((result) => {
          // 回来时可能已经切了会话、刷新过、或卸载了：这一代作废，任何 state 都不许动。
          if (!aliveRef.current || gen !== genRef.current) return
          setLoadingOlder(false)
          if (!result?.ok) {
            setError(result?.error?.message ?? '读取更早消息失败')
            return
          }
          const older = result.value?.messages ?? []
          setHasMore(result.value?.hasMore === true ? true : result.value?.hasMore === false ? false : null)
          pendingScroll.current = keep
          setMessages((prev) => {
            const seen = new Set(prev.map((message) => message.seq))
            const fresh = older.filter((message) => !seen.has(message.seq))
            return fresh.length ? [...fresh, ...prev] : prev
          })
        }).catch((err) => {
          // 失败路径与成功路径用同一个有效性判断：旧请求的错误不许写进新会话。
          if (!aliveRef.current || gen !== genRef.current) return
          setLoadingOlder(false)
          setError(String(err?.message ?? err) || '读取更早消息失败')
        })
      }, [messages, sessionId])

      // 前插落盘之后才回填：这时 scrollHeight 才把新内容算进去。
      useEffect(() => {
        const keep = pendingScroll.current
        pendingScroll.current = null
        const el = streamRef.current
        if (!el || keep == null) return
        el.scrollTop = el.scrollHeight - keep
      }, [messages])

      // 300 ms 防抖：输入框每次按键都更新 query，定时器到点才生效；搜索词变化同时回到第一页。
      useEffect(() => {
        const timer = setTimeout(() => {
          setApplied(query)
          setOffset(0)
        }, 300)
        return () => clearTimeout(timer)
      }, [query])
      return h(
        'div',
        { style: S.split },
        h(
          'div',
          { style: { width: 240, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0 } },
          h('input', {
            type: 'search',
            'aria-label': '搜索会话',
            placeholder: '搜索会话',
            value: query,
            onChange: (event) => setQuery(event.target.value),
            style: S.input,
          }),
          h(SessionsNotice, { degraded: list.degraded, reason: list.reason }),
          h(
            'div',
            { style: { ...S.list, width: 'auto', flex: 1, minHeight: 0 } },
            // 首屏还没回来时显示加载中，避免把「还没回来」说成「没有会话」。
            list.loading && rows.length === 0
              ? h('div', { style: S.empty }, '加载中…')
              : rows.length === 0
              ? h('div', { style: S.empty }, applied ? '没有匹配的会话' : '没有会话')
              : rows.map((session) =>
                  h(
                    'button',
                    {
                      key: session.id,
                      style: session.id === sessionId ? { ...S.item, ...S.itemOn } : S.item,
                      onClick: () => onPick(session.id),
                      title: session.id,
                    },
                    h(
                      'div',
                      { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                      sessionName(session),
                      h(FormatBadge, { row: session })
                    ),
                    h('div', { style: { ...S.meta, fontFamily: MONO } }, fmtTime(session.updatedAt) + (session.preset ? ` · ${session.preset}` : ''))
                  )
                )
          ),
          h(PagerNode, {
            offset: list.offset,
            loaded: rows.length,
            total: list.total,
            limit: SESSIONS_PAGE,
            loading: list.loading,
            onJump: setOffset,
          })
        ),
        h(
          'div',
          { style: S.stream, ref: streamRef },
          // 只在 Host 明确给过 hasMore 时才出现：旧版 Host 没这个字段，硬显示会是个永远点不动的按钮。
          messages.length && hasMore !== null
            ? hasMore
              ? h(
                  'button',
                  { style: { ...S.btn, alignSelf: 'center' }, disabled: loadingOlder, onClick: loadOlder, 'aria-label': '加载更早的消息' },
                  loadingOlder ? '加载中…' : '加载更早'
                )
              : h('div', { style: S.meta, 'aria-live': 'polite' }, '已到最早')
            : null,
          error
            ? h(
                'div',
                { style: S.error },
                error,
                ' ',
                h('button', { style: { ...S.btn, height: 22, marginLeft: 4 }, onClick: () => setAttempt((value) => value + 1) }, '重试')
              )
            : null,
          loading ? h('div', { style: S.empty }, '读取会话日志…') : null,
          !loading && !error && messages.length === 0 ? h('div', { style: S.empty }, '这个会话还没有可回放的对话') : null,
          messages.map((message, index) =>
            h(
              'div',
              { key: `${message.seq}-${index}`, style: S.msg },
              h(
                'div',
                { style: S.msgHead },
                message.role === 'user' ? '用户' : `${message.provider || ''}${message.provider && message.model ? '/' : ''}${message.model || 'assistant'}`,
                ' · ',
                fmtTime(message.time)
              ),
              h('div', { style: S.bubble }, message.text)
            )
          )
        )
      )
    }

    function TasksTab({ state, sessionId, onPick, tick }) {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(false)
      // 失败后点「重试」只递增计数，让下面的 effect 重跑同一份请求。
      const [attempt, setAttempt] = useState(0)

      useEffect(() => {
        if (!sessionId) {
          setData(null)
          return
        }
        let alive = true
        setLoading(true)
        setError('')
        callRpc('tasks', { sessionId }).then((result) => {
          if (!alive) return
          setLoading(false)
          if (result?.ok) setData(result.value)
          else {
            setData(null)
            setError(result?.error?.message ?? '读取失败')
          }
        }).catch((err) => {
          if (!alive) return
          setLoading(false)
          setData(null)
          setError(String(err?.message ?? err) || '读取任务失败')
        })
        return () => {
          alive = false
        }
      }, [sessionId, attempt, tick])

      // 会话选择器同样吃共用列表：这里只关心有用量记录的会话，和缓存/用量页签一致。
      const [offset, setOffset] = useState(0)
      const list = useSessionList({ offset, limit: SESSIONS_PAGE, withUsage: true, state })
      const sessions = list.rows
      // 原生下拉的弹出列表不在我们的样式控制内，只能把测出来的主题透给浏览器。
      const selectRef = useRef(null)
      const selectScheme = useHostScheme(selectRef)
      const teammates = data?.teammates ?? []
      // phase 只有 provisioning → active，没有终态；所以成员数不等于活跃数，只在真有 active 时才显示活跃数。
      const activeMembers = teammates.filter((member) => member.phase === 'active').length
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, flex: 1 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: S.meta }, '会话：'),
          h(
            'select',
            {
              ref: selectRef,
              style: selectScheme ? { ...S.btn, paddingRight: 8, colorScheme: selectScheme } : { ...S.btn, paddingRight: 8 },
              'aria-label': '选择会话',
              value: sessionId || '',
              onChange: (event) => onPick(event.target.value),
            },
            h('option', { value: '', style: OPTION_STYLE }, '选择会话'),
            // 选中的会话可能不在当前页（或没有用量记录）：补一条占位 option，否则下拉会显示空白。
            sessionId && !sessions.some((session) => session.id === sessionId)
              ? h('option', { value: sessionId, style: OPTION_STYLE }, shortSession(sessionId))
              : null,
            sessions.map((session) =>
              h('option', { key: session.id, value: session.id, style: OPTION_STYLE }, sessionLabel(session))
            )
          ),
          teammates.length
            ? h('span', { style: S.tag }, `团队成员 ${teammates.length}${activeMembers ? `（活跃 ${activeMembers}）` : ''}`)
            : null
        ),
        h(SessionsNotice, { degraded: list.degraded, reason: list.reason }),
        h(PagerNode, {
          offset: list.offset,
          loaded: sessions.length,
          total: list.total,
          limit: SESSIONS_PAGE,
          loading: list.loading,
          onJump: setOffset,
        }),
        h('div', { style: S.notice }, '全部取自该会话日志：待办来自 todo/write 快照，团队任务来自 team/task 权威快照（含状态），成员存活状态来自 team/member。早期没有这些事件的会话，才退回按工具调用推断——那种重建没有状态。'),
        error
          ? h(
              'div',
              { style: S.error },
              error,
              ' ',
              h('button', { style: { ...S.btn, height: 22, marginLeft: 4 }, onClick: () => setAttempt((value) => value + 1) }, '重试')
            )
          : null,
        loading ? h('div', { style: S.empty }, '读取中…') : null,
        data && data.todos.length
          ? h(
              'div',
              null,
              h('div', { style: { ...S.cardTitle, marginBottom: 6 } }, `当前待办（${data.todos.length}）`),
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                data.todos.map((todo, index) =>
                  h(
                    'div',
                    { key: index, style: { display: 'flex', gap: 10, fontSize: 12.5, lineHeight: 1.6 } },
                    h(
                      'span',
                      { style: { ...S.num, minWidth: 52, color: MUTED, flexShrink: 0 } },
                      statusText(todo.status)
                    ),
                    h(
                      'span',
                      {
                        style: {
                          opacity: todo.status === 'completed' ? 0.55 : 1,
                          textDecoration: todo.status === 'completed' ? 'line-through' : 'none',
                        },
                      },
                      todo.content
                    )
                  )
                )
              )
            )
          : null,
        data && data.tasks.length
          ? h(
              'div',
              null,
              h('div', { style: { ...S.cardTitle, marginBottom: 6 } }, `团队任务（${data.tasks.length}）`),
              h(
                'table',
                { style: S.table },
                h('thead', null, h('tr', null, ['任务', '状态', '上游', '创建时间'].map((t) => h('th', { key: t, style: S.th }, t)))),
                h(
                  'tbody',
                  null,
                  data.tasks.map((task, index) =>
                    h(
                      'tr',
                      { key: `${task.seq}-${index}` },
                      h(
                        'td',
                        { style: S.td },
                        h('div', { style: { fontWeight: 600 } }, task.subject),
                        task.description ? h('div', { style: S.meta }, task.description.slice(0, 160)) : null
                      ),
                      h(
                        'td',
                        { style: { ...S.td, ...S.num, opacity: task.status === 'completed' ? 0.55 : 1 } },
                        statusText(task.status)
                      ),
                      h('td', { style: { ...S.td, ...S.num } }, Array.isArray(task.blockedBy) && task.blockedBy.length ? task.blockedBy.join(', ') : '-'),
                      h('td', { style: { ...S.td, ...S.num } }, fmtTime(task.at))
                    )
                  )
                )
              )
            )
          : data && !data.todos.length
            ? h('div', { style: S.empty }, '该会话没有待办或团队任务记录')
            : null,
        data && data.actions.length
          ? h(
              'div',
              null,
              h('div', { style: { ...S.cardTitle, marginBottom: 6 } }, '协同动作流水'),
              h(
                'table',
                { style: S.table },
                h('thead', null, h('tr', null, ['时间', '动作', '目标', '摘要'].map((t) => h('th', { key: t, style: S.th }, t)))),
                h(
                  'tbody',
                  null,
                  data.actions
                    .slice()
                    .reverse()
                    .map((action, index) =>
                      h(
                        'tr',
                        { key: `${action.seq}-${index}` },
                        h('td', { style: { ...S.td, ...S.num } }, fmtTime(action.time)),
                        h('td', { style: { ...S.td, ...S.num } }, action.name),
                        h('td', { style: { ...S.td, ...S.num } }, action.target || '-'),
                        h('td', { style: S.td }, action.summary || '-')
                      )
                    )
                )
              )
            )
          : null
      )
    }

    function CacheTab({ state }) {
      const [offset, setOffset] = useState(0)
      // withUsage：Host 端只回有用量记录的会话；Host 未更新时 hook 在快照上做同样的过滤。
      const list = useSessionList({ offset, limit: SESSIONS_PAGE, withUsage: true, state })
      // 再挡一层：行里没有 usage 就画不出缓存列，宁可少一行也别让整页抛错。
      const sessions = list.rows.filter((session) => session && session.usage)
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h('div', { style: S.notice }, '数据来自 dsh-cost-meter 账本（cacheRead / cacheWrite 为 provider 上报的缓存读写 token）。'),
        state && !state.ledgerFound ? h('div', { style: S.notice }, '未找到 cost-meter 账本，缓存数据为空。') : null,
        h(SessionsNotice, { degraded: list.degraded, reason: list.reason }),
        list.loading && sessions.length === 0
          ? h('div', { style: S.empty }, '加载中…')
          : sessions.length === 0
          ? h('div', { style: S.empty }, '还没有缓存记录')
          : h(
              'table',
              { style: S.table },
              h('thead', null, h('tr', null, ['会话', '缓存读', '缓存写', '命中率', '调用'].map((t) => h('th', { key: t, style: S.th }, t)))),
              h(
                'tbody',
                null,
                sessions.map((session) => {
                  const u = session.usage
                  const hit = fmtPct(u.cacheRead, u.cacheRead + u.input)
                  return h(
                    'tr',
                    { key: session.id },
                    h(
                      'td',
                      { style: S.td },
                      h('div', { style: { fontWeight: 600 } }, sessionName(session)),
                      h('div', { style: { ...S.meta, fontFamily: MONO } }, shortSession(session.id))
                    ),
                    h('td', { style: { ...S.td, ...S.num }, title: String(u.cacheRead) }, fmtNum(u.cacheRead)),
                    h('td', { style: { ...S.td, ...S.num }, title: String(u.cacheWrite) }, fmtNum(u.cacheWrite)),
                    h(
                      'td',
                      { style: S.td },
                      h('div', { style: S.num }, hit),
                      h('div', { style: S.bar }, h('div', { style: { ...S.barFill, width: `${Math.min(100, u.cacheRead + u.input ? (u.cacheRead / (u.cacheRead + u.input)) * 100 : 0)}%` } }))
                    ),
                    h('td', { style: { ...S.td, ...S.num } }, fmtNum(u.calls))
                  )
                })
              )
            ),
        h(PagerNode, {
          offset: list.offset,
          loaded: sessions.length,
          total: list.total,
          limit: SESSIONS_PAGE,
          loading: list.loading,
          onJump: setOffset,
        })
      )
    }

    function UsageTab({ state }) {
      const [offset, setOffset] = useState(0)
      // 会话级用量表也走共用列表：Host 端 withUsage 只回有用量记录的会话，降级时 hook 自己过滤快照。
      const list = useSessionList({ offset, limit: SESSIONS_PAGE, withUsage: true, state })
      const sessions = list.rows.filter((session) => session && session.usage)
      const trend = state?.trend ?? []
      const byModel = Array.isArray(state?.byProviderModel) ? state.byProviderModel : []
      const peak = Math.max(1, ...trend.map((day) => (Number(day.input) || 0) + (Number(day.output) || 0)))
      const missingDays = trend.filter((day) => day.missing === true).length
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
        h(
          'div',
          { style: S.stat },
          [
            ['输入 token', fmtNum(state?.totals?.input)],
            ['输出 token', fmtNum(state?.totals?.output)],
            ['缓存读', fmtNum(state?.totals?.cacheRead)],
            ['调用次数', fmtNum(state?.totals?.calls)],
            // 总计花费是账本原币种（USD）；账本只给这一列，没有逐币种换算值，所以走 fmtCost 统一带单位。
            ['花费', fmtCost(state?.totals, state?.currency)],
          ].map(([label, text]) =>
            h('div', { key: label, style: S.statBox }, h('div', { style: S.statLabel }, label), h('div', { style: S.statValue }, text))
          )
        ),
        h('div', { style: S.notice }, '数据来自 dsh-cost-meter 账本，按会话聚合；只展示已有记录，不估算。'),
        h(SessionsNotice, { degraded: list.degraded, reason: list.reason }),
        trend.length
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              h('div', { style: S.cardTitle }, '近 30 天输入+输出'),
              h(
                'div',
                {
                  role: 'img',
                  'aria-label': `近 30 天输入与输出柱状图，共 ${trend.length} 天，单日峰值 ${fmtNum(peak)}${
                    missingDays ? `，其中 ${missingDays} 天无记录` : ''
                  }`,
                  style: { display: 'flex', alignItems: 'flex-end', gap: 3, height: 90, borderBottom: `1px solid ${EDGE}`, paddingBottom: 2 },
                },
                trend.map((day) => {
                  // missing：Host 明说这天没有记录。不能画成实心柱，否则和「有记录但零用量」看起来一样。
                  if (day.missing === true) {
                    return h('div', {
                      key: day.date,
                      title: '无记录',
                      'aria-label': `${day.date} 无记录`,
                      style: { flex: 1, minWidth: 3, height: 0, borderTop: `1px dashed ${MUTED}` },
                    })
                  }
                  return h('div', {
                    key: day.date,
                    title: `${day.date}：${fmtNum(day.input)} 入 / ${fmtNum(day.output)} 出 / ${day.calls} 次`,
                    style: {
                      flex: 1,
                      minWidth: 3,
                      height: `${Math.max(2, (((Number(day.input) || 0) + (Number(day.output) || 0)) / peak) * 100)}%`,
                      background: 'currentColor',
                      opacity: 0.35,
                      borderRadius: '2px 2px 0 0',
                    },
                  })
                })
              )
            )
          : null,
        list.loading && sessions.length === 0
          ? h('div', { style: S.empty }, '加载中…')
          : sessions.length === 0
          ? h('div', { style: S.empty }, '还没有用量记录')
          : h(
              'table',
              { style: S.table },
              h('thead', null, h('tr', null, ['会话', '输入', '输出', '推理', '缓存读', '调用', '花费'].map((t) => h('th', { key: t, style: S.th }, t)))),
              h(
                'tbody',
                null,
                sessions.map((session) =>
                  h(
                    'tr',
                    { key: session.id },
                    h(
                      'td',
                      { style: S.td },
                      h('div', { style: { fontWeight: 600 } }, sessionName(session)),
                      h('div', { style: { ...S.meta, fontFamily: MONO } }, `${shortSession(session.id)} · ${session.preset || 'default'}`)
                    ),
                    h('td', { style: { ...S.td, ...S.num }, title: String(session.usage.input) }, fmtNum(session.usage.input)),
                    h('td', { style: { ...S.td, ...S.num }, title: String(session.usage.output) }, fmtNum(session.usage.output)),
                    h('td', { style: { ...S.td, ...S.num } }, fmtNum(session.usage.reasoning)),
                    h('td', { style: { ...S.td, ...S.num } }, fmtNum(session.usage.cacheRead)),
                    h('td', { style: { ...S.td, ...S.num } }, fmtNum(session.usage.calls)),
                    h('td', { style: { ...S.td, ...S.num } }, fmtCost(session.usage, state?.currency))
                  )
                )
              )
            ),
        h(PagerNode, {
          offset: list.offset,
          loaded: sessions.length,
          total: list.total,
          limit: SESSIONS_PAGE,
          loading: list.loading,
          onJump: setOffset,
        }),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          h('div', { style: S.cardTitle }, `按模型花费（${byModel.length}）`),
          byModel.length === 0
            ? h('div', { style: S.empty }, '还没有按模型的用量记录')
            : h(
                'table',
                { style: S.table },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    ['模型', 'calls', 'input', 'output', 'cacheRead', state?.currency === 'CNY' ? '花费（CNY）' : '花费（USD）'].map((t) =>
                      h('th', { key: t, style: S.th }, t)
                    )
                  )
                ),
                h(
                  'tbody',
                  null,
                  byModel.map((row, index) =>
                    h(
                      'tr',
                      { key: row?.key || `${row?.provider || ''}/${row?.model || ''}/${index}` },
                      h(
                        'td',
                        { style: S.td },
                        h('div', { style: { fontWeight: 600 } }, row?.model || row?.key || '未知模型'),
                        row?.provider ? h('div', { style: { ...S.meta, fontFamily: MONO } }, row.provider) : null
                      ),
                      h('td', { style: { ...S.td, ...S.num } }, fmtNum(row?.calls)),
                      h('td', { style: { ...S.td, ...S.num } }, fmtNum(row?.input)),
                      h('td', { style: { ...S.td, ...S.num } }, fmtNum(row?.output)),
                      h('td', { style: { ...S.td, ...S.num } }, fmtNum(row?.cacheRead)),
                      h('td', { style: { ...S.td, ...S.num } }, fmtCost(row, state?.currency))
                    )
                  )
                )
              ),
          h('div', { style: S.meta }, '账本基准 USD；Host 给出 costCny 时按人民币显示。')
        )
      )
    }

    function Panel() {
      const [tab, setTab] = useState('team')
      const [state, setState] = useState(null)
      const [sessionId, setSessionId] = useState('')
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(false)
      // 刷新成功后自增，透传给群聊/任务页签：它们的 effect 依赖 tick 重跑同一份请求，切页签不再是旧数据。
      const [tick, setTick] = useState(0)

      const refresh = useCallback(() => {
        setLoading(true)
        setError('')
        callRpc('state', {}).then((result) => {
          setLoading(false)
          if (result?.ok) {
            const value = result.value ?? {}
            setState(value)
            setSessionId((current) => current || value.sessions?.[0]?.id || '')
            setTick((current) => current + 1)
          } else {
            setError(result?.error?.message ?? '读取失败')
          }
        }).catch((err) => {
          setLoading(false)
          setError(String(err?.message ?? err) || '无法连接插件')
        })
      }, [])

      useEffect(() => {
        refresh()
      }, [refresh])

      // 只是一次条件分派：元素每次 render 都会重建，套记忆化没有收益。
      let content = h(TeamTab, { state })
      if (tab === 'chat') content = h(ChatTab, { state, sessionId, onPick: setSessionId, tick })
      else if (tab === 'tasks') content = h(TasksTab, { state, sessionId, onPick: setSessionId, tick })
      else if (tab === 'cache') content = h(CacheTab, { state })
      else if (tab === 'usage') content = h(UsageTab, { state })

      // 会话总数优先用 Host 的 sessionsTotal；Host 未更新时退回首页快照条数（那时没有真总数可用）。
      const sessionTotal = state?.sessionsTotal ?? (state?.sessions ?? []).length
      const summary = state
        ? `${state.roles?.length ?? 0} 岗位 · ${sessionTotal} 会话`
        : '多角色协同、群聊、任务与各 agent 用量'

      return h(
        'div',
        { style: S.root },
        h(
          'div',
          { style: S.header },
          h(
            'div',
            null,
            h('div', { style: S.title }, '协同工作台'),
            h('div', { style: S.subtitle }, summary)
          ),
          h('div', { style: S.spacer }),
          h('button', { style: S.btn, onClick: refresh, disabled: loading, 'aria-busy': loading }, loading ? '刷新中…' : '刷新')
        ),
        h(
          'div',
          { style: S.tabs, role: 'tablist' },
          TABS.map((item) =>
            h(
              'button',
              {
                key: item.id,
                role: 'tab',
                'aria-selected': item.id === tab,
                style: item.id === tab ? { ...S.tab, ...S.tabOn } : S.tab,
                onClick: () => setTab(item.id),
              },
              item.label
            )
          )
        ),
        h('div', { style: S.body }, error ? h('div', { style: S.error }, error) : null, content)
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 用 ctx.inject 等连接服务就绪再接管（首方插件通用写法），拿不到就一直走 HTTP 兜底。
        ctx.inject(['connection'], (inner) => {
          const connection = inner.get('connection')
          if (connection && connection.rpc && typeof connection.rpc.call === 'function') {
            viaConnection = (channel, endpoint, payload) => connection.rpc.call(channel, endpoint, payload)
          }
        })
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'codenow' }, Panel))
        ctx.slots.inject('conversation.session.header.actions', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.actions',
              id: 'codenow-coord',
              order: 21,
              label: () => 'AI 团队',
            },
            CoordHeaderAction
          )
        )
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'codenow', order: 6, label: () => '协同工作台' },
            SidebarEntry
          )
        )
      },
    }
  },
})
