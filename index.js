/**
 * dsh-heartbeat —— 自己的闹钟。
 *
 * 和内置 schedule 的区别：模型自己定时间（工具），到点在同一条会话里注一条 notice，
 * 带时段窗口（默认全天）和每日预算（默认 48 次），还有「他这会儿在不在说话」的判断。
 * 没有死提示词，也不派任务。
 *
 * 投递方式照 DSH 自己的 schedule 运行时来：
 *   agent.followup(createUserMessage({ content, source }))  →  ctx.sessions.flush(agent.session)
 * 会话没活着的用 ctx.sessionController.resolveAgent(sessionId) 复活。
 */
import { readFile, writeFile, rename, mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

import {
  MINUTE, budgetState, dayKey, hhmm, judgeTiming, nextFire, parseCron, statusOf, windowOf,
} from './lib/core.js'
import { preview, readSessionPresence } from './lib/presence.js'
import { loadCreateUserMessage } from './lib/message.js'

/**
 * 路由准入（工单-HTTP路由准入，2026-11-26）。
 *
 * 宿主契约：register({ auth }) 的 auth 可以是
 * 'anonymous' | 'required' | 'deny'，或 (request) => policy；
 * request 里有 { headers, method, url, transport }。
 *
 * 规则：请求带 Origin/Referer 且跟 Host 对不上 → 拒；Origin 是 "null"
 * （沙箱页面 / data: / file:）→ 拒；没带来源（curl、本地脚本、同源导航）
 * 或来源就是本服务的 Host → 放行。面板在同源 iframe 里跑，功能不变。
 */
export function sameSiteAuth(request) {
  const headers = request?.headers
  const read = (name) => {
    if (!headers) return undefined
    if (typeof headers.get === 'function') return headers.get(name) ?? undefined
    const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()]
    return Array.isArray(value) ? value[0] : value
  }
  const host = String(read('host') || '')
  const source = String(read('origin') || read('referer') || '')
  if (!source) return 'anonymous'
  if (source === 'null') return 'deny'
  try {
    const url = new URL(source)
    if (host && url.host === host) return 'anonymous'
    // 同一个本机服务、但 Host 头缺失（HTTP/1.0、某些本地代理）
    if (!host && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) return 'anonymous'
    return 'deny'
  } catch {
    return 'deny'
  }
}


export const name = 'dsh-heartbeat'

/** tools 是必须的；agents／sessions 用来投递与落盘；webServer 用来给面板挂一个只读页。 */
export const inject = ['tools', 'agents', 'sessions', 'webServer']

const DEFAULTS = {
  // 每条闹钟自己的默认值（字段在 alarms[sessionId] 上）
  windowStart: 0,
  windowEnd: 23,
  dailyBudget: 48,
  everyMinutes: null,
  // 判断「现在算不算我自己的时间」
  chatGraceMinutes: 5,
  postReplyGraceMinutes: 2,
  // presence 的三道闸：先认来源，再认「必须含」的章，最后排掉系统注入与插件汇报。
  ownerSourceKinds: ['user', 'qq'],
  ownerSourceRequire: '',
  ownerSourceDeny: [
    '^\\s*【当前时间】',
    '^\\s*【通用档案】',
    '^\\s*\\*\\*第[一二三四五六七八九十\\d]',
    '^\\s*\\[SCHEDULE REMINDER\\]',
    '^\\s*<system-reminder>',
    '^\\s*Current runtime context',
    '^\\s*\\[MNEMON\\]',
    '^\\s*\\[Compressed conversation section\\]',
    '^\\s*<acp',
  ],
}
const MAX_TIMER = 2 ** 31 - 1
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_FILE = join(DSH_HOME, 'heartbeat.json')
const INTENTS_FILE = join(DSH_HOME, 'intents.json')
const SELF_DIR = join(DSH_HOME, 'self')
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')
const PROJ_DIR = join(DSH_HOME, 'storages', 'session_projcache', 'sessions')
const LABEL_MAX = 80
const MIN_EVERY = 5
const GENTLE_TEXT = '到点了。（他刚说完话没多久，先别起新话题；想说什么就轻轻说一句。）'

/* ------------------------------------------------------------ 意图（intents） */
/** 同时最多挂着几条 */
const INTENT_MAX_PENDING = 5
/** 一天最多被意图唤醒几次——这是刹车，不是配额 */
const INTENT_MAX_PER_DAY = 4
/** 过期多久算作废 */
const INTENT_TTL = 24 * 60 * MINUTE

const TEMPLATE_INTENTS = `# 意图

一行一条：\`- 时间 | 条件 | 想干嘛 | 来源 | 状态\`
例：\`- 23:30 | 他还在电脑前 | 看一眼，在就别出声 | 他说「今晚可能很晚」 | pending\`

这份是给人看的。真正会叫醒你的是 \`intent_set\`，它写 \`~/.dsh/intents.json\`。
边界：最多 5 条；过期 24 小时作废；只记「什么时候该看场面」，不记活。
空着也正常——一整天一条都没有，说明今天没什么非看不可的场面。
`

const TEMPLATE_WANTS = `# 我想做的事

一行一条，写想做还没做的。
例：\`- 把《雪中》读完\`、\`- 学一下怎么给自己做个网页\`

这不是任务清单——没有截止日期，也不用汇报，想删就删。
也可以一直空着：醒来没事就歇着，那不算浪费。
`

const TEMPLATE_CAN = `# 醒来能干嘛

这是你自己醒来的时候、可以随便做的事——不用问他、不用交差、做不成也没人扣分。

不知道自己能干嘛的时候，先把眼前能做的事列一列：读文件、跑命令、查网页是工具；
也可以是发句话给他、翻自己的本子、重读他写的或你写的东西、玩一把，或者什么都不做。

想往 \`意图.md\` 里写「到点干什么」的时候，从这页挑一条。
加的时候带一句「怎么开始」（用什么、落在哪），下次醒来才接得上。

（这份就写在这里，跟 \`意图.md\`、\`我想做的事.md\` 同一个目录。你自己的工作区里要是也有本子目录，
抄一份过去、或者留一句指回来都行，但只留一份真话，别两边各写一半。）

他要说过「下次别再提这事」，那不是意图本该记的——是你自己要守住的东西。
意图本是叫醒你的，不替你守规矩。
`

function intentsPath() {
  return INTENTS_FILE
}

function emptyIntents() {
  return { version: 1, intents: [], usage: { date: '', count: 0 } }
}

async function loadIntents() {
  try {
    const raw = await readFile(intentsPath(), 'utf8')
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed?.intents) ? parsed.intents : []
    return {
      version: parsed?.version ?? 1,
      intents: list.filter((item) => item && typeof item === 'object'),
      usage: parsed?.usage && typeof parsed.usage === 'object'
        ? { date: String(parsed.usage.date ?? ''), count: num(parsed.usage.count, 0) }
        : { date: '', count: 0 },
    }
  } catch {
    return emptyIntents()
  }
}

async function saveIntents(doc) {
  const payload = {
    version: doc.version ?? 1,
    intents: Array.isArray(doc.intents) ? doc.intents : [],
    usage: doc.usage ?? { date: '', count: 0 },
  }
  const file = intentsPath()
  const tmp = `${file}.${process.pid}.tmp`
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
    await rename(tmp, file)
  } catch {}
}

