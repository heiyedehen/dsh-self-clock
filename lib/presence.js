/**
 * presence —— 从会话日志正文里认「他本人最后说的一句话」。
 *
 * 为什么不看 mtime：会话日志每轮都在写（系统注入、汇报都算），mtime 永远是新的。
 * 只有正文能告诉你是谁在写。
 *
 * 判据是三道闸（顺序不能换）：
 *   ① kind 白名单 —— 只认这些来源（user / qq / 桥自定义 kind）
 *   ② 必须含     —— 正则，给「接口收不了 source、只能往正文里盖章」的桥用
 *   ③ 排除       —— 正则数组，命中就不算他说的（系统注入、定时、插件汇报）
 *
 * 麻烦的地方在于：真正被写进 session.v4 的 `user/message` 事件里**不带 source**。
 * 来源只活在 `agent/inbox/spliced` 事件的 inserted[].source 里。所以先把 spliced
 * 建一张「正文 → source」的表，再拿 user/message 的正文去对。对不上就当 'user'。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const FRAME = [0x28, 0xb5, 0x2f, 0xfd]
const PREVIEW = 80
const SPLICE_KEY = 200

/** 多帧 zstd：按魔数切开逐帧解，再拼起来。只解第一帧会漏掉 99% 的内容。 */
export function decodeLog(buffer, options = {}) {
  const frames = []
  let start = -1
  for (let i = 0; i + 3 < buffer.length; i += 1) {
    if (buffer[i] === FRAME[0] && buffer[i + 1] === FRAME[1] && buffer[i + 2] === FRAME[2] && buffer[i + 3] === FRAME[3]) {
      if (start >= 0) frames.push(buffer.subarray(start, i))
      start = i
    }
  }
  if (start >= 0) frames.push(buffer.subarray(start))
  if (frames.length === 0) return ''
  const limit = Number.isInteger(options.maxFrames) && options.maxFrames > 0 ? options.maxFrames : frames.length
  const parts = []
  for (const frame of frames.slice(-limit)) {
    try {
      parts.push(zstdDecompressSync(frame).toString('utf8'))
    } catch {
      // 坏帧跳过，别整份报废
    }
  }
  return parts.join('')
}

export function parseEvents(text) {
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (event && typeof event === 'object') out.push(event)
    } catch {
      // 半行/坏行跳过
    }
  }
  return out
}

/** content 可能是字符串、数组或分片，统一拼成正文。 */
export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (typeof part === 'string') parts.push(part)
    else if (part && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.join('')
}

function spliceKey(text) {
  return text.trim().slice(0, SPLICE_KEY)
}

/** 把 agent/inbox/spliced 里的 source 记成「正文 → 来源」，给不带 source 的 user/message 用。 */
export function buildSpliceIndex(events) {
  const index = new Map()
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    const inserted = event.data?.inserted
    if (!Array.isArray(inserted)) continue
    for (const item of inserted) {
      const text = textOfContent(item?.content)
      if (!text.trim()) continue
      const key = spliceKey(text)
      if (index.has(key)) continue
      const source = item?.source ?? {}
      index.set(key, {
        kind: typeof source.kind === 'string' && source.kind ? source.kind : 'user',
        form: typeof source.form === 'string' ? source.form : null,
      })
    }
  }
  return index
}

export function channelOf(source) {
  const kind = typeof source?.kind === 'string' && source.kind ? source.kind : 'unknown'
  const form = typeof source?.form === 'string' && source.form ? `/${source.form}` : ''
  return `${kind}${form}`
}

/** 三道闸：kind 白名单 → 必须含 → 排除。返回 { ok, kind, reason }。 */
export function judge(text, kind, cfg) {
  const kinds = Array.isArray(cfg?.ownerSourceKinds) ? cfg.ownerSourceKinds : []
  if (kinds.length > 0 && !kinds.includes(kind)) return { ok: false, reason: 'kind' }

  const require = typeof cfg?.ownerSourceRequire === 'string' ? cfg.ownerSourceRequire.trim() : ''
  if (require) {
    let re
    try {
      re = new RegExp(require, 'u')
    } catch {
      re = null
    }
    if (re && !re.test(text)) return { ok: false, reason: 'require' }
  }

  const deny = Array.isArray(cfg?.ownerSourceDeny) ? cfg.ownerSourceDeny : []
  for (const pattern of deny) {
    if (typeof pattern !== 'string' || !pattern) continue
    let re
    try {
      re = new RegExp(pattern, 'u')
    } catch {
      continue
    }
    if (re.test(text)) return { ok: false, reason: 'deny' }
  }
  return { ok: true, reason: null }
}

