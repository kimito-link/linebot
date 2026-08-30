'use client'

// =============================================================================
// 接続状態 — 「どこがどう繋がっているか分からない」を潰すための画面
// =============================================================================
//
// 表示の原則（apps/worker/src/services/connection-registry.ts と対）:
//   緑 = 実際に疎通を確認した
//   赤 = 確認したうえで失敗した
//   青 = 設定済みだが疎通は未確認（**緑ではない**）
//   灰 = 未設定
//
// 「未設定でも黙って動き続ける」接続を最上部に別枠で出す。
// これが今回の「気づけなかった」の正体なので、一番先に目に入るようにしている。

import { useState, useEffect, useCallback } from 'react'
import Header from '@/components/layout/header'
import { api } from '@/lib/api'
import type {
  ConnectionState,
  ConnectionStatus,
  ConnectionsResponse,
  DegradeMode,
  LlmUsageResponse,
} from '@/lib/api'

const statusConfig: Record<
  ConnectionStatus,
  { label: string; dot: string; text: string; bg: string; hint: string }
> = {
  ok: {
    label: '疎通OK',
    dot: 'bg-green-500',
    text: 'text-green-800',
    bg: 'bg-green-50 border-green-200',
    hint: '実際に通信できることを確認済み',
  },
  ng: {
    label: '異常',
    dot: 'bg-red-500',
    text: 'text-red-800',
    bg: 'bg-red-50 border-red-200',
    hint: '確認した結果、失敗している',
  },
  unverified: {
    label: '設定済み・未確認',
    dot: 'bg-blue-400',
    text: 'text-blue-800',
    bg: 'bg-blue-50 border-blue-200',
    hint: '鍵はあるが、実際に通信できるかは確かめていない',
  },
  unconfigured: {
    label: '未設定',
    dot: 'bg-gray-400',
    text: 'text-gray-700',
    bg: 'bg-gray-50 border-gray-200',
    hint: '必要な設定が入っていない',
  },
}

const degradeLabel: Record<DegradeMode, { label: string; tone: string }> = {
  'silent-skip': { label: '黙って素通り', tone: 'text-orange-700 bg-orange-100' },
  fallback: { label: '別経路へ', tone: 'text-blue-700 bg-blue-100' },
  'feature-off': { label: '機能停止', tone: 'text-yellow-800 bg-yellow-100' },
  'fail-closed': { label: '閉じる(安全)', tone: 'text-green-800 bg-green-100' },
  required: { label: '必須', tone: 'text-red-700 bg-red-100' },
}

const groupLabel: Record<ConnectionState['group'], string> = {
  line: 'LINE',
  llm: 'AIモデル',
  storage: 'データ保管',
  integration: '外部連携',
  ops: '運用',
}