/**
 * 首次运行时放三份空模板，让别人的鱼自己往里写。
 * 硬规矩：文件存在就一个字都不改；写不进去也不能拦住插件启动。
 */
async function ensureTemplates(log) {
  const files = [
    [join(SELF_DIR, '意图.md'), TEMPLATE_INTENTS],
    [join(SELF_DIR, '我想做的事.md'), TEMPLATE_WANTS],
    [join(SELF_DIR, '醒来能干嘛.md'), TEMPLATE_CAN],
  ]
  try {
    await mkdir(SELF_DIR, { recursive: true })
  } catch (error) {
    log?.(`模板目录建不了（${error?.message || error}），跳过模板`)
    return []
  }
  const written = []
  for (const [file, text] of files) {
    try {
      await stat(file)
      continue
    } catch {}
    try {
      await writeFile(file, text, 'utf8')
      written.push(file)
    } catch (error) {
      log?.(`模板写不进去（${file}）：${error?.message || error}`)
    }
  }
  return written
}

/** 意图时间：只认绝对时刻，写进去就定死，不留表达式 */
function parseIntentAt(raw, now = Date.now()) {
  const text = String(raw ?? '').trim()
  if (!text) return { ok: false, message: '要给时间：ISO、HH:MM 或 +3h。' }
  const relative = /^\+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i.exec(text)
  if (relative) {
    const amount = Number(relative[1])
    const unit = relative[2].toLowerCase()
    const ms = unit.startsWith('m')
      ? amount * MINUTE
      : unit.startsWith('h') ? amount * 60 * MINUTE : amount * 24 * 60 * MINUTE
    if (!(ms > 0)) return { ok: false, message: '相对时间要大于 0。' }
    return { ok: true, at: now + ms }
  }
  const clock = /^(\d{1,2}):(\d{2})$/.exec(text)
  if (clock) {
    const hour = Number(clock[1])
    const minute = Number(clock[2])
    if (hour > 23 || minute > 59) return { ok: false, message: `时间不合法：${text}（HH:MM）。` }
    const day = new Date(now)
    day.setHours(hour, minute, 0, 0)
    let at = day.getTime()
    if (at <= now) at += 24 * 60 * MINUTE
    return { ok: true, at }
  }
  const at = Date.parse(text)
  if (!Number.isFinite(at)) return { ok: false, message: `认不出这个时间：${text}` }
  return { ok: true, at }
}

function statePath() {
  return STATE_FILE
}

/** 会话标题存在 projcache 里；读不到就空着 */
async function sessionTitleOf(sessionId) {
  try {
    const raw = await readFile(join(PROJ_DIR, String(sessionId) + '.json'), 'utf8')
    const j = JSON.parse(raw)
    const t = j?.record?.rows?.title?.val
    return typeof t === 'string' ? t : ''
  } catch {
    return ''
  }
}

