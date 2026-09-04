/**
 * chats 台帳型カードの「状態」を決める純関数と定数。
 *
 * ここに React を持ち込まない。表示の判断だけを切り出してテスト可能にするための場所。
 * 仕様: _docs/SPEC-CHATS-LEDGER-REDESIGN.md
 */

export type ChatStatus = 'unread' | 'in_progress' | 'resolved'
export type AiReplyMode = 'bot' | 'human'

/**
 * status のラベルと色。
 *
 * ★「対応中」は status 専用の語。ai_reply_mode='human' 側を「対応中」と呼ばないこと。
 *   同じ語を2つの軸に使うと、運用者が「何が対応中なのか」を判断できなくなる
 *   （リバースハックは botPaused を「対応中」と表示しているが、あちらは status と
 *   別のセレクトで段階を持っているので衝突しない。line-bot は status がその役)。
 */
export const STATUS_LABELS: Record<ChatStatus, { label: string; className: string }> = {
  unread: { label: '未読', className: 'bg-red-100 text-red-700' },
  in_progress: { label: '対応中', className: 'bg-yellow-100 text-yellow-700' },
  resolved: { label: '解決済', className: 'bg-green-100 text-green-700' },
}

export interface CardFlags {
  /** 未返信（相手の発言に、まだこちらが手で返していない）。出典は /api/inbox/unanswered */
  unanswered: boolean
  /**
   * 自分で返信するモードか。
   * null = まだ取得できていない（一覧APIが aiReplyMode を返すまでは詳細を開かないと分からない）。
   * ★false と null を混同しないこと。false は「Botが返す」、null は「不明」。
   */
  humanMode: boolean | null
  status: ChatStatus
  /** 左端のアクセント色。未返信が最優先（今すぐ返すべきものを見落とさないため）。 */
  accent: 'red' | 'amber' | 'none'
}

export function deriveCardFlags(
  chat: { id: string; status: ChatStatus },
  unansweredIds: ReadonlySet<string>,
  aiReplyMode: AiReplyMode | undefined,
): CardFlags {
  const unanswered = unansweredIds.has(chat.id)
  const humanMode = aiReplyMode === undefined ? null : aiReplyMode === 'human'
  return {
    unanswered,
    humanMode,
    status: chat.status,
    accent: unanswered ? 'red' : humanMode ? 'amber' : 'none',
  }
}

/**
 * 一覧に出すプレビュー文言。
 * flex/image 等は本文を出しても意味が薄いので種類の表記に置き換える。
 */
export function previewLabel(chat: {
  lastMessageContent?: string | null
  lastMessageType?: string | null
}): string {
  switch (chat.lastMessageType) {
    case 'image': return '📷 画像'
    case 'flex': return '📋 Flexメッセージ'
    case 'sticker': return '🎨 スタンプ'
    case 'video': return '🎥 動画'
    case 'audio': return '🎤 音声'
    case 'file': return '📎 ファイル'
    case 'location': return '📍 位置情報'
    default: return (chat.lastMessageContent ?? '').replace(/\n+/g, ' ').slice(0, 60)
  }
}

/** 経過時間の表示。inbox-row と同じ見え方にするため、ここを唯一の実装にする。 */
export function formatElapsed(iso: string, now: number = Date.now()): string {
  const ms = now - new Date(iso).getTime()
  if (Number.isNaN(ms)) return ''
  if (ms < 0) return 'たった今'
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'たった今'
  if (min < 60) return `${min}分前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}時間前`
  return `${Math.floor(hr / 24)}日前`
}

/** カードの定型ボタンに出してよい種類。carousel は send が送れないので含めない。 */
export const QUICK_SEND_TYPES = ['text', 'flex', 'image'] as const

export type ExpandResult =
  | { ok: true; messageType: string; content: string }
  | {
      ok: false
      reason: 'unsupported_type' | 'unresolved_vars' | 'invalid_json'
      unresolved?: string[]
    }

/**
 * テンプレを「この相手へ送る1通」に変換する。
 *
 * ★フェイルクローズ。POST /api/chats/:id/send は worker 側の expandVariables を
 *   通さないので、{{name}} 入りのテンプレをそのまま渡すと {{name}} の文字列が
 *   相手に届いてしまう。ここで展開できない変数が1つでも残っていたら送らせない。
 *   （{{uid}} や {{metadata.*}} を画面側で真似すると worker 側と二重管理になるので、
 *    対応するのは {{name}} だけに留め、残りは「テンプレを直してください」と促す）
 */
export function expandTemplateForChat(
  tpl: { messageType: string; messageContent: string },
  chat: { friendName: string },
): ExpandResult {
  if (!(QUICK_SEND_TYPES as readonly string[]).includes(tpl.messageType)) {
    return { ok: false, reason: 'unsupported_type' }
  }
  const content = tpl.messageContent.replace(/\{\{name\}\}/g, chat.friendName)
  const unresolved = [...content.matchAll(/\{\{[^}]+\}\}/g)].map((m) => m[0])
  if (unresolved.length > 0) {
    return { ok: false, reason: 'unresolved_vars', unresolved: [...new Set(unresolved)] }
  }
  // text 以外は JSON として送るので、壊れていたら送信前に止める
  // （送ってから worker で JSON.parse が投げると 500 になり、原因が分かりにくい）
  if (tpl.messageType !== 'text') {
    try {
      JSON.parse(content)
    } catch {
      return { ok: false, reason: 'invalid_json' }
    }
  }
  return { ok: true, messageType: tpl.messageType, content }
}
