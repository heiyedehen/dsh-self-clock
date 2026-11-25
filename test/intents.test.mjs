import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { zstdCompressSync } from 'node:zlib'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsh-heartbeat-intents-'))
process.env.DSH_HOME = home
const STATE = join(home, 'heartbeat.json')
const INTENTS = join(home, 'intents.json')

const { apply } = await import('../index.js')
const { dayKey } = await import('../lib/core.js')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const readState = () => JSON.parse(readFileSync(STATE, 'utf8'))
const writeState = (value) => writeFileSync(STATE, JSON.stringify(value, null, 2))
const readIntents = () => JSON.parse(readFileSync(INTENTS, 'utf8'))
const writeIntents = (value) => writeFileSync(INTENTS, JSON.stringify(value, null, 2))
const reset = () => {
  writeState({ version: 1, alarms: {}, usage: { date: '', bySession: {} } })
  writeIntents({ version: 1, intents: [], usage: { date: '', count: 0 } })
}

/** 造会话日志：他 N 分钟前说话、我 M 分钟前回过 */
function writeSessionLog(sessionId, { userMinutesAgo = 45, assistantMinutesAgo = 40, noAssistant = false } = {}) {
  const now = Date.now()
  const lines = [
    { type: 'agent/inbox/spliced', time: now - userMinutesAgo * 60000, data: { target: 'next-turn', inserted: [{ content: [{ type: 'text', text: '在吗' }], source: { kind: 'user' } }] } },
    { type: 'user/message', time: now - userMinutesAgo * 60000, data: { content: [{ type: 'text', text: '在吗' }] } },
  ]
  if (!noAssistant) {
    lines.push({ type: 'assistant/message', time: now - assistantMinutesAgo * 60000, data: { message: { content: [{ type: 'text', text: '在' }] } } })
  }
  const dir = join(home, 'sessions', 'proj', sessionId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n')))
}

let pendingCleanups = []
function start(ctx, cfg) {
  for (const fn of pendingCleanups) {
    try {
      fn()
    } catch {}
  }
  pendingCleanups = []
  apply(ctx, cfg)
}

const SID = 'session-intent-test'

function makeCtx() {
  const tools = new Map()
  const delivered = []
  const agent = {
    session: { id: SID, header: { origin: 'user' } },
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
    agents: { get: (id) => (id === SID ? agent : undefined) },
    sessions: { flush: async () => true },
    get: () => undefined,
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') pendingCleanups.push(cleanup)
      return () => {}
    },
  }
  return { ctx, tools, delivered, agent }
}

const exec = (agent) => ({ agent, signal: undefined })

function dueIntent(overrides = {}) {
  return {
    id: overrides.id ?? 'intent-due',
    at: overrides.at ?? new Date(Date.now() - 60000).toISOString(),
    condition: overrides.condition ?? null,
    note: overrides.note ?? '他说今晚可能很晚',
    status: overrides.status ?? 'pending',
    sessionId: overrides.sessionId ?? SID,
    createdAt: new Date(Date.now() - 120000).toISOString(),
  }
}

/* ---------------------------------------------------------------- 第 0 节 */

test('heartbeat_set 回执不再带 undefined，落盘也补齐三个字段', async () => {
  reset()
  const { ctx, tools, agent } = makeCtx()
  start(ctx, {})
  await sleep(50)
  const result = await tools.get('heartbeat_set').execute({ inMinutes: 30, label: 'test' }, exec(agent))
  assert.equal(result.ok, true)
  assert.equal(typeof result.windowStart, 'number')
  assert.equal(typeof result.windowEnd, 'number')
  assert.equal(typeof result.dailyBudget, 'number')
  assert.equal(typeof result.remainingToday, 'number')
  const stored = readState().alarms[SID]
  assert.equal(typeof stored.windowStart, 'number')
  assert.equal(typeof stored.windowEnd, 'number')
  assert.equal(typeof stored.dailyBudget, 'number')
})

/* ---------------------------------------------------------------- 意图 */

test('到点的意图会投一条 notice，正文带 note，状态变 done', async () => {
  reset()
  writeIntents({ version: 1, intents: [dueIntent()], usage: { date: '', count: 0 } })
  writeSessionLog(SID)
  const { ctx, delivered } = makeCtx()
  start(ctx, {})
  await sleep(250)

  assert.equal(delivered.length, 1, '应当投递一次')
  const message = delivered[0]
  assert.equal(message.source.form, 'notice')
  assert.match(message.content[0].text, /意图唤醒/)
  assert.match(message.content[0].text, /他说今晚可能很晚/)
  const item = readIntents().intents[0]
  assert.equal(item.status, 'done')
  assert.equal(readIntents().usage.count, 1)
})

test('刚收尾（最后一条 assistant 不到 2 分钟）不投，保持 pending', async () => {
  reset()
  writeIntents({ version: 1, intents: [dueIntent()], usage: { date: '', count: 0 } })
  writeSessionLog(SID, { userMinutesAgo: 30, assistantMinutesAgo: 1 })
  const { ctx, delivered } = makeCtx()
  start(ctx, {})
  await sleep(250)

  assert.equal(delivered.length, 0)
  assert.equal(readIntents().intents[0].status, 'pending')
  assert.match(readIntents().intents[0].lastSkipReason, /刚收尾/)
})

test('上一条 user 还没回，不投，保持 pending', async () => {
  reset()
  writeIntents({ version: 1, intents: [dueIntent()], usage: { date: '', count: 0 } })
  writeSessionLog(SID, { userMinutesAgo: 10, noAssistant: true })
  const { ctx, delivered } = makeCtx()
  start(ctx, {})
  await sleep(250)

  assert.equal(delivered.length, 0)
  assert.equal(readIntents().intents[0].status, 'pending')
  assert.match(readIntents().intents[0].lastSkipReason, /等回复/)
})

