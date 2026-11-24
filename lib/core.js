/**
 * 纯逻辑：什么时候该响、时段怎么顺延、每日预算怎么算、cron 怎么解、状态怎么描述。
 * 这里不碰 ctx、不碰文件，方便直接拿 node 跑测试。
 */

export const MINUTE = 60_000
export const DAY = 86_400_000

/** "08:30" → 510（当天的分钟数）；写错就当没设 */
export function parseHHMM(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

/** 本地的「当天第几分钟」 */
export function minuteOfDay(ms) {
  const d = new Date(ms)
  return d.getHours() * 60 + d.getMinutes()
}

/** 本地某天的 00:00（毫秒） */
export function startOfDay(ms) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 本地日期键 2026-11-22 */
export function dayKey(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 本地 HH:MM */
export function hhmm(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

const pad2 = (n) => String(n).padStart(2, '0')

/**
 * 旧的安静时段写法（全局 quietStart/quietEnd）。现在主用 alarm.windowStart/windowEnd，
 * 这两个留作兼容：老数据、老测试、配置里没迁完的部分还认它。
 */
export function quietRange(cfg = {}) {
  const start = parseHHMM(cfg.quietStart)
  const end = parseHHMM(cfg.quietEnd)
  if (start === null || end === null || start === end) return null
  return { start, end }
}

export function isQuiet(ms, cfg = {}) {
  const range = quietRange(cfg)
  if (!range) return false
  const m = minuteOfDay(ms)
  return range.start < range.end
    ? m >= range.start && m < range.end
    : m >= range.start || m < range.end
}

/** 从 ms 起，第一个不在安静时段里的时刻（ms 本身不安静就原样返回） */
export function exitQuiet(ms, cfg = {}) {
  const range = quietRange(cfg)
  if (!range || !isQuiet(ms, cfg)) return ms
  const base = startOfDay(ms)
  const todayEnd = base + range.end * MINUTE
  if (range.start < range.end) return todayEnd > ms ? todayEnd : todayEnd + DAY
  return todayEnd > ms ? todayEnd : todayEnd + DAY
}

/* ---------------------------------------------------------------- cron */

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 6 },
]

/** 一个字段 → 允许值集合；支持 *、a、a,b、a-b、*\/n、a-b\/n */
function parseField(text, { min, max }) {
  const out = new Set()
  for (const part of String(text).split(',')) {
    const [body, stepText] = part.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron 步长不合法：${part}`)
    let lo = min
    let hi = max
    if (body !== '*') {
      const m = /^(\d+)(?:-(\d+))?$/.exec(body)
      if (!m) throw new Error(`cron 字段不合法：${part}`)
      lo = Number(m[1])
      hi = m[2] === undefined ? (stepText === undefined ? Number(m[1]) : max) : Number(m[2])
      if (lo < min || hi > max || lo > hi) throw new Error(`cron 字段超范围：${part}`)
    }
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  if (out.size === 0) throw new Error('cron 字段是空的')
  return out
}

/** "30 7 * * *" → 五个集合 */
export function parseCron(expr) {
  const parts = String(expr ?? '').trim().split(/\s+/)
  if (parts.length !== 5) throw new Error('cron 要五个字段：分 时 日 月 周')
  const sets = parts.map((p, i) => parseField(p, FIELDS[i]))
  return {
    minute: sets[0],
    hour: sets[1],
    dayOfMonth: sets[2],
    month: sets[3],
    dayOfWeek: sets[4],
    expr: parts.join(' '),
  }
}

function cronMatches(parsed, date) {
  if (!parsed.minute.has(date.getMinutes())) return false
  if (!parsed.hour.has(date.getHours())) return false
  if (!parsed.month.has(date.getMonth() + 1)) return false
  const domOk = parsed.dayOfMonth.has(date.getDate())
  const dowOk = parsed.dayOfWeek.has(date.getDay())
  // 日和周都限定时，按 cron 惯例取「或」
  const domRestricted = parsed.dayOfMonth.size !== 31
  const dowRestricted = parsed.dayOfWeek.size !== 7
  if (domRestricted && dowRestricted) return domOk || dowOk
  return domOk && dowOk
}

/**
 * 严格晚于 fromMs 的下一个 cron 时刻；一年内没有就返回 null。
 * 从下一分钟开始扫，整点省略的字段也能接受。
 */
export function cronNext(parsed, fromMs) {
  const start = Math.floor(fromMs / MINUTE) * MINUTE + MINUTE
  const limit = start + 370 * DAY
  for (let t = start; t <= limit; t += MINUTE) {
    if (cronMatches(parsed, new Date(t))) return t
  }
  return null
}

/**
 * 读 alarm.cronParsed：落盘回来可能是空对象（Set 序列化后变 {}），
 * 这时候用 expr 重新解析——不能让「空集合算出 null 就静默不动」再发生。
 */
export function cronParsedOf(alarm) {
  const parsed = alarm?.cronParsed
  if (parsed && typeof parsed === 'object') {
    const built = {}
    let ok = true
    for (const field of FIELDS) {
      const value = parsed[field.name]
      let set = null
      if (value instanceof Set) set = value
      else if (Array.isArray(value)) set = new Set(value.filter((v) => Number.isInteger(v)))
      if (!set || set.size === 0) { ok = false; break }
      built[field.name] = set
    }
    if (ok) return { parsed: { ...built, expr: parsed.expr || alarm?.cron || '' }, error: null }
  }
  try {
    return { parsed: parseCron(alarm?.cron), error: null }
  } catch (error) {
    return { parsed: null, error: String(error?.message || error) }
  }
}

/* ------------------------------------------------------------ 下一次 */

/**
 * 时段（小时制）：alarm.windowStart/windowEnd 优先，其次旧的 quietStart/quietEnd。
 * start=0 且 end=23/24 当全天；start > end 表示跨夜。
 */
export function windowOf(alarm = {}) {
  const s = Number.isInteger(alarm.windowStart) ? alarm.windowStart * 60 : 0
  const e = Number.isInteger(alarm.windowEnd) ? alarm.windowEnd * 60 : 24 * 60
  if (s === e) return null
  if (s === 0 && (e === 23 * 60 || e === 24 * 60)) return null
  return { start: s, end: e }
}

export function isInWindow(ms, alarm = {}) {
  const range = windowOf(alarm)
  if (!range) return true
  const m = minuteOfDay(ms)
  return range.start < range.end
    ? m >= range.start && m < range.end
    : m >= range.start || m < range.end
}

/** 不在时段里时，下一个「时段开始」的时刻 */
export function exitWindow(ms, alarm = {}) {
  const range = windowOf(alarm)
  if (!range || isInWindow(ms, alarm)) return ms
  const base = startOfDay(ms)
  const todayStart = base + range.start * MINUTE
  return todayStart > ms ? todayStart : todayStart + DAY
}

/** 面板/工具都要能回答「为什么没响」 */
export function statusOf(alarm = {}, now = Date.now(), extra = {}) {
  if (alarm.enabled === false) return { code: 'disabled', text: '已关闭（总开关）' }

  const mutedUntil = alarm.mutedUntil ? Date.parse(alarm.mutedUntil) : NaN
  if (Number.isFinite(mutedUntil) && mutedUntil > now) {
    return { code: 'muted', text: `临时静音中 · ${hhmm(mutedUntil)} 恢复`, until: mutedUntil }
  }

  const used = Number(extra.used ?? 0)
  const budget = Number(extra.budget ?? alarm.dailyBudget ?? 48)
  if (used >= budget) return { code: 'budget', text: `今日预算用完（${used}/${budget}）` }

  if (!isInWindow(now, alarm)) {
    const range = windowOf(alarm)
    const s = Math.floor(range.start / 60)
    const e = Math.floor(range.end / 60)
    const cross = s > e ? '，跨夜' : ''
    return { code: 'window', text: `不在时段（${pad2(s)}:00–${pad2(e)}:00${cross}）` }
  }

  if (!Number.isFinite(alarm.nextAt)) return { code: 'none', text: '⚠ 未排到下次触发' }
  return { code: 'waiting', text: `等待中 · 下次 ${hhmm(alarm.nextAt)}` }
}

/** 不考虑时段时，闹钟的原始下一次 */
function rawNext(alarm, fromMs) {
  if (alarm.mode === 'once') return alarm.at ?? null
  if (alarm.mode === 'every' || alarm.mode === 'interval') {
    const step = Number(alarm.everyMinutes) * MINUTE
    if (!Number.isFinite(step) || step <= 0) return null
    const base = alarm.baseAt ?? alarm.createdAt ?? fromMs
    // 刚响过就从前一次之后算，避免同一刻反复响；停机错过的那几拍直接跳到下一个未过的时刻
    const from = Math.max(fromMs, (alarm.lastFiredAt ?? 0) + 1)
    const k = Math.max(1, Math.ceil((from - base) / step))
    return base + k * step
  }
  if (alarm.mode === 'cron') {
    const { parsed } = cronParsedOf(alarm)
    if (!parsed) return null
    return cronNext(parsed, fromMs)
  }
  return null
}

/** 闹钟的下一次响铃时刻：raw 落在时段外就顺延到时段里（不报错、不丢）。一次性闹钟顺延后仍只响一次。 */
export function nextFire(alarm, fromMs, cfg = {}) {
  let t = rawNext(alarm, fromMs)
  if (t === null || t === undefined) return null
  if (isInWindow(t, alarm)) return t

  const leave = exitWindow(t, alarm)
  if (alarm.mode === 'once') return leave

  if (alarm.mode === 'cron') {
    const { parsed } = cronParsedOf(alarm)
    if (!parsed) return leave
    let n = cronNext(parsed, leave - MINUTE)
    let guard = 0
    while (n !== null && !isInWindow(n, alarm) && guard++ < 64) {
      n = cronNext(parsed, exitWindow(n, alarm) - MINUTE)
    }
    return n
  }

  // every/interval：按 base 的整倍数往后挪，直到进入时段
  const step = Number(alarm.everyMinutes) * MINUTE
  const base = alarm.baseAt ?? alarm.createdAt ?? fromMs
  const k = Math.max(1, Math.ceil((leave - base) / step))
  let cur = base + k * step
  let guard = 0
  while (!isInWindow(cur, alarm) && guard++ < 64) cur += step
  return cur
}

/**
 * 「现在算不算我自己的时间」——纯判断，不读文件：
 * ① 距上条 user < chatGrace → 跳过 ② 还没回他 → 跳过 ③ 最后一条 assistant 距今 < postReplyGrace → 跳过
 * ④ 5–20 分钟 → 温和版 ⑤ >20 分钟 → 原文
 */
export function judgeTiming(input = {}) {
  const now = Number(input.now ?? Date.now())
  const userAt = Number.isFinite(input.userAt) ? input.userAt : null
  const lastAssistantAt = Number.isFinite(input.lastAssistantAt) ? input.lastAssistantAt : null
  const chatGrace = Number(input.chatGraceMinutes ?? 5)
  const postGrace = Number(input.postReplyGraceMinutes ?? 2)

  if (userAt === null) return { kind: 'deliver', mode: 'normal', note: '会话里还没有他的消息' }

  const gap = (now - userAt) / MINUTE
  if (gap < chatGrace) return { kind: 'skip', reason: `距上条消息 ${Math.round(gap)} 分钟`, note: '太近' }
  if (lastAssistantAt === null || lastAssistantAt < userAt) {
    return { kind: 'skip', reason: '他在等回复', note: '上一条还没回' }
  }
  if ((now - lastAssistantAt) / MINUTE < postGrace) return { kind: 'skip', reason: '刚收尾', note: '最后一句是刚说的' }
  if (gap <= 20) return { kind: 'deliver', mode: 'gentle', note: `距上条消息 ${Math.round(gap)} 分钟` }
  return { kind: 'deliver', mode: 'normal', note: `距上条消息 ${Math.round(gap)} 分钟` }
}

/** 当天的预算状态；跨天就重置 */
export function budgetState(usage, nowMs) {
  const today = dayKey(nowMs)
  const used = usage && usage.date === today ? Number(usage.count) || 0 : 0
  return { date: today, used }
}

export function budgetLeft(usage, nowMs, limit) {
  const { used } = budgetState(usage, nowMs)
  return Math.max(0, Number(limit) - used)
}
