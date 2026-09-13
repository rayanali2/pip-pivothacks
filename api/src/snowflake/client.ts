import path from 'node:path';
import type { Bind as SdkBind, Connection } from 'snowflake-sdk';
import type { SnowflakeSettings } from '../config';
import { errorMessage, log, logSql } from '../log';
import { asRecord, cell, type Row } from './rows';

export type Bind = SdkBind;
export type { Row } from './rows';

/** Everything the live path needs from Snowflake. SnowflakeClient is the real one; tests inject fakes. */
export interface SqlExecutor {
  query(sql: string, binds?: readonly Bind[]): Promise<Row[]>;
  /** true when the executor already passes every statement through logSql before running it */
  readonly logsSql?: boolean;
}

/** Wraps an executor so every statement goes through logSql (debug level) first. No-op for executors that already log. */
export function withSqlLogging(executor: SqlExecutor): SqlExecutor {
  if (executor.logsSql === true) return executor;
  return {
    logsSql: true,
    async query(sql: string, binds?: readonly Bind[]): Promise<Row[]> {
      logSql(sql, binds);
      return executor.query(sql, binds);
    },
  };
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/** Rejects with TimeoutError after `ms`. The underlying work keeps running; its late rejection is handled by the race. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms} ms`)), ms);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** snowflake-sdk ErrorCode values that mean the connection (not the statement) is the problem. */
const CONNECTION_ERROR_CODES = new Set<number>([
  401001, // ERR_SF_NETWORK_COULD_NOT_CONNECT
  402001, // ERR_LARGE_RESULT_SET_NETWORK_COULD_NOT_CONNECT
  405503, // ERR_CONN_CONNECT_STATUS_DISCONNECTED
  406502, // ERR_CONN_DESTROY_STATUS_DISCONNECTED
  407002, // ERR_CONN_REQUEST_STATUS_DISCONNECTED
  390111, // session no longer exists
  390112, // session token expired
  390114, // authentication token expired
]);
const CONNECTION_ERROR_RE =
  /terminated|not connected|disconnected|connection (?:is )?(?:closed|lost|reset)|session (?:does not exist|no longer exists|expired)|token (?:has )?expired|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|network/i;

export function isConnectionError(err: unknown): boolean {
  const rec = asRecord(err);
  if (!rec) return false;
  const code = rec.code;
  const numeric = typeof code === 'number' ? code : typeof code === 'string' && /^\d+$/.test(code) ? Number(code) : null;
  if (numeric !== null && CONNECTION_ERROR_CODES.has(numeric)) return true;
  if (typeof rec.sqlState === 'string' && rec.sqlState.startsWith('08')) return true;
  if (rec.isFatal === true) return true;
  return CONNECTION_ERROR_RE.test(errorMessage(err));
}

// ---------------------------------------------------------------------------
// PUT
// ---------------------------------------------------------------------------

export const AUDIO_STAGE = '@PIP.APP.AUDIO_STAGE';

/**
 * PUT 'file://C:/.../file.m4a' @PIP.APP.AUDIO_STAGE/<dir>/ AUTO_COMPRESS = FALSE OVERWRITE = TRUE
 * The file URI is quoted and uses forward slashes (Windows paths become file://C:/...); AUTO_COMPRESS = FALSE keeps
 * the staged name identical so TO_FILE can find it and AI_TRANSCRIBE can read it.
 */
export function putSql(localPath: string, stageDir: string): string {
  let file = localPath.replace(/\\/g, '/');
  if (!/^[A-Za-z]:\//.test(file) && !file.startsWith('/')) file = path.resolve(localPath).replace(/\\/g, '/');
  if (/['\r\n\0]/.test(file)) throw new Error(`unsupported character in local path: ${localPath}`);
  const dir = stageDir
    .replace(/^@PIP\.APP\.AUDIO_STAGE\/?/i, '')
    .replace(/^\/+|\/+$/g, '');
  if (!/^[A-Za-z0-9_\-./]*$/.test(dir) || dir.split('/').includes('..')) throw new Error(`invalid stage directory: ${stageDir}`);
  return `PUT 'file://${file}' ${AUDIO_STAGE}/${dir === '' ? '' : `${dir}/`} AUTO_COMPRESS = FALSE OVERWRITE = TRUE`;
}

/** Uploads one local file to @PIP.APP.AUDIO_STAGE/<stageDir>/ and checks the per-file status. */
export async function putFile(executor: SqlExecutor, localPath: string, stageDir: string): Promise<Row[]> {
  const rows = await executor.query(putSql(localPath, stageDir));
  for (const row of rows) {
    const status = cell(row, 'status');
    if (typeof status === 'string' && !['UPLOADED', 'SKIPPED'].includes(status.toUpperCase())) {
      const message = cell(row, 'message');
      throw new Error(`PUT ${path.basename(localPath)} failed: ${status}${typeof message === 'string' && message ? ` (${message})` : ''}`);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// SnowflakeClient
// ---------------------------------------------------------------------------

const TIMEZONE_RE = /^[A-Za-z_]+(\/[A-Za-z_+-]+)*$/;

export function validateTimezone(zone: string): string {
  const z = zone.trim();
  if (!TIMEZONE_RE.test(z)) throw new Error(`PIP_TIMEZONE "${zone}" is not an IANA zone name like America/Los_Angeles`);
  return z;
}

/** Unquoted identifier when safe, otherwise a double-quoted one. */
export function identifier(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

export interface SnowflakeClientOptions {
  settings: SnowflakeSettings;
  /** IANA zone for ALTER SESSION SET TIMEZONE */
  timezone: string;
  /** login timeout (default 20 s) */
  connectTimeoutMs?: number;
  /** after a failed connect, calls fail fast with the last error for this long (default 30 s) */
  failureCooldownMs?: number;
  /** STATEMENT_TIMEOUT_IN_SECONDS (default 90) */
  statementTimeoutSeconds?: number;
}

type SnowflakeSdk = typeof import('snowflake-sdk');

let sdkPromise: Promise<SnowflakeSdk> | null = null;

/**
 * Loads snowflake-sdk once (lazily, so mock mode and tests never load it) and configures it: logLevel ERROR, and a
 * custom logger so the driver's (already secret-masked) messages go to our log instead of a snowflake.log file in cwd.
 */
function loadSdk(): Promise<SnowflakeSdk> {
  if (!sdkPromise) {
    sdkPromise = import('snowflake-sdk').then((module) => {
      // Node 24 exposes this CommonJS package under `default`; older runtimes expose
      // its named exports directly. Normalize both shapes before using the SDK.
      const sdk = (module as unknown as { default?: SnowflakeSdk }).default ?? module;
      sdk.configure({
        logLevel: 'ERROR',
        customLogger: {
          error: (m: string) => log.warn(`[snowflake-sdk] ${m}`),
          warn: (m: string) => log.warn(`[snowflake-sdk] ${m}`),
          info: (m: string) => log.debug(`[snowflake-sdk] ${m}`),
          debug: (m: string) => log.debug(`[snowflake-sdk] ${m}`),
          trace: (m: string) => log.debug(`[snowflake-sdk] ${m}`),
        },
      });
      return sdk;
    });
  }
  return sdkPromise;
}

/** Loads snowflake-sdk up front (its require() is synchronous and slow on a cold start). Returns the milliseconds it took. */
export async function preloadSnowflakeSdk(): Promise<number> {
  const started = Date.now();
  await loadSdk();
  return Date.now() - started;
}

function toRows(rows: unknown): Row[] {
  if (!Array.isArray(rows)) return [];
  const out: Row[] = [];
  for (const r of rows) {
    const rec = asRecord(r);
    if (rec) out.push(rec);
  }
  return out;
}

/**
 * One lazily opened snowflake-sdk connection shared by all requests.
 * - a single in-flight connect promise; a failed connect starts a short cooldown so requests fall back fast
 * - on connect: ALTER SESSION SET TIMEZONE, STATEMENT_TIMEOUT_IN_SECONDS = 90, USE WAREHOUSE, USE SCHEMA
 * - a statement that fails with a connection-level error reconnects once and is retried
 * - every statement (session setup and PUT included) is logged via logSql first; the password never is
 */
export class SnowflakeClient implements SqlExecutor {
  readonly logsSql = true;
  private readonly settings: SnowflakeSettings;
  private readonly timezone: string;
  private readonly connectTimeoutMs: number;
  private readonly failureCooldownMs: number;
  private readonly statementTimeoutSeconds: number;
  private conn: Connection | null = null;
  private connecting: Promise<Connection> | null = null;
  private lastFailure: { at: number; message: string } | null = null;

  constructor(opts: SnowflakeClientOptions) {
    this.settings = opts.settings;
    this.timezone = opts.timezone;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 20_000;
    this.failureCooldownMs = opts.failureCooldownMs ?? 30_000;
    this.statementTimeoutSeconds = Math.max(1, Math.floor(opts.statementTimeoutSeconds ?? 90));
  }

  get isConnected(): boolean {
    return this.conn !== null && this.conn.isUp();
  }

  async query(sql: string, binds?: readonly Bind[]): Promise<Row[]> {
    const conn = await this.connection();
    try {
      return await this.exec(conn, sql, binds);
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      log.warn(`snowflake connection error, reconnecting once: ${errorMessage(err)}`);
      this.discard(conn);
      const fresh = await this.connection();
      return this.exec(fresh, sql, binds);
    }
  }

  /** PUT a local file to @PIP.APP.AUDIO_STAGE/<stagePath>/. */
  put(localPath: string, stagePath: string): Promise<Row[]> {
    return putFile(this, localPath, stagePath);
  }

  async close(): Promise<void> {
    const conn = this.conn;
    this.conn = null;
    if (!conn) return;
    await new Promise<void>((resolve) => {
      try {
        conn.destroy(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  private connection(): Promise<Connection> {
    if (this.conn && this.conn.isUp()) return Promise.resolve(this.conn);
    if (this.connecting) return this.connecting;
    const failure = this.lastFailure;
    if (failure && Date.now() - failure.at < this.failureCooldownMs) {
      const wait = Math.ceil((this.failureCooldownMs - (Date.now() - failure.at)) / 1000);
      return Promise.reject(new Error(`snowflake unavailable (next connect attempt in ${wait}s): ${failure.message}`));
    }
    const attempt = this.open().then(
      (conn) => {
        this.conn = conn;
        this.lastFailure = null;
        return conn;
      },
      (err: unknown) => {
        this.lastFailure = { at: Date.now(), message: errorMessage(err) };
        throw err;
      },
    );
    const tracked = attempt.finally(() => {
      this.connecting = null;
    });
    this.connecting = tracked;
    return tracked;
  }

  private async open(): Promise<Connection> {
    const s = this.settings;
    if (!s.account || !s.user || (!s.token && !s.password) || !s.warehouse) {
      throw new Error('Snowflake is not configured (SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_TOKEN or SNOWFLAKE_PASSWORD, SNOWFLAKE_WAREHOUSE)');
    }
    const zone = validateTimezone(this.timezone);
    const sdk = await loadSdk();
    log.info(`connecting to Snowflake account ${s.account} as ${s.user} (warehouse ${s.warehouse})`);
    const conn = sdk.createConnection({
      account: s.account,
      username: s.user,
      ...(s.token
        ? { authenticator: 'PROGRAMMATIC_ACCESS_TOKEN', token: s.token }
        : { password: s.password! }),
      warehouse: s.warehouse,
      database: s.database,
      schema: s.schema,
      role: s.role ?? undefined,
      clientSessionKeepAlive: true,
    });
    try {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          conn.connect((err) => (err ? reject(err) : resolve()));
        }),
        this.connectTimeoutMs,
        'snowflake connect',
      );
      await this.exec(conn, `ALTER SESSION SET TIMEZONE = '${zone}'`);
      await this.exec(conn, `ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = ${this.statementTimeoutSeconds}`);
      await this.exec(conn, `USE WAREHOUSE ${identifier(s.warehouse)}`);
      await this.exec(conn, `USE SCHEMA ${identifier(s.database)}.${identifier(s.schema)}`);
    } catch (err) {
      this.destroyQuietly(conn);
      throw err;
    }
    log.info(`connected to Snowflake (session TIMEZONE ${zone})`);
    return conn;
  }

  private exec(conn: Connection, sql: string, binds?: readonly Bind[]): Promise<Row[]> {
    logSql(sql, binds);
    return new Promise<Row[]>((resolve, reject) => {
      conn.execute({
        sqlText: sql,
        binds: binds && binds.length > 0 ? binds : undefined,
        complete: (err, _stmt, rows) => {
          if (err) reject(err);
          else resolve(toRows(rows));
        },
      });
    });
  }

  private discard(conn: Connection): void {
    if (this.conn === conn) this.conn = null;
    this.destroyQuietly(conn);
  }

  private destroyQuietly(conn: Connection): void {
    try {
      conn.destroy(() => undefined);
    } catch {
      // already gone
    }
  }
}