export default function ConnectionsPage() {
  const [data, setData] = useState<ConnectionsResponse | null>(null)
  const [usage, setUsage] = useState<LlmUsageResponse | null>(null)
  const [usageError, setUsageError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setUsageError(null)
    try {
      const res = await api.connections.list()
      if (res.success) setData(res.data)
      else setError(res.error)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    // 使用量は別枠。落ちても接続一覧は出す（片方の失敗で全部見えなくならないように）
    try {
      const u = await api.connections.llmUsage()
      if (u.success) setUsage(u.data)
      else setUsageError(u.error)
    } catch (e) {
      setUsageError(e instanceof Error ? e.message : String(e))
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const grouped = (data?.connections ?? []).reduce<Record<string, ConnectionState[]>>(
    (acc, c) => {
      ;(acc[c.group] ??= []).push(c)
      return acc
    },
    {},
  )

  return (
    <div className="min-h-screen bg-gray-50">
      <Header title="接続状態" />

      <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-600">
            この Bot が何と繋がっているか。
            {data && (
              <span className="ml-2 text-gray-400">
                取得: {new Date(data.generatedAt).toLocaleString('ja-JP')}
              </span>
            )}
          </p>
          <button
            onClick={() => void load()}
            disabled={loading}
            className="px-4 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            {loading ? '確認中…' : '再確認'}
          </button>
        </div>

        {error && (
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
            接続状態を取得できませんでした: {error}
          </div>
        )}

        {/* 最も気づきにくい欠落を最上部に。ここが今回の問題の本体。 */}
        {data && data.silentlyMissing.length > 0 && (
          <section className="p-4 bg-orange-50 border border-orange-300 rounded-lg">
            <h2 className="font-bold text-orange-900 mb-1">
              黙って素通りしている設定が {data.silentlyMissing.length} 件あります
            </h2>
            <p className="text-xs text-orange-800 mb-3">
              未設定でもエラーにならないため、気づかないまま機能が欠けています。
            </p>
            <ul className="space-y-2">
              {data.silentlyMissing.map((s) => (
                <li key={s.id} className="text-sm bg-white rounded p-3 border border-orange-200">
                  <div className="font-medium text-gray-900">{s.label}</div>
                  <div className="text-gray-600 mt-1">{s.whenMissing}</div>
                  <div className="text-xs text-gray-500 mt-1">
                    未設定: <code className="bg-gray-100 px-1 rounded">{s.missingKeys.join(', ')}</code>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {data?.probeError && (
          <div className="p-3 bg-yellow-50 border border-yellow-300 rounded-lg text-sm text-yellow-900">
            疎通記録を読めませんでした（正常だと判断しません）: {data.probeError}
          </div>
        )}

        {/* LLM使用量 */}
        <section className="bg-white rounded-lg border border-gray-200 p-4">
          <h2 className="font-bold text-gray-900 mb-3">AIモデルの使用量（本日）</h2>
          {usageError ? (
            <p className="text-sm text-yellow-800">使用量を取得できませんでした: {usageError}</p>
          ) : usage ? (
            <div>
              <p className="text-sm text-gray-600 mb-2">
                {usage.date} ／ 予算 {usage.budget} 回/日 ・ 合計 {usage.totalCalls} 回
              </p>
              {usage.accounts.length === 0 ? (
                <p className="text-sm text-gray-500">本日の呼び出しはまだありません。</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-500 border-b">
                      <th className="py-1">アカウント</th>
                      <th className="py-1 text-right">呼出</th>
                      <th className="py-1 text-right">キャッシュ</th>
                      <th className="py-1 text-right">残り</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.accounts.map((a) => (
                      <tr key={a.lineAccountId ?? 'null'} className="border-b last:border-0">
                        <td className="py-1">{a.lineAccountId ?? '(未指定)'}</td>
                        <td className="py-1 text-right">{a.calls}</td>
                        <td className="py-1 text-right text-gray-500">{a.cacheHits}</td>
                        <td className={`py-1 text-right ${a.exceeded ? 'text-red-600 font-bold' : ''}`}>
                          {a.exceeded ? '超過' : a.remaining}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ) : (
            <p className="text-sm text-gray-500">読み込み中…</p>
          )}
        </section>

        {/* 接続一覧 */}
        {Object.entries(grouped).map(([group, items]) => (
          <section key={group}>
            <h2 className="font-bold text-gray-900 mb-2">
              {groupLabel[group as ConnectionState['group']] ?? group}
            </h2>
            <div className="space-y-2">
              {items.map((c) => {
                const sc = statusConfig[c.status]
                const dg = degradeLabel[c.degrade]
                return (
                  <div key={c.id} className={`border rounded-lg p-4 ${sc.bg}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${sc.dot}`} />
                        <span className="font-medium text-gray-900 truncate">{c.label}</span>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className={`text-xs px-2 py-0.5 rounded ${dg.tone}`}>{dg.label}</span>
                        <span className={`text-xs font-medium ${sc.text}`}>{sc.label}</span>
                      </div>
                    </div>

                    <p className="text-xs text-gray-500 mt-2">{sc.hint}</p>

                    {!c.configured && (
                      <div className="mt-2 text-sm">
                        <p className="text-gray-700">{c.whenMissing}</p>
                        <p className="text-xs text-gray-500 mt-1">
                          未設定:{' '}
                          <code className="bg-white px-1 rounded border">
                            {c.missingKeys.join(', ')}
                          </code>
                        </p>
                      </div>
                    )}

                    {c.probe && (
                      <p className="text-xs text-gray-600 mt-2">
                        アカウント {c.probe.accounts} 件を監視中
                        {c.probe.danger > 0 && (
                          <span className="text-red-700 font-bold"> ・危険 {c.probe.danger}</span>
                        )}
                        {c.probe.warning > 0 && (
                          <span className="text-yellow-700"> ・警告 {c.probe.warning}</span>
                        )}
                        {c.probe.checkedAt && (
                          <span className="text-gray-400">
                            {' '}
                            ・最終 {new Date(c.probe.checkedAt).toLocaleString('ja-JP')}
                          </span>
                        )}
                      </p>
                    )}

                    <p className="text-[11px] text-gray-400 mt-2 font-mono truncate">{c.source}</p>
                  </div>
                )
              })}
            </div>
          </section>
        ))}

        <p className="text-xs text-gray-400 pt-2">
          一覧の正本は apps/worker/src/services/connection-registry.ts です。
          接続を足したときに書き忘れると、テストが落ちて知らせます。
        </p>
      </div>
    </div>
  )
}
