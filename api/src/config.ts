import path from 'node:path';
import dotenv from 'dotenv';
import { log, parseLogLevel, setLogLevel, type LogLevel } from './log';

export type Mode = 'mock' | 'live';

export interface SnowflakeSettings {
  account: string | null;
  user: string | null;
  password: string | null;
  token: string | null;
  warehouse: string | null;
  database: string;
  schema: string;
  role: string | null;
}

export interface ClaudeSettings {
  /** ANTHROPIC_API_KEY; null disables the Claude extraction fallback */
  apiKey: string | null;
  /** PIP_CLAUDE_MODEL */
  model: string;
  /** PIP_CLAUDE_TIMEOUT_MS: one extraction request, then the heuristic parser answers */
  timeoutMs: number;
}

/** Fast model for low-latency transcript extraction. */
export const DEFAULT_CLAUDE_MODEL = 'claude-haiku-4-5';
export const DEFAULT_CLAUDE_TIMEOUT_MS = 8000;

export interface AppConfig {
  snowflake: SnowflakeSettings;
  claude: ClaudeSettings;
  /** ANTHROPIC_API_KEY is present */
  claudeConfigured: boolean;
  /** account + user + (token or password) + warehouse are all present */
  snowflakeConfigured: boolean;
  /** MOCK_MODE as written in the environment */
  mockModeRequested: boolean;
  /** effective mode: 'mock' if MOCK_MODE=true or Snowflake is not configured */
  mode: Mode;
  port: number;
  logLevel: LogLevel;
  /** 'HH:MM', 'real' or null (unset) */
  demoNow: string | null;
  /** IANA zone used for plan math and the Snowflake session TIMEZONE */
  timezone: string;
  /** Skip optional wording generation for plain captures; extraction/ranking are unchanged. */
  fastCapturePlan: boolean;
}

export type Env = Readonly<Record<string, string | undefined>>;

function str(env: Env, key: string): string | null {
  const v = env[key];
  if (v === undefined) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const v = str(env, key);
  if (v === null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/** Pure: builds the config from an env map (no dotenv, no side effects). */
export function loadConfig(env: Env): AppConfig {
  const snowflake: SnowflakeSettings = {
    account: str(env, 'SNOWFLAKE_ACCOUNT'),
    user: str(env, 'SNOWFLAKE_USER'),
    password: str(env, 'SNOWFLAKE_PASSWORD'),
    token: str(env, 'SNOWFLAKE_TOKEN'),
    warehouse: str(env, 'SNOWFLAKE_WAREHOUSE'),
    database: str(env, 'SNOWFLAKE_DATABASE') ?? 'PIP',
    schema: str(env, 'SNOWFLAKE_SCHEMA') ?? 'APP',
    role: str(env, 'SNOWFLAKE_ROLE'),
  };
  const snowflakeConfigured =
    snowflake.account !== null && snowflake.user !== null && (snowflake.token !== null || snowflake.password !== null) && snowflake.warehouse !== null;
  const mockModeRequested = bool(env, 'MOCK_MODE', false);
  const mode: Mode = mockModeRequested || !snowflakeConfigured ? 'mock' : 'live';

  const portRaw = str(env, 'PORT');
  const portNum = portRaw === null ? 3000 : Number.parseInt(portRaw, 10);
  const port = Number.isFinite(portNum) && portNum > 0 && portNum < 65536 ? portNum : 3000;

  const demoRaw = str(env, 'DEMO_NOW');
  let demoNow: string | null = null;
  if (demoRaw !== null) {
    if (demoRaw.toLowerCase() === 'real') demoNow = 'real';
    else if (/^([01]?\d|2[0-3]):[0-5]\d$/.test(demoRaw)) demoNow = demoRaw.padStart(5, '0');
  }

  const claudeTimeoutRaw = str(env, 'PIP_CLAUDE_TIMEOUT_MS');
  const claudeTimeout = claudeTimeoutRaw === null ? DEFAULT_CLAUDE_TIMEOUT_MS : Number.parseInt(claudeTimeoutRaw, 10);
  const claude: ClaudeSettings = {
    apiKey: str(env, 'ANTHROPIC_API_KEY'),
    model: str(env, 'PIP_CLAUDE_MODEL') ?? DEFAULT_CLAUDE_MODEL,
    timeoutMs: Number.isFinite(claudeTimeout) && claudeTimeout > 0 ? claudeTimeout : DEFAULT_CLAUDE_TIMEOUT_MS,
  };

  return {
    snowflake,
    claude,
    claudeConfigured: claude.apiKey !== null,
    snowflakeConfigured,
    mockModeRequested,
    mode,
    port,
    logLevel: parseLogLevel(str(env, 'LOG_LEVEL') ?? undefined) ?? 'info',
    demoNow,
    timezone: str(env, 'PIP_TIMEZONE') ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    fastCapturePlan: bool(env, 'FAST_CAPTURE_PLAN', true),
  };
}

let cached: AppConfig | null = null;

/** Loads api/.env (if present) into process.env once and returns the config. */
export function getConfig(): AppConfig {
  if (cached) return cached;
  dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });
  const cfg = loadConfig(process.env);
  // Plans use the server's local time zone; PIP_TIMEZONE (if set) becomes that zone.
  if (process.env.PIP_TIMEZONE && process.env.PIP_TIMEZONE.trim() !== '') {
    process.env.TZ = process.env.PIP_TIMEZONE.trim();
  }
  setLogLevel(cfg.logLevel);
  if (!cfg.mockModeRequested && !cfg.snowflakeConfigured) {
    log.warn(
      'Snowflake is not configured (need SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_TOKEN or SNOWFLAKE_PASSWORD, SNOWFLAKE_WAREHOUSE); running in mock mode.',
    );
  }
  const DEMO_NOW = process.env.DEMO_NOW;
  if (DEMO_NOW !== undefined && DEMO_NOW.trim() !== '' && cfg.demoNow === null) {
    log.warn(`Ignoring DEMO_NOW="${DEMO_NOW}" (expected HH:MM or "real").`);
  }
  cached = cfg;
  return cfg;
}
