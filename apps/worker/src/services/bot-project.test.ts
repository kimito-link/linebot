import { describe, expect, it, vi, beforeEach } from 'vitest';
import { resolveBotProject } from './bot-project.js';

vi.mock('@line-crm/db', () => ({
  getEntryRouteByRefCode: vi.fn(),
  getLineAccountById: vi.fn(),
}));

vi.mock('./groq-config.js', () => ({
  getBotConfig: () => ({ defaultProject: 'ai-shain-link' }),
  isKnownProject: (project: string) => ['ai-shain-link', 'soushin-suggest', 'henshin-hisho', 'yukkuri-exosome'].includes(project),
}));

const { getEntryRouteByRefCode, getLineAccountById } = await import('@line-crm/db');

beforeEach(() => {
  vi.mocked(getLineAccountById).mockReset();
  vi.mocked(getLineAccountById).mockResolvedValue(null);
});

describe('resolveBotProject', () => {
  it('falls back to defaultProject when friend has no ref_code', async () => {
    const project = await resolveBotProject({} as D1Database, { ref_code: null });
    expect(project).toBe('ai-shain-link');
  });

  it('falls back to defaultProject when entry_routes has no matching row', async () => {
    vi.mocked(getEntryRouteByRefCode).mockResolvedValueOnce(null);
    const project = await resolveBotProject({} as D1Database, { ref_code: 'unknown-ref' });
    expect(project).toBe('ai-shain-link');
  });

  it('falls back to defaultProject when entry_routes row has project=NULL', async () => {
    vi.mocked(getEntryRouteByRefCode).mockResolvedValueOnce({ ref_code: 'legacy-ref', project: null } as any);
    const project = await resolveBotProject({} as D1Database, { ref_code: 'legacy-ref' });
    expect(project).toBe('ai-shain-link');
  });

  it('falls back to defaultProject when project is not registered in bot.config.json', async () => {
    vi.mocked(getEntryRouteByRefCode).mockResolvedValueOnce({ ref_code: 'x', project: 'unknown-product' } as any);
    const project = await resolveBotProject({} as D1Database, { ref_code: 'x' });
    expect(project).toBe('ai-shain-link');
  });

  it('resolves to henshin-hisho when ref_code maps to it', async () => {
    vi.mocked(getEntryRouteByRefCode).mockResolvedValueOnce({ ref_code: 'hh-lp', project: 'henshin-hisho' } as any);
    const project = await resolveBotProject({} as D1Database, { ref_code: 'hh-lp' });
    expect(project).toBe('henshin-hisho');
  });

  it('falls back to line_accounts.default_project when friend has no ref_code', async () => {
    vi.mocked(getLineAccountById).mockResolvedValueOnce({ id: 'acc-1', default_project: 'yukkuri-exosome' } as any);
    const project = await resolveBotProject({} as D1Database, { ref_code: null, line_account_id: 'acc-1' });
    expect(project).toBe('yukkuri-exosome');
  });

  it('falls back to line_accounts.default_project when ref_code resolves to no project', async () => {
    vi.mocked(getEntryRouteByRefCode).mockResolvedValueOnce(null);
    vi.mocked(getLineAccountById).mockResolvedValueOnce({ id: 'acc-1', default_project: 'yukkuri-exosome' } as any);
    const project = await resolveBotProject({} as D1Database, { ref_code: 'unknown-ref', line_account_id: 'acc-1' });
    expect(project).toBe('yukkuri-exosome');
  });

  it('falls back to global defaultProject when line_accounts.default_project is unknown', async () => {
    vi.mocked(getLineAccountById).mockResolvedValueOnce({ id: 'acc-1', default_project: 'unknown-product' } as any);
    const project = await resolveBotProject({} as D1Database, { ref_code: null, line_account_id: 'acc-1' });
    expect(project).toBe('ai-shain-link');
  });

  it('falls back to global defaultProject when line_account_id is absent', async () => {
    const project = await resolveBotProject({} as D1Database, { ref_code: null, line_account_id: null });
    expect(project).toBe('ai-shain-link');
  });

  it('prefers ref_code project over line_accounts.default_project', async () => {
    vi.mocked(getEntryRouteByRefCode).mockResolvedValueOnce({ ref_code: 'hh-lp', project: 'henshin-hisho' } as any);
    const project = await resolveBotProject({} as D1Database, { ref_code: 'hh-lp', line_account_id: 'acc-1' });
    expect(project).toBe('henshin-hisho');
    expect(getLineAccountById).not.toHaveBeenCalled();
  });
});
