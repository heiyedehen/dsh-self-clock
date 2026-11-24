/**
 * 造一条「notice 型」用户消息：角色是 user，来源写成 heartbeat + form:notice，
 * 这样界面按系统提示那一排显示，不会冒充杨欣荣在说话。
 *
 * 优先从宿主那棵树里取官方的 createUserMessage（拿不到就手工造一个等价对象）。
 * 桌面版 profile 用 autoInstallPeers:false，裸 import 常常解析不到——
 * 所以这里「能拿到就用官方的，拿不到退到等价实现」，绝不因为一个 import 让整条插件不激活。
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const PKG = 'dsh-llm';
const LOADED = Symbol('heartbeat.createUserMessage');

function candidateFiles() {
  const out = [];
  const add = (p) => {
    if (p && existsSync(p) && !out.includes(p)) out.push(p);
  };
  const res = process.resourcesPath;
  if (res) {
    add(join(res, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', PKG, 'lib', 'index.js'));
    add(join(res, 'app', 'dsh', 'node_modules', '@deepseek-ai', PKG, 'lib', 'index.js'));
  }
  const appdata = process.env.APPDATA;
  if (appdata) {
    add(join(appdata, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', PKG, 'lib', 'index.js'));
  }
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  try {
    for (const profile of ['desktop', 'web']) {
      add(join(dshHome, 'profiles', profile, 'node_modules', '@deepseek-ai', PKG, 'lib', 'index.js'));
    }
  } catch {
    /* 没有就算了 */
  }
  return out;
}

function fallback(input) {
  const text = typeof input?.text === 'string'
    ? input.text
    : (Array.isArray(input?.content) ? input.content : [])
      .filter((block) => block?.type === 'text')
      .map((block) => String(block.text ?? ''))
      .join('')
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'heartbeat', form: 'notice', summary: input.summary ?? text.slice(0, 120) },
  };
  return Object.freeze({
    ...message,
    content: Object.freeze(message.content),
    source: Object.freeze(message.source),
  });
}

let cached;

/** 取 createUserMessage（缓存；拿不到官方实现就用本地等价实现） */
export async function loadCreateUserMessage(onNote = () => {}) {
  if (cached) return cached;
  for (const file of candidateFiles()) {
    try {
      const mod = await import(pathToFileURL(file).href);
      if (typeof mod.createUserMessage === 'function') {
        cached = mod.createUserMessage;
        onNote(`createUserMessage：用宿主那份（${file}）`);
        return cached;
      }
    } catch (error) {
      onNote(`createUserMessage：${file} 取不到（${error?.code || error?.message || error}）`);
    }
  }
  try {
    const mod = await import('@deepseek-ai/dsh-llm');
    if (typeof mod?.createUserMessage === 'function') {
      cached = mod.createUserMessage;
      onNote('createUserMessage：用裸 import 那份');
      return cached;
    }
  } catch {
    /* 走兜底 */
  }
  cached = fallback;
  onNote('createUserMessage：官方那份拿不到，用本地等价实现（结构一致）');
  return cached;
}

export { LOADED };
