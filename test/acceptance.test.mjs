/**
 * 工单「dsh-heartbeat 一次改完（2026-11-24）」的验收用例。
 * 每条对应工单第五节的一项，能纯函数测的就纯测，要落盘的走临时 DSH_HOME。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { MINUTE, dayKey, judgeTiming, statusOf } from '../lib/core.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-heartbeat-acc-'))
process.env.DSH_HOME = home
const STATE = join(home, 'heartbeat.json')
const SID = 'session-acceptance'

const { apply } = await import('../index.js')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const readState = () => JSON.parse(readFileSync(STATE, 'utf8'))
const writeState = (value) => writeFileSync(STATE, JSON.stringify(value, null, 2))

let pendingCleanups = []

function start(ctx, cfg = {}) {
  for (const fn of pendingCleanups) {
    try {
      fn()
    } catch {}
  }
  pendingCleanups = []
  apply(ctx, cfg)
}

function makeCtx(sessionId = SID) {
  const tools = new Map()
  const delivered = []
  const agent = {
    session: { id: sessionId, header: { origin: 'user' } },
    followup(message) {
      delivered.push(message)
    },
  }
  const ctx = {
    logger: { info() {} },
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
    agents: { get: (id) => (id === sessionId ? agent : undefined) },
    sessions: { flush: async () => true },
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') pendingCleanups.push(cleanup)
      return () => {}
    },
  }
  return { ctx, tools, delivered, agent }
}

const exec = (agent) => ({ agent, signal: undefined })
const today = () => dayKey(Date.now())

test('judgeTiming：1 分钟太近 → 跳过；12 分钟 → 温和版；45 分钟 → 原文', () => {
  const now = Date.now()
  const one = judgeTiming({ now, userAt: now - 1 * MINUTE, lastAssistantAt: now - 30_000 })
  assert.equal(one.kind, 'skip')
  assert.match(one.reason, /1 分钟/)

  const middle = judgeTiming({ now, userAt: now - 12 * MINUTE, lastAssistantAt: now - 11 * MINUTE })
  assert.equal(middle.kind, 'deliver')
  assert.equal(middle.mode, 'gentle')

  const far = judgeTiming({ now, userAt: now - 45 * MINUTE, lastAssistantAt: now - 44 * MINUTE })
  assert.equal(far.kind, 'deliver')
  assert.equal(far.mode, 'normal')
})

test('judgeTiming：上一条还没回 → 不投；刚收尾 → 不投', () => {
  const now = Date.now()
  const waiting = judgeTiming({ now, userAt: now - 10 * MINUTE, lastAssistantAt: now - 12 * MINUTE })
  assert.equal(waiting.kind, 'skip')
  assert.equal(waiting.reason, '他在等回复')

  const justReplied = judgeTiming({ now, userAt: now - 10 * MINUTE, lastAssistantAt: now - 30_000 })
  assert.equal(justReplied.kind, 'skip')
  assert.equal(justReplied.reason, '刚收尾')
})

test('关掉总开关 → 不触发，落盘仍是关的（重启也一样）', async () => {
  writeState({ version: 1, alarms: {}, usage: { date: today(), bySession: {} } })
  const { ctx, tools, delivered, agent } = makeCtx()
  start(ctx, {})
  await sleep(40)

  await tools.get('heartbeat_config').execute({ everyMinutes: 5 }, exec(agent))
  const off = await tools.get('heartbeat_config').execute({ enabled: false }, exec(agent))
  assert.equal(off.ok, true)
  assert.equal(off.enabled, false)
  assert.equal(off.status, 'disabled')
  assert.match(off.statusText, /已关闭/)

  const saved = readState()
  assert.equal(saved.alarms[SID].enabled, false)

  // 重启：新实例读同一份落盘
  const second = makeCtx()
  start(second.ctx, {})
  await sleep(60)
  const listed = await second.tools.get('heartbeat_list').execute({}, exec(second.agent))
  assert.equal(listed.alarms.length, 1)
  assert.equal(listed.alarms[0].enabled, false)
  assert.equal(second.delivered.length, 0)
  assert.equal(delivered.length, 0)
})

test('频次：1 分钟被拒；5 分钟能挂上且下次在 5 分钟内', async () => {
  writeState({ version: 1, alarms: {}, usage: { date: today(), bySession: {} } })
  const { ctx, tools, agent } = makeCtx()
  start(ctx, {})
  await sleep(40)

  const bad = await tools.get('heartbeat_config').execute({ everyMinutes: 1 }, exec(agent))
  assert.equal(bad.ok, false)
  assert.match(bad.message, /5/)

  const ok = await tools.get('heartbeat_config').execute({ everyMinutes: 5 }, exec(agent))
  assert.equal(ok.ok, true)
  const minutes = (new Date(ok.nextAt).getTime() - Date.now()) / MINUTE
  assert.ok(minutes > 0 && minutes <= 5.1, `下次应落在 5 分钟内，实际 ${minutes}`)
})

test('预算用完 → 不投递，闹钟还在，状态说明原因', async () => {
  writeState({
    version: 1,
    alarms: {
      [SID]: { sessionId: SID, mode: 'interval', everyMinutes: 5, label: '预算', nextAt: Date.now() - 1000, createdAt: Date.now() - 60000, baseAt: Date.now() - 60000, dailyBudget: 2 },
    },
    usage: { date: today(), bySession: { [SID]: 2 } },
  })
  const { ctx, tools, delivered } = makeCtx()
  start(ctx, {})
  await sleep(200)

  assert.equal(delivered.length, 0)
  const listed = await tools.get('heartbeat_list').execute({}, exec(makeCtx().agent))
  assert.equal(listed.alarms.length, 1)
  assert.equal(listed.alarms[0].status, 'budget')
  assert.match(listed.alarms[0].statusText, /今日预算用完/)
  assert.equal(readState().usage.bySession[SID], 2)
})

test('临时静音 30 分钟 → 期间不响、不消耗预算，mutedUntil 落盘', async () => {
  writeState({
    version: 1,
    alarms: {
      [SID]: { sessionId: SID, mode: 'interval', everyMinutes: 5, label: '静音', nextAt: Date.now() - 1000, createdAt: Date.now() - 60000, baseAt: Date.now() - 60000 },
    },
    usage: { date: today(), bySession: {} },
  })
  const { ctx, tools, delivered, agent } = makeCtx()
  start(ctx, {})
  await sleep(40)

  const muted = await tools.get('heartbeat_config').execute({ muteMinutes: 30 }, exec(agent))
  assert.equal(muted.ok, true)
  assert.equal(muted.status, 'muted')

  await sleep(200)
  assert.equal(delivered.length, 0, '静音期间不该投')
  const saved = readState()
  assert.ok(saved.alarms[SID].mutedUntil)
  assert.equal(saved.usage.bySession?.[SID] ?? 0, 0, '静音不消耗预算')
})

test('时段 9–23 凌晨不响，状态说明「不在时段」', async () => {
  const now = new Date()
  const outside = now.getHours() < 9 || now.getHours() >= 23
  const alarm = { sessionId: SID, mode: 'interval', everyMinutes: 30, nextAt: now.getTime(), windowStart: 9, windowEnd: 23 }
  const status = statusOf(alarm, now.getTime(), { used: 0, budget: 48 })
  if (outside) {
    assert.equal(status.code, 'window')
    assert.match(status.text, /不在时段/)
    assert.match(status.text, /09:00–23:00/)
  } else {
    assert.equal(status.code, 'waiting')
  }
})

test('旧数据：只有 cron 且 cronParsed 是空对象 → 升级后照常排下一次', async () => {
  const expr = '0,30 0-3,5,7,9-23 * * *'
  writeState({
    version: 1,
    alarms: {
      [SID]: {
        sessionId: SID,
        label: '旧的',
        mode: 'cron',
        cron: expr,
        cronParsed: { minute: {}, hour: {}, dayOfMonth: {}, month: {}, dayOfWeek: {}, expr },
        nextAt: null,
        createdAt: Date.now() - 86400000,
        baseAt: Date.now() - 86400000,
      },
    },
    usage: { date: today(), bySession: {} },
  })
  const { ctx, tools } = makeCtx()
  start(ctx, {})
  await sleep(80)

  const listed = await tools.get('heartbeat_list').execute({}, exec(makeCtx().agent))
  assert.equal(listed.alarms.length, 1)
  assert.ok(listed.alarms[0].nextAt, '应当重新排出下一次')
  assert.notEqual(listed.alarms[0].status, 'none')
  assert.equal(listed.alarms[0].enabled, true)

  const saved = readState()
  assert.ok(!('cronParsed' in saved.alarms[SID]), '落盘不再写 cronParsed')
})

test('排不出下次时状态是 ⚠ 未排到下次触发，不静默', async () => {
  writeState({ version: 1, alarms: {}, usage: { date: today(), bySession: {} } })
  const { ctx, tools, agent } = makeCtx()
  start(ctx, {})
  await sleep(40)
  // 一条算不出来的：mode cron 但 expr 坏的（工具会拒，这里直接落盘模拟）
  const bad = {
    version: 1,
    alarms: {
      [SID]: { sessionId: SID, mode: 'cron', cron: '99 * * * *', nextAt: null, createdAt: Date.now(), baseAt: Date.now() },
    },
    usage: { date: today(), bySession: {} },
  }
  writeState(bad)
  const second = makeCtx()
  start(second.ctx, {})
  await sleep(80)
  const listed = await second.tools.get('heartbeat_list').execute({}, exec(second.agent ?? agent))
  assert.equal(listed.alarms.length, 1)
  assert.equal(listed.alarms[0].status, 'none')
  assert.match(listed.alarms[0].statusText, /未排到下次触发/)
})

test('读不到会话日志 → 照响（不知道他在不在，也别漏）', async () => {
  writeState({
    version: 1,
    alarms: {
      [SID]: { sessionId: SID, mode: 'once', at: Date.now() - 1000, label: '没日志', nextAt: Date.now() - 1000, createdAt: Date.now() - 60000, baseAt: Date.now() - 60000 },
    },
    usage: { date: today(), bySession: {} },
  })
  const { ctx, delivered } = makeCtx()
  start(ctx, {})
  await sleep(220)
  assert.equal(delivered.length, 1, '读不到日志也要响，不能静默失效')
  assert.equal(readState().usage.bySession[SID], 1)
})

test.after(async () => {
  for (const fn of pendingCleanups) {
    try {
      fn()
    } catch {}
  }
  pendingCleanups = []
  await sleep(120)
  rmSync(home, { recursive: true, force: true })
})
