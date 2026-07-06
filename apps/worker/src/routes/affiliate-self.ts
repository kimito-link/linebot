import { Hono, type Context } from 'hono';
import {
  getFriendByLineUserId,
  getAffiliateByFriendId,
  createAffiliate,
  createAffiliateLink,
  listAffiliateLinks,
  countAffiliateLinks,
  generateRefSlug,
  getLineAccounts,
  getAffiliateLinkStats,
  type Affiliate,
  type AffiliateLink,
  type AffiliateLinkStat,
} from '@line-crm/db';
import { resolveLinkBaseUrl } from '../lib/link-base-url.js';
import type { Env } from '../index.js';

/**
 * Self-serve affiliate API for LIFF clients.
 *
 * Auth boundary: these endpoints are authenticated ONLY by a LINE access token
 * that the LIFF SDK obtains client-side. The token is verified against LINE's
 * OAuth2 + profile endpoints server-side; the resulting LINE userId is resolved
 * to a friend row, and the affiliate is resolved from THAT friend. Clients never
 * pass an affiliate_id — it is always derived server-side from the verified
 * token, so one affiliate can never read or mutate another's data.
 *
 * authMiddleware skips `/api/liff/*` (staff auth), so verification lives here.
 */
const affiliateSelfRoutes = new Hono<Env>();

/** Max self-issued links per affiliate. The 21st issuance is a 400. */
const MAX_SELF_LINKS = 20;

type ResolvedFriend = { id: string; display_name: string };

/**
 * Verify a LINE access token and resolve the backing friend row.
 *
 * Returns a discriminated result so callers can pick the right HTTP status in
 * a single pass:
 *   - 'invalid_token' → 401 (token could not be verified against LINE)
 *   - 'no_friend'     → 404 (token verified, but no friend row exists)
 *   - 'ok'            → proceed with the resolved friend
 */
async function resolveFriendFromLineToken(
  env: Env['Bindings'],
  accessToken: string,
): Promise<
  | { status: 'invalid_token' }
  | { status: 'no_friend' }
  | { status: 'ok'; friend: ResolvedFriend }
> {
  const db = env.DB;
  const v = await fetch(
    'https://api.line.me/oauth2/v2.1/verify?access_token=' +
      encodeURIComponent(accessToken),
  );
  if (!v.ok) return { status: 'invalid_token' };

  // The verify response carries the LINE Login channel (`client_id`) that
  // minted this token. Reject any token issued by a channel this deployment
  // does not own — otherwise a token from an unrelated LINE Login app whose
  // user happens to share a lineUserId could impersonate an affiliate.
  // Allowed channels = env default + every DB account's login channel, mirroring
  // the multi-account verification pattern in liff.ts.
  const verifyBody = await v
    .json<{ client_id?: string }>()
    .catch((): { client_id?: string } => ({}));
  const tokenClientId = verifyBody.client_id;
  if (!tokenClientId) return { status: 'invalid_token' };

  const allowedChannelIds = new Set<string>();
  if (env.LINE_LOGIN_CHANNEL_ID) allowedChannelIds.add(env.LINE_LOGIN_CHANNEL_ID);
  const dbAccounts = await getLineAccounts(db);
  for (const acct of dbAccounts) {
    if (acct.login_channel_id) allowedChannelIds.add(acct.login_channel_id);
  }
  if (!allowedChannelIds.has(tokenClientId)) return { status: 'invalid_token' };

  const prof = await fetch('https://api.line.me/v2/profile', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!prof.ok) return { status: 'invalid_token' };

  const { userId } = await prof.json<{ userId: string }>();
  if (!userId) return { status: 'invalid_token' };

  const friend = await getFriendByLineUserId(db, userId);
  if (!friend) return { status: 'no_friend' };
  return { status: 'ok', friend: friend as unknown as ResolvedFriend };
}

/** Map a non-ok resolution to its JSON error response. */
function unresolvedResponse(
  c: Context<Env>,
  result: { status: 'invalid_token' } | { status: 'no_friend' },
) {
  if (result.status === 'invalid_token') {
    return c.json({ success: false, error: 'Invalid LINE access token' }, 401);
  }
  return c.json({ success: false, error: 'Friend not found' }, 404);
}

/**
 * Shape each affiliate link into the client-facing row. `stats` maps ref_code →
 * per-link counters (getAffiliateLinkStats). A link absent from the map (e.g. a
 * freshly issued link with no activity yet) defaults to zeros.
 */
function serializeLink(
  link: AffiliateLink,
  baseUrl: string,
  stats?: Map<string, AffiliateLinkStat>,
) {
  const s = stats?.get(link.ref_code);
  return {
    refCode: link.ref_code,
    label: link.label,
    url: `${baseUrl}/${link.ref_code}`,
    clickCount: link.click_count,
    friendAdds: s?.friendAdds ?? 0,
    conversions: s?.conversions ?? 0,
  };
}

function serializeAffiliate(aff: Affiliate) {
  return {
    id: aff.id,
    name: aff.name,
    code: aff.code,
    commissionRate: aff.commission_rate,
    isActive: Boolean(aff.is_active),
    friendId: aff.friend_id,
  };
}

/**
 * POST /api/liff/affiliate/register — idempotent self-registration.
 * Body: { lineAccessToken }. If already registered, returns the existing
 * affiliate + links. On first registration, auto-issues one link.
 */
