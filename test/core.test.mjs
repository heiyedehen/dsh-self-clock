import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MINUTE, budgetState, cronNext, dayKey, exitQuiet, hhmm, isInWindow, isQuiet, nextFire, parseCron, parseHHMM,
  quietRange, statusOf,
} from '../lib/core.js'

const at = (h, m = 0, d = 22) => new Date(2026, 10, d, h, m, 0, 0).getTime()
const cfg = { quietStart: '08:30', quietEnd: '16:30' }

test('parseHHMM 认 "08:30"，不认垃圾', () => {
  assert.equal(parseHHMM('08:30'), 510)
  assert.equal(parseHHMM(' 9:05 '), 545)
  assert.equal(parseHHMM('24:00'), null)
  assert.equal(parseHHMM(''), null)
  assert.equal(parseHHMM(undefined), null)
})

test('安静时段：09:00 在里头，17:00 在外头', () => {
  assert.equal(isQuiet(at(9), cfg), true)
  assert.equal(isQuiet(at(8, 29), cfg), false)
  assert.equal(isQuiet(at(16, 30), cfg), false)
  assert.equal(isQuiet(at(17), cfg), false)
})

test('安静时段跨零点也对', () => {
  const night = { quietStart: '23:00', quietEnd: '07:00' }
  assert.equal(isQuiet(at(23, 30), night), true)
  assert.equal(isQuiet(at(2), night), true)
  assert.equal(isQuiet(at(12), night), false)
  assert.equal(quietRange(night).start, 23 * 60)
  assert.equal(hhmm(exitQuiet(at(23, 30), night)), '07:00')
})

test('exitQuiet 从安静时段里出来是 16:30', () => {
  assert.equal(hhmm(exitQuiet(at(9), cfg)), '16:30')
  assert.equal(exitQuiet(at(19), cfg), at(19))
})

test('一次性闹钟落在时段外 → 顺延到时段开始，仍然只有一次', () => {
  const now = at(9)
  const alarm = { mode: 'once', at: now + 5 * MINUTE, windowStart: 16, windowEnd: 20 }
  const next = nextFire(alarm, now)
  assert.equal(hhmm(next), '16:00')
  assert.equal(next, at(16, 0))
})

test('interval：时段外整段跳过，落到时段内的整倍数', () => {
  const now = at(9)
  const alarm = { mode: 'interval', everyMinutes: 30, baseAt: at(8, 0), createdAt: at(8, 0), windowStart: 16, windowEnd: 20 }
  const next = nextFire(alarm, now)
  assert.ok(next >= at(16), 'next 应该不早于 16:00')
  assert.equal((next - alarm.baseAt) % (30 * MINUTE), 0)
})

test('interval：正常时刻是 base + N 步', () => {
  const now = at(19)
  const alarm = { mode: 'interval', everyMinutes: 15, baseAt: at(18, 0), lastFiredAt: at(18, 45) }
  assert.equal(hhmm(nextFire(alarm, now)), '19:00')
})

test('cron 解析与下一次（"30 7 * * *"）', () => {
  const parsed = parseCron('30 7 * * *')
  const next = cronNext(parsed, at(6))
  assert.equal(hhmm(next), '07:30')
  assert.equal(dayKey(next), dayKey(at(6)))
})

test('cron 支持 */n 与列表，时段外的时刻被顺延', () => {
  const parsed = parseCron('*/20 * * * *')
  const next = cronNext(parsed, at(6, 5))
  assert.equal(hhmm(next), '06:20')

  const alarm = { mode: 'cron', cron: '*/20 * * * *', cronParsed: parsed, windowStart: 16, windowEnd: 20 }
  const shifted = nextFire(alarm, at(6, 5))
  assert.equal(hhmm(shifted), '16:00')
})

test('cronParsed 落盘变空对象 → 用 expr 重解析，不静默不动', () => {
  const alarm = {
    mode: 'cron',
    cron: '30 7 * * *',
    cronParsed: { minute: {}, hour: {}, dayOfMonth: {}, month: {}, dayOfWeek: {}, expr: '30 7 * * *' },
  }
  assert.equal(hhmm(nextFire(alarm, at(6))), '07:30')
})

test('时段跨夜（22–6）', () => {
  const alarm = { windowStart: 22, windowEnd: 6 }
  assert.equal(isInWindow(at(23), alarm), true)
  assert.equal(isInWindow(at(2), alarm), true)
  assert.equal(isInWindow(at(12), alarm), false)
})

test('状态文案：关 / 静音 / 预算 / 时段外 / 未排到 / 等待', () => {
  const now = at(9)
  assert.equal(statusOf({ enabled: false }, now).code, 'disabled')
  assert.equal(statusOf({ mutedUntil: new Date(now + 30 * MINUTE).toISOString() }, now).code, 'muted')
  assert.equal(statusOf({ nextAt: now + MINUTE }, now, { used: 3, budget: 3 }).code, 'budget')
  assert.equal(statusOf({ windowStart: 22, windowEnd: 6, nextAt: now + MINUTE }, now).code, 'window')
  assert.equal(statusOf({ nextAt: null }, now).code, 'none')
  assert.ok(statusOf({ nextAt: now + MINUTE }, now).text.startsWith('等待中'))
})

test('cron 写错要抛', () => {
  assert.throws(() => parseCron('30 7 * *'))
  assert.throws(() => parseCron('99 * * * *'))
})

test('预算按本地日期重置', () => {
  const usage = { date: dayKey(at(9)), count: 5 }
  assert.equal(budgetState(usage, at(10)).used, 5)
  assert.equal(budgetState(usage, at(10, 0, 23)).used, 0)
})
