import { describe, expect, it, vi, beforeEach } from 'vitest';

const callGroqVisionMock = vi.fn();
const callGeminiVisionMock = vi.fn();
vi.mock('./llm-providers.js', () => ({
  callGroqVision: (...args: unknown[]) => callGroqVisionMock(...args),
  callGeminiVision: (...args: unknown[]) => callGeminiVisionMock(...args),
}));

const { describeImage } = await import('./vision-describe.js');

const SMALL_IMAGE = new ArrayBuffer(1024); // 1KB, well under the 3MB data-URI cutoff
const LARGE_IMAGE = new ArrayBuffer(4 * 1024 * 1024); // 4MB, over the cutoff

const twoStageChain = [
  { provider: 'groq' as const, model: 'qwen/qwen3.6-27b', timeoutMs: 10000 },
  { provider: 'gemini' as const, model: 'gemini-2.5-flash-lite', timeoutMs: 10000 },
];

const baseParams = {
  bytes: SMALL_IMAGE,
  contentType: 'image/jpeg',
  vision: { enabled: true, chain: twoStageChain, maxDescriptionTokens: 250 },
  groqApiKey: 'gsk-test',
  geminiApiKey: 'gemini-test',
  receivedAt: Date.now(),
};

describe('describeImage', () => {
  beforeEach(() => {
    callGroqVisionMock.mockReset();
    callGeminiVisionMock.mockReset();
  });

  it('returns null immediately when vision is disabled (no calls made)', async () => {
    const result = await describeImage({ ...baseParams, vision: { ...baseParams.vision, enabled: false } });
    expect(result).toBeNull();
    expect(callGroqVisionMock).not.toHaveBeenCalled();
    expect(callGeminiVisionMock).not.toHaveBeenCalled();
  });

  it('returns the first stage result when Groq succeeds', async () => {
    callGroqVisionMock.mockResolvedValue('猫が写っています。');
    const result = await describeImage(baseParams);
    expect(result).toBe('猫が写っています。');
    expect(callGroqVisionMock).toHaveBeenCalledTimes(1);
    expect(callGeminiVisionMock).not.toHaveBeenCalled();
  });

  it('falls back to Gemini when Groq returns null', async () => {
    callGroqVisionMock.mockResolvedValue(null);
    callGeminiVisionMock.mockResolvedValue('犬が写っています。');
    const result = await describeImage(baseParams);
    expect(result).toBe('犬が写っています。');
    expect(callGroqVisionMock).toHaveBeenCalledTimes(1);
    expect(callGeminiVisionMock).toHaveBeenCalledTimes(1);
  });

  it('returns null (fail-closed) when the entire chain fails', async () => {
    callGroqVisionMock.mockResolvedValue(null);
    callGeminiVisionMock.mockResolvedValue(null);
    const result = await describeImage(baseParams);
    expect(result).toBeNull();
  });

  it('skips a stage with no matching API key', async () => {
    callGeminiVisionMock.mockResolvedValue('説明文');
    const result = await describeImage({ ...baseParams, groqApiKey: undefined });
    expect(result).toBe('説明文');
    expect(callGroqVisionMock).not.toHaveBeenCalled();
    expect(callGeminiVisionMock).toHaveBeenCalledTimes(1);
  });

  it('skips a stage when remaining time is under its timeout + margin', async () => {
    // deadline = 45000ms. receivedAt 36000ms ago -> remaining ~9000ms.
    // groq stage timeoutMs=10000 + 15000 margin = 25000 > 9000 -> skip groq.
    // gemini stage same threshold -> also skipped -> overall null without calling either.
    callGeminiVisionMock.mockResolvedValue('should not be reached');
    const receivedAt = Date.now() - 36_000;
    const result = await describeImage({ ...baseParams, receivedAt });
    expect(result).toBeNull();
    expect(callGroqVisionMock).not.toHaveBeenCalled();
    expect(callGeminiVisionMock).not.toHaveBeenCalled();
  });

  it('uses a data URI for images at or under the 3MB cutoff', async () => {
    callGroqVisionMock.mockResolvedValue('説明');
    await describeImage(baseParams);
    const [, , callParams] = callGroqVisionMock.mock.calls[0];
    expect(callParams.imageUrl).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('falls back to the public URL for images over the 3MB cutoff', async () => {
    callGroqVisionMock.mockResolvedValue('説明');
    await describeImage({
      ...baseParams,
      bytes: LARGE_IMAGE,
      publicImageUrl: 'https://worker.example.workers.dev/images/abc.jpg',
    });
    const [, , callParams] = callGroqVisionMock.mock.calls[0];
    expect(callParams.imageUrl).toBe('https://worker.example.workers.dev/images/abc.jpg');
  });

  it('fails closed for oversized images with no reachable public URL (e.g. local dev)', async () => {
    const result = await describeImage({
      ...baseParams,
      bytes: LARGE_IMAGE,
      publicImageUrl: 'http://localhost:8787/images/abc.jpg',
      publicUrlUnreachable: true,
    });
    expect(result).toBeNull();
    expect(callGroqVisionMock).not.toHaveBeenCalled();
  });

  it('fails closed for oversized images with no public URL at all', async () => {
    const result = await describeImage({ ...baseParams, bytes: LARGE_IMAGE });
    expect(result).toBeNull();
    expect(callGroqVisionMock).not.toHaveBeenCalled();
  });

  it('never sends the chain to workers-ai even if configured (guarded by type, defensively skipped at runtime)', async () => {
    callGeminiVisionMock.mockResolvedValue('gemini結果');
    const chainWithBogusStage = [
      { provider: 'workers-ai' as unknown as 'groq', model: 'whatever', timeoutMs: 5000 },
      { provider: 'gemini' as const, model: 'gemini-2.5-flash-lite', timeoutMs: 10000 },
    ];
    const result = await describeImage({
      ...baseParams,
      vision: { enabled: true, chain: chainWithBogusStage, maxDescriptionTokens: 250 },
    });
    expect(result).toBe('gemini結果');
    expect(callGroqVisionMock).not.toHaveBeenCalled();
  });
});