affiliateSelfRoutes.post('/api/liff/affiliate/register', async (c) => {
  try {
    const body = await c.req
      .json<{ lineAccessToken?: string }>()
      .catch((): { lineAccessToken?: string } => ({}));
    const token = body.lineAccessToken;
    if (!token) {
      return c.json({ success: false, error: 'lineAccessToken is required' }, 400);
    }

    const db = c.env.DB;
    const resolved = await resolveFriendFromLineToken(c.env, token);
    if (resolved.status !== 'ok') {
      return unresolvedResponse(c, resolved);
    }
    const friend = resolved.friend;

    const existing = await getAffiliateByFriendId(db, friend.id);
    if (existing) {
      const links = await listAffiliateLinks(db, existing.id);
      const baseUrl = await resolveLinkBaseUrl(db, c.env);
      const stats = await getAffiliateLinkStats(db, existing.id);
      return c.json({
        affiliate: serializeAffiliate(existing),
        links: links.map((l) => serializeLink(l, baseUrl, stats)),
      });
    }

    let affiliate: Affiliate;
    try {
      affiliate = await createAffiliate(db, {
        name: friend.display_name || 'Affiliate',
        code: generateRefSlug(),
        friendId: friend.id,
      });
    } catch (createErr) {
      // Concurrent double-register: two requests both passed the getAffiliateBy-
      // FriendId check, then raced the INSERT. The UNIQUE(friend_id) index makes
      // the loser throw — recover by returning the winner's row so register stays
      // idempotent even under a race. Re-throw anything that isn't the expected
      // uniqueness collision.
      const raced = await getAffiliateByFriendId(db, friend.id);
      if (!raced) throw createErr;
      const links = await listAffiliateLinks(db, raced.id);
      const baseUrl = await resolveLinkBaseUrl(db, c.env);
      const stats = await getAffiliateLinkStats(db, raced.id);
      return c.json({
        affiliate: serializeAffiliate(raced),
        links: links.map((l) => serializeLink(l, baseUrl, stats)),
      });
    }
    // Auto-issue the first link on registration.
    const firstLink = await createAffiliateLink(db, { affiliateId: affiliate.id });
    const baseUrl = await resolveLinkBaseUrl(db, c.env);
    return c.json({
      affiliate: serializeAffiliate(affiliate),
      links: [serializeLink(firstLink, baseUrl)],
    });
  } catch (err) {
    console.error('POST /api/liff/affiliate/register error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/liff/affiliate/me?lineAccessToken= — return the caller's affiliate
 * profile + links. 404 if the caller is a friend but not yet registered.
 */
affiliateSelfRoutes.get('/api/liff/affiliate/me', async (c) => {
  try {
    const token = c.req.query('lineAccessToken');
    if (!token) {
      return c.json({ success: false, error: 'lineAccessToken is required' }, 400);
    }

    const db = c.env.DB;
    const resolved = await resolveFriendFromLineToken(c.env, token);
    if (resolved.status !== 'ok') {
      return unresolvedResponse(c, resolved);
    }
    const friend = resolved.friend;

    const affiliate = await getAffiliateByFriendId(db, friend.id);
    if (!affiliate) {
      return c.json({ success: false, error: 'Not registered as an affiliate' }, 404);
    }

    const links = await listAffiliateLinks(db, affiliate.id);
    const baseUrl = await resolveLinkBaseUrl(db, c.env);
    const stats = await getAffiliateLinkStats(db, affiliate.id);
    return c.json({
      affiliate: serializeAffiliate(affiliate),
      links: links.map((l) => serializeLink(l, baseUrl, stats)),
    });
  } catch (err) {
    console.error('GET /api/liff/affiliate/me error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/liff/affiliate/links — issue a new self-serve link.
 * Body: { lineAccessToken, label? }. Enforces the 20-link cap (21st → 400).
 */
affiliateSelfRoutes.post('/api/liff/affiliate/links', async (c) => {
  try {
    const body = await c.req
      .json<{ lineAccessToken?: string; label?: string | null }>()
      .catch((): { lineAccessToken?: string; label?: string | null } => ({}));
    const token = body.lineAccessToken;
    if (!token) {
      return c.json({ success: false, error: 'lineAccessToken is required' }, 400);
    }

    const db = c.env.DB;
    const resolved = await resolveFriendFromLineToken(c.env, token);
    if (resolved.status !== 'ok') {
      return unresolvedResponse(c, resolved);
    }
    const friend = resolved.friend;

    const affiliate = await getAffiliateByFriendId(db, friend.id);
    if (!affiliate) {
      return c.json({ success: false, error: 'Not registered as an affiliate' }, 404);
    }

    const count = await countAffiliateLinks(db, affiliate.id);
    if (count >= MAX_SELF_LINKS) {
      return c.json(
        { success: false, error: `Link limit reached (max ${MAX_SELF_LINKS})` },
        400,
      );
    }

    const label = typeof body.label === 'string' ? body.label : null;
    const link = await createAffiliateLink(db, { affiliateId: affiliate.id, label });
    const baseUrl = await resolveLinkBaseUrl(db, c.env);
    return c.json({ link: serializeLink(link, baseUrl) });
  } catch (err) {
    console.error('POST /api/liff/affiliate/links error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { affiliateSelfRoutes };
