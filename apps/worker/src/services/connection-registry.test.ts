import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CONNECTIONS, buildConnectionStates } from './connection-registry.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX_TS = path.resolve(here, '../index.ts');

/**
 * Env型に宣言されているキー名を、実ファイルから抜き出す。
 *
 * ここが「100年後に楽できる」仕掛けの本体。接続を足したのに
 * connection-registry.ts へ書き忘れる（またはその逆）と、このテストが落ちて
 * 教えてくれる。人が突き合わせを覚えておく必要がない。
 */
function extractEnvKeys(): Set<string> {
  const src = readFileSync(INDEX_TS, 'utf8');
  const start = src.indexOf('Bindings: {');
  if (start === -1) throw new Error('index.ts に Bindings ブロックが見つからない');

  // Bindings ブロックの終端（対応する閉じ括弧）を探す
  let depth = 0;
  let end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) throw new Error('Bindings ブロックの終端が見つからない');

  const block = src.slice(start, end);
  const keys = new Set<string>();
  // `KEY: type;` / `KEY?: type;` の形を拾う（コメント行は : の前に // があるので除外）
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    const m = trimmed.match(/^([A-Z][A-Z0-9_]*)\??\s*:/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

describe('接続レジストリ — 定義の健全性', () => {
  test('idが重複していない（画面のキーに使うので一意である必要がある）', () => {
    const ids = CONNECTIONS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('envKeysが空の接続がない', () => {
    for (const c of CONNECTIONS) {
      expect(c.envKeys.length, `${c.id} の envKeys が空`).toBeGreaterThan(0);
    }
  });

  test('whenMissing が書かれている（未設定時に何が起きるかを画面に出すため）', () => {
    for (const c of CONNECTIONS) {
      expect(c.whenMissing.trim().length, `${c.id} の whenMissing が空`).toBeGreaterThan(0);
    }
  });
});

describe('接続レジストリ — Env型とのズレ検出', () => {
  // これが落ちたときの直し方:
  //   (a) Envに足したのにレジストリに書いていない → connection-registry.ts に追記
  //   (b) レジストリにあるがEnvに無い → キー名のtypo、またはEnvへの宣言漏れ
  test('レジストリのenvKeysは全てEnv型に宣言されている', () => {
    const envKeys = extractEnvKeys();
    const unknown: string[] = [];
    for (const c of CONNECTIONS) {
      for (const k of c.envKeys) {
        if (!envKeys.has(k)) unknown.push(`${c.id} → ${k}`);
      }
    }
    expect(unknown, `Env型に無いキーを参照している: ${unknown.join(', ')}`).toEqual([]);
  });

  test('外部サービスに繋がるEnvキーは、いずれかの接続に登録されている', () => {
    const envKeys = extractEnvKeys();
    const registered = new Set(CONNECTIONS.flatMap((c) => c.envKeys));

    // 接続ではないもの（認証・表示設定・デプロイ先の名前など）は対象外。
    // ここに足すのは「外部と通信しないキー」だけにすること。
    const NOT_A_CONNECTION = new Set([
      'API_KEY', 'LEGACY_API_KEY',            // 管理APIの認証
      'ADMIN_ORIGIN', 'ADMIN_COOKIE_SAMESITE', 'ADMIN_ALLOW_CROSS_SITE', // CORS/Cookie
      'ASSETS',                                // 静的配信バインディング
      'LINE_CHANNEL_ID',                       // 識別子（通信には使わない）
      'WORKER_URL', 'WORKER_PUBLIC_URL', 'ADMIN_PUBLIC_URL', 'LIFF_PUBLIC_URL', // 自分のURL
      'WORKER_NAME', 'ADMIN_PAGES_PROJECT', 'LIFF_PAGES_PROJECT', 'D1_DATABASE_ID', // デプロイ先の名前
      'MANIFEST_URL',                          // 公開URL（認証不要）
      'VOICE_SYNTH_TIMEOUT_MS', 'VOICE_CHARACTER', // 音声のチューニング値
    ]);

    const orphans = [...envKeys].filter(
      (k) => !registered.has(k) && !NOT_A_CONNECTION.has(k),
    );
    expect(
      orphans,
      `接続レジストリにもNOT_A_CONNECTIONにも無いキー: ${orphans.join(', ')}\n` +
        '→ 外部接続なら CONNECTIONS に足す。そうでないなら NOT_A_CONNECTION に足す。',
    ).toEqual([]);
  });
});

describe('buildConnectionStates', () => {
  test('必要なキーが揃っていれば configured=true / status=unverified', () => {
    // 設定済みでも「疎通は確認していない」ので ok にはしない
    const states = buildConnectionStates({ GROQ_API_KEY: 'gsk-xxx' });
    const groq = states.find((s) => s.id === 'llm-groq')!;
    expect(groq.configured).toBe(true);
    expect(groq.status).toBe('unverified');
    expect(groq.missingKeys).toEqual([]);
  });

  test('キーが欠けていれば configured=false / status=unconfigured', () => {
    const states = buildConnectionStates({});
    const groq = states.find((s) => s.id === 'llm-groq')!;
    expect(groq.configured).toBe(false);
    expect(groq.status).toBe('unconfigured');
    expect(groq.missingKeys).toEqual(['GROQ_API_KEY']);
  });

  test('複数キーのうち一部だけ設定されていても configured=false', () => {
    const states = buildConnectionStates({ VOICE_SYNTH_ENDPOINT: 'https://x.example' });
    const voice = states.find((s) => s.id === 'voice-synth')!;
    expect(voice.configured).toBe(false);
    expect(voice.missingKeys).toEqual(['VOICE_SYNTH_TOKEN']);
  });

  test('空文字は未設定として扱う（wrangler secretに空を入れた事故を拾う）', () => {
    const states = buildConnectionStates({ GROQ_API_KEY: '   ' });
    const groq = states.find((s) => s.id === 'llm-groq')!;
    expect(groq.configured).toBe(false);
  });

  test('シークレットの値そのものを含まない（漏洩防止）', () => {
    const SECRET = 'gsk-super-secret-value-12345';
    const states = buildConnectionStates({
      GROQ_API_KEY: SECRET,
      LINE_CHANNEL_ACCESS_TOKEN: SECRET,
      VOICE_SYNTH_TOKEN: SECRET,
    });
    // 状態オブジェクト全体をJSONにしても値が出てこないこと
    expect(JSON.stringify(states)).not.toContain(SECRET);
  });

  test('全接続について状態が返る（数が一致する）', () => {
    expect(buildConnectionStates({}).length).toBe(CONNECTIONS.length);
  });
});
