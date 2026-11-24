import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { zstdCompressSync } from 'node:zlib'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsh-heartbeat-'))
process.env.DSH_HOME = home
const STATE = join(home, 'heartbeat.json')

const { apply } = await import('../index.js')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const readState = () => JSON.parse(readFileSync(STATE, 'utf8'))
const writeState = (value) => writeFileSync(STATE, JSON.stringify(value, null, 2))

/** 造一份会话日志：他 45 分钟前说话、我 40 分钟前回过（够远，判定该投） */
function writeSessionLog(sessionId, { userMinutesAgo = 45, assistantMinutesAgo = 40 } = {}) {
  const now = Date.now()
  const lines = [
    { type: 'agent/inbox/spliced', time: now - userMinutesAgo * 60000, data: { target: 'next-turn', inserted: [{ content: [{ type: 'text', text: '在吗' }], source: { kind: 'user' } }] } },
    { type: 'user/message', time: now - userMinutesAgo * 60000, data: { content: [{ type: 'text', text: '在吗' }] } },
    { type: 'assistant/message', time: now - assistantMinutesAgo * 60000, data: { message: { content: [{ type: 'text', text: '在' }] } } },
  ]
  const dir = join(home, 'sessions', 'proj', sessionId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n')))
}

let pendingCleanups = []

/** 起一个新实例前，先把上一个实例的定时器停掉（否则它会在后台写盘、干扰这一条） */
function start(ctx, cfg) {
  for (const fn of pendingCleanups) {
    try {
      fn()
    } catch {}
  }
  pendingCleanups = []
  apply(ctx, cfg)
}

function makeCtx({ sessionId = 'session-heartbeat-test' } = {}) {
  const tools = new Map()
  const delivered = []
  const cleanups = []
  const agent = {
    session: { id: sessionId, header: { origin: 'user' } },
    followup(message) {
      delivered.push(message)
    },
  }
  const ctx = {
    logger: { info(m) { if (process.env.HB_DEBUG) console.log('LOG', m) } },
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
    agents: { get: (id) => (id === sessionId ? agent : undefined) },
    sessions: { flush: async () => true },
    get: () => undefined,
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') {
        cleanups.push(cleanup)
        pendingCleanups.push(cleanup)
      }
      return () => {}
    },
  }
  return { ctx, tools, delivered, cleanups, agent }
}

const exec = (agent) => ({ agent, signal: undefined })

test('挂上之后 list 能看见，重复 set 只留最后一个', async () => {
  writeState({ version: 1, alarms: {}, usage: { date: '', bySession: {} } })
  const { ctx, tools } = makeCtx()
  start(ctx, { quietStart: '08:30', quietEnd: '16:30', dailyBudget: 24 })
  await sleep(50)

  const set = tools.get('heartbeat_set')
  const list = tools.get('heartbeat_list')
  const { agent } = makeCtx()

  const first = await set.execute({ inMinutes: 30, label: '先挂一个' }, exec(agent))
  assert.equal(first.ok, true)
  const second = await set.execute({ everyMinutes: 45, label: '换成循环的' }, exec(agent))
  assert.equal(second.ok, true)
  assert.equal(second.mode, 'interval')
  assert.equal(second.everyMinutes, 45)
  assert.equal(second.label, '换成循环的')

  const listed = await list.execute({}, exec(agent))
  assert.equal(listed.alarms.length, 1)
  assert.equal(listed.alarms[0].label, '换成循环的')
  assert.equal(listed.budget.used, 0)
})

test('三个时间参数只能给一个', async () => {
  const { ctx, tools } = makeCtx()
  start(ctx, {})
  await sleep(30)
  const { agent } = makeCtx()
  const bad = await tools.get('heartbeat_set').execute({ inMinutes: 5, everyMinutes: 10 }, exec(agent))
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'invalid_rule')
})

