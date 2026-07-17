import { describe, it, expect, vi } from 'vitest';
import { extractFirstUrl, isUrlAllowed, fetchUrlContext, type UrlContextEnv } from './url-context';

const ENV: UrlContextEnv = {
  WORKER_URL: 'https://line-harness.example.workers.dev',
  WORKER_PUBLIC_URL: 'https://line-harness.example.workers.dev',
  ADMIN_PUBLIC_URL: 'https://line-harness-admin.example.pages.dev',
  LIFF_PUBLIC_URL: 'https://line-harness-liff.example.pages.dev',
};

describe('extractFirstUrl', () => {
  it('extracts the first http(s) URL from text', () => {
    expect(extractFirstUrl('見て https://example.com/page こちらです')).toBe('https://example.com/page');
    expect(extractFirstUrl('http://example.com only')).toBe('http://example.com');
  });

  it('returns null when no URL present', () => {
    expect(extractFirstUrl('こんにちは')).toBeNull();
  });

  it('picks only the first URL when multiple are present', () => {
    expect(extractFirstUrl('https://a.example.com and https://b.example.com')).toBe('https://a.example.com');
  });
});

describe('isUrlAllowed — SSRF guard', () => {
  it('allows a normal https domain', () => {
    expect(isUrlAllowed('https://example.com/article', ENV)).toBe(true);
  });

  it('allows a normal http domain', () => {
    expect(isUrlAllowed('http://example.com/article', ENV)).toBe(true);
  });

  it('rejects non-http(s) schemes', () => {
    expect(isUrlAllowed('file:///etc/passwd', ENV)).toBe(false);
    expect(isUrlAllowed('ftp://example.com/file', ENV)).toBe(false);
    expect(isUrlAllowed('data:text/html,<script>1</script>', ENV)).toBe(false);
  });

  it('rejects userinfo in URL', () => {
    expect(isUrlAllowed('https://user:pass@example.com/', ENV)).toBe(false);
  });

  it('rejects non-standard ports', () => {
    expect(isUrlAllowed('https://example.com:8080/', ENV)).toBe(false);
    expect(isUrlAllowed('http://example.com:22/', ENV)).toBe(false);
  });

  it('allows explicit standard ports', () => {
    expect(isUrlAllowed('https://example.com:443/', ENV)).toBe(true);
    expect(isUrlAllowed('http://example.com:80/', ENV)).toBe(true);
  });

  it('rejects IPv4 dot-decimal literals', () => {
    expect(isUrlAllowed('http://127.0.0.1/', ENV)).toBe(false);
    expect(isUrlAllowed('http://169.254.169.254/', ENV)).toBe(false);
    expect(isUrlAllowed('https://8.8.8.8/', ENV)).toBe(false);
  });

  it('rejects IPv4 decimal-integer obfuscation (127.0.0.1 = 2130706433)', () => {
    expect(isUrlAllowed('http://2130706433/', ENV)).toBe(false);
  });

  it('rejects IPv6 literals including localhost', () => {
    expect(isUrlAllowed('http://[::1]/', ENV)).toBe(false);
    expect(isUrlAllowed('http://[fe80::1]/', ENV)).toBe(false);
  });

  it('rejects localhost and blocked suffixes', () => {
    expect(isUrlAllowed('http://localhost/', ENV)).toBe(false);
    expect(isUrlAllowed('http://foo.local/', ENV)).toBe(false);
    expect(isUrlAllowed('http://foo.internal/', ENV)).toBe(false);
    expect(isUrlAllowed('http://foo.localhost/', ENV)).toBe(false);
  });

  it('rejects the worker/admin/liff self-hosts and their subdomains', () => {
    expect(isUrlAllowed('https://line-harness.example.workers.dev/images/x', ENV)).toBe(false);
    expect(isUrlAllowed('https://line-harness-admin.example.pages.dev/', ENV)).toBe(false);
    expect(isUrlAllowed('https://line-harness-liff.example.pages.dev/', ENV)).toBe(false);
    expect(isUrlAllowed('https://sub.line-harness.example.workers.dev/', ENV)).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(isUrlAllowed('not a url', ENV)).toBe(false);
    expect(isUrlAllowed('', ENV)).toBe(false);
  });
});

