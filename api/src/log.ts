export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let currentLevel: LogLevel = parseLogLevel(process.env.LOG_LEVEL) ?? 'info';

export function parseLogLevel(value: string | undefined): LogLevel | null {
  if (value === undefined) return null;
  const v = value.trim().toLowerCase();
  for (const level of LOG_LEVELS) {
    if (level === v) return level;
  }
  return null;
}

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function enabled(level: LogLevel): boolean {
  return RANK[level] >= RANK[currentLevel];
}

function stamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function write(level: LogLevel, message: string, extra: unknown[]): void {
  if (!enabled(level)) return;
  const line = `${stamp()} ${level.toUpperCase().padEnd(5)} ${message}`;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (extra.length > 0) sink(line, ...extra);
  else sink(line);
}

export const log = {
  debug: (message: string, ...extra: unknown[]): void => write('debug', message, extra),
  info: (message: string, ...extra: unknown[]): void => write('info', message, extra),
  warn: (message: string, ...extra: unknown[]): void => write('warn', message, extra),
  error: (message: string, ...extra: unknown[]): void => write('error', message, extra),
};

/** Logs one Snowflake statement at debug level. The live backend calls this for every statement it executes. */
export function logSql(sql: string, binds?: ReadonlyArray<unknown>): void {
  if (!enabled('debug')) return;
  const compact = sql.replace(/\s+/g, ' ').trim();
  const bindText = binds && binds.length > 0 ? ` binds=${safeJson(binds)}` : '';
  write('debug', `[snowflake] ${compact}${bindText}`, []);
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return safeJson(err);
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return String(value);
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return String(value);
  }
}
