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

    /**
     * 把浮层挂到 document.body。
     *
     * 会话头部插槽渲染在宿主的 .an3WzG_titleRow 里，那一行带
     * `container-type: inline-size`（等价于 `contain: layout style inline-size`）——
     * 布局 containment 会让它成为内部 `position: fixed` 后代的包含块，并切出独立层叠上下文。
     * 于是 `inset: 0` 只等于那条 30px 高的标题行，弹层被压成窄缝、还会被后绘制的消息区盖住。
     * 挂到 body 才拿得到真正的视口。
     *
     * react-dom 取不到时原样返回节点，退化成旧的内联渲染（不抛错、不白屏）。
     */
    /**
     * 内联样式画不出 :hover / :focus-visible / :disabled，所以补一张很小的一次性样式表。
     * 只挂在 [data-cn] 作用域内（面板根节点与 portal 到 body 的弹层都带这个属性），
     * 不碰宿主样式；宿主没有 document 时整个函数是空操作。
     */
    let cnStylesInjected = false
    function injectCnStyles() {
      if (cnStylesInjected) return
      if (typeof document === 'undefined' || !document.head) return
      const css = [
        '[data-cn] *, [data-cn] *::before, [data-cn] *::after { box-sizing: border-box; }',
        '[data-cn] button, [data-cn] select, [data-cn] input, [data-cn] tr {',
        '  transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease, box-shadow 140ms ease;',
        '}',
        '[data-cn] button:not([role="tab"]):hover:not(:disabled) {',
        '  background: var(--cn-hover) !important;',
        '  border-color: var(--cn-line-strong) !important;',
        '}',
        '[data-cn] button:active:not(:disabled) {',
        '  background: var(--cn-selected) !important;',
        '}',
        '[data-cn] button:disabled { opacity: .5; cursor: not-allowed; }',
        '[data-cn] [aria-busy="true"] { cursor: progress; }',
        '[data-cn] button:focus-visible, [data-cn] select:focus-visible, [data-cn] input:focus-visible, [data-cn] [tabindex="0"]:focus-visible {',
        '  outline: 2px solid var(--cn-accent, #184bc0);',
        '  outline-offset: 3px;',
        '}',
        '[data-cn] input::placeholder { color: var(--cn-text-dim); opacity: 1; }',
        '[data-cn] tbody tr:hover { background: var(--cn-hover); }',
        '[data-cn] .cn-header { flex-wrap: wrap; }',
        '[data-cn] .cn-identity { display: flex; align-items: center; gap: 12px; min-width: 0; }',
        '[data-cn] .cn-brand { width: 44px; height: 44px; padding: 5px; flex-shrink: 0; border: 1px solid var(--cn-line); border-radius: 12px; background: #fff; }',
        '[data-cn] .cn-toolbar { display: flex; align-items: center; gap: 8px; margin-left: auto; min-width: 0; }',
        '[data-cn] .cn-toolbar select { width: 260px; min-width: 0; text-overflow: ellipsis; }',
        '[data-cn] .cn-tab:hover { color: var(--cn-accent) !important; background: var(--cn-hover) !important; }',
        '[data-cn] .cn-tab[aria-selected="true"] { color: var(--cn-accent) !important; background: var(--cn-elevated) !important; box-shadow: 0 1px 3px rgba(24,75,192,.08); }',
        '[data-cn] .cn-tab svg { opacity: .75; }',
        '[data-cn] .cn-tab[aria-selected="true"] svg { opacity: 1; }',
        '[data-cn] .cn-section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }',
        '[data-cn] .cn-role-card { display: flex; flex-direction: column; min-width: 0; transition: border-color 140ms ease; }',
        '[data-cn] .cn-role-card:hover { border-color: var(--cn-line-strong) !important; }',
        '[data-cn] .cn-role-card[data-cn-lead="true"] { border-color: var(--cn-line-strong) !important; background: var(--cn-lead) !important; }',
        '[data-cn] .cn-role-title { font-size: 14px; font-weight: 600; line-height: 1.55; }',
        '[data-cn] .cn-role-desc { margin-top: 12px; font-size: 12.5px; line-height: 1.8; flex: 1; overflow-wrap: anywhere; }',
        '[data-cn] .cn-role-footer { margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--cn-line-faint); color: var(--cn-text-dim); font-size: 11px; line-height: 1.7; }',
        '[data-cn] .cn-table-scroll { max-width: 100%; min-height: 0; flex-shrink: 0; overflow: auto; border: 1px solid var(--cn-line); border-radius: 12px; background: var(--cn-elevated); }',
        '[data-cn] .cn-table-scroll tbody tr:last-child td { border-bottom: 0 !important; }',
        '[data-cn] .cn-env { gap: 8px 16px; }',
        '[data-cn] .cn-env-label { font-size: 11px; font-weight: 600; color: var(--cn-text-dim); }',
        '[data-cn] [data-cn-state]::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--cn-success); flex-shrink: 0; }',
        '[data-cn] [data-cn-state="missing"] { color: var(--cn-warning); }',
        '[data-cn] [data-cn-state="missing"]::before { background: var(--cn-warning); }',
        '[data-cn] ::-webkit-scrollbar { width: 8px; height: 8px; }',
        '[data-cn] ::-webkit-scrollbar-thumb { background: color-mix(in srgb, currentColor 18%, transparent); border-radius: 8px; border: 2px solid transparent; background-clip: padding-box; }',
        '[data-cn] ::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, currentColor 30%, transparent); background-clip: padding-box; }',
        '[data-cn] ::-webkit-scrollbar-track { background: transparent; }',
        '@container (max-width: 720px) {',
        '  [data-cn] .cn-header { padding: 16px !important; gap: 14px !important; }',
        '  [data-cn] .cn-toolbar { width: 100%; margin-left: 0; }',
        '  [data-cn] .cn-toolbar select { flex: 1; width: 0; }',
        '  [data-cn] .cn-tabs { margin-inline: 16px !important; }',
        '  [data-cn] .cn-env { margin-inline: 16px !important; }',
        '  [data-cn] .cn-body { padding: 18px 16px 24px !important; }',
        '}',
        '@container (max-width: 520px) {',
        '  [data-cn] .cn-split { flex-direction: column; }',
        '  [data-cn] .cn-session-pane { width: 100% !important; flex: 0 0 auto; }',
        '  [data-cn] .cn-session-list { max-height: 160px; flex: 0 0 auto !important; }',
        '  [data-cn] .cn-chat-pane { min-height: 360px !important; flex-shrink: 0 !important; }',
        '  [data-cn] .cn-stream { min-height: 280px; flex-shrink: 0; }',
        '  [data-cn] .cn-tabs { gap: 2px !important; }',
        '  [data-cn] .cn-tab { flex: 1; justify-content: center; padding: 9px 6px !important; }',
        '  [data-cn] .cn-tab svg { display: none; }',
        '}',
        '@media (prefers-reduced-motion: reduce) {',
        '  [data-cn] button, [data-cn] select, [data-cn] input, [data-cn] tr, [data-cn] .cn-role-card { transition: none; }',
        '}',
      ].join('\n')
      const style = document.createElement('style')
      style.setAttribute('data-cn-styles', '')
      style.textContent = css
      document.head.appendChild(style)
      cnStylesInjected = true
    }
    const portalIntoBody = (() => {
      if (typeof document === 'undefined' || document.body === null) return (node) => node
      let createPortal = null
      try {
        const reactDom = require('react-dom')
        createPortal = typeof reactDom?.createPortal === 'function' ? reactDom.createPortal : null
      } catch {
        createPortal = null
      }
      return createPortal === null ? (node) => node : (node) => createPortal(node, document.body)
    })()

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
        ? Promise.resolve().then(() => viaConnection('/codenow', endpoint, payload)).catch(() => fetchRpc(endpoint, payload))
        : fetchRpc(endpoint, payload)
    }

    const EDGE = 'var(--cn-line, color-mix(in srgb, currentColor 16%, transparent))'
    const SOFT = 'var(--cn-surface-3, color-mix(in srgb, currentColor 7%, transparent))'
    const MUTED = 'var(--cn-text-dim, color-mix(in srgb, currentColor 62%, transparent))'
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    // 从 D:/Users/16520/Pictures/jy.png 等比缩小，内嵌以兼容无需额外静态资源声明的宿主。
    const BRAND_LOGO = 'data:image/png;base64,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'

    const EDGE_STRONG = 'var(--cn-line-strong, color-mix(in srgb, currentColor 22%, transparent))'
    const FAINT = 'var(--cn-line-faint, color-mix(in srgb, currentColor 7%, transparent))'
    const CARD_BG = 'var(--cn-surface-2, color-mix(in srgb, currentColor 3%, transparent))'
    const ACCENT = 'var(--cn-accent, currentColor)'

    /**
     * 主题变量：宿主背景可能是半透明/带壁纸的，插件不能只靠 color-mix 叠透明色，
     * 否则壁纸透上来整块面板就糊。这里给一套不透明的自建表面色，明暗各一套。
     */
    function cnTokens(scheme) {
      const dark = scheme !== 'light'
      return {
        '--cn-surface': dark ? '#141b25' : '#F7F4ED',
        '--cn-surface-2': dark ? '#1b2431' : '#ffffff',
        '--cn-surface-3': dark ? '#222e3f' : '#edf1f6',
        '--cn-nav': dark ? '#192738' : '#E6F7FF',
        '--cn-elevated': dark ? '#1b2431' : '#ffffff',
        '--cn-line': dark ? 'rgba(186,208,240,0.12)' : 'rgba(24,75,192,0.12)',
        '--cn-line-strong': dark ? 'rgba(138,180,255,0.4)' : 'rgba(24,75,192,0.32)',
        '--cn-line-faint': dark ? 'rgba(186,208,240,0.08)' : 'rgba(24,75,192,0.08)',
        '--cn-text': dark ? '#e8edf6' : '#1A1A1A',
        '--cn-text-dim': dark ? '#a6b4c8' : '#606c7c',
        '--cn-accent': dark ? '#91b9ff' : '#184BC0',
        '--cn-hover': dark ? '#26364c' : '#edf4fd',
        '--cn-selected': dark ? '#253d61' : '#dfeafb',
        '--cn-lead': dark ? '#1c2d45' : '#f2f7ff',
        '--cn-success': dark ? '#78c6a3' : '#237858',
        '--cn-warning': dark ? '#e7bc75' : '#946112',
        '--cn-shadow': dark ? '0 1px 2px rgba(0,0,0,0.14)' : '0 1px 2px rgba(24,75,192,0.03)',
      }
    }
    // 交互反馈统一走注入样式表（见 factory 末尾 injectCnStyles）；这里是它的选择器前缀。
    const CN = 'codenow'

    const S = {
      root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0, overflow: 'hidden', fontSize: 13, containerType: 'inline-size' },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '20px 24px 16px',
        flexShrink: 0,
        background: 'var(--cn-surface)',
        borderBottom: `1px solid ${FAINT}`,
      },
      title: { fontSize: 18, fontWeight: 650, lineHeight: '26px', letterSpacing: '-0.02em' },
      subtitle: { marginTop: 3, fontSize: 11.5, color: MUTED, lineHeight: '18px' },
      tabs: {
        display: 'flex',
        gap: 6,
        padding: 5,
        margin: '0 24px',
        background: 'var(--cn-nav)',
        borderRadius: 12,
        flexShrink: 0,
      },
      tab: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        color: MUTED,
        padding: '9px 16px',
        borderRadius: 8,
        fontSize: 12.5,
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      tabOn: { fontWeight: 600 },
      body: { flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto', padding: '24px 24px 32px', display: 'flex', flexDirection: 'column', gap: 16 },
      btn: {
        appearance: 'none',
        border: `1px solid ${EDGE}`,
        background: 'var(--cn-elevated)',
        color: 'inherit',
        borderRadius: 8,
        padding: '6px 12px',
        fontSize: 12,
        lineHeight: '18px',
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      select: {
        appearance: 'auto',
        boxSizing: 'border-box',
        border: `1px solid ${EDGE}`,
        background: 'var(--cn-elevated)',
        color: 'inherit',
        borderRadius: 8,
        padding: '7px 10px',
        minHeight: 34,
        maxWidth: '100%',
        fontSize: 12,
        fontFamily: 'inherit',
        cursor: 'pointer',
      },
      input: {
        appearance: 'none',
        boxSizing: 'border-box',
        width: '100%',
        border: `1px solid ${EDGE}`,
        background: 'var(--cn-elevated)',
        color: 'inherit',
        borderRadius: 8,
        padding: '9px 11px',
        fontSize: 12,
        fontFamily: 'inherit',
      },
      card: {
        border: `1px solid ${EDGE}`,
        borderRadius: 12,
        padding: '18px 18px 14px',
        background: CARD_BG,
        boxShadow: 'var(--cn-shadow, none)',
      },
      cardTitle: {
        fontSize: 13,
        fontWeight: 600,
        lineHeight: '18px',
        letterSpacing: '-0.005em',
        paddingLeft: 10,
        borderLeft: `3px solid ${ACCENT}`,
      },
      meta: { marginTop: 4, fontSize: 12, color: MUTED, lineHeight: 1.65, overflowWrap: 'anywhere' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 290px), 1fr))', gap: 14 },
      stat: { display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 160px), 1fr))' },
      statBox: { minWidth: 0, padding: '16px 18px', border: `1px solid ${EDGE}`, borderRadius: 12, background: CARD_BG },
      statLabel: { fontSize: 11, fontWeight: 500, color: MUTED, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' },
      statValue: { fontSize: 20, fontWeight: 600, fontFamily: MONO, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' },
      table: { width: '100%', minWidth: 540, borderCollapse: 'collapse', fontSize: 12, fontVariantNumeric: 'tabular-nums' },
      th: { textAlign: 'left', padding: '12px 14px', borderBottom: `1px solid ${EDGE}`, color: MUTED, fontWeight: 600, whiteSpace: 'nowrap', fontSize: 11, letterSpacing: '0.02em', position: 'sticky', top: 0, zIndex: 1, background: 'var(--cn-surface-3)' },
      td: { padding: '12px 14px', borderBottom: `1px solid ${FAINT}`, verticalAlign: 'top', overflowWrap: 'anywhere' },
      num: { fontFamily: MONO, whiteSpace: 'nowrap' },
      split: { display: 'flex', gap: 12, minHeight: 0, flex: 1 },
      list: { width: 240, flexShrink: 0, overflowY: 'auto', background: 'var(--cn-nav)', border: `1px solid ${EDGE}`, borderRadius: 12, padding: 6, display: 'flex', flexDirection: 'column', gap: 4 },
      item: {
        appearance: 'none',
        textAlign: 'left',
        border: '1px solid transparent',
        background: 'transparent',
        color: 'inherit',
        borderRadius: 7,
        padding: '10px 11px',
        fontSize: 12,
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      itemOn: { background: 'var(--cn-elevated)', border: `1px solid ${EDGE_STRONG}`, boxShadow: `inset 3px 0 ${ACCENT}` },
      stream: { flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', background: CARD_BG, border: `1px solid ${EDGE}`, borderRadius: 12, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 20 },
      msg: { display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 },
      msgHead: { fontSize: 11, color: MUTED, fontFamily: MONO, overflowWrap: 'anywhere' },
      bubble: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.8, fontSize: 13, borderLeft: `2px solid ${EDGE_STRONG}`, paddingLeft: 12 },
      bar: { height: 6, borderRadius: 3, background: SOFT, overflow: 'hidden', marginTop: 6 },
      barFill: { height: '100%', background: ACCENT, opacity: 0.8 },
      notice: { fontSize: 12, color: MUTED, lineHeight: 1.6, background: SOFT, borderRadius: 8, padding: '8px 12px' },
      // 宿主用 --dsw-alias-label-error 表达错误文本（首方 CSS 既有用法）；缺令牌时退回原红。
      error: { fontSize: 12.5, color: 'var(--dsw-alias-label-error, #c0392b)', background: 'color-mix(in srgb, var(--dsw-alias-label-error, #c0392b) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-error, #c0392b) 30%, transparent)', borderRadius: 8, padding: '8px 12px', lineHeight: 1.5 },
      empty: { padding: '40px 24px', fontSize: 13, color: MUTED, textAlign: 'center', border: `1px dashed ${EDGE}`, borderRadius: 10, lineHeight: 1.6 },
      emptyInline: { padding: '24px 0', fontSize: 13, color: MUTED },
      pill: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '1px 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 500,
        lineHeight: '16px',
        border: `1px solid ${EDGE}`,
        color: MUTED,
        whiteSpace: 'nowrap',
      },
      tag: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '1px 8px',
        marginRight: 6,
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 500,
        lineHeight: '16px',
        whiteSpace: 'nowrap',
        border: `1px solid ${EDGE}`,
        color: MUTED,
      },
      envBar: {
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 12,
        margin: '12px 24px',
        padding: '10px 12px',
        fontSize: 12,
        color: MUTED,
        background: 'transparent',
        borderRadius: 10,
        border: `1px solid ${FAINT}`,
      },
      envItem: { display: 'inline-flex', alignItems: 'center', gap: 4 },
      envMissing: { color: 'var(--dsw-alias-label-error, #c0392b)' },
      envBtn: {
        appearance: 'none',
        border: `1px solid ${EDGE}`,
        background: 'transparent',
        color: 'inherit',
        borderRadius: 6,
        padding: '2px 8px',
        fontSize: 11,
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
    }

    const TABS = [
      { id: 'team', label: '协同', icon: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0' },
      { id: 'chat', label: '群聊', icon: 'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6A8.4 8.4 0 0 1 12.5 3H13a8.5 8.5 0 0 1 8 8v.5Z' },
      { id: 'tasks', label: '任务', icon: 'm3 6 2 2 4-4M13 6h8M3 13l2 2 4-4M13 13h8M13 20h8M5 20h.01' },
      { id: 'cache', label: '缓存', icon: 'M20 6c0 2.2-3.6 4-8 4S4 8.2 4 6s3.6-4 8-4 8 1.8 8 4ZM4 6v6c0 2.2 3.6 4 8 4s8-1.8 8-4V6M4 12v6c0 2.2 3.6 4 8 4s8-1.8 8-4v-6' },
      { id: 'usage', label: '用量', icon: 'M3 3v18h18M8 16v-4M13 16V8M18 16V5' },
    ]

    function Icon({ path, size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, style: { flexShrink: 0 } }, h('path', { d: path }))
    }

    function DataTable({ label, children }) {
      return h('div', { className: 'cn-table-scroll', role: 'region', 'aria-label': label, tabIndex: 0 }, h('table', { style: S.table }, children))
    }

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

    // 任务「卡在谁身上」的标签。Host 没算 stage（旧版本、或首个请求还没带）时返回空串，不占格子。
    const STAGE_TEXT = {
      review: '等你验收',
      blocked: '等上游',
      queued: '未开始',
      working: '进行中',
      stalled: '疑似停摆',
      unknown: '未知',
    }

    function stageText(task) {
      const stage = String(task?.stage ?? '')
      if (!stage) return ''
      const text = STAGE_TEXT[stage] ?? stage
      // 停摆是结构化启发式推出来的，不是事实，标出来免得被当成结论。
      return stage === 'stalled' ? `${text}（推测）` : text
    }

    // 等你验收的排最前：这一栏存在的意义就是回答「现在需要我做什么」。
    const STAGE_RANK = { review: 0, stalled: 1, blocked: 2, working: 3, queued: 4, unknown: 5 }

    function orderedTasks(tasks) {
      return tasks.slice().sort((a, b) => (STAGE_RANK[a?.stage] ?? 9) - (STAGE_RANK[b?.stage] ?? 9))
    }

    // 有人要处理时才把数字顶到标题上；没人要处理就不打扰。
    function tasksTitle(tasks) {
      const waiting = tasks.filter((task) => task?.stage === 'review').length
      return waiting > 0 ? `团队任务（${tasks.length}，等你处理 ${waiting}）` : `团队任务（${tasks.length}）`
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
      injectCnStyles()
      const actionRef = useRef(null)
      const dialogRef = useRef(null)
      const actionScheme = useHostScheme(actionRef)
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
        const previous = document.activeElement
        const dialog = dialogRef.current
        dialog?.querySelector('button')?.focus()
        const onKeyDown = (event) => {
          if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
          if (event.key === 'Tab') {
            const buttons = dialog?.querySelectorAll('button:not(:disabled)')
            if (!buttons?.length) return
            const first = buttons[0]
            const last = buttons[buttons.length - 1]
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
          }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => {
          window.removeEventListener('keydown', onKeyDown)
          if (previous?.isConnected) previous.focus()
        }
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
        { ref: actionRef, 'data-cn': '', style: { ...cnTokens(actionScheme), position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 4 } },
        chips,
        open
          ? portalIntoBody(h(
              'div',
              {
                style: { position: 'fixed', inset: 0, zIndex: 9998, background: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.35))' },
                onClick: () => setOpen(false),
              },
              h(
                'div',
                {
                  role: 'dialog',
                  ref: dialogRef,
                  'aria-modal': true,
                  'aria-label': 'AI 团队',
                  style: {
                    ...cnTokens(actionScheme),
                    colorScheme: actionScheme,
                    position: 'absolute',
                    right: 16,
                    top: 60,
                    width: 'min(420px, calc(100vw - 32px))',
                    maxHeight: 'min(560px, calc(100vh - 84px))',
                    overflow: 'auto',
                    background: 'var(--cn-elevated)',
                    color: 'var(--cn-text)',
                    border: `1px solid ${EDGE}`,
                    borderRadius: 12,
                    padding: 16,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                    boxShadow: '0 12px 32px rgba(0,0,0,0.24), 0 2px 6px rgba(0,0,0,0.16)',
                  },
                  'data-cn': '',
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
          )
          : null
      )
    }

    function TeamTab({ state, loading }) {
      if (!state) return h('div', { style: S.empty, role: 'status' }, loading ? '正在读取岗位与会话…' : '暂时无法读取岗位，请点击刷新重试。')
      const roles = state.roles ?? []
      const roleNames = new Map(roles.map((role) => [role.id, role.displayName]))
      const ordered = roles.slice().sort((a, b) => Number(b.id === 'chief-engineer') - Number(a.id === 'chief-engineer'))
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
        h(
          'div',
          null,
          h('div', { className: 'cn-section-head' },
            h('div', null, h('div', { style: S.cardTitle }, '岗位与协作'), h('div', { style: S.meta }, '首席统筹，专家按需协作。查看各岗位的职责与交接范围。')),
            h('span', { style: S.pill }, `${roles.length} 个岗位`)
          ),
          h(
            'div',
            { style: { ...S.grid, marginTop: 18 } },
            ordered.map((role) =>
              h(
                'div',
                { key: role.id, style: S.card, className: 'cn-role-card', 'data-cn-card': '', 'data-cn-lead': role.id === 'chief-engineer' },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
                  h('div', { className: 'cn-role-title' }, role.displayName),
                  role.level
                    ? h(
                        'div',
                        { style: S.pill },
                        role.level
                      )
                    : null
                ),
                h('div', { style: { ...S.meta, fontFamily: MONO, fontSize: 11 } }, role.id + (role.version ? ` · v${role.version}` : '')),
                role.summary ? h('div', { className: 'cn-role-desc' }, role.summary) : null,
                role.canHandoffTo?.length
                  ? h('div', { className: 'cn-role-footer', title: role.canHandoffTo.map((id) => roleNames.get(id) || id).join('、') }, `交接给 ${role.canHandoffTo.slice(0, 3).map((id) => roleNames.get(id) || id).join('、')}${role.canHandoffTo.length > 3 ? ` 等 ${role.canHandoffTo.length} 个岗位` : ''}`)
                  : null
              )
            )
          )
        ),
      )
    }

    function ChatTab({ state, sessionId, onPick, tick }) {
      const [chat, setChat] = useState({ sessionId: '', messages: [], hasMore: null })
      const messages = chat.sessionId === sessionId ? chat.messages : []
      const hasMore = chat.sessionId === sessionId ? chat.hasMore : null
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
      const [loadingOlder, setLoadingOlder] = useState(false)
      const streamRef = useRef(null)
      const followLatestRef = useRef(true)
      const [atLatest, setAtLatest] = useState(true)
      // 头部前插会把视口顶下去：先记下距底距离，插完再回填 scrollTop。
      const pendingScroll = useRef(null)
      const aliveRef = useRef(true)
      // 请求代次：切会话、刷新、重试都会 +1。同一个 sessionId 刷新时 sessionId 本身比不出新旧，
      // 只有代次能判断「这个响应还是不是当前这一轮的」。
      const genRef = useRef(0)

      useEffect(() => {
        aliveRef.current = true
        return () => { aliveRef.current = false }
      }, [])

      useEffect(() => {
        followLatestRef.current = true
        setAtLatest(true)
      }, [sessionId])

      useEffect(() => {
        genRef.current += 1
        setLoadingOlder(false)
        pendingScroll.current = null
        setError('')
        if (!sessionId) {
          setChat({ sessionId: '', messages: [], hasMore: null })
          setLoading(false)
          return
        }
        let alive = true
        setLoading(true)
        callRpc('chat', { sessionId, limit: CHAT_PAGE }).then((result) => {
          if (!alive) return
          setLoading(false)
          if (result?.ok) {
            const latest = result.value?.messages ?? []
            const more = result.value?.hasMore === true ? true : result.value?.hasMore === false ? false : null
            setChat((prev) => {
              if (prev.sessionId !== sessionId || !prev.messages.length) return { sessionId, messages: latest, hasMore: more }
              // 同一会话按 seq 更新尾部，保留用户主动加载的历史；整个合并只遍历各列表一次。
              const incoming = new Map(latest.map((message) => [message.seq, message]))
              // 页面久未更新可能缺一整段消息，没有重叠时重新使用连续的最新页。
              if (latest.length && !prev.messages.some((message) => incoming.has(message.seq))) return { sessionId, messages: latest, hasMore: more }
              const merged = prev.messages.map((message) => {
                const updated = incoming.get(message.seq) ?? message
                incoming.delete(message.seq)
                return updated
              })
              merged.push(...incoming.values())
              // 自动更新保持用户已加载的窗口大小，避免长时间打开时累积整份日志。
              const capacity = Math.max(CHAT_PAGE, prev.messages.length)
              const kept = merged.length > capacity ? merged.slice(-capacity) : merged
              return { sessionId, messages: kept, hasMore: kept.length < merged.length ? true : prev.hasMore ?? more }
            })
          } else {
            setError(result?.error?.message ?? '读取失败')
          }
        }).catch((err) => {
          if (!alive) return
          setLoading(false)
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
        setError('')
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
          const seen = new Set(messages.map((message) => message.seq))
          const fresh = older.filter((message) => !seen.has(message.seq))
          const el = streamRef.current
          pendingScroll.current = fresh.length && el ? el.scrollHeight - el.scrollTop : null
          setChat((prev) => ({ ...prev, messages: fresh.length ? [...fresh, ...prev.messages] : prev.messages, hasMore: result.value?.hasMore === true ? true : result.value?.hasMore === false ? false : null }))
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
        if (!el) return
        if (keep != null) el.scrollTop = el.scrollHeight - keep
        else if (followLatestRef.current) el.scrollTop = el.scrollHeight
      }, [messages])

      // 300 ms 防抖：输入框每次按键都更新 query，定时器到点才生效；搜索词变化同时回到第一页。
      useEffect(() => {
        const timer = setTimeout(() => {
          setApplied(query)
          setOffset(0)
        }, 300)
        return () => clearTimeout(timer)
      }, [query])
      const currentSession = rows.find((row) => row.id === sessionId) ?? state?.sessions?.find((row) => row.id === sessionId)
      return h(
        'div',
        { style: S.split, className: 'cn-split' },
        h(
          'div',
          { className: 'cn-session-pane', style: { width: 240, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, minWidth: 0 } },
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
            { className: 'cn-session-list', style: { ...S.list, width: 'auto', flex: 1, minHeight: 0 } },
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
                      'aria-pressed': session.id === sessionId,
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
          { className: 'cn-chat-pane', style: { display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minWidth: 0, minHeight: 0 } },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' } },
            h('div', { style: { minWidth: 0, overflowWrap: 'anywhere' } },
              h('div', { style: S.cardTitle, title: sessionId }, sessionId ? sessionName(currentSession ?? { id: sessionId }) : '群聊回放'),
              h('div', { style: S.meta, role: 'status' }, `${messages.length ? `已加载 ${messages.length} 条消息 · ` : ''}${loading ? '更新中…' : '每 8 秒自动更新'}`)),
            messages.length && !atLatest ? h('button', { style: S.btn, onClick: () => { followLatestRef.current = true; setAtLatest(true); const el = streamRef.current; if (el) el.scrollTop = el.scrollHeight } }, '回到最新') : null
          ),
          h('div', { style: S.stream, className: 'cn-stream', ref: streamRef, role: 'region', 'aria-label': '会话消息', tabIndex: 0, onScroll: (event) => { const el = event.currentTarget; const latest = el.scrollHeight - el.clientHeight - el.scrollTop <= 48; followLatestRef.current = latest; setAtLatest(latest) } },
          // 只在 Host 明确给过 hasMore 时才出现：旧版 Host 没这个字段，硬显示会是个永远点不动的按钮。
          messages.length && hasMore !== null
            ? hasMore
              ? h(
                  'button',
                  { style: { ...S.btn, alignSelf: 'center', flexShrink: 0 }, disabled: loadingOlder || loading, onClick: loadOlder, 'aria-label': '加载更早的消息' },
                  loadingOlder ? '加载中…' : '加载更早'
                )
              : h('div', { style: S.meta, 'aria-live': 'polite' }, '已到最早')
            : null,
          error
            ? h(
                'div',
                { style: S.error, role: 'alert' },
                error,
                messages.length ? '（保留上次读取的消息）' : '',
                ' ',
                h('button', { style: { ...S.btn, height: 22, marginLeft: 4 }, onClick: () => setAttempt((value) => value + 1) }, '重试')
              )
            : null,
          loading && !messages.length ? h('div', { style: S.emptyInline, role: 'status' }, '读取会话日志…') : null,
          !loading && !error && messages.length === 0 ? h('div', { style: S.emptyInline }, sessionId ? '这个会话还没有可回放的对话' : '请先选择会话，查看对话记录。') : null,
          messages.map((message) =>
            h(
              'div',
              { key: message.seq, style: S.msg },
              h(
                'div',
                { style: S.msgHead },
                message.role === 'user' ? '用户' : `${message.provider || ''}${message.provider && message.model ? '/' : ''}${message.model || 'assistant'}`,
                ' · ',
                fmtTime(message.time)
              ),
              h('div', { style: S.bubble }, message.text)
            )
          ))
        )
      )
    }

    function TasksTab({ state, sessionId, onPick, tick }) {
      const [snapshot, setSnapshot] = useState(null)
      const data = snapshot?.sessionId === sessionId ? snapshot.value : null
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(false)
      // 失败后点「重试」只递增计数，让下面的 effect 重跑同一份请求。
      const [attempt, setAttempt] = useState(0)

      useEffect(() => {
        if (!sessionId) {
          setSnapshot(null)
          setLoading(false)
          setError('')
          return
        }
        let alive = true
        setLoading(true)
        setError('')
        callRpc('tasks', { sessionId }).then((result) => {
          if (!alive) return
          setLoading(false)
          if (result?.ok) setSnapshot({ sessionId, value: result.value })
          else {
            setError(result?.error?.message ?? '读取失败')
          }
        }).catch((err) => {
          if (!alive) return
          setLoading(false)
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
              style: { ...S.select, padding: '5px 10px' },
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
              { style: S.error, role: 'alert' },
              error,
              data ? '（保留上次读取的任务）' : '',
              ' ',
              h('button', { style: { ...S.btn, height: 22, marginLeft: 4 }, onClick: () => setAttempt((value) => value + 1) }, '重试')
            )
          : null,
        loading ? h('div', { style: S.emptyInline, role: 'status' }, data ? '更新任务中…' : '读取中…') : null,
        !sessionId ? h('div', { style: S.emptyInline }, '请先选择会话，查看待办与团队任务。') : null,
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
              h('div', { style: { ...S.cardTitle, marginBottom: 6 } }, tasksTitle(data.tasks)),
              h(
                DataTable,
                { label: '团队任务' },
                h('thead', null, h('tr', null, ['任务', '状态', '归属', '上游', '创建时间'].map((t) => h('th', { key: t, style: S.th }, t)))),
                h(
                  'tbody',
                  null,
                  orderedTasks(data.tasks).map((task, index) =>
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
                      h(
                        'td',
                        { style: { ...S.td, ...S.num, fontWeight: task.stage === 'review' ? 600 : 400 } },
                        stageText(task) || '-'
                      ),
                      h('td', { style: { ...S.td, ...S.num } }, Array.isArray(task.blockedBy) && task.blockedBy.length ? task.blockedBy.join(', ') : '-'),
                      h('td', { style: { ...S.td, ...S.num } }, fmtTime(task.at))
                    )
                  )
                )
              )
            )
          : data && !data.todos.length
            ? h('div', { style: S.emptyInline }, '该会话没有待办或团队任务记录')
            : null,
        data && data.actions.length
          ? h(
              'div',
              null,
              h('div', { style: { ...S.cardTitle, marginBottom: 6 } }, '协同动作流水'),
              h(
                DataTable,
                { label: '协同动作流水' },
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
              DataTable,
              { label: '会话缓存明细' },
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
                      background: ACCENT,
                      opacity: 0.72,
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
              DataTable,
              { label: '会话用量明细' },
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
                DataTable,
                { label: '模型用量明细' },
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
      const panelRef = useRef(null)
      const scheme = useHostScheme(panelRef)
      injectCnStyles()
      const [tab, setTab] = useState('team')
      const [state, setState] = useState(null)
      const [sessionId, setSessionId] = useState('')
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(true)
      // 刷新成功后自增，透传给群聊/任务页签：它们的 effect 依赖 tick 重跑同一份请求，切页签不再是旧数据。
      const [tick, setTick] = useState(0)
      const requestRef = useRef(0)
      const pendingRef = useRef(null)
      const pickSession = useCallback((id) => {
        if (id === sessionId) return
        requestRef.current += 1
        setSessionId(id)
        setState((current) => current ? { ...current, autonomy: null } : current)
      }, [sessionId])

      const refresh = useCallback(() => {
        if (pendingRef.current?.request === requestRef.current) return pendingRef.current.promise
        const request = ++requestRef.current
        setLoading(true)
        setError('')
        const promise = callRpc('state', { sessionId }).then((result) => {
          if (request !== requestRef.current) return
          setLoading(false)
          if (result?.ok) {
            const value = result.value ?? {}
            setState(value)
            if (!sessionId && value.sessions?.[0]?.id) pickSession(value.sessions[0].id)
            setTick((current) => current + 1)
          } else {
            setError(result?.error?.message ?? '读取失败')
          }
        }).catch((err) => {
          if (request !== requestRef.current) return
          setLoading(false)
          setError(String(err?.message ?? err) || '无法连接插件')
        }).finally(() => {
          if (pendingRef.current?.request === request) pendingRef.current = null
        })
        pendingRef.current = { request, promise }
        return promise
      }, [sessionId, pickSession])

      // 环境：只读检测 + 用户点一次才装。装完立刻重读状态，不做乐观更新（避免界面说装好了其实没装）。
      const [env, setEnv] = useState(null)
      const [envBusy, setEnvBusy] = useState('')
      const [envNote, setEnvNote] = useState('')

      const loadEnv = useCallback(() => {
        return callRpc('setup', {})
          .then((result) => {
            if (result?.ok) setEnv(result.value ?? null)
            else setEnvNote(result?.error?.message ?? '环境检测失败')
          })
          .catch((err) => {
            setEnvNote(String(err?.message ?? err) || '环境检测失败')
          })
      }, [])

      const install = useCallback(
        (target) => {
          setEnvBusy(target)
          setEnvNote('')
          callRpc('install', { target })
            .then((result) => {
              setEnvBusy('')
              if (result?.ok) {
                setEnvNote(target === 'mcp' ? '已注册 MCP，重启 DSH 后生效' : '已装 Blender addon')
                loadEnv()
              } else {
                setEnvNote(result?.error?.message ?? '安装失败')
              }
            })
            .catch((err) => {
              setEnvBusy('')
              setEnvNote(String(err?.message ?? err) || '安装失败')
            })
        },
        [loadEnv]
      )

      useEffect(() => {
        refresh()
        const timer = setInterval(() => { if (document.visibilityState !== 'hidden') refresh() }, 8000)
        return () => { requestRef.current += 1; clearInterval(timer) }
      }, [refresh])
      useEffect(() => { loadEnv() }, [loadEnv])
      // 控件继承面板主题，避免用控件颜色过渡的中间值再次判断明暗。

      // 只是一次条件分派：元素每次 render 都会重建，套记忆化没有收益。
      let content = h(TeamTab, { state, loading })
      if (tab === 'chat') content = h(ChatTab, { state, sessionId, onPick: pickSession, tick })
      else if (tab === 'tasks') content = h(TasksTab, { state, sessionId, onPick: pickSession, tick })
      else if (tab === 'cache') content = h(CacheTab, { state })
      else if (tab === 'usage') content = h(UsageTab, { state })

      // 会话总数优先用 Host 的 sessionsTotal；Host 未更新时退回首页快照条数（那时没有真总数可用）。
      const sessionTotal = state?.sessionsTotal ?? (state?.sessions ?? []).length
      const summary = state
        ? `${state.roles?.length ?? 0} 岗位 · ${sessionTotal} 会话`
        : '多角色协同、群聊、任务与各 agent 用量'

      return h(
        'div',
        { style: { ...S.root, ...cnTokens(scheme), colorScheme: scheme, background: 'var(--cn-surface)' }, ref: panelRef, 'data-cn': '' },
        h(
          'div',
          { style: S.header, className: 'cn-header' },
          h(
            'div',
            { className: 'cn-identity' },
            h('img', { className: 'cn-brand', src: BRAND_LOGO, alt: '极源科技', width: 44, height: 44 }),
            h('div', null, h('div', { style: S.title }, '协同工作台'), h('div', { style: S.subtitle }, `CodeNow · ${summary}`))
          ),
          h('div', { className: 'cn-toolbar' },
            h('select', {
              value: sessionId,
              onChange: (event) => pickSession(event.target.value),
              'aria-label': '项目所属会话',
              style: { ...S.select, maxWidth: 280 },
            },
              !sessionId ? h('option', { value: '', style: OPTION_STYLE }, '选择会话') : null,
              sessionId && !(state?.sessions ?? []).some((row) => row.id === sessionId) ? h('option', { value: sessionId, style: OPTION_STYLE }, shortSession(sessionId)) : null,
              (state?.sessions ?? []).map((row) => h('option', { key: row.id, value: row.id, style: OPTION_STYLE }, sessionLabel(row)))),
            h('button', { style: { ...S.btn, display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }, onClick: refresh, disabled: loading, 'aria-busy': loading }, h(Icon, { path: 'M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.6-2L20 8M4 16l2.3 3a7 7 0 0 0 11.6-2' }), loading ? '刷新中…' : '刷新')
          )
        ),
        h(
          'div',
          { style: S.envBar, className: 'cn-env' },
          h('span', { className: 'cn-env-label' }, '运行环境'),
          ...(env
            ? [
                (() => {
                  const rows = env.skills?.items ?? []
                  const skillsOk = rows.length > 0 && rows.every((row) => row.installed)
                  return h('span', { key: 'skills', style: S.envItem, 'data-cn-state': skillsOk ? 'ready' : 'missing' }, `技能 ${skillsOk ? '已内置' : '缺失'}`)
                })(),
                h('span', { key: 'mcp', style: S.envItem, 'data-cn-state': env.mcp?.registered ? 'ready' : 'missing' }, `MCP ${env.mcp?.registered ? '已注册' : '未注册'}`),
                (() => {
                  const addons = env.blender?.addons ?? []
                  return h('span', { key: 'addon', style: S.envItem, 'data-cn-state': addons.length > 0 ? 'ready' : 'missing' }, `Blender addon ${addons.length > 0 ? addons.join(' / ') : '未装'}`)
                })(),
              ]
            : [h('span', { key: 'loading', style: S.envItem }, envNote || '检测中…')]),
          env && envNote ? h('span', { style: S.envMissing }, envNote) : null,
          env && !env.mcp?.registered ? h(
            'button',
            {
              style: S.envBtn,
              onClick: () => install('mcp'),
              disabled: envBusy !== '',
            },
            envBusy === 'mcp' ? '注册中…' : '装 MCP'
          ) : null,
          env && !(env.blender?.addons?.length > 0) ? h(
            'button',
            {
              style: S.envBtn,
              onClick: () => install('addon'),
              disabled: envBusy !== '',
            },
            envBusy === 'addon' ? '安装中…' : '装 Blender addon'
          ) : null
        ),
        (() => {
          // 项目级状态：只有真需要用户动作时才高亮，内部复核/进行中不打扰用户。
          const auto = state?.autonomy
          if (!auto) return null
          if (auto.problem || auto.reconciliationProblem) return h('div', { style: { ...S.envBar, ...S.envMissing } }, `项目状态暂不可用：${auto.problem || auto.reconciliationProblem}`)
          if (!auto.project && !auto.stopped) return null
          const project = auto.project
          const tasks = project?.tasks ?? []
          const open = (project?.questions ?? []).filter((row) => !row.answeredAt)
          const verified = tasks.filter((row) => row.status === 'verified' && row.verification?.verdict === 'pass' && row.verification.artifactStamp === row.artifactStamp)
          const working = tasks.filter((row) => row.status === 'in_progress')
          const head = auto.stopped
            ? `自动接续已停止（${auto.stopped.reason || '无原因'}）· 需要用户明确说恢复`
            : `${project.deliveredAt ? '已交付' : '目标'}：${project.objective}`
          const tail = project
            ? [
                `任务 ${tasks.length}（进行中 ${working.length} / 已复核 ${verified.length}）`,
                open.length > 0 ? `需要你处理 ${open.length} 项：${open[0].question}` : '',
                !project.deliveredAt && project.nextAction ? `下一步：${project.nextAction}` : '',
                auto.deliveries?.unresolved?.length ? `接续待核对 ${auto.deliveries.unresolved.length} 条` : '',
              ]
                .filter(Boolean)
                .join(' · ')
            : ''
          return h('div', { style: open.length > 0 || auto.stopped ? { ...S.envBar, ...S.envMissing } : S.envBar }, head, tail ? h('span', null, tail) : null)
        })(),
        h(
          'div',
          { style: S.tabs, className: 'cn-tabs', role: 'tablist', 'aria-label': '协同工作台导航' },
          TABS.map((item) =>
            h(
              'button',
              {
                key: item.id,
                id: `cn-tab-${item.id}`,
                className: 'cn-tab',
                role: 'tab',
                'aria-selected': item.id === tab,
                'aria-controls': `cn-panel-${item.id}`,
                tabIndex: item.id === tab ? 0 : -1,
                style: item.id === tab ? { ...S.tab, ...S.tabOn } : S.tab,
                onClick: () => setTab(item.id),
                onKeyDown: (event) => {
                  const index = TABS.findIndex((entry) => entry.id === tab)
                  const next = { ArrowRight: (index + 1) % TABS.length, ArrowLeft: (index + TABS.length - 1) % TABS.length, Home: 0, End: TABS.length - 1 }[event.key]
                  if (next === undefined) return
                  event.preventDefault()
                  setTab(TABS[next].id)
                  event.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next]?.focus()
                },
              },
              h(Icon, { path: item.icon }),
              item.label
            )
          )
        ),
        h('div', { style: S.body, className: 'cn-body', role: 'tabpanel', id: `cn-panel-${tab}`, 'aria-labelledby': `cn-tab-${tab}`, tabIndex: 0 }, error ? h('div', { style: S.error, role: 'alert' }, error) : null, content)
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
