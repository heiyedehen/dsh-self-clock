/**
 * dsh-self-clock — 心跳（Client 半边）
 * 设置页里的一节：看每个会话的闹钟状态，改开关 / 频次 / 临时静音。
 * 数据全部走宿主那两个路由，不另做后端：
 *   GET  /dsh-heartbeat.json    现在的状态
 *   POST /dsh-heartbeat/config  { sessionId, enabled?, everyMinutes?, muteMinutes? }
 */
// 下面的 id 必须等于 package.json 的 name（DSH 按入口名判重）
window.__ModuleLoader__.load({
  id: 'dsh-self-clock',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    // 浅色，跟 DSH 主界面一致
    const C = {
      text: 'var(--dsw-alias-label-primary, #1f2329)',
      dim: 'var(--dsw-alias-label-tertiary, #8a9099)',
      line: 'var(--dsw-alias-border-secondary, #e6e8eb)',
      card: 'var(--dsw-alias-bg-secondary, #fff)',
      bg: 'var(--dsw-alias-bg-primary, #f7f8fa)',
      accent: '#2f6fed',
      warn: '#c25e00',
    }

    const S = {
      wrap: { height: '100%', overflow: 'auto', padding: '14px 16px 28px', background: C.bg, color: C.text, fontSize: 13 },
      card: { background: C.card, border: '1px solid ' + C.line, borderRadius: 10, padding: '12px 14px', marginBottom: 12 },
      head: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 10 },
      title: { fontSize: 15, fontWeight: 600 },
      dim: { color: C.dim, fontSize: 12 },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      table: { width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 12 },
      th: { textAlign: 'left', color: C.dim, fontWeight: 500, padding: '6px 6px', borderBottom: '1px solid ' + C.line, whiteSpace: 'nowrap' },
      td: { padding: '7px 6px', borderBottom: '1px solid ' + C.line, verticalAlign: 'middle' },
      sel: { fontSize: 12, padding: '2px 4px', borderRadius: 6, border: '1px solid ' + C.line, background: C.card, color: C.text },
      btn: { fontSize: 12, padding: '3px 9px', borderRadius: 6, border: '1px solid ' + C.line, background: C.card, color: C.text, cursor: 'pointer' },
      btnOn: { fontSize: 12, padding: '3px 9px', borderRadius: 6, border: '1px solid ' + C.accent, background: C.accent, color: '#fff', cursor: 'pointer' },
      chip: { display: 'inline-block', padding: '1px 7px', borderRadius: 999, fontSize: 11, border: '1px solid ' + C.line, color: C.dim },
    }

    const FREQS = [15, 30, 60, 120]

    // settings.section 是 root scope，注册时拿不到 sessionId；
    // 借一个 scope:session 的槽位把它记下来（见下面 apply 里的 session-probe）
    let lastSessionId = ''

    function shortId(id) {
      const s = String(id || '')
      return s.length > 16 ? s.slice(0, 8) + '…' + s.slice(-4) : s
    }

    function nameOf(a) {
      return (a && a.label) || ('会话 ' + shortId(a && a.sessionId))
    }

    function statusStyle(code) {
      if (code === 'waiting') return { color: C.accent, borderColor: C.accent }
      if (code === 'disabled') return { color: C.dim }
      if (code === 'muted') return { color: C.warn, borderColor: C.warn }
      if (code === 'budget' || code === 'window') return { color: C.warn }
      if (code === 'none') return { color: C.warn, borderColor: C.warn }
      return {}
    }

    function nextText(a) {
      if (!a) return ''
      if (a.nextAtLocal) return a.nextAtLocal
      return String(a.statusText || '').indexOf('未排到') >= 0 ? '⚠ 未排到下次触发' : '—'
    }

    function Panel() {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')
      const [creating, setCreating] = useState(false)
      const [newSid, setNewSid] = useState('')
      const [newFreq, setNewFreq] = useState(30)
      const [newBudget, setNewBudget] = useState(48)
  const [pendingDel, setPendingDel] = useState('')

      const load = useCallback(async () => {
        try {
          const res = await fetch('/dsh-heartbeat.json', { cache: 'no-store' })
          const j = await res.json()
          setData(j)
          setError('')
        } catch (e) {
          setError(String((e && e.message) || e))
        }
      }, [])

      useEffect(() => {
        load()
        const timer = setInterval(load, 30000)
        return () => clearInterval(timer)
      }, [load])

      const post = async (sessionId, patch, key) => {
        setBusy(key)
        try {
          await fetch('/dsh-heartbeat/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, ...patch }),
          })
          await load()
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setBusy('')
        }
      }

      const alarms = (data && Array.isArray(data.alarms)) ? data.alarms.slice() : []
      const mine = lastSessionId ? alarms.find((a) => a.sessionId === lastSessionId) : null
      // 本会话那条排最前；其余按「下次要响」升序，已关掉 / 排不出的放后面
      const rank = (a) => {
        if (mine && a.sessionId === mine.sessionId) return -1
        return a.nextAt ? Date.parse(a.nextAt) : Infinity
      }
      alarms.sort((a, b) => {
        const ra = rank(a)
        const rb = rank(b)
        if (ra !== rb) return ra - rb
        return String(nameOf(a)).localeCompare(String(nameOf(b)))
      })

      const nowLocal = (data && data.nowLocal) || '—'
      const used = data ? Number(data.used || 0) : 0

      const summary = h('div', { style: S.head },
        h('div', { style: S.title }, '现在 ' + String(nowLocal).slice(11)),
        h('div', { style: S.dim }, '今天已响 ' + used + ' 次' + (alarms.length ? '｜' + alarms.length + ' 个闹钟' : '')),
        mine ? h('div', { style: { ...S.chip, color: C.accent, borderColor: C.accent } }, '本会话：' + (mine.title || nameOf(mine))) : null,
        h('div', { style: { flex: 1 } }),
        h('button', { style: S.btnOn, onClick: () => setCreating((v) => !v) }, creating ? '收起' : '新建'),
        h('button', { style: S.btn, onClick: load }, '刷新'),
      )

      const sessions = (data && Array.isArray(data.sessions)) ? data.sessions : []
      const takenSids = new Set(alarms.map((a) => a.sessionId))
      const freeSessions = sessions.filter((s) => !takenSids.has(s.id))
      const sessionLabel = (s) => (s.title ? s.title : '会话 ' + shortId(s.id)) + (s.atLocal ? ' · ' + s.atLocal : '')

      const createCard = creating
        ? h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '给一条会话开一个闹钟'),
          h('div', { style: S.row },
            h('select', {
              style: { ...S.sel, maxWidth: 380 },
              value: newSid,
              onChange: (e) => setNewSid(e.target.value),
            },
              h('option', { value: '' }, freeSessions.length ? '选一条活着的会话…' : '现在没有活着的会话'),
              freeSessions.map((s) => h('option', { key: s.id, value: s.id }, sessionLabel(s))),
            ),
            h('select', {
              style: S.sel,
              value: String(newFreq),
              onChange: (e) => setNewFreq(Number(e.target.value)),
            }, FREQS.map((m) => h('option', { key: m, value: String(m) }, '每 ' + m + ' 分'))),
            h('div', { style: S.dim }, '每日上限'),
            h('input', {
              style: { ...S.sel, width: 58 },
              type: 'number', min: 1, max: 999,
              value: newBudget,
              onChange: (e) => setNewBudget(Number(e.target.value) || 48),
            }),
            h('button', {
              style: S.btnOn,
              disabled: !newSid || busy === 'new',
              onClick: async () => {
                if (!newSid) return
                await post(newSid, { enabled: true, everyMinutes: newFreq, dailyBudget: newBudget }, 'new')
                setNewSid('')
                setCreating(false)
              },
            }, '建'),
            h('button', { style: S.btn, onClick: () => setCreating(false) }, '取消'),
          ),
          h('div', { style: { ...S.dim, marginTop: 6 } }, '建完就是一个「每 N 分钟叫一次」的闹钟，之后在表里改开关 / 频次 / 上限。'),
        )
        : null

      const notice = error
        ? h('div', { style: { ...S.card, borderColor: '#e8b4b4', color: '#b23b3b' } }, '读不到心跳状态：' + error)
        : null

      if (!data) {
        return h('div', { style: S.wrap }, summary, notice, h('div', { style: S.dim }, '正在读…'))
      }

      if (!alarms.length) {
        return h('div', { style: S.wrap }, summary, notice, createCard,
          h('div', { style: S.card },
            h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '还没有闹钟'),
            h('div', { style: S.dim }, '点右上角「新建」挑一条会话——这里只列现在还活着的（有会话开着）那条；也可以在会话里让我设一个（比如「三十分钟后提醒我」）。'),
          ),
        )
      }

      const rows = alarms.map((a, i) => {
        const key = a.sessionId + ':' + i
        const isMine = !!mine && a.sessionId === mine.sessionId
        const isNext = !mine && i === 0 && !!a.nextAt
        const freq = Number(a.everyMinutes || 0)
        const freqOptions = FREQS.slice()
        if (freq && freqOptions.indexOf(freq) < 0) freqOptions.push(freq)
        freqOptions.sort((x, y) => x - y)

        return h('tr', { key, style: (isMine || isNext) ? { background: 'rgba(47,111,237,0.06)' } : null },
          h('td', { style: { ...S.td, maxWidth: 0 } },
            h('div', {
              style: {
                fontWeight: (isMine || isNext) ? 600 : 500,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
              title: a.title || a.label || a.sessionId,
            }, a.title || ('会话 ' + shortId(a.sessionId))),
            a.nextAtLocal
              ? h('div', { style: { fontSize: 11, opacity: 0.6, marginTop: 2, whiteSpace: 'nowrap' } }, '下次 ' + String(a.nextAtLocal).slice(11))
              : null,
          ),
          h('td', { style: S.td },
            h('span', { style: { ...S.chip, ...statusStyle(a.status) } },
              String(a.statusText || a.status || '—').split('·')[0].trim()),
          ),
          h('td', { style: S.td },
            h('input', {
              type: 'checkbox',
              checked: a.enabled !== false,
              disabled: busy === key,
              onChange: (e) => post(a.sessionId, { enabled: e.target.checked }, key),
            }),
          ),
          h('td', { style: S.td },
            h('select', {
              style: { ...S.sel, width: '100%', padding: '1px 2px' },
              value: String(freq || 30),
              disabled: busy === key,
              onChange: (e) => post(a.sessionId, { everyMinutes: Number(e.target.value) }, key),
            }, freqOptions.map((m) => h('option', { key: m, value: String(m) }, m + ' 分'))),
          ),
          h('td', { style: S.td },
            h('input', {
              type: 'number', min: 1, max: 999,
              style: { ...S.sel, width: '100%', maxWidth: 54, padding: '2px 2px' },
              defaultValue: a.dailyBudget || 48,
              disabled: busy === key,
              onBlur: (e) => post(a.sessionId, { dailyBudget: Number(e.target.value) || 48 }, key),
            }),
          ),
          h('td', { style: S.td },
            h('button', {
              style: { ...S.btn, padding: '2px 4px', fontSize: 11 },
              disabled: busy === key,
              title: '静音 30 分钟，不响也不消耗预算',
              onClick: () => post(a.sessionId, { muteMinutes: 30 }, key),
            }, '静音'),
          ),
          h('td', { style: S.td },
            h('button', {
              style: pendingDel === a.sessionId
                ? { ...S.btn, padding: '2px 6px', background: C.dangerBg || '#fde8e8', borderColor: C.dangerBg || '#f4c2c2', color: '#b42318' }
                : { ...S.btn, padding: '2px 6px' },
              disabled: busy === key,
              title: '删掉这条会话的闹钟（再点一次确认）',
              onClick: () => {
                if (pendingDel !== a.sessionId) {
                  setPendingDel(a.sessionId)
                  window.setTimeout(() => setPendingDel((cur) => (cur === a.sessionId ? '' : cur)), 5000)
                  return
                }
                setPendingDel('')
                post(a.sessionId, { remove: true }, key)
              },
            }, pendingDel === a.sessionId ? '确定' : '删'),
          ),
        )
      })

      return h('div', { style: S.wrap },
        summary,
        notice,
        createCard,
        h('div', { style: S.card },
          h('table', { style: S.table },
            h('thead', null,
              h('tr', null,
                h('th', { style: { ...S.th, width: '30%' } }, '会话'),
                h('th', { style: { ...S.th, width: '17%' } }, '状态'),
                h('th', { style: { ...S.th, width: '8%' } }, '开关'),
                h('th', { style: { ...S.th, width: '16%' } }, '频次'),
                h('th', { style: { ...S.th, width: '10%' } }, '上限'),
                h('th', { style: { ...S.th, width: '10%' } }, '静音'),
                h('th', { style: { ...S.th, width: '9%' } }, '删'),
              ),
            ),
            h('tbody', null, rows),
          ),
          h('div', { style: { marginTop: 10, paddingTop: 10, borderTop: '1px solid ' + C.line } },
            h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '什么时候才会真叫一声'),
            h('div', { style: S.dim }, '上面这些开关只管「能不能响」；真到点的时候还有五道闸，任何一条不过就安静跳过：'),
            h('ul', { style: { ...S.dim, margin: '6px 0 0', paddingLeft: 18, lineHeight: 1.7 } },
              h('li', null, '你上一条消息至少过去 5 分钟——刚说完话不打断'),
              h('li', null, '上一条你已经回过了，我没有在等你'),
              h('li', null, '我上一条回复也过去 2 分钟了'),
              h('li', null, '这条会话 10 分钟内没被叫过——只有半页的书房时间会避让心跳，心跳自己不避让'),
              h('li', null, '在时段内、今日预算没用完、没有临时静音'),
            ),
            h('div', { style: { ...S.dim, marginTop: 6 } },
              '安静 5–20 分钟：只说「到点了」；超过 20 分钟：连你留言的那句话一起说。'),
            h('div', { style: { ...S.dim, marginTop: 4 } },
              '上面五道闸靠读会话日志判断；万一读不到（日志没落盘、换了目录、文件坏了），五道闸一起失效，照时段和预算响——宁可白叫一次，也不漏。'),
          ),
        ),
        h('div', { style: { ...S.dim, marginTop: 2 } }, mine ? '「本会话」那条排最前并高亮。改完立刻写回，宿主那边是同一份状态。' : '下次要响的那条高亮。改完立刻写回，宿主那边是同一份状态。'),
      )
    }

    function Boundary(props) {
      try {
        return h(Panel, props)
      } catch (e) {
        return h('div', { style: { padding: 14, color: '#b23b3b', fontSize: 12 } }, '心跳面板出错了：' + String((e && e.message) || e))
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        // 探针：scope:session 的槽位能拿到 sessionId，记下最后看过的那个会话
        slots.inject('conversation.chat.assistant-actions', () => slots.register({
          name: 'conversation.chat.assistant-actions',
          id: 'dsh-self-clock/session-probe',
          order: 999,
          inject: (sessionId) => {
            if (typeof sessionId === 'string' && sessionId !== '') lastSessionId = sessionId
            return {}
          },
        }, () => null))
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'dsh-self-clock', order: 68, label: '鱼的心跳' },
          () => h(Boundary),
        ))
      },
    }
  },
})
