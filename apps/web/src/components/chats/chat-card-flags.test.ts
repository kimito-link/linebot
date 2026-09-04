import { describe, it, expect } from 'vitest'
import {
  deriveCardFlags,
  previewLabel,
  formatElapsed,
  expandTemplateForChat,
} from './chat-card-flags'

const chat = (id: string, status: 'unread' | 'in_progress' | 'resolved' = 'unread') => ({ id, status })

describe('deriveCardFlags', () => {
  it('未返信のときは accent が red（human より優先される）', () => {
    const f = deriveCardFlags(chat('a'), new Set(['a']), 'human')
    expect(f.unanswered).toBe(true)
    expect(f.humanMode).toBe(true)
    expect(f.accent).toBe('red')
  })

  it('未返信でなく human のときは amber', () => {
    const f = deriveCardFlags(chat('a'), new Set(), 'human')
    expect(f.unanswered).toBe(false)
    expect(f.accent).toBe('amber')
  })

  it('未返信でも human でもなければアクセントなし', () => {
    expect(deriveCardFlags(chat('a'), new Set(), 'bot').accent).toBe('none')
  })

  it('★aiReplyMode 未取得は null。false（Botが返す）と区別する', () => {
    const f = deriveCardFlags(chat('a'), new Set(), undefined)
    expect(f.humanMode).toBeNull()
    // null は amber を出さない（不明なものを断定して色を付けない）
    expect(f.accent).toBe('none')
  })

  it('status はそのまま持ち回る', () => {
    expect(deriveCardFlags(chat('a', 'resolved'), new Set(), 'bot').status).toBe('resolved')
  })

  it('未返信の判定は id の一致で行う（別idに引きずられない）', () => {
    expect(deriveCardFlags(chat('a'), new Set(['b']), 'bot').unanswered).toBe(false)
  })
})

describe('previewLabel', () => {
  it('テキストは改行を潰して60字までにする', () => {
    expect(previewLabel({ lastMessageContent: 'あ\n\nい', lastMessageType: 'text' })).toBe('あ い')
    expect(previewLabel({ lastMessageContent: 'x'.repeat(80), lastMessageType: 'text' })).toHaveLength(60)
  })

  it('本文を出しても意味の薄い種類は表記に置き換える', () => {
    expect(previewLabel({ lastMessageType: 'image' })).toBe('📷 画像')
    expect(previewLabel({ lastMessageType: 'flex' })).toBe('📋 Flexメッセージ')
    expect(previewLabel({ lastMessageType: 'sticker' })).toBe('🎨 スタンプ')
  })

  it('本文が無くても落ちない', () => {
    expect(previewLabel({})).toBe('')
    expect(previewLabel({ lastMessageContent: null, lastMessageType: null })).toBe('')
  })
})

describe('formatElapsed', () => {
  const base = new Date('2026-09-04T12:00:00Z').getTime()
  const at = (iso: string) => formatElapsed(iso, base)

  it('分・時間・日で切り替わる', () => {
    expect(at('2026-09-04T11:59:30Z')).toBe('たった今')
    expect(at('2026-09-04T11:30:00Z')).toBe('30分前')
    expect(at('2026-09-04T09:00:00Z')).toBe('3時間前')
    expect(at('2026-09-02T12:00:00Z')).toBe('2日前')
  })

  it('未来の時刻でも壊れない（時計ずれ）', () => {
    expect(at('2026-09-04T12:05:00Z')).toBe('たった今')
  })

  it('壊れた日付は空文字（NaN分前 と出さない）', () => {
    expect(at('not-a-date')).toBe('')
  })
})

describe('expandTemplateForChat', () => {
  const to = { friendName: '山田 太郎' }

  it('{{name}} を相手の名前に置き換える', () => {
    const r = expandTemplateForChat({ messageType: 'text', messageContent: '{{name}}さん、こんにちは' }, to)
    expect(r).toEqual({ ok: true, messageType: 'text', content: '山田 太郎さん、こんにちは' })
  })

  it('★展開できない変数が残ったら送らせない', () => {
    const r = expandTemplateForChat({ messageType: 'text', messageContent: '{{name}}様 {{uid}}' }, to)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('unresolved_vars')
      expect(r.unresolved).toEqual(['{{uid}}'])
    }
  })

  it('同じ未対応変数が複数あっても重複して並べない', () => {
    const r = expandTemplateForChat({ messageType: 'text', messageContent: '{{uid}}{{uid}}' }, to)
    if (!r.ok) expect(r.unresolved).toEqual(['{{uid}}'])
  })

  it('★carousel は送れないので弾く（send が対応していない）', () => {
    const r = expandTemplateForChat({ messageType: 'carousel', messageContent: '[]' }, to)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('unsupported_type')
  })

  it('flex の壊れた JSON は送信前に止める', () => {
    const r = expandTemplateForChat({ messageType: 'flex', messageContent: '{壊れ' }, to)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('invalid_json')
  })

  it('image の JSON はそのまま通る', () => {
    const content = JSON.stringify({ originalContentUrl: 'https://e/x.png', previewImageUrl: 'https://e/p.png' })
    const r = expandTemplateForChat({ messageType: 'image', messageContent: content }, to)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.content).toBe(content)
  })

  it('flex の中の {{name}} も展開される', () => {
    const r = expandTemplateForChat(
      { messageType: 'flex', messageContent: '{"type":"text","text":"{{name}}様"}' },
      to,
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.content).toContain('山田 太郎様')
  })
})
