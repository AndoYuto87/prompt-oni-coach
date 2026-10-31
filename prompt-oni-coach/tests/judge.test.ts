import { expect, test } from 'claude-code/testing'
import {
  addCounts,
  buildPrompt,
  buildReport,
  dayOf,
  FORCE_LINE,
  hasBug,
  hasForce,
  hasNegative,
  PREVIOUS_LIMIT,
  readVerdict,
  stripForce,
  TEXT_LIMIT,
  wordCounts,
} from '../hooks/judge'

test('返事の JSON から判定を読む', async () => {
  expect(readVerdict('{"stop": true, "habits": ["前提不足"], "comment": "エラーの全文どこ行ってん!"}')).toEqual({
    stop: true,
    habits: ['前提不足'],
    comment: 'エラーの全文どこ行ってん!',
  })
  // ```json で囲まれていても読む
  expect(readVerdict('```json\n{"stop": false, "habits": [], "comment": "分かっとるやないか!"}\n```')).toEqual({
    stop: false,
    habits: [],
    comment: '分かっとるやないか!',
  })
  // 知らない癖の名前は捨て、habits が無ければ空にする
  expect(readVerdict('{"stop": false, "habits": ["脱線", "寝坊"], "comment": "話どこ行ってん"}')?.habits).toEqual(['脱線'])
  expect(readVerdict('{"stop": false, "comment": "ええやん"}')?.habits).toEqual([])
})

test('壊れた返事は読まない(= 通す)', async () => {
  expect(readVerdict('')).toBe(undefined)
  expect(readVerdict('stop')).toBe(undefined)
  expect(readVerdict('{"stop": true, "habits": [')).toBe(undefined)
  // stop が真偽値でない・comment が無い・空
  expect(readVerdict('{"stop": "true", "habits": [], "comment": "あかん"}')).toBe(undefined)
  expect(readVerdict('{"stop": true, "habits": []}')).toBe(undefined)
  expect(readVerdict('{"stop": true, "habits": [], "comment": " "}')).toBe(undefined)
  expect(readVerdict('null')).toBe(undefined)
})

test('発言は先頭を、前の回答は末尾を残し、モードを添える', async () => {
  const text = 'あ'.repeat(TEXT_LIMIT) + 'い'
  const previous = 'う' + 'え'.repeat(PREVIOUS_LIMIT)
  const prompt = buildPrompt(text, previous, false)
  expect(prompt.includes('い')).toBe(false)
  expect(prompt.includes('う')).toBe(false)
  expect(prompt.indexOf('<前の回答の末尾>') < prompt.indexOf('<発言>')).toBe(true)
  expect(prompt.includes('<今のモード>通常モード</今のモード>')).toBe(true)
  // プランモードなら「プランを飛ばす」を挙げさせない
  expect(buildPrompt('テスト', undefined, true).includes('プランモード(「プランを飛ばす」は挙げない)')).toBe(true)
  // 前の回答が無ければ付けない
  expect(buildPrompt('テスト', undefined, false).includes('前の回答')).toBe(false)
  expect(buildPrompt('テスト', '', false).includes('前の回答')).toBe(false)
})

test('強制的に通す行:末尾・途中・無い', async () => {
  const tail = `直して\n${FORCE_LINE}`
  const middle = `直して\n${FORCE_LINE}\nエラーは下のとおり`
  expect(hasForce(tail)).toBe(true)
  expect(hasForce(middle)).toBe(true)
  // 前後の空白は許す
  expect(hasForce(`直して\n  ${FORCE_LINE} `)).toBe(true)
  expect(hasForce('直して')).toBe(false)
  // 行の一部だけなら通さない
  expect(hasForce(`直して${FORCE_LINE}`)).toBe(false)
  expect(hasForce(`直して\n${FORCE_LINE.slice(1)}`)).toBe(false)
})

test('強制的に通す行を消した文', async () => {
  expect(stripForce(`直して\n${FORCE_LINE}`)).toBe('直して')
  expect(stripForce(`直して\n${FORCE_LINE}\nエラーは下のとおり`)).toBe('直して\nエラーは下のとおり')
  expect(stripForce('直して')).toBe('直して')
})

test('やり直しと不具合の言葉', async () => {
  expect(hasNegative('違う、そっちじゃなくて')).toBe(true)
  expect(hasNegative('そうじゃない')).toBe(true)
  expect(hasNegative('ありがとう')).toBe(false)
  expect(hasBug('バグがあって動かない')).toBe(true)
  expect(hasBug('保存するとエラーが出る')).toBe(true)
  expect(hasBug('ありがとう')).toBe(false)
})

test('言葉で数えるもの', async () => {
  expect(wordCounts('違う、バグってる')).toEqual(['否定の言葉', '不具合の言葉'])
  expect(wordCounts('動かない')).toEqual(['不具合の言葉'])
  expect(wordCounts('ありがとう')).toEqual([])
})

test('日付は手元のタイムゾーンで区切る', async () => {
  expect(dayOf(new Date(2026, 9, 31, 0, 0).getTime())).toBe('2026-10-31')
  expect(dayOf(new Date(2026, 9, 31, 23, 59).getTime())).toBe('2026-10-31')
  expect(dayOf(new Date(2026, 10, 1, 0, 0).getTime())).toBe('2026-11-01')
})

test('回数を足す。元の Days は変えない', async () => {
  const days = { '2026-10-31': { 依頼: 2 } }
  const added = addCounts(days, '2026-10-31', ['依頼', '脱線', '脱線'])
  expect(added).toEqual({ '2026-10-31': { 依頼: 3, 脱線: 2 } })
  expect(days).toEqual({ '2026-10-31': { 依頼: 2 } })
  expect(addCounts(days, '2026-11-01', ['止めた'])).toEqual({ '2026-10-31': { 依頼: 2 }, '2026-11-01': { 止めた: 1 } })
})

test('report の表:古い日から並べ、無い回数は 0', async () => {
  expect(buildReport({}).startsWith('まだ記録がありません')).toBe(true)
  const report = buildReport({
    '2026-11-01': { 依頼: 4, 前提不足: 1 },
    '2026-10-31': { 依頼: 3, 止めた: 1, 聞き返し: 2, 中断: 1, 否定の言葉: 1, 不具合の言葉: 1, 曖昧な指示: 2 },
  })
  expect(report).toBe(
    [
      '## 日ごとの回数',
      '| 日付 | 依頼 | 止めた | 聞き返し | 中断 | 否定の言葉 | 不具合の言葉 |',
      '|---|---:|---:|---:|---:|---:|---:|',
      '| 2026-10-31 | 3 | 1 | 2 | 1 | 1 | 1 |',
      '| 2026-11-01 | 4 | 0 | 0 | 0 | 0 | 0 |',
      '',
      '## 癖ごとの指摘(止めたときと、通して一言で指摘したとき)',
      '| 日付 | 脱線 | 曖昧な指示 | 前提不足 | 詰め込み | プランを飛ばす |',
      '|---|---:|---:|---:|---:|---:|',
      '| 2026-10-31 | 0 | 2 | 0 | 0 | 0 |',
      '| 2026-11-01 | 0 | 0 | 1 | 0 | 0 |',
    ].join('\n'),
  )
})
