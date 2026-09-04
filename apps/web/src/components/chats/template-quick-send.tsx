'use client'

import { useState } from 'react'
import { expandTemplateForChat, QUICK_SEND_TYPES, type ExpandResult } from './chat-card-flags'

/**
 * カード上の「定型文」ボタン群と、送信前の確認モーダル。
 *
 * ★業種を選ばない作りにする。リバースハック側は「+3日確認」「+25日保証終了」
 *   のように業務手順ごとの専用ボタンだが、あれはITサポート固有。
 *   ここでは templates テーブル（category 付き）を読んで並べるだけにして、
 *   何を並べるかは各業種が /templates 画面で決める。
 *   → コードに業種の語が一切出ない。
 *
 * ★1クリックで送らない。相手に届くものを、送る前に必ず見せる。
 */

export interface QuickTemplate {
  id: string
  name: string
  category: string
  messageType: string
  messageContent: string
}

/** カードに直接ボタンとして出す数。これを超えた分はメニューに入れる。 */
const MAX_BUTTONS = 6

const REASON_TEXT: Record<Exclude<ExpandResult & { ok: false }, never>['reason'], string> = {
  unsupported_type: 'この種類の定型文は、この画面からは送れません。',
  unresolved_vars: '',   // 個別に組み立てる
  invalid_json: '定型文の中身が壊れています（JSONとして読めません）。',
}

export default function TemplateQuickSend({
  templates,
  friendName,
  sending,
  onSend,
}: {
  templates: QuickTemplate[]
  friendName: string
  sending: boolean
  onSend: (messageType: string, content: string) => Promise<void> | void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirming, setConfirming] = useState<QuickTemplate | null>(null)

  // 送れない種類は最初から出さない（押してから断るより、出さないほうが親切）。
  const usable = templates.filter((t) => (QUICK_SEND_TYPES as readonly string[]).includes(t.messageType))
  if (usable.length === 0) return null

  const buttons = usable.slice(0, MAX_BUTTONS)
  const overflow = usable.slice(MAX_BUTTONS)

  const expanded = confirming ? expandTemplateForChat(confirming, { friendName }) : null

  return (
    <>
      {buttons.map((t) => (
        <button
          key={t.id}
          onClick={() => setConfirming(t)}
          className="px-2 py-1 text-xs rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
          title={t.name}
        >
          {t.name.length > 12 ? `${t.name.slice(0, 12)}…` : t.name}
        </button>
      ))}

      {overflow.length > 0 && (
        <div className="relative">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="px-2 py-1 text-xs rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
          >
            📋 定型文…
          </button>
          {menuOpen && (
            <div className="absolute z-20 mt-1 w-56 max-h-64 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg">
              {overflow.map((t) => (
                <button
                  key={t.id}
                  onClick={() => { setMenuOpen(false); setConfirming(t) }}
                  className="block w-full text-left px-3 py-2 text-xs hover:bg-gray-50 border-b border-gray-100 last:border-b-0"
                >
                  <span className="text-gray-400 mr-1">{t.category}</span>
                  {t.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {confirming && expanded && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
          onClick={() => setConfirming(null)}
        >
          <div
            className="bg-white rounded-lg shadow-xl max-w-md w-full p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-bold text-gray-900">この内容で送ります</h3>
            <p className="text-xs text-gray-500 mt-1">
              送信先: <span className="font-medium text-gray-700">{friendName}</span>
            </p>

            <div className="mt-3 p-3 bg-gray-50 border border-gray-200 rounded text-xs whitespace-pre-wrap break-words max-h-56 overflow-y-auto">
              {expanded.ok
                ? (expanded.messageType === 'text'
                    ? expanded.content
                    : `（${expanded.messageType}）\n${expanded.content.slice(0, 400)}`)
                : confirming.messageContent}
            </div>

            {/* ★送れない理由は、送る前にはっきり出す。
                黙って送って {{uid}} が相手に届くほうが、はるかにまずい。 */}
            {!expanded.ok && (
              <p className="mt-2 text-xs text-red-600">
                {expanded.reason === 'unresolved_vars'
                  ? `${expanded.unresolved?.join(' ')} を展開できません。定型文を直すか、手入力で送ってください。`
                  : REASON_TEXT[expanded.reason]}
              </p>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirming(null)}
                className="px-3 py-1.5 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
              >
                キャンセル
              </button>
              <button
                disabled={!expanded.ok || sending}
                onClick={async () => {
                  if (!expanded.ok) return
                  await onSend(expanded.messageType, expanded.content)
                  setConfirming(null)
                }}
                className="px-3 py-1.5 text-xs font-medium rounded bg-[#06C755] text-white hover:bg-[#05b34c] disabled:opacity-40"
              >
                {sending ? '送信中...' : 'この内容で送信'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