test('时段外挂 1 分钟 → 顺延到时段开始，不报错', async () => {
  writeState({ version: 1, alarms: {}, usage: { date: '', bySession: {} } })
  const { ctx, tools } = makeCtx()
  start(ctx, {})
  await sleep(30)
  const { agent } = makeCtx()
  const config = tools.get('heartbeat_config')
  // 把时段设成「现在之后 2 小时才开」
  const now = new Date()
  const soon = new Date(now.getTime() + 2 * 60 * 60 * 1000)
  const result0 = await config.execute({ windowStart: soon.getHours(), windowEnd: (soon.getHours() + 1) % 24 }, exec(agent))
  assert.equal(result0.ok, true)

  const result = await tools.get('heartbeat_set').execute({ inMinutes: 1, label: '时段测试' }, exec(agent))
  assert.equal(result.ok, true)
  const minutes = (new Date(result.nextAt).getTime() - Date.now()) / 60000
  assert.ok(minutes > 60, `应当顺延到时段开始之后，实际 ${Math.round(minutes)} 分钟`)
})

test('到点真的投一条 notice（不是用户消息），然后一次性闹钟消失', async () => {
  const past = Date.now() - 1000
  writeState({
    version: 1,
    alarms: {
      'session-heartbeat-test': {
        sessionId: 'session-heartbeat-test',
        mode: 'once',
        label: '五点该喝水',
        at: past,
        nextAt: past,
        createdAt: past - 60000,
        baseAt: past - 60000,
        quietShifted: false,
      },
    },
    usage: { date: '', bySession: {} },
  })
  writeSessionLog('session-heartbeat-test')
  const { ctx, delivered } = makeCtx()
  start(ctx, { quietStart: '', quietEnd: '', dailyBudget: 24 })
  await sleep(300)

  assert.equal(delivered.length, 1, '应当投递一次')
  const message = delivered[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'heartbeat')
  assert.equal(message.source.form, 'notice')
  assert.match(message.content[0].text, /到点了/)
  assert.match(message.content[0].text, /五点该喝水/)

  const state = readState()
  assert.equal(Object.keys(state.alarms).length, 0, '一次性闹钟响完要删掉')
  assert.equal(state.usage.bySession['session-heartbeat-test'], 1)
})

test('预算用完就不再响，闹钟还在', async () => {
  const now = Date.now()
  const today = new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  const dayKey = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
  writeState({
    version: 1,
    alarms: {
      'session-heartbeat-test': {
        sessionId: 'session-heartbeat-test',
        mode: 'every',
        everyMinutes: 5,
        label: '预算测试',
        nextAt: now - 1000,
        createdAt: now - 600000,
        baseAt: now - 600000,
        quietShifted: false,
      },
    },
    usage: { date: dayKey, bySession: { 'session-heartbeat-test': 3 } },
  })
  const { ctx, delivered } = makeCtx()
  start(ctx, { quietStart: '', quietEnd: '', dailyBudget: 3 })
  await sleep(300)

  assert.equal(delivered.length, 0, '预算 3 已经用完，不该响')
  assert.ok(Object.keys(readState().alarms).length === 1, '闹钟要留着')
})

test('取消之后 list 空，卸载不留定时器', async () => {
  const now = Date.now()
  writeState({
    version: 1,
    alarms: {
      'session-heartbeat-test': {
        sessionId: 'session-heartbeat-test',
        mode: 'every',
        everyMinutes: 30,
        label: '取消测试',
        nextAt: now + 60000,
        createdAt: now,
        baseAt: now,
      },
    },
    usage: { date: '', bySession: {} },
  })
  const { ctx, tools, cleanups } = makeCtx()
  start(ctx, {})
  await sleep(30)
  const { agent } = makeCtx()

  const cancelled = await tools.get('heartbeat_cancel').execute({}, exec(agent))
  assert.equal(cancelled.cancelled, true)
  const listed = await tools.get('heartbeat_list').execute({}, exec(agent))
  assert.equal(listed.alarms.length, 0)

  for (const cleanup of cleanups) cleanup()
  // 卸载后再等一会儿，不该抛错、不该再投递
  await sleep(50)
})

test.after(() => {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    /* 让系统自己清 */
  }
})