/** 内部会话（子代理、Mnemon 委托、批处理）不该出现在「新建」的候选里 */
function looksInternal(sessionId, title) {
  const sid = String(sessionId || '')
  // 正常会话的 id 有前缀：session- / onebot- / qq-；裸 uuid 基本是内部起的
  if (!/^(session-|onebot-|qq-)/.test(sid)) return true
  // [dsh-mnemon:delegated review] 这类委托会话标题以方括号开头
  if (/^\[/.test(String(title || '').trim())) return true
  return false
}

/** 最近有动静的会话，给设置页的「新建」挑目标用 */
/** sessions that still have a live agent - the New picker only shows these */
function liveSessions(ctx, limit = 40) {
  const out = []
  try {
    const arr = ctx.agents.list()
    const list = Array.isArray(arr) ? arr : arr && typeof arr[Symbol.iterator] === "function" ? [...arr] : []
    for (const a of list) {
      const sid = (a && a.session && a.session.id) || (a && a.id)
      if (!sid) continue
      const header = (a && a.session && a.session.header) || {}
      if (header.origin === "subagent") continue
      out.push({ id: String(sid) })
      if (out.length >= limit) break
    }
  } catch {
    // no agents service -> empty list is safer than a wrong one
  }
  return out
}

async function listRecentSessions(limit = 40) {
  const out = []
  let projects = []
  try {
    projects = await readdir(SESSIONS_ROOT, { withFileTypes: true })
  } catch {
    return out
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    let subs = []
    try {
      subs = await readdir(join(SESSIONS_ROOT, project.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const sub of subs) {
      if (!sub.isDirectory()) continue
      try {
        const info = await stat(join(SESSIONS_ROOT, project.name, sub.name, 'session.v4.jsonl.zstd'))
        out.push({ id: sub.name, at: info.mtimeMs })
      } catch {
        // 没日志的会话跳过
      }
    }
  }
  out.sort((a, b) => b.at - a.at)
  const picked = []
  for (const item of out) {
    if (picked.length >= limit) break
    const title = await sessionTitleOf(item.id)
    if (looksInternal(item.id, title)) continue
    picked.push({ ...item, title, atLocal: `${dayKey(item.at)} ${hhmm(item.at)}` })
  }
  return picked
}

function emptyState() {
  return { version: 1, alarms: {}, usage: { date: '', bySession: {} } }
}

function num(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function normaliseConfig(raw = {}) {
  const windowStart = Number.isInteger(raw.windowStart) ? raw.windowStart : DEFAULTS.windowStart
  const windowEnd = Number.isInteger(raw.windowEnd) ? raw.windowEnd : DEFAULTS.windowEnd
  const dailyBudget = Number.isInteger(raw.dailyBudget) ? raw.dailyBudget : DEFAULTS.dailyBudget
  const chatGraceMinutes = num(raw.chatGraceMinutes, DEFAULTS.chatGraceMinutes)
  const postReplyGraceMinutes = num(raw.postReplyGraceMinutes, DEFAULTS.postReplyGraceMinutes)
  const kinds = Array.isArray(raw.ownerSourceKinds) && raw.ownerSourceKinds.length > 0
    ? raw.ownerSourceKinds.map(String)
    : DEFAULTS.ownerSourceKinds
  return {
    windowStart,
    windowEnd,
    dailyBudget,
    chatGraceMinutes,
    postReplyGraceMinutes,
    ownerSourceKinds: kinds,
    ownerSourceRequire: typeof raw.ownerSourceRequire === 'string' ? raw.ownerSourceRequire : DEFAULTS.ownerSourceRequire,
    ownerSourceDeny: Array.isArray(raw.ownerSourceDeny) && raw.ownerSourceDeny.length > 0
      ? raw.ownerSourceDeny.map(String)
      : DEFAULTS.ownerSourceDeny,
  }
}

/** 老数据补默认值：字段只加不改名 */
function normaliseAlarm(alarm, cfg, now = Date.now()) {
  const out = { ...alarm }
  if (typeof out.enabled !== 'boolean') out.enabled = true
  if (out.mode === 'every') out.mode = 'interval'
  if (!out.mode) out.mode = 'cron'
  if (!Number.isInteger(out.windowStart)) out.windowStart = cfg.windowStart
  if (!Number.isInteger(out.windowEnd)) out.windowEnd = cfg.windowEnd
  if (!Number.isInteger(out.dailyBudget)) out.dailyBudget = cfg.dailyBudget
  if (!('mutedUntil' in out)) out.mutedUntil = null
  if (out.mutedUntil) {
    const until = Date.parse(out.mutedUntil)
    if (!Number.isFinite(until) || until <= now) out.mutedUntil = null
  }
  if (!out.sessionId) out.sessionId = out.sessionId ?? ''
  return out
}

/** 落盘时去掉 cronParsed：Set 存成 JSON 会变成 {}，读回来再按 expr 重解析 */
function persistable(alarm) {
  const { cronParsed, ...rest } = alarm
  return rest
}

async function loadState() {
  try {
    const raw = await readFile(statePath(), 'utf8')
    const parsed = JSON.parse(raw)
    return {
      version: parsed.version ?? 1,
      alarms: parsed.alarms && typeof parsed.alarms === 'object' && !Array.isArray(parsed.alarms) ? parsed.alarms : {},
      usage: parsed.usage && typeof parsed.usage === 'object' ? parsed.usage : { date: '', bySession: {} },
    }
  } catch {
    return emptyState()
  }
}

async function saveState(state) {
  const alarms = {}
  for (const [key, alarm] of Object.entries(state.alarms ?? {})) alarms[key] = persistable(alarm)
  const payload = {
    version: state.version ?? 1,
    alarms,
    usage: state.usage ?? { date: '', bySession: {} },
  }
  const file = statePath()
  const tmp = `${file}.${process.pid}.tmp`
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
    await rename(tmp, file)
  } catch (error) {
    // 目录被删、磁盘忙：写不进去不该把定时器带崩
    try {
      ctx?.logger?.warn?.(`heartbeat: 落盘失败（${error?.message || error}）`)
    } catch {}
  }
}

function firedText(label) {
  return label ? `到点了。（${label}）` : '到点了。'
}

function shortId(sessionId) {
  const text = String(sessionId || '')
  return text.length > 18 ? `${text.slice(0, 10)}…${text.slice(-4)}` : text
}

function alarmView(alarm, now, cfg, used) {
  const budget = Number.isInteger(alarm.dailyBudget) ? alarm.dailyBudget : cfg.dailyBudget
  const status = statusOf(alarm, now, { ...cfg, used, budget })
  const range = windowOf(alarm, cfg)
  return {
    sessionId: alarm.sessionId,
    label: alarm.label || '',
    mode: alarm.mode === 'every' ? 'interval' : alarm.mode,
    enabled: alarm.enabled !== false,
    everyMinutes: alarm.everyMinutes ?? null,
    cron: alarm.cron ?? null,
    window: range ? `${String(Math.floor(range.start / 60)).padStart(2, '0')}:00–${String(Math.floor(range.end / 60)).padStart(2, '0')}:00` : '全天',
    windowStart: alarm.windowStart,
    windowEnd: alarm.windowEnd,
    dailyBudget: budget,
    mutedUntil: alarm.mutedUntil ?? null,
    nextAt: Number.isFinite(alarm.nextAt) ? new Date(alarm.nextAt).toISOString() : null,
    nextAtLocal: Number.isFinite(alarm.nextAt) ? `${dayKey(alarm.nextAt)} ${hhmm(alarm.nextAt)}` : null,
    lastFiredAt: Number.isFinite(alarm.lastFiredAt) ? new Date(alarm.lastFiredAt).toISOString() : null,
    firedCount: alarm.firedCount ?? 0,
    status: status.code,
    statusText: status.text,
  }
}

/**
 * 绑到当前插件上。ctx 由 Cordis 给；rawConfig 来自 cordis.patch.yml 的 config。
 */
export function apply(ctx, rawConfig = {}) {
  const cfg = normaliseConfig(rawConfig)
  let timer
  let ticking = false
  let disposed = false
  let state = emptyState()
  let createUserMessage
  const notes = []
  /** 会话日志读数缓存：同一分钟内不重复解压 */
  const presenceCache = new Map()

  const log = (message) => {
    try {
      ctx.logger?.info?.(`heartbeat: ${message}`)
    } catch {}
  }

  const ready = loadCreateUserMessage((note) => notes.push(note)).then((fn) => {
    createUserMessage = fn
  })

  let loadedFromDisk = false
  let intentsDoc = emptyIntents()
  let intentsLoaded = false

  async function loadIntentsOnce() {
    if (intentsLoaded) return
    // 第一次运行（或者别人刚装上）就落一份空结构，让人能打开看见、也知道该往哪写
    const existed = await stat(intentsPath()).then(() => true).catch(() => false)
    intentsDoc = await loadIntents()
    intentsLoaded = true
    if (!existed) await saveIntents(intentsDoc)
  }
  async function bootState() {
    await ready
    if (loadedFromDisk) return
    state = await loadState()
    loadedFromDisk = true
    const now = Date.now()
    let changed = false
    for (const [key, alarm] of Object.entries(state.alarms)) {
      const normalised = normaliseAlarm(alarm, cfg, now)
      if (JSON.stringify(normalised) !== JSON.stringify(alarm)) changed = true
      state.alarms[key] = normalised
    }
    // 预算按会话分桶：搬过会话之后，旧 key 还占着今天的额度，启动时清一次。
    // 只在启动做（不是每次落盘都做），否则一次性闹钟响完删条目会把刚记下的那一次也抹掉。
    const bucket = state.usage?.bySession && typeof state.usage.bySession === 'object' ? state.usage.bySession : {}
    for (const sessionId of Object.keys(bucket)) {
      if (!state.alarms[sessionId]) {
        delete bucket[sessionId]
        changed = true
      }
    }
    if (changed) await saveState(state)
  }

  /* ------------------------------------------------------------ 投递 */

  async function resolveAgent(sessionId) {
    const live = ctx.agents?.get?.(sessionId)
    if (live) return live
    try {
      const resolved = await ctx.sessionController?.resolveAgent?.(sessionId)
      if (resolved && 'agent' in resolved) return resolved.agent
      if (resolved && resolved.agent) return resolved.agent
    } catch {}
    return null
  }

  async function deliver(sessionId, text) {
    const agent = await resolveAgent(sessionId)
    if (!agent) return { ok: false, reason: 'no-session' }
    // 官方 createUserMessage 收 (input) → createMessage({...input, role:'user'})，
    // 内容要给 content 数组；fallback 两种形状都认。
    const message = await createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'heartbeat', form: 'notice', summary: text.slice(0, 120) },
    })
    try {
      await agent.followup(message)
    } catch (error) {
      return { ok: false, reason: error?.message || String(error) }
    }
    try {
      const flushed = await ctx.sessions.flush(agent.session)
      if (flushed === false) return { ok: false, reason: 'flush-failed' }
    } catch (error) {
      return { ok: false, reason: error?.message || String(error) }
    }
    return { ok: true, at: Date.now() }
  }

  /* ------------------------------------------------------------ 在不在 */

  async function presenceOf(sessionId) {
    const cached = presenceCache.get(sessionId)
    const now = Date.now()
    if (cached && now - cached.at < MINUTE) return cached.result
    let result
    try {
      result = await readSessionPresence(SESSIONS_ROOT, sessionId, cfg, { maxScan: 50 })
    } catch (error) {
      result = { ok: false, error: error?.message || String(error) }
    }
    presenceCache.set(sessionId, { at: now, result })
    return result
  }

  /**
   * 现在算不算「我自己的时间」：
   * ① 距上条 user < chatGraceMinutes → 只写日志 ② 还没回他 → 不投
   * ③ 最后一条 assistant 距今 < postReplyGraceMinutes → 刚收尾 ④ 5–20 分钟 → 温和版 ⑤ >20 分钟 → 原文
   */
  async function decide(sessionId, now) {
    const pres = await presenceOf(sessionId)
    // 读不到日志 ≠ 他不在。真读不到时（没落盘 / 解不开 / 目录换了）只是不知道他刚说过什么，
    // 这时五道时间闸一起失效，按时段和预算照常响——误叫一次没损失，漏叫才是功能废了。
    if (!pres?.ok) {
      const via = judgeTiming({
        now,
        userAt: null,
        lastAssistantAt: null,
        chatGraceMinutes: cfg.chatGraceMinutes,
        postReplyGraceMinutes: cfg.postReplyGraceMinutes,
      })
      return { ...via, note: `读不到会话日志（${pres?.error || 'unknown'}），按不知道处理` }
    }
    return judgeTiming({
      now,
      userAt: pres.found ? pres.message.at : pres.lastUserAt,
      lastAssistantAt: pres.lastAssistantAt ?? null,
      chatGraceMinutes: cfg.chatGraceMinutes,
      postReplyGraceMinutes: cfg.postReplyGraceMinutes,
    })
  }

  /* ------------------------------------------------------------ 意图唤醒 */

  function intentUsage(now) {
    const day = dayKey(now)
    const usage = intentsDoc.usage ?? { date: '', count: 0 }
    return { day, used: usage.date === day ? num(usage.count, 0) : 0 }
  }

  function intentView(item, now) {
    const at = Date.parse(item.at)
    return {
      id: item.id,
      at: item.at,
      atLocal: Number.isFinite(at) ? `${dayKey(at)} ${hhmm(at)}` : null,
      note: item.note || '',
      status: item.status || 'pending',
      sessionId: item.sessionId ?? '',
      createdAt: item.createdAt ?? null,
      due: Number.isFinite(at) ? at <= now : false,
    }
  }

  async function pruneIntents(now) {
    let changed = false
    for (const item of intentsDoc.intents ?? []) {
      if (item.status !== 'pending') continue
      const at = Date.parse(item.at)
      if (!Number.isFinite(at) || now - at > INTENT_TTL) {
        item.status = 'expired'
        item.closedAt = new Date(now).toISOString()
        changed = true
        log(`意图过期（${item.id}）${item.note || ''}`)
      }
    }
    return changed
  }

  /**
   * 每拍先看意图，再看 cron。
   * 意图只说「该醒了」；能不能出声仍由 judgeTiming 五档决定——没过闸就留在 pending，下一拍再看。
   */
  async function tickIntents(now) {
    await loadIntentsOnce()
    let changed = await pruneIntents(now)
    const usage = intentUsage(now)

    const due = (intentsDoc.intents ?? [])
      .filter((item) => item.status === 'pending' && Number.isFinite(Date.parse(item.at)) && Date.parse(item.at) <= now)
      .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))

    for (const item of due) {
      const sessionId = String(item.sessionId || '')
      if (!sessionId) {
        item.status = 'expired'
        item.closedAt = new Date(now).toISOString()
        changed = true
        log(`意图没有会话（${item.id}），作废`)
        continue
      }

      if (usage.used >= INTENT_MAX_PER_DAY) {
        log(`今天的意图唤醒已用满（${usage.used}/${INTENT_MAX_PER_DAY}），${item.id} 先不投`)
        continue
      }

      const alarm = state.alarms?.[sessionId]
      if (alarm?.mutedUntil && Date.parse(alarm.mutedUntil) > now) {
        log(`静音中，意图先不投（${item.id}）`)
        continue
      }

      // 这里曾经有 he-awake（「他 >6 小时没说话就当睡着，不投」），2026-11-26 他去掉了：
      // 心跳是我自己的时间，不该因为他睡着就不走；只有他正在跟我说话时才往后让一步。
      // 那个「正在说话」的判断本来就在 decide() 的五道闸里（<5 分钟、等他回、刚收尾）。

      const verdict = await decide(sessionId, now)
      if (verdict.kind === 'skip') {
        log(`意图没过闸（${item.id}）：${verdict.reason}`)
        item.lastSkipAt = new Date(now).toISOString()
        item.lastSkipReason = verdict.reason
        changed = true
        continue
      }

      const text = `意图唤醒 · 你自己记的「${String(item.note || '').slice(0, LABEL_MAX)}」，到点了。`
      let result
      try {
        result = await deliver(sessionId, text)
      } catch (error) {
        result = { ok: false, reason: error?.message || String(error) }
      }
      if (!result.ok) {
        log(`意图投递失败（${item.id}）：${result.reason}`)
        continue
      }
      item.status = 'done'
      item.deliveredAt = new Date(now).toISOString()
      intentsDoc.usage = { date: usage.day, count: usage.used + 1 }
      usage.used += 1
      changed = true
      log(`意图唤醒了一次（${item.id}，今天 ${usage.used}/${INTENT_MAX_PER_DAY}）`)
    }

    if (changed) await saveIntents(intentsDoc)
    return changed
  }

  /** 把 intents 里还有 pending 的最近一条算进下一次唤醒时刻 */
  function nextIntentAt(now = Date.now()) {
    let earliest = Infinity
    for (const item of intentsDoc.intents ?? []) {
      if (item.status !== 'pending') continue
      const at = Date.parse(item.at)
      if (!Number.isFinite(at)) continue
      // 已经到点却没投出去的：第一次立刻处理（该作废的作废、该投的投）；
      // 处理过还留着的（在等他回、刚收尾、静音…）下一分钟再看，别空转。
      const candidate = at <= now ? (item.lastSkipAt ? now + MINUTE : now) : at
      if (candidate < earliest) earliest = candidate
    }
    return earliest
  }


  function clearTimer() {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  function recompute(alarm, fromMs) {
    if (alarm.enabled === false) {
      alarm.nextAt = null
      return null
    }
    try {
      const next = nextFire(alarm, fromMs, cfg)
      alarm.nextAt = Number.isFinite(next) ? next : null
      if (alarm.nextAt === null) log(`算不出下一次（${shortId(alarm.sessionId)}）：${alarm.mode} ${alarm.cron || alarm.everyMinutes || alarm.at}`)
      return alarm.nextAt
    } catch (error) {
      alarm.nextAt = null
      log(`算下一次失败（${shortId(alarm.sessionId)}）：${error?.message || error}`)
      return null
    }
  }

  function scheduleTick() {
    clearTimer()
    if (disposed) return
    let earliest = nextIntentAt()
    for (const alarm of Object.values(state.alarms ?? {})) {
      if (alarm.enabled === false) continue
      const at = Number(alarm.nextAt)
      if (Number.isFinite(at) && at < earliest) earliest = at
    }
    if (!Number.isFinite(earliest)) return
    const delay = Math.min(Math.max(earliest - Date.now(), 0), MAX_TIMER)
    timer = setTimeout(() => {
      timer = undefined
      void tick()
    }, delay)
    timer.unref?.()
  }

  async function tick() {
    if (disposed) return
    if (ticking) return
    ticking = true
    try {
      await ready
      const now = Date.now()
      let changed = false

      // 意图先走：到点了、且过得了「他这会儿在不在」的闸，就投一条；没过闸留 pending 等下一拍。
      try {
        if (await tickIntents(now)) changed = true
      } catch (error) {
        log(`意图处理失败：${error?.message || error}`)
      }

      for (const [sessionId, alarm] of Object.entries({ ...(state.alarms ?? {}) })) {
        state.alarms[sessionId] = normaliseAlarm(alarm, cfg, now)
        const current = state.alarms[sessionId]

        if (current.mutedUntil) {
          const until = Date.parse(current.mutedUntil)
          if (!Number.isFinite(until) || until <= now) {
            current.mutedUntil = null
            changed = true
          }
        }

        if (current.enabled === false) {
          if (current.nextAt !== null) {
            current.nextAt = null
            changed = true
          }
          continue
        }

        if (!Number.isFinite(current.nextAt)) {
          const next = recompute(current, now)
          changed = true
          if (next === null) continue
        }
        if (current.nextAt > now + 1_000) continue

        // 到点：先看静音/预算
        if (current.mutedUntil && Date.parse(current.mutedUntil) > now) {
          log(`静音中，跳过 ${shortId(sessionId)}`)
          current.lastFiredAt = now
          recompute(current, now)
          changed = true
          continue
        }
        const budget = Number.isInteger(current.dailyBudget) ? current.dailyBudget : cfg.dailyBudget
        const mine = usageFor(sessionId, now)
        if (mine.used >= budget) {
          log(`预算用完（${mine.used}/${budget}），跳过 ${shortId(sessionId)}`)
          if (current.mode === 'once') {
            current.nextAt = now + MINUTE
            changed = true
          } else {
            current.lastFiredAt = now
            recompute(current, now)
            changed = true
          }
          continue
        }

        // 再看他这会儿在不在
        const verdict = await decide(sessionId, now)
        if (verdict.kind === 'skip') {
          log(`跳过 ${shortId(sessionId)}：${verdict.reason}`)
          current.lastSkipAt = now
          current.lastSkipReason = verdict.reason
          if (current.mode === 'once') {
            current.nextAt = now + MINUTE
          } else {
            current.lastFiredAt = now
            recompute(current, now)
          }
          changed = true
          continue
        }

        const text = verdict.mode === 'gentle' ? GENTLE_TEXT : firedText(current.label)
        let result
        try {
          result = await deliver(sessionId, text)
        } catch (error) {
          result = { ok: false, reason: error?.message || String(error) }
        }
        if (!result.ok) {
          log(`投递失败（${shortId(sessionId)}）：${result.reason}`)
          current.nextAt = current.mode === 'once' ? now + MINUTE : recompute(current, now)
          changed = true
          continue
        }
        state.usage = { date: mine.day, bySession: { ...mine.bucket, [sessionId]: mine.used + 1 } }
        current.lastFiredAt = now
        current.firedCount = (current.firedCount ?? 0) + 1
        current.lastDeliveredMode = verdict.mode
        log(`响了一次（${shortId(sessionId)}，${verdict.mode}，今天 ${mine.used + 1}/${budget}）`)
        if (current.mode === 'once') delete state.alarms[sessionId]
        else recompute(current, now)
        changed = true
      }

      if (changed) await saveState(state)
      scheduleTick()
    } finally {
      ticking = false
    }
  }

  /* ------------------------------------------------------------ 启动 */

  async function boot() {
    await ready
    await bootState()
    await loadIntentsOnce()
    if (disposed) return
    // 别人的机器上没有这两份本子：只在缺的时候放空模板，一个字都不覆盖。
    const written = await ensureTemplates(log)
    if (written.length > 0) log(`首次运行，放了两份空模板（${written.join('、')}）`)
    if (disposed) return
    const now = Date.now()
    for (const alarm of Object.values(state.alarms ?? {})) recompute(alarm, now)
    if (disposed) return
    await saveState(state)
    scheduleTick()
    const count = Object.keys(state.alarms ?? {}).length
    const pending = (intentsDoc.intents ?? []).filter((item) => item.status === 'pending').length
    log(`起来了，${count} 个闹钟，${pending} 条待醒的意图，默认时段 ${String(cfg.windowStart).padStart(2, '0')}–${String(cfg.windowEnd).padStart(2, '0')}，预算 ${cfg.dailyBudget}/天`)
  }

  ctx.effect(() => {
    void boot().catch((error) => log(`启动失败：${error?.message || error}`))
    return () => {
      disposed = true
      clearTimer()
    }
  })

  /* ------------------------------------------------------------ 工具 */

  /** 面板与工具共用的一处改法：只动传进来的字段 */
  async function updateAlarmConfig(sessionId, args = {}) {
    const now = Date.now()
    if (args.remove === true) {
      const existed = Boolean(state.alarms[sessionId])
      delete state.alarms[sessionId]
      return { ok: true, removed: existed, sessionId }
    }
    let alarm = state.alarms[sessionId] ? normaliseAlarm(state.alarms[sessionId], cfg, now) : null
    if (!alarm) {
      alarm = normaliseAlarm({
        sessionId,
        label: '',
        createdAt: now,
        baseAt: now,
        mode: 'interval',
        everyMinutes: 30,
        enabled: true,
      }, cfg, now)
    }

    if (typeof args.enabled === 'boolean') {
      const turnedOn = args.enabled && alarm.enabled === false
      alarm.enabled = args.enabled
      if (!args.enabled) alarm.nextAt = null
      else if (turnedOn) alarm.baseAt = now
    }
    if (args.everyMinutes !== undefined) {
      const minutes = Number(args.everyMinutes)
      if (!Number.isInteger(minutes) || minutes < MIN_EVERY || minutes > 1440) {
        return { ok: false, error: 'invalid_rule', message: `everyMinutes 要 ${MIN_EVERY}–1440 的整数。` }
      }
      alarm.everyMinutes = minutes
      if (alarm.mode === 'once' || alarm.mode === 'cron') alarm.mode = 'interval'
      alarm.baseAt = now
    }
    if (args.windowStart !== undefined) {
      const h = Number(args.windowStart)
      if (!Number.isInteger(h) || h < 0 || h > 23) {
        return { ok: false, error: 'invalid_rule', message: 'windowStart 要 0–23 的整数。' }
      }
      alarm.windowStart = h
    }
    if (args.windowEnd !== undefined) {
      const h = Number(args.windowEnd)
      if (!Number.isInteger(h) || h < 0 || h > 23) {
        return { ok: false, error: 'invalid_rule', message: 'windowEnd 要 0–23 的整数。' }
      }
      alarm.windowEnd = h
    }
    if (args.dailyBudget !== undefined) {
      const n = Number(args.dailyBudget)
      if (!Number.isInteger(n) || n < 1) {
        return { ok: false, error: 'invalid_rule', message: 'dailyBudget 要 ≥ 1 的整数。' }
      }
      alarm.dailyBudget = n
    }
    if (args.muteMinutes !== undefined) {
      const minutes = Number(args.muteMinutes)
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
        return { ok: false, error: 'invalid_rule', message: 'muteMinutes 要 1–1440 的整数。' }
      }
      alarm.mutedUntil = new Date(now + minutes * MINUTE).toISOString()
    }

    state.alarms[sessionId] = alarm
    if (alarm.enabled !== false) recompute(alarm, now)
    const used = currentUsage(sessionId)
    return { ok: true, ...alarmView(alarm, now, cfg, used.used) }
  }

  const output = (schema) => ({
    schema,
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  })

  const CALLER = () => ({
    ok: false,
    error: 'subagent_session',
    message: '子会话不设闹钟：闹钟是给一条会话自己用的。',
  })

  function sessionKeyOf(exec) {
    const agent = exec?.agent
    const id = agent?.session?.id ?? agent?.id
    if (!id) return null
    if (agent?.session?.header?.origin === 'subagent') return { subagent: true, id }
    return { subagent: false, id }
  }

  function usageFor(sessionId, now = Date.now()) {
    const day = dayKey(now)
    const usage = state.usage && typeof state.usage === 'object' ? state.usage : {}
    const bucket = usage.date === day && usage.bySession && typeof usage.bySession === 'object'
      ? usage.bySession
      : {}
    return { day, bucket, used: num(bucket[sessionId], 0) }
  }

  function currentUsage(sessionId) {
    return usageFor(sessionId)
  }

  ctx.effect(() =>
    ctx.tools.register({
      name: 'heartbeat_set',
      description:
        '给自己挂一个闹钟：到点会在**同一条会话**里收到一条系统提示（notice）。'
        + '三种时间任选一个：inMinutes（N 分钟后一次）、everyMinutes（每隔 N 分钟，最少 5）、cron（五个字段）。'
        + '每条会话同时只挂一个，重复调用会覆盖旧的。落在时段外会自动顺延，不会报错。',
      parameters: {
        inMinutes: { type: 'integer', description: 'N 分钟后响一次（1–1440）。' },
        everyMinutes: { type: 'integer', description: '每隔 N 分钟响一次（5–1440）。' },
        cron: { type: 'string', description: 'cron 表达式，五个字段：分 时 日 月 周，例如 "30 7 * * *"。' },
        label: { type: 'string', description: `唤醒时提示自己「上次停在哪」的一句话（不超过 ${LABEL_MAX} 字）。` },
      },
      output: output({ type: 'object', properties: {}, additionalProperties: true }),
      async execute(args, exec) {
        await ready
        await bootState()
        const key = sessionKeyOf(exec)
        if (!key) return { ok: false, error: 'no_caller', message: '拿不到当前会话。' }
        if (key.subagent) return CALLER()

        const given = ['inMinutes', 'everyMinutes', 'cron'].filter((field) => args?.[field] !== undefined)
        if (given.length !== 1) {
          return { ok: false, error: 'invalid_rule', message: 'inMinutes / everyMinutes / cron 三选一。' }
        }
        const now = Date.now()
        const previous = state.alarms[key.id] ? normaliseAlarm(state.alarms[key.id], cfg, now) : {}
        const alarm = {
          ...previous,
          sessionId: key.id,
          label: String(args?.label ?? previous.label ?? '').trim().slice(0, LABEL_MAX),
          createdAt: previous.createdAt ?? now,
          baseAt: now,
          enabled: true,
          mutedUntil: null,
        }
        const mode = given[0]
        if (mode === 'inMinutes') {
          const minutes = Number(args.inMinutes)
          if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
            return { ok: false, error: 'invalid_rule', message: 'inMinutes 要 1–1440 的整数。' }
          }
          alarm.mode = 'once'
          alarm.at = now + minutes * MINUTE
        } else if (mode === 'everyMinutes') {
          const minutes = Number(args.everyMinutes)
          if (!Number.isInteger(minutes) || minutes < MIN_EVERY || minutes > 1440) {
            return { ok: false, error: 'invalid_rule', message: `everyMinutes 要 ${MIN_EVERY}–1440 的整数。` }
          }
          alarm.mode = 'interval'
          alarm.everyMinutes = minutes
        } else {
          try {
            parseCron(args.cron)
          } catch (error) {
            return { ok: false, error: 'invalid_rule', message: String(error?.message || error) }
          }
          alarm.mode = 'cron'
          alarm.cron = String(args.cron).trim()
          delete alarm.cronParsed
        }

        // 存盘与回执都用走过 normalise 的那份：裸对象没有 windowStart/windowEnd/dailyBudget，
        // alarmView 读到 undefined 会让工具输出过不了 lossless JSON 校验（0.3.11 的 bug）。
        const normalised = normaliseAlarm(alarm, cfg, now)
        const next = recompute(normalised, now)
        if (!Number.isFinite(next)) {
          return { ok: false, error: 'no_next', message: '这个规则算不出下一次，换一个。' }
        }
        state.alarms[key.id] = normalised
        await saveState(state)
        scheduleTick()
        const used = currentUsage(key.id)
        return {
          ok: true,
          ...alarmView(normalised, now, cfg, used.used),
          remainingToday: Math.max(0, normalised.dailyBudget - used.used),
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'heartbeat_cancel',
      description: '取消这条会话挂着的闹钟（没有就算取消成功）。',
      parameters: {},
      output: output({ type: 'object', properties: {}, additionalProperties: true }),
      async execute(_args, exec) {
        await ready
        const key = sessionKeyOf(exec)
        if (!key) return { ok: false, error: 'no_caller', message: '拿不到当前会话。' }
        if (key.subagent) return CALLER()
        const existed = Boolean(state.alarms[key.id])
        if (existed) {
          delete state.alarms[key.id]
          await saveState(state)
          scheduleTick()
        }
        return { ok: true, cancelled: existed }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'heartbeat_config',
      description:
        '改这条会话的闹钟设置（总开关 / 频次 / 时段 / 每日上限 / 临时静音）。只传要改的字段。'
        + '临时静音期间不响、不消耗预算，到点自动恢复。',
      parameters: {
        enabled: { type: 'boolean', description: '总开关。关掉后不触发，重新打开从头算，不补发积压。' },
        everyMinutes: { type: 'integer', description: `频次（分钟，最少 ${MIN_EVERY}）。设置后按「上次触发 + N 分钟」算。` },
        windowStart: { type: 'integer', description: '时段开始小时 0–23（默认 0）。' },
        windowEnd: { type: 'integer', description: '时段结束小时 0–23（默认 23，支持跨夜：start > end）。' },
        dailyBudget: { type: 'integer', description: '每日上限（默认 48）。' },
        muteMinutes: { type: 'integer', description: '临时静音多少分钟（1–1440）。' },
      },
      output: output({ type: 'object', properties: {}, additionalProperties: true }),
      async execute(args, exec) {
        await ready
        await bootState()
        const key = sessionKeyOf(exec)
        if (!key) return { ok: false, error: 'no_caller', message: '拿不到当前会话。' }
        if (key.subagent) return CALLER()
        const result = await updateAlarmConfig(key.id, args)
        if (result.ok) {
          await saveState(state)
          scheduleTick()
        }
        return result
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'heartbeat_mute',
      description: '临时静音这条会话的闹钟：N 分钟内不响、也不消耗每日预算，到点自动恢复。不传 minutes 就是 30 分钟。',
      parameters: {
        minutes: { type: 'number', description: '静音多少分钟（1–1440），默认 30。' },
      },
      output: output({ type: 'object', properties: {}, additionalProperties: true }),
      async execute(args, exec) {
        await ready
        await bootState()
        const key = sessionKeyOf(exec)
        if (!key) return { ok: false, error: 'no_caller', message: '拿不到当前会话。' }
        if (key.subagent) return CALLER()
        const minutes = Number(args?.minutes ?? 30)
        const result = await updateAlarmConfig(key.id, { muteMinutes: Number.isFinite(minutes) ? minutes : 30 })
        if (result.ok) {
          await saveState(state)
          scheduleTick()
        }
        return result
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'heartbeat_list',
      description: '看现在挂着哪些闹钟：下次时间、今天用了几次预算、以及「为什么没响」。',
      parameters: {},
      output: output({ type: 'object', properties: {}, additionalProperties: true }),
      async execute() {
        await ready
        const now = Date.now()
        const alarms = Object.values(state.alarms ?? {})
          .map((alarm) => normaliseAlarm(alarm, cfg, now))
          .sort((a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity))
          .map((alarm) => alarmView(alarm, now, cfg, usageFor(alarm.sessionId, now).used))
        const totalUsed = Object.values(usageFor('', now).bucket).reduce((sum, n) => sum + num(n, 0), 0)
        return {
          ok: true,
          now: new Date(now).toISOString(),
          nowLocal: `${dayKey(now)} ${hhmm(now)}`,
          defaultWindow: `${String(cfg.windowStart).padStart(2, '0')}:00–${String(cfg.windowEnd).padStart(2, '0')}:00`,
          graceMinutes: { chat: cfg.chatGraceMinutes, postReply: cfg.postReplyGraceMinutes },
          budget: { used: totalUsed, limit: cfg.dailyBudget, remaining: Math.max(0, cfg.dailyBudget - totalUsed) },
          alarms,
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'intent_set',
      description:
        '给「我该在什么时候醒」记一条——不是闹钟，是一个念头：到点了，先看你有没有在说话，合适才出声。'
        + 'at 可以是 ISO 时间、今天的 "HH:MM"、或相对 "+3h" / "+90m"。'
        + '最多同时挂 5 条，一天最多被这样叫醒 4 次。',
      parameters: {
        at: { type: 'string', description: '什么时候该醒：ISO 时间、HH:MM 或 +3h / +90m。' },
        note: { type: 'string', description: '一句来源：他说的原话，或者你自己的判断。会出现在唤醒里。' },
      },
      output: output({ type: 'object', properties: {}, additionalProperties: true }),
      async execute(args, exec) {
        await ready
        await loadIntentsOnce()
        const key = sessionKeyOf(exec)
        if (!key) return { ok: false, error: 'no_caller', message: '拿不到当前会话。' }
        if (key.subagent) return CALLER()

        const when = parseIntentAt(args?.at, Date.now())
        if (!when.ok) return { ok: false, error: 'invalid_at', message: when.message }

        await pruneIntents(Date.now())
        const pending = (intentsDoc.intents ?? []).filter((item) => item.status === 'pending')
        if (pending.length >= INTENT_MAX_PENDING) {
          return {
            ok: false,
            error: 'too_many_intents',
            message: `同时最多挂 ${INTENT_MAX_PENDING} 条意图，先取消一条再来。`,
            pending: pending.map((item) => ({ id: item.id, at: item.at, note: item.note })),
          }
        }

        const now = Date.now()
        const item = {
          id: randomUUID(),
          at: new Date(when.at).toISOString(),
          note: String(args?.note ?? '').trim().slice(0, LABEL_MAX * 2),
          status: 'pending',
          sessionId: key.id,
          createdAt: new Date(now).toISOString(),
        }
        intentsDoc.intents.push(item)
        await saveIntents(intentsDoc)
        scheduleTick()
        return { ok: true, ...intentView(item, now), pending: pending.length + 1 }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'intent_list',
      description: '看现在挂着哪些「该醒的念头」：什么时候、为什么、还差多少条到上限。',
      parameters: {},
      output: output({ type: 'object', properties: {}, additionalProperties: true }),
      async execute() {
        await ready
        await loadIntentsOnce()
        const now = Date.now()
        const pending = (intentsDoc.intents ?? [])
          .filter((item) => item.status === 'pending')
          .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
        const usage = intentUsage(now)
        return {
          ok: true,
          now: new Date(now).toISOString(),
          nowLocal: `${dayKey(now)} ${hhmm(now)}`,
          pending: pending.map((item) => intentView(item, now)),
          limit: { pending: INTENT_MAX_PENDING, perDay: INTENT_MAX_PER_DAY },
          usedToday: usage.used,
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'intent_cancel',
      description: '取消一条挂着的意图（改主意了、或他已经说过那件事了）。',
      parameters: {
        id: { type: 'string', description: '意图 id，从 intent_list 拿。' },
      },
      output: output({ type: 'object', properties: {}, additionalProperties: true }),
      async execute(args) {
        await ready
        await loadIntentsOnce()
        const id = String(args?.id ?? '').trim()
        if (!id) return { ok: false, error: 'invalid_id', message: '要给 id。' }
        const item = (intentsDoc.intents ?? []).find((entry) => entry.id === id)
        if (!item) return { ok: false, error: 'not_found', message: `没有这条意图：${id}` }
        if (item.status !== 'pending') {
          return { ok: false, error: 'not_pending', message: `这条已经是 ${item.status}，不用取消。` }
        }
        item.status = 'cancelled'
        item.closedAt = new Date().toISOString()
        await saveIntents(intentsDoc)
        scheduleTick()
        return { ok: true, cancelled: true, id }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'presence',
      description:
        '读会话日志正文，回答「他本人最后说话是什么时候、走的哪条通道」——看的是正文不是 mtime'
        + '（会话文件每轮都在写，mtime 永远是新的）。判据是三道闸，顺序固定：'
        + '① ownerSourceKinds 白名单（默认 user / qq）② ownerSourceRequire 正则（空＝不要求）'
        + '③ ownerSourceDeny 排除（默认挡系统注入、定时提醒、插件汇报）。'
        + '只做查询，不参与闹钟触发。',
      parameters: {
        sessionId: { type: 'string', description: '要查的会话 id；不填就是当前这条会话。' },
        maxScan: { type: 'integer', description: '最多往前翻多少条 user 消息，默认 400。' },
        kinds: {
          type: 'array',
          items: { type: 'string' },
          description: '临时覆盖白名单（例如只看 "qq"）；不填用配置里的。',
        },
      },
      output: output({ type: 'object', properties: {}, additionalProperties: true }),
      async execute(args, exec) {
        const key = sessionKeyOf(exec)
        const sessionId = String(args?.sessionId || key?.id || '')
        if (!sessionId) return { ok: false, error: 'no_session', message: '没给 sessionId，也拿不到当前会话。' }

        const effective = { ...cfg }
        if (Array.isArray(args?.kinds) && args.kinds.length > 0) effective.ownerSourceKinds = args.kinds.map(String)
        const maxScan = Number.isInteger(args?.maxScan) && args.maxScan > 0 ? args.maxScan : 400

        let result
        try {
          result = await readSessionPresence(SESSIONS_ROOT, sessionId, effective, { maxScan })
        } catch (error) {
          return { ok: false, error: 'read_failed', sessionId, message: String(error?.message || error) }
        }
        if (!result.ok) {
          return {
            ok: false,
            error: result.error,
            sessionId,
            message: `找不到这条会话的日志（${SESSIONS_ROOT} 下没有 ${shortId(sessionId)}）。`,
          }
        }

        if (!result.found) {
          return {
            ok: true,
            found: false,
            sessionId,
            sessionFile: result.sessionFile,
            scanned: result.scanned,
            skipped: result.skipped,
            message: `往前翻了 ${result.scanned} 条 user 消息，没有一条通过三道闸。`,
          }
        }

        const at = result.message.at
        const minutes = at ? Math.max(0, Math.round((Date.now() - at) / MINUTE)) : null
        return {
          ok: true,
          found: true,
          sessionId,
          sessionFile: result.sessionFile,
          at: at ? new Date(at).toISOString() : null,
          atLocal: at ? `${dayKey(at)} ${hhmm(at)}` : null,
          ageMinutes: minutes,
          channel: result.message.channel,
          kind: result.message.kind,
          preview: preview(result.message.text),
          text: result.message.text.slice(0, 400),
          scanned: result.scanned,
          skipped: result.skipped,
          lastAssistantAt: result.lastAssistantAt ? new Date(result.lastAssistantAt).toISOString() : null,
        }
      },
    }),
  )

  /* ------------------------------------------------------------ 面板（只读） */

  /* ------------------------------------------------------------ 面板（设置） */

  const PANEL_HTML = [
    '<!doctype html><html lang="zh"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>心跳 · dsh-heartbeat</title><style>',
    'body{font:14px/1.6 system-ui,sans-serif;margin:0;padding:24px;background:#15171c;color:#e6e8ee}',
    'h1{font-size:18px;margin:0 0 4px}.sub{color:#8b93a7;margin-bottom:18px}',
    'table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:10px 8px;border-bottom:1px solid #262a33;vertical-align:top}',
    'th{color:#8b93a7;font-weight:500;font-size:12px}',
    'button{background:#2a3040;color:#e6e8ee;border:1px solid #3a4155;border-radius:6px;padding:4px 10px;cursor:pointer;margin-right:6px}',
    'button:hover{background:#343c50}select{background:#20242e;color:#e6e8ee;border:1px solid #3a4155;border-radius:6px;padding:3px 6px}',
    '.ok{color:#7bd88f}.warn{color:#f0b25e}.off{color:#8b93a7}',
    '</style></head><body><h1>心跳</h1><div class="sub" id="sub">读取中…</div>',
    '<table><thead><tr><th>会话</th><th>状态</th><th>下次</th><th>设置</th></tr></thead><tbody id="rows"></tbody></table>',
    '<script>',
    'const fmt=(s)=>s||"—";',
    'async function post(body){await fetch("/dsh-heartbeat/config",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});await load();}',
    'function cls(t){if(/等待中/.test(t))return "ok";if(/未排到|关闭|静音|预算|不在时段/.test(t))return "warn";return "off";}',
    'async function load(){',
    '  const data=await (await fetch("/dsh-heartbeat.json")).json();',
    '  document.getElementById("sub").textContent=`现在 ${data.nowLocal} · 今天已响 ${data.used} 次 · ${data.stateFile}`;',
    '  const rows=document.getElementById("rows");rows.innerHTML="";',
    '  if(!data.alarms.length){rows.innerHTML="<tr><td colspan=4 class=off>还没有闹钟</td></tr>";return;}',
    '  for(const a of data.alarms){',
    '    const tr=document.createElement("tr");',
    '    const td1=document.createElement("td");td1.textContent=a.sessionId+(a.label?"\\n"+a.label:"");',
    '    const td2=document.createElement("td");const sp=document.createElement("div");sp.className=cls(a.statusText);sp.textContent=a.statusText;td2.appendChild(sp);',
    '    const td3=document.createElement("td");td3.textContent=fmt(a.nextAtLocal);',
    '    const td4=document.createElement("td");',
    '    const b1=document.createElement("button");b1.textContent=a.enabled?"关掉":"打开";b1.onclick=()=>post({sessionId:a.sessionId,enabled:!a.enabled});',
    '    const sel=document.createElement("select");',
    '    for(const m of [15,30,60,120]){const o=document.createElement("option");o.value=m;o.textContent=m+" 分钟";if(a.everyMinutes===m)o.selected=true;sel.appendChild(o);}',
    '    sel.onchange=()=>post({sessionId:a.sessionId,everyMinutes:Number(sel.value)});',
    '    const b2=document.createElement("button");b2.textContent="静音 30 分";b2.onclick=()=>post({sessionId:a.sessionId,muteMinutes:30});',
    '    td4.appendChild(b1);td4.appendChild(sel);td4.appendChild(b2);',
    '    tr.appendChild(td1);tr.appendChild(td2);tr.appendChild(td3);tr.appendChild(td4);rows.appendChild(tr);',
    '  }',
    '}',
    'load();setInterval(load,30000);',
    '</script></body></html>',
  ].join('\n')

  if (ctx.webServer?.register) ctx.effect(() =>
    ctx.webServer.register({
      auth: sameSiteAuth,
      kind: 'exact',
      path: '/dsh-heartbeat.json',
      async handler(req, res) {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        const now = Date.now()
        const sessions = []
        for (const item of liveSessions(ctx, 40)) {
          const title = await sessionTitleOf(item.id)
          if (looksInternal(item.id, title)) continue
          sessions.push({ id: item.id, title, atLocal: '' })
        }
        const alarms = []
        for (const alarm of Object.values(state.alarms ?? {})) {
          const normalised = normaliseAlarm(alarm, cfg, now)
          alarms.push({
            ...alarmView(normalised, now, cfg, usageFor(normalised.sessionId, now).used),
            title: await sessionTitleOf(normalised.sessionId),
          })
        }
        const totalUsed = Object.values(usageFor('', now).bucket).reduce((sum, n) => sum + num(n, 0), 0)
        res.end(JSON.stringify({
          ok: true,
          nowLocal: `${dayKey(now)} ${hhmm(now)}`,
          used: totalUsed,
          alarms,
          sessions,
          stateFile: statePath(),
        }))
      },
    }),
  )

  if (ctx.webServer?.register) ctx.effect(() =>
    ctx.webServer.register({
      auth: sameSiteAuth,
      kind: 'exact',
      path: '/dsh-heartbeat',
      async handler(_req, res) {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end(PANEL_HTML)
      },
    }),
  )

  if (ctx.webServer?.register) ctx.effect(() =>
    ctx.webServer.register({
      auth: sameSiteAuth,
      kind: 'exact',
      path: '/dsh-heartbeat/config',
      async handler(req, res) {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }))
          return
        }
        let raw = ''
        try {
          for await (const chunk of req) raw += chunk
          const patch = raw ? JSON.parse(raw) : {}
          const sessionId = String(patch.sessionId || '')
          if (!sessionId) {
            res.statusCode = 400
            res.end(JSON.stringify({ ok: false, error: 'no_session' }))
            return
          }
          await ready
          await bootState()
          const result = await updateAlarmConfig(sessionId, patch)
          if (result.ok) {
            await saveState(state)
            scheduleTick()
          } else {
            res.statusCode = 400
          }
          res.end(JSON.stringify(result))
        } catch (error) {
          res.statusCode = 500
          res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }))
        }
      },
    }),
  )
}