describe('fetchUrlContext', () => {
  it('returns null immediately when the URL fails the SSRF guard (no fetch performed)', async () => {
    const mockFetch = vi.fn();
    const result = await fetchUrlContext('http://127.0.0.1/secret', ENV, {
      timeoutMs: 6000,
      maxContentBytes: 512 * 1024,
      maxExtractChars: 2000,
      fetch: mockFetch,
    });
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('extracts title/OGP/body text from an html response', async () => {
    const html = `<!doctype html><html><head><title>テストページ</title>
      <meta property="og:title" content="OGタイトル">
      <meta property="og:description" content="OGの説明文">
      <style>.x{color:red}</style>
      </head><body><script>var x=1;</script><p>本文の内容です。</p></body></html>`;
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    );
    const result = await fetchUrlContext('https://example.com/page', ENV, {
      timeoutMs: 6000,
      maxContentBytes: 512 * 1024,
      maxExtractChars: 2000,
      fetch: mockFetch,
    });
    expect(result).toContain('テストページ');
    expect(result).toContain('OGタイトル');
    expect(result).toContain('OGの説明文');
    expect(result).toContain('本文の内容です');
    expect(result).not.toContain('color:red');
    expect(result).not.toContain('var x=1');
  });

  it('returns null on fetch network failure', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('network down'));
    const result = await fetchUrlContext('https://example.com/page', ENV, {
      timeoutMs: 6000,
      maxContentBytes: 512 * 1024,
      maxExtractChars: 2000,
      fetch: mockFetch,
    });
    expect(result).toBeNull();
  });

  it('returns null on non-200 response', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('not found', { status: 404 }));
    const result = await fetchUrlContext('https://example.com/missing', ENV, {
      timeoutMs: 6000,
      maxContentBytes: 512 * 1024,
      maxExtractChars: 2000,
      fetch: mockFetch,
    });
    expect(result).toBeNull();
  });

  it('returns null for unsupported content types without reading the body', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('binary', { status: 200, headers: { 'Content-Type': 'application/pdf' } }),
    );
    const result = await fetchUrlContext('https://example.com/file.pdf', ENV, {
      timeoutMs: 6000,
      maxContentBytes: 512 * 1024,
      maxExtractChars: 2000,
      fetch: mockFetch,
    });
    expect(result).toBeNull();
  });

  it('re-validates the SSRF guard on each redirect hop (public URL -> localhost is blocked)', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/admin' } }),
    );
    const result = await fetchUrlContext('https://example.com/redirect-me', ENV, {
      timeoutMs: 6000,
      maxContentBytes: 512 * 1024,
      maxExtractChars: 2000,
      fetch: mockFetch,
    });
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('follows a chain of allowed redirects (e.g. short URL services)', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { Location: 'https://example.com/final' } }))
      .mockResolvedValueOnce(
        new Response('<html><head><title>最終ページ</title></head><body><p>到達</p></body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
      );
    const result = await fetchUrlContext('https://short.example/abc', ENV, {
      timeoutMs: 6000,
      maxContentBytes: 512 * 1024,
      maxExtractChars: 2000,
      fetch: mockFetch,
    });
    expect(result).toContain('最終ページ');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('gives up after exceeding the max redirect hop count', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(null, { status: 302, headers: { Location: 'https://example.com/loop' } }),
    );
    const result = await fetchUrlContext('https://example.com/loop', ENV, {
      timeoutMs: 6000,
      maxContentBytes: 512 * 1024,
      maxExtractChars: 2000,
      fetch: mockFetch,
    });
    expect(result).toBeNull();
  });

  it('truncates extracted text to maxExtractChars', async () => {
    const longBody = 'あ'.repeat(5000);
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(`<html><body><p>${longBody}</p></body></html>`, {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );
    const result = await fetchUrlContext('https://example.com/long', ENV, {
      timeoutMs: 6000,
      maxContentBytes: 512 * 1024,
      maxExtractChars: 100,
      fetch: mockFetch,
    });
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(100);
  });

  it('rejects oversized responses declared via Content-Length', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('x', {
        status: 200,
        headers: { 'Content-Type': 'text/html', 'Content-Length': String(600 * 1024) },
      }),
    );
    const result = await fetchUrlContext('https://example.com/huge', ENV, {
      timeoutMs: 6000,
      maxContentBytes: 512 * 1024,
      maxExtractChars: 2000,
      fetch: mockFetch,
    });
    expect(result).toBeNull();
  });

  it('handles text/plain responses', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('プレーンテキストの内容', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }),
    );
    const result = await fetchUrlContext('https://example.com/notes.txt', ENV, {
      timeoutMs: 6000,
      maxContentBytes: 512 * 1024,
      maxExtractChars: 2000,
      fetch: mockFetch,
    });
    expect(result).toContain('プレーンテキストの内容');
  });
});