test('同时最多挂 5 条，第 6 条被明确拒绝', async () => {
  reset()
  const { ctx, tools, agent } = makeCtx()
  start(ctx, {})
  await sleep(50)
  const set = tools.get('intent_set')
  for (let i = 0; i < 5; i += 1) {
    const ok = await set.execute({ at: `+${30 + i}m`, note: `第 ${i + 1} 条` }, exec(agent))
    assert.equal(ok.ok, true)
  }
  const sixth = await set.execute({ at: '+60m', note: '第六条' }, exec(agent))
  assert.equal(sixth.ok, false)
  assert.equal(sixth.error, 'too_many_intents')
  assert.equal(readIntents().intents.filter((item) => item.status === 'pending').length, 5)
})

test('超过 24 小时的意图标 expired，不投', async () => {
  reset()
  writeIntents({
    version: 1,
    intents: [dueIntent({ at: new Date(Date.now() - 25 * 3600 * 1000).toISOString() })],
    usage: { date: '', count: 0 },
  })
  writeSessionLog(SID)
  const { ctx, delivered } = makeCtx()
  start(ctx, {})
  await sleep(250)

  assert.equal(delivered.length, 0)
  assert.equal(readIntents().intents[0].status, 'expired')
})

test('一天投满 4 次后，第 5 条不投', async () => {
  reset()
  const today = dayKey(Date.now())
  writeIntents({
    version: 1,
    intents: [dueIntent()],
    usage: { date: today, count: 4 },
  })
  writeSessionLog(SID)
  const { ctx, delivered } = makeCtx()
  start(ctx, {})
  await sleep(250)

  assert.equal(delivered.length, 0)
  assert.equal(readIntents().intents[0].status, 'pending')
  assert.equal(readIntents().usage.count, 4)
})

test('静音期间不投意图', async () => {
  reset()
  const now = Date.now()
  writeState({
    version: 1,
    alarms: {
      [SID]: {
        sessionId: SID,
        mode: 'cron',
        cron: '0 9 * * *',
        label: '',
        createdAt: now - 3600000,
        mutedUntil: new Date(now + 30 * 60000).toISOString(),
      },
    },
    usage: { date: '', bySession: {} },
  })
  writeIntents({ version: 1, intents: [dueIntent()], usage: { date: '', count: 0 } })
  writeSessionLog(SID)
  const { ctx, delivered } = makeCtx()
  start(ctx, {})
  await sleep(250)

  assert.equal(delivered.length, 0)
  assert.equal(readIntents().intents[0].status, 'pending')
})

test('他睡着也照响：心跳是我自己的时间，不按他在不在决定', async () => {
  reset()
  writeIntents({
    version: 1,
    intents: [dueIntent()],
    usage: { date: '', count: 0 },
  })
  // 七小时没说话（= 他睡着/不在）。以前 he-awake 会因此不投，现在要去掉那种行为。
  writeSessionLog(SID, { userMinutesAgo: 7 * 60, assistantMinutesAgo: 7 * 60 - 2 })
  const { ctx, delivered } = makeCtx()
  start(ctx, {})
  await sleep(250)

  assert.equal(delivered.length, 1)
  assert.match(String(delivered[0]?.content?.[0]?.text ?? ''), /意图唤醒/)
  assert.equal(readIntents().intents[0].status, 'done')
})

test('没有意图时 cron 路径照旧（回归）', async () => {
  reset()
  const past = Date.now() - 1000
  writeState({
    version: 1,
    alarms: {
      [SID]: {
        sessionId: SID,
        mode: 'once',
        label: '回归测试',
        at: past,
        nextAt: past,
        createdAt: past - 60000,
        baseAt: past - 60000,
      },
    },
    usage: { date: '', bySession: {} },
  })
  writeSessionLog(SID)
  const { ctx, delivered } = makeCtx()
  start(ctx, {})
  await sleep(250)

  assert.equal(delivered.length, 1)
  assert.match(delivered[0].content[0].text, /回归测试/)
})

test('首次运行放两份空模板；已存在的一个字不改', async () => {
  reset()
  const { ctx } = makeCtx()
  start(ctx, {})
  await sleep(200)
  const intentsFile = join(home, 'self', '意图.md')
  const wantsFile = join(home, 'self', '我想做的事.md')
  assert.equal(existsSync(intentsFile), true)
  assert.equal(existsSync(wantsFile), true)
  assert.match(readFileSync(intentsFile, 'utf8'), /最多 5 条/)
  assert.doesNotMatch(readFileSync(intentsFile, 'utf8'), /^\s*-\s*\S+\s*\|/m)

  writeFileSync(intentsFile, '# 我自己改过的\n')
  const second = makeCtx()
  start(second.ctx, {})
  await sleep(200)
  assert.equal(readFileSync(intentsFile, 'utf8'), '# 我自己改过的\n')
})

test('intent_cancel 取消后列表里就没了', async () => {
  reset()
  const { ctx, tools, agent } = makeCtx()
  start(ctx, {})
  await sleep(50)
  const created = await tools.get('intent_set').execute({ at: '+2h', note: '两小时后看看' }, exec(agent))
  assert.equal(created.ok, true)
  const listed = await tools.get('intent_list').execute({}, exec(agent))
  assert.equal(listed.pending.length, 1)
  const cancelled = await tools.get('intent_cancel').execute({ id: created.id }, exec(agent))
  assert.equal(cancelled.ok, true)
  const after = await tools.get('intent_list').execute({}, exec(agent))
  assert.equal(after.pending.length, 0)
})
