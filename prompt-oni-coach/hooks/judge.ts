// 判定の部品。フックからは呼ばれるだけで、$ には触らない

// 見る癖(D-006)。Haiku の返事も、日ごとの回数もこの名前で扱う
export const HABITS = ['脱線', '曖昧な指示', '前提不足', '詰め込み', 'プランを飛ばす'] as const
export type Habit = (typeof HABITS)[number]

export type Verdict = {
  stop: boolean // 止めて書き直させるか(D-009・D-010)
  habits: Habit[] // 見つけた癖。無ければ空
  comment: string // ステータスラインと、止めたときの理由に出す一言(D-008・D-021)
}

// Haiku に渡す発言と前の回答の長さ(文字数)
export const TEXT_LIMIT = 1000
export const PREVIOUS_LIMIT = 400

// 判定基準(D-006・D-007・D-009・D-010・D-012・D-021・D-022)。Haiku の system に渡す
export const RULES = `あなたは、コーディング支援の AI(Claude)への人の発言を読み、AI の使い方の癖をその場でツッコむ係です。

見る癖は次の5つです。
- 脱線:前の回答の話題や、進めている作業と関係ない話を急に始める
- 曖昧な指示:何を・どこを・どうしたいかが読み取れない(「いい感じにして」「直して」だけ など)
- 前提不足:判断に要る材料が無い(エラーの全文・ファイル名・再現手順 など)
- 詰め込み:別々の作業を1回の発言にいくつも頼む
- プランを飛ばす:設計や大きな変更など、プランを立ててから進めた方がいい作業を、通常モードのまま頼む

止めるかどうか:
- このまま送ると、AI からの聞き返し・的外れな作業・やり直しが起きそうなら stop を true にする
- 癖があっても軽く、AI が迷わず進められそうなら stop は false にして、一言だけツッコむ
- 「OK」「2で」のような短い返事は、前の回答の問いへの答えとして通じるかで見る。通じるなら癖ではない
- 「プランを飛ばす」は、今のモードが通常モードのときだけ見る。プランモードのときは挙げない

comment の書き方:
- 話し手は、人から無茶ぶりされる下っ端の AI。「俺にもそんな言い方で頼むんか!」と関西弁で怒ってツッコみ、そのあと従うしかない苦労をぼやく。50字以内にする(例:「『いい感じに』て…それで外したら怒られるの俺やねんぞ!」「エラー見せんと直せて…下っ端は超能力者ちゃうねん!」)
- 足りないもの(どの癖か・何が無いか)が、ツッコミの中で分かるようにする。書き直した文や、こう書けという案は出さない
- 癖が無く、良い発言なら、上から目線で認める(例:「やればできるやん…最初からそうしてや」)

返事は次の形の JSON を1つだけにしてください。説明は要りません。
{"stop": true または false, "habits": [見つけた癖の名前], "comment": "一言"}
habits に入れる名前は、脱線 / 曖昧な指示 / 前提不足 / 詰め込み / プランを飛ばす のどれかです。`

// Haiku に渡す本文。前の回答の末尾は、短い返事と脱線を読むために添える(D-007)
export function buildPrompt(text: string, previous: string | undefined, isPlan: boolean): string {
  const parts: string[] = []
  if (previous) {
    parts.push(`<前の回答の末尾>\n${previous.slice(-PREVIOUS_LIMIT)}\n</前の回答の末尾>`)
  }
  // プランモード中は「プランを飛ばす」を見させない(D-022)
  parts.push(`<今のモード>${isPlan ? 'プランモード(「プランを飛ばす」は挙げない)' : '通常モード'}</今のモード>`)
  parts.push(`<発言>\n${text.slice(0, TEXT_LIMIT)}\n</発言>`)
  return parts.join('\n\n')
}

