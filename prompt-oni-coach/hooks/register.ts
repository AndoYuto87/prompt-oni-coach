import type { EngineInterface, Register } from 'claude-code'
import {
  addCounts,
  buildPrompt,
  buildReport,
  type Count,
  dayOf,
  type Days,
  FORCE_LINE,
  hasForce,
  readVerdict,
  RULES,
  stripForce,
  type Verdict,
  wordCounts,
} from './judge'

const COMMAND = 'prompt-oni-coach'

// Haiku の判定を待つ長さ(D-020)
const JUDGE_TIMEOUT_MS = 5000

// 判定しない発言:バックグラウンドの作業の完了通知(D-019)と、AskUserQuestion のダイアログの答え(D-025)
const NOTIFICATION = '<task-notification>'
const DIALOG_ANSWER = 'Answering your earlier question'

// メインスレッドだけを見る。値はこのセッションの間だけ持ち、読み直しで消える
let previous = '' // 前の回答。短い返事と脱線を読むために末尾を添える(D-007)
let isPlan = false // 最後に届いた印で覚えた今のモード(D-022)
let isNotice = false // 今のターンは完了通知か。通知のターンの中断は数えない(D-019)

// on / off は次のセッションにも残す。初期は off(D-013)
async function isOn($: EngineInterface): Promise<boolean> {
  return (await $.store.get('enabled')) === true
}

function showStatus($: EngineInterface, on: boolean): void {
  $.ui.status(`${COMMAND}: ${on ? 'on' : 'off'}`)
}

async function readDays($: EngineInterface): Promise<Days> {
  return ((await $.store.get('days')) ?? {}) as Days
}

// 今日の回数に足す(D-011)。呼ぶのは on のときだけ(D-026)。数え損ねても発言やツールは止めない
async function count($: EngineInterface, counts: readonly Count[]): Promise<void> {
  try {
    const day = dayOf(await $.clock.now())
    await $.store.set('days', addCounts(await readDays($), day, counts))
  } catch {}
}

// Haiku に判定を聞く。間に合わない・読めないときは undefined(= 通す。D-020)
async function judge($: EngineInterface, text: string): Promise<Verdict | undefined> {
  const r = await $.model.complete({
    model: 'haiku',
    system: RULES,
    prompt: buildPrompt(text, previous, isPlan),
    maxTokens: 200,
    timeoutMs: JUDGE_TIMEOUT_MS,
  })
  return r.isAnswered ? readVerdict(r.text) : undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: '発言の癖のツッコミを on / off し、日ごとの回数を出す',
      argumentHint: 'on|off|report',
    })
    showStatus($, await isOn($))
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'report') return { text: buildReport(await readDays($)) }
    if (arg !== 'on' && arg !== 'off') {
      const now = (await isOn($)) ? 'on' : 'off'
      return { text: `今は ${now} です。/${COMMAND} on か off で切り替え、report で日ごとの回数を出します` }
    }
    await $.store.set('enabled', arg === 'on')
    showStatus($, arg === 'on')
    return { text: `${COMMAND}: ${arg}` }
  }).catch(() => ({ text: `${COMMAND}: 失敗しました` }))

  // モードの印は発言の後に届くので、次の発言の判定に使う(D-022・C-6b)
  on('prompt.attachment', async ($, e, next) => {
    if (e.agentId === undefined) {
      if (e.type === 'plan_mode' || e.type === 'plan_mode_reentry') isPlan = true
      if (e.type === 'plan_mode_exit') isPlan = false
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // 覚え損ねても添付は止めない

  // Claude の聞き返し(U-2)。メインスレッドの AskUserQuestion だけ数える
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (e.agentId === undefined && (await isOn($))) await count($, ['聞き返し'])
    return next(e)
  }).catch(($, e, next) => next(e)) // 数え損ねてもツールは止めない

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) isNotice = e.text.trim().startsWith(NOTIFICATION)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      // 人の中断(U-3)。通知のターンは人の依頼ではないので数えない(D-019)
      if (e.isAborted && !isNotice && (await isOn($))) await count($, ['中断'])
      if (e.answer !== '') previous = e.answer
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!(await isOn($))) return next(e)

    const text = e.text.trim()
    // 通知・コマンドは数えない(D-019・D-028)
    if (e.command || e.isMeta || text === '' || text.startsWith(NOTIFICATION)) return next(e)
    // ダイアログの答えは依頼に数える。Claude の質問文が入るので言葉は数えない(D-025・D-027)
    if (text.startsWith(DIALOG_ANSWER)) {
      await count($, ['依頼'])
      return next(e)
    }
    // 行が残っていれば判定せず、行を消して Claude に渡す(D-017・D-023)
    if (hasForce(e.text)) {
      const passed = stripForce(e.text)
      await count($, ['依頼', ...wordCounts(passed)])
      return next({ ...e, text: passed })
    }

    const verdict = await judge($, e.text)
    if (!verdict) {
      await count($, ['依頼', ...wordCounts(e.text)])
      return next(e)
    }
    $.ui.status(verdict.comment)

    if (verdict.stop) {
      // 止めた文を入力欄に戻す(D-016)。戻せなければ、文を失わないよう通す
      const filled = await $.prompt.fill({ text: `${e.text}\n${FORCE_LINE}` })
      if (filled.isFilled) {
        // 止めた発言は Claude に届かないので依頼に入れない(D-019)
        await count($, ['止めた', ...verdict.habits])
        return { drop: verdict.comment }
      }
    }
    await count($, ['依頼', ...verdict.habits, ...wordCounts(e.text)])
    return next(e)
  }).catch(($, e, next) => next(e)) // 判定が壊れても発言は止めない
}
