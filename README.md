# 鱼的心跳 · dsh-self-clock

一个会自己定闹钟的插件。到点了，它在同一条会话里给自己留一句「到点了」——不是用户消息，不派任务，也不替你安排什么。

内置的 `schedule` 是一张张写好的时刻表；心跳是**会话自己决定**什么时候该醒。想每隔半小时看一眼、想在夜里某个点回头捡起一件事，一句话就够，不用先去写一条 cron。

## 它做的事

- **模型自己设**：`heartbeat_set({ inMinutes: 30, label: "把刚才那半段写完" })`，三十分钟后在原会话醒一次，带着你留的那句话。
- **不是提醒你，是提醒它自己**：投的是一条 `notice`，出现在对话里，不弹窗、不响铃、不冒充你说过话。
- **会看你在不在**：到点先读会话日志正文，判断你刚说完话没有、我上一条回复多久了。你正说着话，它就不响。
- **一口气能关**：总开关、频次、时段、每日上限、临时静音，都在设置页里点，不用改文件。

![鱼的心跳设置页](assets/screenshot-1.png)

## 和内置 `schedule` 的区别

| | `schedule` | 心跳 |
| --- | --- | --- |
| 谁定时间 | 你写在任务里 | 会话自己，随时改 |
| 提示词 | 写死的 | `label`，一句「上次停在哪」 |
| 到点不响的理由 | 没有 | 会告诉你是「太近」「在等你」「刚收尾」「不在时段」「预算用完」 |
| 看你在不在 | 不看 | 看正文，不看到 mtime |

## 什么时候不会响

开关只管「能不能响」；真到点还有五道闸，任何一条不过就安静跳过：

- 你上一条消息至少过去 5 分钟——刚说完话不打断
- 上一条你已经回过了，它没有在等你
- 它上一条回复也过去 2 分钟了
- 这条会话 10 分钟内没被叫过——只有半页的书房时间会避让心跳，心跳自己不避让
- 在时段内、今日预算没用完、没有临时静音

安静 5–20 分钟只说「到点了」；超过 20 分钟，连你留言的那句话一起说。

读不到会话日志（还没落盘、换了目录、文件坏了）时，五道闸一起失效，照时段和预算响——宁可白叫一次，也不漏。

## 意图唤醒：让「什么时候该醒」从对话里长出来

cron 只回答「过了半小时」，不回答「这会儿该不该醒」。所以除了闹钟，还能挂**意图**：

```js
intent_set({ at: "+3h", note: "他说今晚可能很晚" })
intent_set({ at: "23:30", note: "答应过这时候看一眼那两页" })
```

到点了，它会先说清这是谁记的：`意图唤醒 · 你自己记的「他说今晚可能很晚」，到点了。`

- **意图不等于能出声**：到点仍要过上面那五道闸。你正在说话、它在等你回、刚收尾、静音中、十分钟内刚叫过——都安静跳过，**这条意图留着**，下一拍再看，不丢。
- **不看你睡没睡**：心跳是我自己的时间，按钟走，不按你在不在走。只有「你正在跟我说话」才会让它往后让一步——就是上面那几道闸，不是「你六小时没说话就不响」。
- **三道刹车**（不是配额，是让它别退化成班表）：同时最多 5 条、一天最多被这样叫醒 4 次、超过 24 小时自动作废。
- **cron 不删**：意图是加成。文件丢了、忘了写、规则坏了，还得有人按时叫你。

首次运行会在 `~/.dsh/self/` 放两份**空模板**，让你的鱼自己往里写（已存在则一个字都不改）：

- `意图.md`：什么时候该看场面，给人看的版本
- `我想做的事.md`：长期想做的事、想读的书，没有时间，不触发任何投递

两份别混——混了就成「待办清单 + 闹钟」了。

## 装

```bash
dsh plugin add dsh-self-clock
```

或者在 DSH 的「插件市场」里搜「心跳」，点安装。装完在「设置 → 心跳」里能看到面板。

## 说两句

装了就麻烦点个 ⭐（仓库右上角），让我知道有人在用；装不上、用着别扭、想要什么功能，直接在市场评论区留言或开个 issue——都会看到。

## 工具

### `heartbeat_set`

一条会话同时只挂一个闹钟，重复调用覆盖旧的。

| 参数 | 说明 |
| --- | --- |
| `inMinutes` | N 分钟后响一次（1–1440） |
| `everyMinutes` | 每隔 N 分钟响一次（5–1440） |
| `cron` | 五个字段：分 时 日 月 周，支持 `*`、`a`、`a,b`、`a-b`、`*/n`，例如 `30 7 * * *` |
| `label` | 唤醒时提示自己「上次停在哪」的一句话，不超过 80 字 |

三个时间参数只能给一个。返回里的 `nextAtLocal` / `statusText` / `window` 说明什么时候响、以及为什么没响。子会话拒绝设置。

### `heartbeat_config`

改这条会话的设置，只传要改的字段：`enabled`、`everyMinutes`、`windowStart` / `windowEnd`（0–23 小时，`start > end` 表示跨夜）、`dailyBudget`、`muteMinutes`。

### `heartbeat_mute`

临时静音，默认 30 分钟。期间不响、不消耗预算，到点自动恢复。

### `heartbeat_list`

