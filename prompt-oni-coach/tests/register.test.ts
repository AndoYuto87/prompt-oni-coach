import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { buildReport, FORCE_LINE } from '../hooks/judge'

const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

// 時計の始まり。手元のタイムゾーンで 2026-10-31 の昼
const NOW = new Date(2026, 9, 31, 12, 0).getTime()
const DAY = '2026-10-31'

const STOP = '{"stop": true, "habits": ["曖昧な指示"], "comment": "何がダサいねん!"}'
const PASS = '{"stop": false, "habits": [], "comment": "分かっとるやないか!"}'

let status: string | undefined
let asked: string[] = []
let filled: string[] = []
let entered: string[] = [] // Claude に届いた発言
let reply: string | undefined // undefined なら Haiku が間に合わない
let canFill = true

function engine(on: Parameters<Parameters<typeof test>[1]>[1], store: Record<string, unknown> = { enabled: true }) {
  status = undefined
  asked = []
  filled = []
  entered = []
  reply = PASS
  canFill = true
  mock.store(on, store)
  const clock = mock.clock(on, { now: NOW })
  on('command.register', () => ({ value: { command: 'prompt-oni-coach' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', (_, e) => ((status = e.text), { value: undefined }))
  on('model.complete', (_, e) => {
    asked.push(e.prompt)
    return {
      value: reply === undefined
        ? { isAnswered: false, reason: 'aborted', usage }
        : { isAnswered: true, text: reply, usage },
    }
  })
  on('prompt.fill', (_, e) => (canFill && filled.push(e.text), { isFilled: canFill }))
  on('prompt.submit', (_, e) => (entered.push(e.text), { text: e.text }))
  on('prompt.attachment', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ isError: false, result: 'ok', text: 'ok' }))
  return clock
}

// 残った回数は report で読む。表は judge.test.ts で確かめた buildReport と同じになる
async function report($: Engine): Promise<string> {
  return ((await run($, 'report')) as { text: string }).text
}

// 1ターン:始まり → (Claude の聞き返し) → 終わり
async function turn($: Engine, text: string, opts: { aborted?: boolean; ask?: boolean; agentId?: string } = {}) {
  const { agentId } = opts
  await $.turn.start({ text, turnId: 't', agentId } as never)
  if (opts.ask) await $.tool.call({ tool: 'AskUserQuestion', questions: [], agentId } as never)
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 0, isAborted: opts.aborted ?? false, reason: opts.aborted ? 'aborted' : 'answer', agentId } as never)
}

async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
}

function submit($: Engine, text: string, extra: Record<string, unknown> = {}) {
  return $.prompt.submit({ text, wait: false, origin: { kind: 'composer' }, ...extra } as never)
}

function attach($: Engine, type: string, agentId?: string) {
  return $.prompt.attachment({ type, text: '', origin: { kind: 'engine' }, agentId } as never)
}

function run($: Engine, args: string) {
  return $.command.run({ command: 'prompt-oni-coach', args, origin: { kind: 'composer' }, presentation: { layout: 'main', columns: 80 } } as never)
}

test('入れた直後は off で、Haiku を呼ばずに通す', async ($, on) => {
  engine(on, {})
  await start($)
  expect(status).toBe('prompt-oni-coach: off')
  await submit($, 'いい感じにして')
  expect(asked.length).toBe(0)
  expect(entered).toEqual(['いい感じにして'])
})

test('コマンドで on / off を切り替える', async ($, on) => {
  engine(on, {})
  await start($)
  await run($, 'on')
  expect(status).toBe('prompt-oni-coach: on')
  await submit($, 'いい感じにして')
  expect(asked.length).toBe(1)
  await run($, 'off')
  expect(status).toBe('prompt-oni-coach: off')
  await submit($, 'いい感じにして')
  expect(asked.length).toBe(1)
  expect(((await run($, '')) as { text: string }).text.includes('今は off')).toBe(true)
})

