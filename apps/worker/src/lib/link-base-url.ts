import { getLinkBaseUrl } from '@line-crm/db';

/**
 * Resolve the base URL used to build affiliate link click URLs.
 *
 * Priority:
 *  1. DB-configured `link_base_url` global setting (stored under the sentinel
 *     accountId `'__global__'`).  This is what operators fill in when they set
 *     up a custom short domain, e.g. "https://go.example.com".
 *  2. Fallback: `<WORKER_URL>/r` — the built-in redirect route.
 *
 * URL contract for callers:
 *   The returned string is a *base* — append `/<slug>` to form the full URL:
 *     `${base}/${link.ref_code}`
 *
 *   Whether the base already includes "/r" depends on which branch was taken:
 *   - Fallback path: includes "/r"  → `https://worker.example.com/r/<slug>`
 *   - Custom domain: does NOT include "/r" by default (the operator configures
 *     whatever path prefix they want, and sets up a Redirect Rule accordingly).
 *     Example with no path: `https://go.example.com/<slug>`
 *   Callers must not add an extra "/r" segment — the base is authoritative.
 *
 * Fails fast if WORKER_URL is empty/undefined and no DB setting is found: this
 * repo forbids a localhost fallback, and silently emitting a base-less URL would
 * bake broken affiliate links into client responses.
 */
export async function resolveLinkBaseUrl(
  db: D1Database,
  env: { WORKER_URL?: string },
): Promise<string> {
  const stored = await getLinkBaseUrl(db, '__global__');
  if (stored) {
    // Already normalised (no trailing slash) by setLinkBaseUrl.
    return stored;
  }

  const workerUrl = env.WORKER_URL?.trim();
  if (!workerUrl) {
    throw new Error(
      'WORKER_URL is not configured; cannot resolve affiliate link base URL',
    );
  }
  return workerUrl.replace(/\/$/, '') + '/r';
}
