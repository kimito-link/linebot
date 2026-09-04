'use client'

import type { CardFlags, ChatStatus } from './chat-card-flags'
import { STATUS_LABELS, previewLabel, formatElapsed } from './chat-card-flags'

/**
 * 台帳型カード1枚（折りたたみ時のヘッダ部分）。
 *
 * ★台帳型の要点は「カードを開かずに次の一手を打てる」こと。
 *   会話を読むためではなく、何をするか決めるための画面。
 *   だから状態と操作を先に見せ、会話は開いたときだけ出す。
 *
 * 仕様: _docs/SPEC-CHATS-LEDGER-REDESIGN.md
 */

export interface ChatCardChat {
  id: string
  friendName: string
  friendPictureUrl: string | null
  status: ChatStatus
  notes: string | null
  lastMessageAt: string | null
  lastMessageContent: string | null
  lastMessageType: string | null
}

const ACCENT: Record<CardFlags['accent'], string> = {
  red: 'border-l-4 border-l-red-500',
  amber: 'border-l-4 border-l-amber-500',
  none: 'border-l-4 border-l-transparent',
}

export default function ChatCard({
  chat,
  flags,
  expanded,
  accountName,
  switchingMode,
  onToggleExpand,
  onStatusChange,
  onToggleAiReplyMode,
  quickSend,
  children,
}: {
  chat: ChatCardChat
  flags: CardFlags
  expanded: boolean
  accountName?: string | null
  switchingMode?: boolean
  onToggleExpand: () => void
  onStatusChange: (status: ChatStatus) => void
  onToggleAiReplyMode: () => void
  /** 操作行に並べる定型文ボタン（TemplateQuickSend）。 */
  quickSend?: React.ReactNode
  /** 展開時の中身（会話・入力欄など）。折りたたみ時は呼び出し側が渡さない。 */
  children?: React.ReactNode
}) {
  const preview = previewLabel(chat)

  return (
    <div
      className={`bg-white border border-gray-200 rounded-lg mb-2 ${ACCENT[flags.accent]}`}
      // 画面外のカードは描画を省く。50件でも一覧のスクロールが軽くなる。
      // 効かない環境でも表示は変わらない（見た目に影響しない最適化）。
      style={expanded ? undefined : { contentVisibility: 'auto', containIntrinsicSize: '0 96px' }}
    >
      <div className="p-3">
        {/* 行1: バッジ → 名前 → アカウント → 経過時間 */}
        <div className="flex items-center gap-2 flex-wrap">
          {chat.friendPictureUrl ? (
            <img src={chat.friendPictureUrl} alt="" className="w-7 h-7 rounded-full flex-shrink-0" />
          ) : (
            <div className="w-7 h-7 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0">
              <span className="text-gray-500 text-xs">{chat.friendName.charAt(0)}</span>
            </div>
          )}

          {flags.unanswered && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-500 text-white">未返信</span>
          )}
          {/* ★humanMode が null（未取得）のときは何も出さない。
              「Botが返します」と断定できないので、嘘をつくより黙る。 */}
          {flags.humanMode === true && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500 text-white">自分で返信</span>
          )}
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_LABELS[flags.status].className}`}>
            {STATUS_LABELS[flags.status].label}
          </span>

          <p className="text-sm font-semibold text-gray-900 truncate">{chat.friendName}</p>
          {accountName && <span className="text-[11px] text-gray-400 truncate">・{accountName}</span>}
          {chat.lastMessageAt && (
            <span className="text-[11px] text-gray-400 ml-auto flex-shrink-0">
              {formatElapsed(chat.lastMessageAt)}
            </span>
          )}
        </div>

        {/* 行2: プレビュー */}
        <p
          className={`text-xs mt-1 truncate ${flags.unanswered ? 'text-gray-900 font-medium' : 'text-gray-400'}`}
          title={preview}
        >
          {preview || <span className="italic text-gray-300">(まだメッセージなし)</span>}
        </p>

        {/* 行3: 操作。★カードを開かずに押せる */}
        <div className="flex items-center gap-1.5 flex-wrap mt-2">
          <button
            onClick={onToggleExpand}
            className="px-2 py-1 text-xs font-medium rounded bg-[#06C755] text-white hover:bg-[#05b34c]"
          >
            {expanded ? '▲ 閉じる' : '💬 返信する'}
          </button>

          {/* ★aiReplyMode が未取得のときは押させない。
              どちらに切り替わるか分からないボタンは、押せるほうが危ない。 */}
          <button
            onClick={onToggleAiReplyMode}
            disabled={switchingMode || flags.humanMode === null}
            title={flags.humanMode === null ? '会話を開くと切り替えられます' : undefined}
            className={`px-2 py-1 text-xs font-medium rounded border disabled:opacity-40 ${
              flags.humanMode
                ? 'bg-amber-500 text-white border-amber-500 hover:bg-amber-600'
                : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
            }`}
          >
            {switchingMode ? '切替中...' : flags.humanMode ? '▶ Botに戻す' : '⏸ Botを止める'}
          </button>

          <select
            value={chat.status}
            onChange={(e) => onStatusChange(e.target.value as ChatStatus)}
            className="px-1.5 py-1 text-xs border border-gray-300 rounded bg-white text-gray-700"
            aria-label="対応状態"
          >
            <option value="unread">未読</option>
            <option value="in_progress">対応中</option>
            <option value="resolved">解決済</option>
          </select>

          {quickSend}

          {chat.notes && (
            <span className="text-[11px] text-gray-500 truncate max-w-[180px]" title={chat.notes}>
              📝 {chat.notes}
            </span>
          )}
        </div>
      </div>

      {expanded && <div className="border-t border-gray-200">{children}</div>}
    </div>
  )
}
