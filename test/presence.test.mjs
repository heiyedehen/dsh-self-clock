import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSpliceIndex, judge, parseEvents, pickLastUserMessage, preview, textOfContent,
} from '../lib/presence.js'

const CFG = {
  ownerSourceKinds: ['user', 'qq'],
  ownerSourceRequire: '',
  ownerSourceDeny: ['^\\s*【当前时间】', '^\\s*\\[SCHEDULE REMINDER\\]', '^\\s*<system-reminder>'],
}

const userEvent = (text, time, content = [{ type: 'text', text }]) => ({ type: 'user/message', time, data: { content } })

const splice = (text, kind, time) => ({
  type: 'agent/inbox/spliced',
  time,
  data: { target: 'next-turn', inserted: [{ content: [{ type: 'text', text }], source: { kind } }] },
})

test('textOfContent 拼接分片', () => {
  assert.equal(textOfContent('abc'), 'abc')
  assert.equal(textOfContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab')
  assert.equal(textOfContent(undefined), '')
})

test('spliced 的 source 能补回给 user/message', () => {
  const events = [splice('在吗', 'qq', 1), userEvent('在吗', 2)]
  const index = buildSpliceIndex(events)
  assert.equal(index.get('在吗').kind, 'qq')
})

test('跳过系统注入、定时提醒、插件 notice，只认他说的最后一句', () => {
  const events = [
    userEvent('他说的一句话', 100),
    userEvent('【当前时间】2026-11-23 06:00', 200),
    splice('[SCHEDULE REMINDER] 跑巡检', 'schedule', 290),
    userEvent('[SCHEDULE REMINDER] 跑巡检', 300),
    splice('到点了。（验证心跳插件）', 'heartbeat', 390),
    userEvent('到点了。（验证心跳插件）', 400),
  ]
  const picked = pickLastUserMessage(events, CFG)
  assert.equal(picked.found, true)
  assert.equal(picked.message.text, '他说的一句话')
  assert.equal(picked.message.at, 100)
  assert.equal(picked.message.kind, 'user')
  assert.ok(picked.skipped.deny >= 1)
  assert.ok(picked.skipped.kind >= 1)
})

test('qq 通道能认出来', () => {
  const events = [splice('晚安', 'qq', 10), userEvent('晚安', 11)]
  const picked = pickLastUserMessage(events, CFG)
  assert.equal(picked.message.kind, 'qq')
  assert.equal(picked.message.channel, 'qq')
})

test('必须含那道闸：没有章的就不算', () => {
  const cfg = { ...CFG, ownerSourceRequire: '^\\s*<qq>' }
  const events = [userEvent('没盖章', 10), userEvent('<qq>盖了章', 20)]
  const picked = pickLastUserMessage(events, cfg)
  assert.equal(picked.message.text, '<qq>盖了章')

  const onlyUnstamped = pickLastUserMessage([userEvent('没盖章', 30)], cfg)
  assert.equal(onlyUnstamped.found, false)
  assert.equal(onlyUnstamped.skipped.require, 1)
})

test('白名单能收紧到只看 qq', () => {
  const cfg = { ...CFG, ownerSourceKinds: ['qq'] }
  const events = [splice('DSH 里说的', 'user', 10), userEvent('DSH 里说的', 11), splice('QQ 里说的', 'qq', 20), userEvent('QQ 里说的', 21)]
  const picked = pickLastUserMessage(events, cfg)
  assert.equal(picked.message.text, 'QQ 里说的')
})

test('一条都不通过时 found=false', () => {
  const events = [userEvent('【当前时间】2026-11-23 06:00', 10)]
  const picked = pickLastUserMessage(events, CFG)
  assert.equal(picked.found, false)
  assert.equal(picked.scanned, 1)
})

test('maxScan 限制翻多少条', () => {
  const events = [userEvent('很久以前', 10), userEvent('【当前时间】x', 20), userEvent('【当前时间】y', 30)]
  const picked = pickLastUserMessage(events, CFG, { maxScan: 2 })
  assert.equal(picked.found, false)
  assert.equal(picked.scanned, 2)
})

test('judge 的顺序是 kind → require → deny', () => {
  const cfg = { ownerSourceKinds: ['user'], ownerSourceRequire: '^hi', ownerSourceDeny: ['stop'] }
  assert.equal(judge('hi there', 'qq', cfg).reason, 'kind')
  assert.equal(judge('nope', 'user', cfg).reason, 'require')
  assert.equal(judge('hi stop', 'user', cfg).reason, 'deny')
  assert.equal(judge('hi there', 'user', cfg).ok, true)
})

test('坏正则不会炸，只是不生效', () => {
  const cfg = { ownerSourceKinds: [], ownerSourceRequire: '([', ownerSourceDeny: ['([', 'x'] }
  assert.equal(judge('随便', 'user', cfg).ok, true)
})

test('parseEvents 丢掉坏行', () => {
  const events = parseEvents('{"type":"a"}\n{bad\n\n{"type":"b"}')
  assert.deepEqual(events.map((event) => event.type), ['a', 'b'])
})

test('preview 压成一行并截断', () => {
  const long = '一'.repeat(200)
  const text = preview(long)
  assert.ok(text.length <= 81)
  assert.ok(text.endsWith('…'))
  assert.equal(preview('a\n\nb  c'), 'a b c')
})