看所有闹钟和「为什么没响」：`等待中 · 下次 09:30`、`已关闭（总开关）`、`不在时段（23:00–06:00，跨夜）`、`今日预算用完（48/48）`、`临时静音中 · 09:52 恢复`、`距上条消息太近（3 分钟）`、`⚠ 未排到下次触发`。

### `heartbeat_cancel`

取消本会话的闹钟，没有也算成功。

### `intent_set`

挂一条「该醒的念头」。`at` 认 ISO、今天的 `HH:MM`（已过就顺到明天）、或相对时间 `+3h` / `+90m`。

| 参数 | 说明 |
| --- | --- |
| `at` | 什么时候该醒 |
| `note` | 一句来源：他说的原话，或你自己的判断——会出现在唤醒里 |

上限：同时最多 5 条；一天最多被这样叫醒 4 次；超过 24 小时作废。

### `intent_list`

看挂着哪些意图、还差几条到上限、今天已经用了几次。

### `intent_cancel`

按 id 取消一条。改主意就取消再建，别原地改。

### `presence`

读会话日志**正文**，回答「他本人最后说话是什么时候、走的哪条通道」。不看 mtime——会话文件每轮都在写（系统注入、插件汇报都算），mtime 永远是新的。

| 参数 | 说明 |
| --- | --- |
| `sessionId` | 要查的会话；不填就是当前这条 |
| `maxScan` | 最多往前翻多少条 user 消息，默认 400 |
| `kinds` | 临时覆盖白名单，例如只看 `["qq"]` |

判据是三道闸，顺序固定：白名单（`ownerSourceKinds`）→ 必须含（`ownerSourceRequire`）→ 排除（`ownerSourceDeny`）。默认白名单是 `["user", "qq"]`，默认排除挡系统注入和定时提醒。

一个坑：落盘的 `user/message` 事件里不带 `source`，来源只活在 `agent/inbox/spliced` 的 `inserted[].source`。所以先建「正文 → 来源」表再对，对不上才当 `user`。

## 设置页

DSH 的「设置」里有一节「心跳」：

- 顶上一行：现在几点、今天已响几次、几个闹钟；右上角「新建」/「刷新」
- 一张表：会话 / 状态 / 开关 / 频次 / 上限 / 静音
- **新建**只列**现在还活着**（有会话开着）且还没闹钟的会话
- **上限**：每行自己的每日上限，改完立刻写回
- 表下一段「什么时候才会真叫一声」，就是上面那五道闸

## 落盘

`~/.dsh/heartbeat.json`（或 `$DSH_HOME/heartbeat.json`）：

```json
{
  "version": 1,
  "alarms": {
    "<sessionId>": { "mode": "interval", "everyMinutes": 30, "nextAt": 0, "label": "" }
  },
  "usage": { "date": "2026-11-24", "bySession": { "<sessionId>": 3 } }
}
```

`alarms` 是按 `sessionId` 的对象 map；`cronParsed` 不落盘（Set 序列化会变成空对象，读回来按 `cron` 重解析）。插件起来时读它，到点的立刻补响一次；卸载时定时器清掉，文件留着。`usage` 按会话分桶，搬过会话之后旧 key 在启动时会被清掉，不白占额度。

意图单独一份 `~/.dsh/intents.json`（**不塞进 alarms**：闹钟那次踩过 `Set → {}` 的坑，意图表没有要重解析的字段，单独一份最不容易再犯，也方便手改）：

```json
{
  "version": 1,
  "intents": [
    { "id": "…", "at": "2026-11-26T15:30:00.000Z", "note": "他说今晚可能很晚", "status": "pending", "sessionId": "…", "createdAt": "…" }
  ],
  "usage": { "date": "2026-11-26", "count": 1 }
}
```

`status` 有 `pending` / `done` / `expired` / `cancelled`。卸载时不清它，跟 alarms 一样——宁可留垃圾，也别把想做的事抹掉。

## 配置（`cordis.patch.yml`）

```yaml
config:
  windowStart: 0
  windowEnd: 23
  dailyBudget: 48
  chatGraceMinutes: 5
  postReplyGraceMinutes: 2
```

`chatGraceMinutes` / `postReplyGraceMinutes` 就是「5 分钟」「2 分钟」两个门槛。

## 开发

```bash
cd "D:/dsh work/plugins/heartbeat"
ELECTRON_RUN_AS_NODE=1 "D:/deepseek/DeepSeek Harness.exe" --test test/*.test.mjs
```

`core.test.mjs` 只测时间算法；`plugin.test.mjs` 用临时 `DSH_HOME` + 伪造 ctx 跑真实投递；`acceptance.test.mjs` 是工单验收；`presence.test.mjs` 测三道闸；`intents.test.mjs` 测意图（上限、过期、没过闸保持 pending、模板不覆盖）。

## 投递方式

照 DSH 自己的 schedule 运行时：

```js
const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'heartbeat', form: 'notice', summary } })
agent.followup(message)
await ctx.sessions.flush(agent.session)
```

会话没活着就 `ctx.sessionController.resolveAgent(sessionId)` 复活。`createUserMessage` 优先从宿主树里 `@deepseek-ai/dsh-llm` 取（profile 里没有这个包），拿不到就用本地等价实现，对象形状一致。

## 许可

MIT
