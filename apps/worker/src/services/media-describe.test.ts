import { describe, expect, it, vi, beforeEach } from 'vitest';

const callGeminiVideoMock = vi.fn();
const callGeminiAudioMock = vi.fn();
vi.mock('./llm-providers.js', () => ({
  callGeminiVideo: (...args: unknown[]) => callGeminiVideoMock(...args),
  callGeminiAudio: (...args: unknown[]) => callGeminiAudioMock(...args),
}));

const { describeVideo, describeAudio } = await import('./media-describe.js');

const SMALL_VIDEO = new ArrayBuffer(1024); // 1KB
const LARGE_VIDEO = new ArrayBuffer(16 * 1024 * 1024); // 16MB, over the 15MB default cutoff

const baseVideoConfig = { enabled: true, model: 'gemini-2.5-flash-lite', timeoutMs: 15000, maxDescriptionTokens: 250, maxInputBytes: 15 * 1024 * 1024 };

const baseVideoParams = {
  bytes: SMALL_VIDEO,
  contentType: 'video/mp4',
  config: baseVideoConfig,
  geminiApiKey: 'gemini-test',
  receivedAt: Date.now(),
};

describe('describeVideo', () => {
  beforeEach(() => {
    callGeminiVideoMock.mockReset();
  });

  it('returns null immediately when disabled (no calls made)', async () => {
    const result = await describeVideo({ ...baseVideoParams, config: { ...baseVideoConfig, enabled: false } });
    expect(result).toBeNull();
    expect(callGeminiVideoMock).not.toHaveBeenCalled();
  });

  it('returns null immediately when geminiApiKey is missing', async () => {
    const result = await describeVideo({ ...baseVideoParams, geminiApiKey: undefined });
    expect(result).toBeNull();
    expect(callGeminiVideoMock).not.toHaveBeenCalled();
  });

  it('calls callGeminiVideo and returns its result on success', async () => {
    callGeminiVideoMock.mockResolvedValue({ ok: true, text: '猫が歩いている動画です。' });
    const result = await describeVideo(baseVideoParams);
    expect(result).toBe('猫が歩いている動画です。');
    expect(callGeminiVideoMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed (no call) for videos over maxInputBytes', async () => {
    const result = await describeVideo({ ...baseVideoParams, bytes: LARGE_VIDEO });
    expect(result).toBeNull();
    expect(callGeminiVideoMock).not.toHaveBeenCalled();
  });

  it('returns null (fail-closed) when the API call fails with a non-503 error', async () => {
    callGeminiVideoMock.mockResolvedValue({ ok: false, reason: 'http', status: 500 });
    const result = await describeVideo(baseVideoParams);
    expect(result).toBeNull();
    expect(callGeminiVideoMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 429 (rate limit)', async () => {
    callGeminiVideoMock.mockResolvedValue({ ok: false, reason: 'http', status: 429 });
    const result = await describeVideo(baseVideoParams);
    expect(result).toBeNull();
    expect(callGeminiVideoMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry on timeout', async () => {
    callGeminiVideoMock.mockResolvedValue({ ok: false, reason: 'timeout' });
    const result = await describeVideo(baseVideoParams);
    expect(result).toBeNull();
    expect(callGeminiVideoMock).toHaveBeenCalledTimes(1);
  });

  it('retries once on 503 and succeeds on the second attempt', async () => {
    callGeminiVideoMock
      .mockResolvedValueOnce({ ok: false, reason: 'http', status: 503 })
      .mockResolvedValueOnce({ ok: true, text: '2回目で成功しました。' });
    const result = await describeVideo(baseVideoParams);
    expect(result).toBe('2回目で成功しました。');
    expect(callGeminiVideoMock).toHaveBeenCalledTimes(2);
  });

  it('retries once on 503 and returns null if the retry also fails', async () => {
    callGeminiVideoMock.mockResolvedValue({ ok: false, reason: 'http', status: 503 });
    const result = await describeVideo(baseVideoParams);
    expect(result).toBeNull();
    expect(callGeminiVideoMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry on 503 when the remaining budget is insufficient', async () => {
    callGeminiVideoMock.mockResolvedValue({ ok: false, reason: 'http', status: 503 });
    // deadline=45000ms. timeoutMs=15000 + margin=15000 + retryBackoff=2000 = 32000 needed.
    // receivedAt 14000ms ago -> remaining ~31000ms -> insufficient for retry (but enough for the first call).
    const receivedAt = Date.now() - 14_000;
    const result = await describeVideo({ ...baseVideoParams, receivedAt });
    expect(result).toBeNull();
    expect(callGeminiVideoMock).toHaveBeenCalledTimes(1);
  });

  it('skips when remaining time is under timeout + margin', async () => {
    // deadline = 45000ms. receivedAt 36000ms ago -> remaining ~9000ms.
    // timeoutMs=15000 + 15000 margin = 30000 > 9000 -> skip.
    callGeminiVideoMock.mockResolvedValue({ ok: true, text: 'should not be reached' });
    const receivedAt = Date.now() - 36_000;
    const result = await describeVideo({ ...baseVideoParams, receivedAt });
    expect(result).toBeNull();
    expect(callGeminiVideoMock).not.toHaveBeenCalled();
  });

  it('passes mimeType through to callGeminiVideo', async () => {
    callGeminiVideoMock.mockResolvedValue({ ok: true, text: '説明' });
    await describeVideo(baseVideoParams);
    const [, , callParams] = callGeminiVideoMock.mock.calls[0];
    expect(callParams.mimeType).toBe('video/mp4');
  });
});

const SMALL_AUDIO = new ArrayBuffer(1024);
const LARGE_AUDIO = new ArrayBuffer(16 * 1024 * 1024);

const baseAudioConfig = { enabled: true, model: 'gemini-2.5-flash-lite', timeoutMs: 15000, maxDescriptionTokens: 250, maxInputBytes: 15 * 1024 * 1024 };

const baseAudioParams = {
  bytes: SMALL_AUDIO,
  contentType: 'audio/m4a',
  config: baseAudioConfig,
  geminiApiKey: 'gemini-test',
  receivedAt: Date.now(),
};

describe('describeAudio', () => {
  beforeEach(() => {
    callGeminiAudioMock.mockReset();
  });

  it('returns null immediately when disabled (no calls made)', async () => {
    const result = await describeAudio({ ...baseAudioParams, config: { ...baseAudioConfig, enabled: false } });
    expect(result).toBeNull();
    expect(callGeminiAudioMock).not.toHaveBeenCalled();
  });

  it('returns null immediately when geminiApiKey is missing', async () => {
    const result = await describeAudio({ ...baseAudioParams, geminiApiKey: undefined });
    expect(result).toBeNull();
    expect(callGeminiAudioMock).not.toHaveBeenCalled();
  });

  it('calls callGeminiAudio and returns its result on success', async () => {
    callGeminiAudioMock.mockResolvedValue('挨拶をしている音声です。');
    const result = await describeAudio(baseAudioParams);
    expect(result).toBe('挨拶をしている音声です。');
    expect(callGeminiAudioMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed (no call) for audio over maxInputBytes', async () => {
    const result = await describeAudio({ ...baseAudioParams, bytes: LARGE_AUDIO });
    expect(result).toBeNull();
    expect(callGeminiAudioMock).not.toHaveBeenCalled();
  });

  it('fails closed for unsupported content types', async () => {
    const result = await describeAudio({ ...baseAudioParams, contentType: 'audio/x-unknown' });
    expect(result).toBeNull();
    expect(callGeminiAudioMock).not.toHaveBeenCalled();
  });

  it('maps a known content type to the expected format identifier', async () => {
    callGeminiAudioMock.mockResolvedValue('説明');
    await describeAudio({ ...baseAudioParams, contentType: 'audio/wav' });
    const [, , callParams] = callGeminiAudioMock.mock.calls[0];
    expect(callParams.format).toBe('wav');
  });

  it('maps audio/x-m4a (the actual content-type LINE sends, confirmed 2026-07-20) to mp3', async () => {
    callGeminiAudioMock.mockResolvedValue('説明');
    await describeAudio({ ...baseAudioParams, contentType: 'audio/x-m4a' });
    const [, , callParams] = callGeminiAudioMock.mock.calls[0];
    expect(callParams.format).toBe('mp3');
  });

  it('skips when remaining time is under timeout + margin', async () => {
    callGeminiAudioMock.mockResolvedValue('should not be reached');
    const receivedAt = Date.now() - 36_000;
    const result = await describeAudio({ ...baseAudioParams, receivedAt });
    expect(result).toBeNull();
    expect(callGeminiAudioMock).not.toHaveBeenCalled();
  });
});
