import { getEntryRouteByRefCode, getLineAccountById } from '@line-crm/db';
import { getBotConfig, isKnownProject } from './groq-config.js';

/**
 * Resolves which product's knowledge pack a friend's messages should use.
 *
 * Fail-closed at every step: any missing/unknown data falls back to the
 * configured default project, never throws, never guesses via LLM.
 *
 *   1. friend has ref_code with a known entry_routes.project -> that project
 *   2. otherwise, friend's line_accounts.default_project (if set & known)   -> that project
 *   3. otherwise                                                            -> bot.config.json defaultProject
 *
 * Step 2 exists for accounts whose friends mostly arrive without a ref_code
 * (direct QR/friend-add on a dedicated official account, e.g. the standalone
 * "ゆっくりエクソソーム" @871xstqy channel) — without it every such friend would
 * silently fall back to the global defaultProject (ai-shain-link).
 */
export async function resolveBotProject(
  db: D1Database,
  friend: { ref_code?: string | null; line_account_id?: string | null },
): Promise<string> {
  const { defaultProject } = getBotConfig();

  if (friend.ref_code) {
    const route = await getEntryRouteByRefCode(db, friend.ref_code);
    if (route?.project) {
      if (isKnownProject(route.project)) return route.project;
      console.warn(`resolveBotProject: unknown project "${route.project}" for ref_code "${friend.ref_code}", falling back`);
    }
  }

  if (friend.line_account_id) {
    const account = await getLineAccountById(db, friend.line_account_id);
    if (account?.default_project) {
      if (isKnownProject(account.default_project)) return account.default_project;
      console.warn(`resolveBotProject: unknown default_project "${account.default_project}" for line_account_id "${friend.line_account_id}", falling back to default`);
    }
  }

  return defaultProject;
}