/** 从事件流里挑最近一条「真·他说的话」。 */
export function pickLastUserMessage(events, cfg, options = {}) {
  const maxScan = Number.isFinite(options.maxScan) && options.maxScan > 0 ? Math.floor(options.maxScan) : 400
  const spliceIndex = buildSpliceIndex(events)
  const skipped = { kind: 0, require: 0, deny: 0 }
  let scanned = 0
  let newest = null

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event.type !== 'user/message') continue
    const text = textOfContent(event.data?.content)
    if (!text.trim()) continue
    if (scanned >= maxScan) break
    scanned += 1

    const spliced = spliceIndex.get(spliceKey(text))
    const kind = spliced?.kind ?? (typeof event.data?.source?.kind === 'string' ? event.data.source.kind : 'user')
    const verdict = judge(text, kind, cfg)
    if (verdict.ok) {
      newest = {
        at: Number(event.time) || null,
        kind,
        channel: channelOf({ kind, form: spliced?.form }),
        text,
        seq: event.seq ?? null,
      }
      break
    }
    if (verdict.reason && verdict.reason in skipped) skipped[verdict.reason] += 1
  }

  return { found: Boolean(newest), message: newest, scanned, skipped }
}

/** 最后一条 user 消息与最后一条 assistant 消息的时间（不看闸，只问「谁最后说话」） */
export function pickTimeline(events) {
  let lastUserAt = null
  let lastAssistantAt = null
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (lastUserAt !== null && lastAssistantAt !== null) break
    const event = events[i]
    const at = Number(event?.time) || null
    if (!at) continue
    if (lastAssistantAt === null && event.type === 'assistant/message') lastAssistantAt = at
    if (lastUserAt === null && event.type === 'user/message') {
      if (textOfContent(event.data?.content).trim()) lastUserAt = at
    }
  }
  return { lastUserAt, lastAssistantAt }
}

export function preview(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  return flat.length > PREVIEW ? `${flat.slice(0, PREVIEW)}…` : flat
}

/** 会话目录名跟 cwd 编码有关，不猜：直接按 <sid>/session.v4.jsonl.zstd 找。 */
export async function findSessionLog(sessionsRoot, sessionId) {
  let dirs
  try {
    dirs = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return null
  }
  for (const dirent of dirs) {
    if (!dirent.isDirectory()) continue
    const candidate = join(sessionsRoot, dirent.name, String(sessionId), 'session.v4.jsonl.zstd')
    try {
      await readFile(candidate, { encoding: null })
      return candidate
    } catch {
      // 下一个
    }
  }
  return null
}

export async function readSessionPresence(sessionsRoot, sessionId, cfg, options = {}) {
  const file = await findSessionLog(sessionsRoot, sessionId)
  if (!file) return { ok: false, error: 'no_log', sessionId, sessionsRoot }
  const buffer = await readFile(file)
  // 大日志（几十 MB）先只解最后几百帧；找不到再全量解一次
  const tail = Number.isInteger(options.tailFrames) ? options.tailFrames : 300
  let events = parseEvents(decodeLog(buffer, { maxFrames: tail }))
  let picked = pickLastUserMessage(events, cfg, options)
  if (!picked.found && options.allowFull !== false) {
    events = parseEvents(decodeLog(buffer))
    picked = pickLastUserMessage(events, cfg, options)
  }
  const timeline = pickTimeline(events)
  return {
    ok: true,
    sessionId,
    sessionFile: file,
    bytes: buffer.length,
    events: events.length,
    ...timeline,
    ...picked,
  }
}