test('止めると、行を足した文を入力欄に戻し、理由を出して落とす', async ($, on) => {
  engine(on)
  await start($)
  reply = STOP
  const r = await submit($, 'いい感じにして')
  expect(r).toEqual({ drop: '何がダサいねん!' })
  expect(filled).toEqual([`いい感じにして\n${FORCE_LINE}`])
  expect(entered).toEqual([])
  expect(status).toBe('何がダサいねん!')
})

test('通すときは一言をステータスに出し、文はそのまま渡す', async ($, on) => {
  engine(on)
  await start($)
  await submit($, 'src/a.ts の 10 行目で落ちる。エラー全文:TypeError ...')
  expect(entered).toEqual(['src/a.ts の 10 行目で落ちる。エラー全文:TypeError ...'])
  expect(filled).toEqual([])
  expect(status).toBe('分かっとるやないか!')
})

test('行が残っていれば Haiku を呼ばず、行を消して通す', async ($, on) => {
  engine(on)
  await start($)
  reply = STOP
  await submit($, `いい感じにして\n${FORCE_LINE}`)
  expect(asked.length).toBe(0)
  expect(entered).toEqual(['いい感じにして'])
})

test('行が途中にあっても通し、行の後ろに書き足した中身は残す', async ($, on) => {
  engine(on)
  await start($)
  reply = STOP
  await submit($, `いい感じにして\n${FORCE_LINE}\nボタンの色を青に`)
  expect(asked.length).toBe(0)
  expect(entered).toEqual(['いい感じにして\nボタンの色を青に'])
})

test('行を消して送り直すと、もう一度判定する', async ($, on) => {
  engine(on)
  await start($)
  reply = STOP
  await submit($, 'いい感じにして')
  await submit($, 'いい感じにして')
  expect(asked.length).toBe(2)
  expect(entered).toEqual([])
})

test('Haiku が間に合わない・返事が読めないときは通す', async ($, on) => {
  engine(on)
  await start($)
  reply = undefined
  await submit($, 'いい感じにして')
  reply = 'stop'
  await submit($, 'いい感じにして')
  expect(entered).toEqual(['いい感じにして', 'いい感じにして'])
  expect(filled).toEqual([])
})

test('入力欄に戻せないときは、文を失わないよう通す', async ($, on) => {
  engine(on)
  await start($)
  reply = STOP
  canFill = false
  await submit($, 'いい感じにして')
  expect(entered).toEqual(['いい感じにして'])
})

test('通知・ダイアログの答え・コマンド・メタ・空の発言は判定しない', async ($, on) => {
  engine(on)
  await start($)
  reply = STOP
  await submit($, '<task-notification>done</task-notification>')
  await submit($, 'Answering your earlier question "どうする?": 2')
  await submit($, '/foo', { command: { name: 'foo', args: '' } })
  await submit($, '内部の発言', { isMeta: true })
  await submit($, '  ')
  expect(asked.length).toBe(0)
  expect(filled).toEqual([])
  expect(entered.length).toBe(5)
})

test('プランモードの印のあとは、プランモードとして判定する。抜けたら通常に戻す', async ($, on) => {
  engine(on)
  await start($)
  await submit($, '設計して')
  expect(asked[0].includes('<今のモード>通常モード</今のモード>')).toBe(true)
  await attach($, 'plan_mode')
  await submit($, '設計して')
  expect(asked[1].includes('プランモード')).toBe(true)
  await attach($, 'plan_mode_exit')
  await submit($, '設計して')
  expect(asked[2].includes('<今のモード>通常モード</今のモード>')).toBe(true)
  await attach($, 'plan_mode_reentry')
  await submit($, '設計して')
  expect(asked[3].includes('プランモード')).toBe(true)
})

test('サブエージェントの印ではモードを変えない', async ($, on) => {
  engine(on)
  await start($)
  await attach($, 'plan_mode', 'a1')
  await submit($, '設計して')
  expect(asked[0].includes('<今のモード>通常モード</今のモード>')).toBe(true)
})

