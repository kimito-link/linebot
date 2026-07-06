'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Header from '@/components/layout/header'
import { api } from '@/lib/api'

const WORKER_BASE = process.env.NEXT_PUBLIC_API_URL
if (!WORKER_BASE) {
  throw new Error('NEXT_PUBLIC_API_URL is not set. Build cannot proceed.')
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface AffiliateItem {
  id: string
  name: string
  code: string
  commissionRate: number
  isActive: boolean
  createdAt: string
  friendId: string | null
}

interface AffiliateReportRow {
  affiliateId: string
  affiliateName: string
  code: string
  commissionRate: number
  totalClicks: number
  totalConversions: number
  totalRevenue: number
  linkCount: number
  friendAdds: number
}

/** Merged for the list view */
interface AffiliateListRow extends AffiliateItem {
  totalClicks: number
  totalConversions: number
  totalRevenue: number
  estimatedCommission: number
  linkCount: number
  friendAdds: number
}

interface AffiliateLink {
  id: string
  affiliate_id: string
  ref_code: string
  label: string | null
  line_account_id: string | null
  is_active: number
  created_at: string
  click_count: number
}

interface ReportV2 {
  affiliateId: string
  affiliateName: string
  code: string
  commissionRate: number
  clicks: number
  linkClicks: number
  friendAdds: number
  conversions: number
  conversionsByPoint: Array<{ conversionPointId: string; name: string; count: number; value: number }>
  revenue: number
  estimatedCommission: number
  duplicateFlags: Array<{ friendId: string; identityKey: string }>
}

interface JourneySummary {
  friendId: string
  displayName: string | null
  addedAt: string
  refCode: string | null
  touchCount: number
  formCount: number
  conversionCount: number
  lastEventAt: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function formatYen(n: number): string {
  return `¥${Math.round(n).toLocaleString('ja-JP')}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

const JOURNEY_PAGE_SIZE = 30

export default function AffiliatesPage() {
  // ── list ───────────────────────────────────────────────────────────────────
  const [rows, setRows] = useState<AffiliateListRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // ── selected affiliate (detail panel) ─────────────────────────────────────
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [report, setReport] = useState<ReportV2 | null>(null)
  const [links, setLinks] = useState<AffiliateLink[]>([])

  // ── journeys (cursor-paginated) ────────────────────────────────────────────
  const [journeys, setJourneys] = useState<JourneySummary[]>([])
  const [journeyLoading, setJourneyLoading] = useState(false)
  const [journeyMore, setJourneyMore] = useState(false)
  const [journeyLoadingMore, setJourneyLoadingMore] = useState(false)
  const journeyCursorRef = useRef<{ beforeAt: string; beforeId: string } | null>(null)

  // ── load list ──────────────────────────────────────────────────────────────
  const loadList = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [affiliatesRes, reportRes] = await Promise.all([
        api.affiliates.list(),
        api.affiliates.allReport(),
      ])
      if (!affiliatesRes.success) throw new Error('affiliates fetch failed')
      if (!reportRes.success) throw new Error('report fetch failed')

      const affiliates = affiliatesRes.data as unknown as AffiliateItem[]
      const reportMap = new Map<string, AffiliateReportRow>()
      for (const r of (reportRes.data as unknown as AffiliateReportRow[])) {
        reportMap.set(r.affiliateId, r)
      }

      const merged: AffiliateListRow[] = affiliates.map((a) => {
        const rep = reportMap.get(a.id)
        return {
          ...a,
          totalClicks: rep?.totalClicks ?? 0,
          totalConversions: rep?.totalConversions ?? 0,
          totalRevenue: rep?.totalRevenue ?? 0,
          estimatedCommission: ((rep?.totalRevenue ?? 0) * a.commissionRate) / 100,
          linkCount: rep?.linkCount ?? 0,
          friendAdds: rep?.friendAdds ?? 0,
        }
      })
      setRows(merged)
    } catch (e) {
      setError(e instanceof Error ? e.message : '読み込みエラー')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadList() }, [loadList])

  // ── load detail (report v2 + links) ────────────────────────────────────────
  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true)
    setReport(null)
    setLinks([])
    setJourneys([])
    setJourneyMore(false)
    journeyCursorRef.current = null
    try {
      const [reportRes, linksRes] = await Promise.all([
        api.affiliates.reportV2(id),
        api.affiliates.links(id),
      ])
      if (reportRes.success) setReport(reportRes.data as unknown as ReportV2)
      if (linksRes.success) setLinks(linksRes.data as unknown as AffiliateLink[])
    } catch { /* silent — detail is optional */ }
    setDetailLoading(false)
  }, [])

  // ── load first page of journeys ────────────────────────────────────────────
  const loadJourneys = useCallback(async (id: string) => {
    setJourneyLoading(true)
    try {
      const res = await api.affiliates.journeys(id, { limit: JOURNEY_PAGE_SIZE })
      if (res.success) {
        setJourneys(res.data)
        journeyCursorRef.current = res.nextCursor ?? null
        setJourneyMore(Boolean(res.nextCursor))
      }
    } catch { /* silent */ }
    setJourneyLoading(false)
  }, [])

  // ── load more journeys ─────────────────────────────────────────────────────
  const loadMoreJourneys = useCallback(async (id: string) => {
    if (journeyLoadingMore) return
    const cursor = journeyCursorRef.current
    if (!cursor) { setJourneyMore(false); return }
    setJourneyLoadingMore(true)
    try {
      const res = await api.affiliates.journeys(id, {
        limit: JOURNEY_PAGE_SIZE,
        beforeAt: cursor.beforeAt,
        beforeId: cursor.beforeId,
      })
      if (res.success) {
        setJourneys((prev) => {
          const seen = new Set(prev.map((j) => j.friendId))
          return [...prev, ...res.data.filter((j) => !seen.has(j.friendId))]
        })
        journeyCursorRef.current = res.nextCursor ?? null
        setJourneyMore(Boolean(res.nextCursor))
      }
    } catch { /* silent */ }
    setJourneyLoadingMore(false)
  }, [journeyLoadingMore])

  // ── row click ──────────────────────────────────────────────────────────────
  const handleRowClick = useCallback((id: string) => {
    if (selectedId === id) {
      setSelectedId(null)
      return
    }
    setSelectedId(id)
    void loadDetail(id)
    void loadJourneys(id)
  }, [selectedId, loadDetail, loadJourneys])

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div>
      <Header
        title="ASP アフィリエイト"
        description="アフィリエイター別の成果・コミッション・帰属ジャーニー管理"
      />

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400">
          読み込み中...
        </div>
      ) : rows.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400">
          アフィリエイターがまだ登録されていません
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">名前</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">コード</th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">友だち紐付</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">リンク数</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">クリック</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">友だち追加</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">CV</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">売上</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">参考報酬</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">率</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">状態</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {rows.map((row) => {
                const isExpanded = selectedId === row.id
                return (
                  <>
                    <tr
                      key={row.id}
                      className={`cursor-pointer transition-colors ${isExpanded ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                      onClick={() => handleRowClick(row.id)}
                    >
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">{row.name}</td>
                      <td className="px-4 py-3 text-sm font-mono text-blue-600">{row.code}</td>
                      <td className="px-4 py-3 text-sm text-center">
                        {row.friendId
                          ? <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">あり</span>
                          : <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">なし</span>
                        }
                      </td>
                      <td className="px-4 py-3 text-sm text-right text-gray-700">{row.linkCount.toLocaleString()}</td>
                      <td className="px-4 py-3 text-sm text-right text-gray-700">{row.totalClicks.toLocaleString()}</td>
                      <td className="px-4 py-3 text-sm text-right font-semibold text-blue-600">{row.friendAdds.toLocaleString()}</td>
                      <td className="px-4 py-3 text-sm text-right font-semibold text-gray-900">{row.totalConversions.toLocaleString()}</td>
                      <td className="px-4 py-3 text-sm text-right text-gray-700">{formatYen(row.totalRevenue)}</td>
                      <td className="px-4 py-3 text-sm text-right font-semibold text-emerald-600">{formatYen(row.estimatedCommission)}</td>
                      <td className="px-4 py-3 text-sm text-right text-gray-500">{row.commissionRate}%</td>
                      <td className="px-4 py-3 text-sm">
                        {row.isActive
                          ? <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">有効</span>
                          : <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">無効</span>
                        }
                      </td>
                    </tr>

                    {/* Detail expansion row */}
                    {isExpanded && (
                      <tr key={`${row.id}-detail`}>
                        <td colSpan={11} className="px-6 py-5 bg-blue-50 border-t border-blue-100">
                          {detailLoading ? (
                            <p className="text-sm text-gray-400">読み込み中...</p>
                          ) : (
                            <div className="space-y-6">

                              {/* v2 summary cards */}
                              {report && (
                                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                                  <div className="bg-white rounded-lg p-4 border border-gray-100">
                                    <p className="text-xs text-gray-500">クリック (ref_tracking)</p>
                                    <p className="text-2xl font-bold text-gray-900 mt-1">{report.clicks.toLocaleString()}</p>
                                  </div>
                                  <div className="bg-white rounded-lg p-4 border border-gray-100">
                                    <p className="text-xs text-gray-500">友だち追加</p>
                                    <p className="text-2xl font-bold text-blue-600 mt-1">{report.friendAdds.toLocaleString()}</p>
                                  </div>
                                  <div className="bg-white rounded-lg p-4 border border-gray-100">
                                    <p className="text-xs text-gray-500">CV 件数</p>
                                    <p className="text-2xl font-bold text-gray-900 mt-1">{report.conversions.toLocaleString()}</p>
                                  </div>
                                  <div className="bg-white rounded-lg p-4 border border-gray-100">
                                    <p className="text-xs text-gray-500">参考報酬</p>
                                    <p className="text-2xl font-bold text-emerald-600 mt-1">{formatYen(report.estimatedCommission)}</p>
                                  </div>
                                </div>
                              )}

                              {/* Duplicate flags */}
                              {report && report.duplicateFlags.length > 0 && (
                                <div>
                                  <p className="text-xs font-semibold text-amber-700 uppercase mb-2">
                                    重複 identity_key 検出 ({report.duplicateFlags.length} 件)
                                  </p>
                                  <div className="flex flex-wrap gap-2">
                                    {report.duplicateFlags.map((f) => (
                                      <span
                                        key={f.friendId}
                                        className="inline-flex items-center gap-1 px-2 py-1 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800"
                                      >
                                        ⚠ {f.friendId.slice(0, 8)}…
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {/* CV by point */}
                              {report && report.conversionsByPoint.length > 0 && (
                                <div>
                                  <p className="text-xs font-semibold text-gray-500 uppercase mb-2">CV ポイント別内訳</p>
                                  <div className="overflow-x-auto">
                                    <table className="min-w-[400px] text-sm">
                                      <thead>
                                        <tr className="text-left text-xs text-gray-400">
                                          <th className="pb-1 pr-4">ポイント名</th>
                                          <th className="pb-1 pr-4 text-right">件数</th>
                                          <th className="pb-1 text-right">売上合計</th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-gray-100">
                                        {report.conversionsByPoint.map((p) => (
                                          <tr key={p.conversionPointId}>
                                            <td className="py-1 pr-4 text-gray-700">{p.name}</td>
                                            <td className="py-1 pr-4 text-right font-semibold text-gray-900">{p.count}</td>
                                            <td className="py-1 text-right text-gray-700">{formatYen(p.value)}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              )}

                              {/* Links table */}
                              {links.length > 0 && (
                                <div>
                                  <p className="text-xs font-semibold text-gray-500 uppercase mb-2">
                                    リンク別クリック ({links.length} 本)
                                  </p>
                                  <div className="overflow-x-auto">
                                    <table className="min-w-[560px] text-sm">
                                      <thead>
                                        <tr className="text-left text-xs text-gray-400">
                                          <th className="pb-1 pr-4">ref_code</th>
                                          <th className="pb-1 pr-4">ラベル</th>
                                          <th className="pb-1 pr-4 text-right">クリック</th>
                                          <th className="pb-1">状態</th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-gray-100">
                                        {links.map((link) => (
                                          <tr key={link.id}>
                                            <td className="py-1 pr-4 font-mono text-blue-600">{link.ref_code}</td>
                                            <td className="py-1 pr-4 text-gray-600">{link.label ?? '—'}</td>
                                            <td className="py-1 pr-4 text-right font-semibold text-gray-900">{link.click_count.toLocaleString()}</td>
                                            <td className="py-1">
                                              {link.is_active
                                                ? <span className="text-xs text-green-600">有効</span>
                                                : <span className="text-xs text-gray-400">無効</span>
                                              }
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              )}

                              {/* Journeys */}
                              <div>
                                <p className="text-xs font-semibold text-gray-500 uppercase mb-2">
                                  帰属ジャーニー ({journeys.length} 件{journeyMore ? '+' : ''})
                                </p>
                                {journeyLoading ? (
                                  <p className="text-sm text-gray-400">読み込み中...</p>
                                ) : journeys.length === 0 ? (
                                  <p className="text-sm text-gray-400">帰属された友だちがまだいません</p>
                                ) : (
                                  <>
                                    <div className="overflow-x-auto">
                                      <table className="min-w-[640px] text-sm">
                                        <thead>
                                          <tr className="text-left text-xs text-gray-400">
                                            <th className="pb-1 pr-4">友だち</th>
                                            <th className="pb-1 pr-4">追加日</th>
                                            <th className="pb-1 pr-4">ref_code</th>
                                            <th className="pb-1 pr-4 text-right">タッチ</th>
                                            <th className="pb-1 pr-4 text-right">フォーム</th>
                                            <th className="pb-1 pr-4 text-right">CV</th>
                                            <th className="pb-1">最終行動</th>
                                          </tr>
                                        </thead>
                                        <tbody className="divide-y divide-gray-100">
                                          {journeys.map((j) => {
                                            const isDup = report?.duplicateFlags.some((f) => f.friendId === j.friendId)
                                            return (
                                              <tr key={j.friendId} className={isDup ? 'bg-amber-50' : ''}>
                                                <td className="py-1 pr-4 text-gray-800">
                                                  {isDup && <span className="mr-1">⚠</span>}
                                                  {j.displayName ?? <span className="text-gray-400 italic">不明</span>}
                                                </td>
                                                <td className="py-1 pr-4 text-gray-500">{formatDate(j.addedAt)}</td>
                                                <td className="py-1 pr-4 font-mono text-xs text-blue-500">{j.refCode ?? '—'}</td>
                                                <td className="py-1 pr-4 text-right text-gray-700">{j.touchCount}</td>
                                                <td className="py-1 pr-4 text-right text-gray-700">{j.formCount}</td>
                                                <td className="py-1 pr-4 text-right font-semibold text-gray-900">{j.conversionCount}</td>
                                                <td className="py-1 text-gray-400 text-xs">{formatDate(j.lastEventAt)}</td>
                                              </tr>
                                            )
                                          })}
                                        </tbody>
                                      </table>
                                    </div>
                                    {journeyMore && (
                                      <button
                                        onClick={() => { void loadMoreJourneys(row.id) }}
                                        disabled={journeyLoadingMore}
                                        className="mt-3 px-4 py-2 text-sm text-blue-700 hover:bg-blue-100 disabled:opacity-50 rounded-md border border-blue-200"
                                      >
                                        {journeyLoadingMore ? '読み込み中...' : 'さらに読み込む'}
                                      </button>
                                    )}
                                  </>
                                )}
                              </div>

                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