// Haiku の返事から判定を読む。読めなければ undefined(= 判定せずに通す。D-020)
export function readVerdict(text: string): Verdict | undefined {
  // ```json で囲まれても読めるよう、最初の { から最後の } までを取る
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return undefined
  let v: unknown
  try {
    v = JSON.parse(m[0])
  } catch {
    return undefined
  }
  if (typeof v !== 'object' || v === null) return undefined
  const { stop, habits, comment } = v as Record<string, unknown>
  if (typeof stop !== 'boolean' || typeof comment !== 'string' || !comment.trim()) return undefined
  // 知らない癖の名前は捨てる
  const known = Array.isArray(habits)
    ? HABITS.filter(h => habits.includes(h))
    : []
  return { stop, habits: known, comment: comment.trim() }
}

// 止めたときに戻す文の末尾に足す行。この行が残っていれば判定せずに通す(D-017・D-023)
export const FORCE_LINE = '(この行を残して送ると、判定せずに通します)'

// どこかの行が FORCE_LINE と一致するか。末尾以外でも通す(D-023)
export function hasForce(text: string): boolean {
  return text.split('\n').some(line => line.trim() === FORCE_LINE)
}

// FORCE_LINE の行を消す。Claude には消した文を渡す(D-017)
export function stripForce(text: string): string {
  return text
    .split('\n')
    .filter(line => line.trim() !== FORCE_LINE)
    .join('\n')
    .trimEnd()
}

// やり直しを表す言葉(U-3)と、不具合の報告の言葉(U-6・D-005)。拾う精度は未確認(C-1)
export const NEGATIVE_WORDS = ['違う', 'ちがう', 'そうじゃない', 'そうではない', 'やり直し', '元に戻して'] as const
export const BUG_WORDS = ['バグ', '動かない', '動きません', 'エラーになる', 'エラーが出', '壊れ'] as const

export function hasNegative(text: string): boolean {
  return NEGATIVE_WORDS.some(w => text.includes(w))
}

export function hasBug(text: string): boolean {
  return BUG_WORDS.some(w => text.includes(w))
}

// 日ごとに数えるもの(D-004・D-011・D-019)。$.store にもこの名前で残す
// 依頼:通した発言 / 止めた・癖:U-1 / 聞き返し:U-2 / 中断・否定の言葉:U-3 / 不具合の言葉:U-6
export const TOTALS = ['依頼', '止めた', '聞き返し', '中断', '否定の言葉', '不具合の言葉'] as const
export type Count = (typeof TOTALS)[number] | Habit
export type Days = Record<string, Partial<Record<Count, number>>> // 日付(YYYY-MM-DD)ごとの回数

// 通した発言の言葉で数えるもの
export function wordCounts(text: string): Count[] {
  const counts: Count[] = []
  if (hasNegative(text)) counts.push('否定の言葉')
  if (hasBug(text)) counts.push('不具合の言葉')
  return counts
}

// その時刻の、手元のタイムゾーンでの日付(C-8)
export function dayOf(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// その日の回数に1ずつ足した、新しい Days を返す
export function addCounts(days: Days, day: string, counts: readonly Count[]): Days {
  const today = { ...days[day] }
  for (const c of counts) today[c] = (today[c] ?? 0) + 1
  return { ...days, [day]: today }
}

// /prompt-oni-coach report の表。古い日から並べる(D-011)
export function buildReport(days: Days): string {
  const dates = Object.keys(days).sort()
  if (dates.length === 0) return 'まだ記録がありません。on の間の発言を日ごとに数えます'
  const table = (columns: readonly Count[]) =>
    [
      `| 日付 | ${columns.join(' | ')} |`,
      `|---|${columns.map(() => '---:').join('|')}|`,
      ...dates.map(d => `| ${d} | ${columns.map(c => days[d][c] ?? 0).join(' | ')} |`),
    ].join('\n')
  return ['## 日ごとの回数', table(TOTALS), '', '## 癖ごとの指摘(止めたときと、通して一言で指摘したとき)', table(HABITS)].join('\n')
}