test('前の回答の末尾を判定に添える。空の答えとサブエージェントの答えでは書き換えない', async ($, on) => {
  engine(on)
  await start($)
  const complete = (answer: string, agentId?: string) =>
    $.turn.complete({ turnId: 't', answer, durationMs: 0, isAborted: false, reason: 'answer', agentId } as never)
  await complete('1. 用語を足す\n2. 全体を監査する')
  await complete('')
  await complete('サブの報告', 'a1')
  await submit($, '2')
  expect(asked[0].includes('2. 全体を監査する')).toBe(true)
  expect(asked[0].includes('サブの報告')).toBe(false)
})

test('日ごとの回数:止めた発言は依頼に入れず、止めた回数と癖に数える', async ($, on) => {
  engine(on)
  await start($)
  reply = STOP
  await submit($, 'バグってるから直して')
  // 言葉は通した発言だけで数える
  expect(await report($)).toBe(buildReport({ [DAY]: { 止めた: 1, 曖昧な指示: 1 } }))
})

test('日ごとの回数:通した発言は依頼と、一言で指摘した癖と、言葉に数える', async ($, on) => {
  engine(on)
  await start($)
  reply = '{"stop": false, "habits": ["詰め込み"], "comment": "欲張りすぎやろ!"}'
  await submit($, '違う、ボタンが動かない。あとヘッダーも直して')
  reply = PASS
  await submit($, 'src/a.ts の 10 行目を直して')
  // Haiku が間に合わなくても依頼には数える
  reply = undefined
  await submit($, 'テストを足して')
  expect(await report($)).toBe(buildReport({ [DAY]: { 依頼: 3, 詰め込み: 1, 否定の言葉: 1, 不具合の言葉: 1 } }))
})

test('日ごとの回数:強制的に通した発言は依頼に入れ、行を消した文で言葉を数える', async ($, on) => {
  engine(on)
  await start($)
  await submit($, `直して\n${FORCE_LINE}\n動かない`)
  expect(await report($)).toBe(buildReport({ [DAY]: { 依頼: 1, 不具合の言葉: 1 } }))
})

test('日ごとの回数:ダイアログの答えは依頼に入れ、言葉は数えない。通知・コマンドは数えない', async ($, on) => {
  engine(on)
  await start($)
  await submit($, 'Answering your earlier question "バグを直す?": 違う')
  await submit($, '<task-notification>バグ</task-notification>')
  await submit($, '/foo 違う', { command: { name: 'foo', args: '違う' } })
  expect(await report($)).toBe(buildReport({ [DAY]: { 依頼: 1 } }))
})

test('日ごとの回数:メインの聞き返しと中断を数え、通知のターンの中断とサブエージェントは数えない', async ($, on) => {
  engine(on)
  await start($)
  await turn($, '設計して', { ask: true })
  await turn($, '直して', { aborted: true })
  await turn($, '<task-notification>done</task-notification>', { aborted: true })
  await turn($, '調べて', { ask: true, aborted: true, agentId: 'a1' })
  expect(await report($)).toBe(buildReport({ [DAY]: { 聞き返し: 1, 中断: 1 } }))
})

test('日ごとの回数:off の間は何も数えない', async ($, on) => {
  engine(on, {})
  await start($)
  await submit($, 'バグってる')
  await turn($, '直して', { ask: true, aborted: true })
  expect(await report($)).toBe(buildReport({}))
})

test('日付が変わると別の日に数える', async ($, on) => {
  const clock = engine(on)
  await start($)
  await submit($, '直して')
  await clock.set(new Date(2026, 10, 1, 0, 0).getTime())
  await submit($, '直して')
  expect(await report($)).toBe(buildReport({ [DAY]: { 依頼: 1 }, '2026-11-01': { 依頼: 1 } }))
})

test('report で日ごとの表を返す', async ($, on) => {
  engine(on, { enabled: true, days: { [DAY]: { 依頼: 3, 止めた: 1 } } })
  await start($)
  const text = ((await run($, 'report')) as { text: string }).text
  expect(text.includes('| 2026-10-31 | 3 | 1 | 0 | 0 | 0 | 0 |')).toBe(true)
  expect(text.includes('## 癖ごとの指摘')).toBe(true)
})
