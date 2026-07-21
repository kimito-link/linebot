import botConfigJson from '../../../../bot.config.json';

export interface BotLlmChainStage {
  provider: 'groq' | 'gemini' | 'workers-ai';
  model: string;
  timeoutMs: number;
}

/** visionチェーンはgroq/geminiのみ許可（Workers AIのvisionモデルは§6の理由で使用禁止）。 */
export interface BotVisionChainStage {
  provider: 'groq' | 'gemini';
  model: string;
  timeoutMs: number;
}

export interface BotVisionConfig {
  enabled: boolean;
  chain: BotVisionChainStage[];
  maxDescriptionTokens: number;
}

/**
 * 動画・音声の説明文生成設定（2026-07-19追加）。visionと違いGeminiのみ対応
 * （動画: OpenAI互換chat/completionsはvideo_url content typeを受け付けず、
 * ネイティブgenerateContent APIのinline_dataでのみ動作することを実機検証で確認。
 * 音声: OpenAI互換のinput_audio content typeで動作するが、提供元をGeminiに揃える）。
 * Groq/Workers AIは動画・音声inputに対応していないためチェーン化しない。
 */
export interface BotMediaConfig {
  enabled: boolean;
  model: string;
  timeoutMs: number;
  maxDescriptionTokens: number;
  /** この値(バイト)を超える動画・音声はdescribeを諦め、[動画]/[音声]ラベルのみ保存する（fail-closed）。 */
  maxInputBytes: number;
}

export interface BotLlmConfig {
  provider: 'groq';
  model: string;
  maxOutputTokens: number;
  timeoutMs: number;
  dailyCallBudget: number;
  /**
   * 無応答ゼロ化チェーン（2026-07-17 Fable設計）。未指定なら下の getBotConfig() が
   * 旧来の単一プロバイダ設定（provider/model/timeoutMs）から1段チェーンを合成する
   * ため、既存の bot.config.json をそのまま使っているアプリ（web-ios-android の
   * templates/line-bot 等）の後方互換を壊さない。
   */
  chain: BotLlmChainStage[];
  /** 画像認識のvisionチェーン設定（2026-07-17追加）。未指定時はdisabled（後方互換）。 */
  vision?: BotVisionConfig;
  /** 動画の説明文生成設定（2026-07-19追加）。未指定時はdisabled（後方互換）。 */
  video?: BotMediaConfig;
  /** 音声の説明文生成設定（2026-07-19追加）。未指定時はdisabled（後方互換）。 */
  audio?: BotMediaConfig;
}

export interface BotCacheConfig {
  enabled: boolean;
  ttlHours: number;
}

export interface BotRetrievalConfig {
  topK: number;
  minScore: number;
}

export interface BotProjectEntry {
  knowledgePack: string;
}

export interface BotUrlContextConfig {
  enabled: boolean;
  timeoutMs: number;
  maxContentBytes: number;
  maxExtractChars: number;
}

export interface BotConfig {
  /** @deprecated use defaultProject. Kept for callers that still read `.project`. */
  project: string;
  defaultProject: string;
  projects: Record<string, BotProjectEntry>;
  llm: BotLlmConfig;
  cache: BotCacheConfig;
  retrieval: BotRetrievalConfig;
  urlContext: BotUrlContextConfig;
}

type RawBotLlmConfig = Omit<BotLlmConfig, 'chain' | 'vision' | 'video' | 'audio'> & {
  chain?: BotLlmChainStage[];
  vision?: Partial<BotVisionConfig>;
  video?: Partial<BotMediaConfig>;
  audio?: Partial<BotMediaConfig>;
};

type RawBotConfig = {
  // Legacy single-project shape.
  project?: string;
  knowledgePack?: string;
  // New multi-project shape.
  defaultProject?: string;
  projects?: Record<string, BotProjectEntry>;
  llm: RawBotLlmConfig;
  cache?: Partial<BotCacheConfig>;
  retrieval?: Partial<BotRetrievalConfig>;
  urlContext?: Partial<BotUrlContextConfig>;
};

/** Runtime defaults from bot.config.json (project-specific values live there, not in code). */
export function getBotConfig(): BotConfig {
  const raw = botConfigJson as RawBotConfig;

  const defaultProject = raw.defaultProject ?? raw.project ?? '';
  const projects: Record<string, BotProjectEntry> =
    raw.projects ??
    (raw.knowledgePack ? { [defaultProject]: { knowledgePack: raw.knowledgePack } } : {});

  // chain 未指定時は、旧来の単一プロバイダ設定(provider/model/timeoutMs)から
  // 1段チェーンを合成する。既存の bot.config.json（web-ios-android の
  // templates/line-bot 等、まだ chain 化していないアプリ）を壊さないための後方互換。
  const chain: BotLlmChainStage[] = raw.llm.chain ?? [
    { provider: raw.llm.provider, model: raw.llm.model, timeoutMs: raw.llm.timeoutMs },
  ];

  // vision未指定時はdisabled（既存bot.config.jsonの後方互換。2026-07-17画像認識機能追加）。
  const vision: BotVisionConfig = {
    enabled: raw.llm.vision?.enabled ?? false,
    chain: raw.llm.vision?.chain ?? [],
    maxDescriptionTokens: raw.llm.vision?.maxDescriptionTokens ?? 250,
  };

  // video/audio未指定時はdisabled（既存bot.config.jsonの後方互換。2026-07-19動画・音声認識機能追加）。
  const video: BotMediaConfig = {
    enabled: raw.llm.video?.enabled ?? false,
    model: raw.llm.video?.model ?? 'gemini-2.5-flash',
    timeoutMs: raw.llm.video?.timeoutMs ?? 15000,
    maxDescriptionTokens: raw.llm.video?.maxDescriptionTokens ?? 250,
    maxInputBytes: raw.llm.video?.maxInputBytes ?? 15 * 1024 * 1024,
  };
  const audio: BotMediaConfig = {
    enabled: raw.llm.audio?.enabled ?? false,
    model: raw.llm.audio?.model ?? 'gemini-2.5-flash',
    timeoutMs: raw.llm.audio?.timeoutMs ?? 15000,
    maxDescriptionTokens: raw.llm.audio?.maxDescriptionTokens ?? 250,
    maxInputBytes: raw.llm.audio?.maxInputBytes ?? 15 * 1024 * 1024,
  };

  return {
    project: defaultProject,
    defaultProject,
    projects,
    llm: { ...raw.llm, chain, vision, video, audio },
    cache: {
      enabled: raw.cache?.enabled ?? true,
      ttlHours: raw.cache?.ttlHours ?? 72,
    },
    retrieval: {
      topK: raw.retrieval?.topK ?? 3,
      minScore: raw.retrieval?.minScore ?? 0,
    },
    // 未指定時はdisabled（既存bot.config.json、web-ios-androidのtemplates/line-bot等の
    // 後方互換。2026-07-17追加）。
    urlContext: {
      enabled: raw.urlContext?.enabled ?? false,
      timeoutMs: raw.urlContext?.timeoutMs ?? 6000,
      maxContentBytes: raw.urlContext?.maxContentBytes ?? 524288,
      maxExtractChars: raw.urlContext?.maxExtractChars ?? 2000,
    },
  };
}

/** The project used when a friend has no resolvable project (fail-closed default). */
export function getDefaultProject(): string {
  return getBotConfig().defaultProject;
}

/** Whether `project` is a configured project id (used for fail-closed fallback checks). */
export function isKnownProject(project: string): boolean {
  return project in getBotConfig().projects;
}
