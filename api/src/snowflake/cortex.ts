import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CortexStatus } from '../types';
import { toIsoLocal } from '../clock';
import { errorMessage, log } from '../log';
import { AUDIO_STAGE, putFile, withSqlLogging, type SqlExecutor } from './client';
import { strOrNull, withOffset } from './rows';

export const COMPLETE_FNS = ['AI_COMPLETE', 'SNOWFLAKE.CORTEX.COMPLETE'] as const;
export const COMPLETE_MODELS = ['claude-sonnet-4-5', 'mistral-large2', 'llama3.1-8b'] as const;
export const EMBED_FNS = ['AI_EMBED', 'SNOWFLAKE.CORTEX.EMBED_TEXT_768'] as const;
export const EMBED_MODEL = 'snowflake-arctic-embed-m-v1.5';
export const PROBE_STAGE_DIR = '_probe';
export const PROBE_FILE = 'probe.wav';

const MODEL_RE = /^[a-z0-9][a-z0-9.-]*$/;
const PROBE_PROMPT = 'Reply with the single word OK.';

export const CORTEX_CONFIG_MERGE_SQL = `MERGE INTO PIP.APP.CORTEX_CONFIG t
USING (SELECT ? AS k, ? AS v UNION ALL SELECT ?, ? UNION ALL SELECT ?, ? UNION ALL SELECT ?, ?) s
ON t.key = s.k
WHEN MATCHED THEN UPDATE SET value = s.v, verified_at = CURRENT_TIMESTAMP()::TIMESTAMP_NTZ
WHEN NOT MATCHED THEN INSERT (key, value, verified_at) VALUES (s.k, s.v, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)`;

export const CORTEX_CONFIG_SELECT_SQL = `SELECT key AS K, value AS V, TO_VARCHAR(verified_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS VERIFIED_AT FROM PIP.APP.CORTEX_CONFIG`;

export function emptyCortexStatus(errors: string[]): CortexStatus {
  return { transcribe: null, complete: null, complete_model: null, embed: null, verified_at: null, errors };
}

/** A 16 kHz mono 16-bit PCM WAV of silence (44-byte header + samples). */
export function silentWav(seconds = 1, sampleRate = 16_000): Buffer {
  const samples = Math.max(1, Math.round(seconds * sampleRate));
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

function short(label: string, err: unknown): string {
  const first = errorMessage(err).split(/\r?\n/)[0] ?? '';
  return `${label}: ${first.length > 160 ? `${first.slice(0, 157)}...` : first}`;
}

export function describeCortex(status: CortexStatus): string {
  return `complete=${status.complete ?? 'none'}${status.complete_model ? `/${status.complete_model}` : ''}, embed=${status.embed ?? 'none'}, transcribe=${status.transcribe ?? 'none'}`;
}

export interface VerifyCortexOptions {
  /** real clock for verified_at (default new Date) */
  now?: () => Date;
}

async function probeTranscribe(db: SqlExecutor): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `pip-probe-${randomUUID().slice(0, 8)}-`));
  try {
    const file = path.join(dir, PROBE_FILE);
    await fs.writeFile(file, silentWav());
    await putFile(db, file, PROBE_STAGE_DIR);
    await db.query(`SELECT AI_TRANSCRIBE(TO_FILE('${AUDIO_STAGE}', '${PROBE_STAGE_DIR}/${PROBE_FILE}')) AS RESULT`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Verifies which Cortex functions work on this account and MERGEs the result into CORTEX_CONFIG.
 * SELECT 1; completion chain AI_COMPLETE x (claude-sonnet-4-5, mistral-large2, llama3.1-8b) then SNOWFLAKE.CORTEX.COMPLETE x
 * the same models (model literal from a fixed allow-list, prompt bound); AI_EMBED then EMBED_TEXT_768; AI_TRANSCRIBE on a
 * staged 1-second silent WAV (success, even with empty text, means available). Never throws.
 */
export async function verifyCortex(executor: SqlExecutor, opts: VerifyCortexOptions = {}): Promise<CortexStatus> {
  const db = withSqlLogging(executor);
  const now = opts.now ?? ((): Date => new Date());
  try {
    try {
      await db.query('SELECT 1 AS OK');
    } catch (err) {
      return emptyCortexStatus([short('snowflake', err)]);
    }

    const errors: string[] = [];
    const status = emptyCortexStatus(errors);

    const completeErrors: string[] = [];
    for (const fn of COMPLETE_FNS) {
      for (const model of COMPLETE_MODELS) {
        if (status.complete !== null) break;
        if (!MODEL_RE.test(model)) continue;
        try {
          await db.query(`SELECT ${fn}('${model}', ?) AS OUT_TEXT`, [PROBE_PROMPT]);
          status.complete = fn;
          status.complete_model = model;
        } catch (err) {
          completeErrors.push(short(`${fn}/${model}`, err));
        }
      }
    }
    if (status.complete === null) errors.push(...completeErrors);
    else if (completeErrors.length > 0) log.info(`cortex completion fell through: ${completeErrors.join(' | ')}`);

    const embedErrors: string[] = [];
    for (const fn of EMBED_FNS) {
      if (status.embed !== null) break;
      try {
        await db.query(`SELECT ${fn}('${EMBED_MODEL}', ?) AS EMBEDDING`, ['hello']);
        status.embed = fn;
      } catch (err) {
        embedErrors.push(short(fn, err));
      }
    }
    if (status.embed === null) errors.push(...embedErrors);

    try {
      await probeTranscribe(db);
      status.transcribe = 'AI_TRANSCRIBE';
    } catch (err) {
      errors.push(short('AI_TRANSCRIBE', err));
    }

    try {
      await db.query(CORTEX_CONFIG_MERGE_SQL, [
        'complete_fn',
        status.complete,
        'complete_model',
        status.complete_model,
        'embed_fn',
        status.embed,
        'transcribe_fn',
        status.transcribe,
      ]);
    } catch (err) {
      errors.push(short('CORTEX_CONFIG merge', err));
    }
    status.verified_at = toIsoLocal(now());
    return status;
  } catch (err) {
    return emptyCortexStatus([short('cortex verification', err)]);
  }
}

/** Last verification stored in CORTEX_CONFIG (by 03_functions.sql or an earlier API run), or null when empty. */
export async function readCortexConfig(executor: SqlExecutor): Promise<CortexStatus | null> {
  const rows = await withSqlLogging(executor).query(CORTEX_CONFIG_SELECT_SQL);
  if (rows.length === 0) return null;
  const status = emptyCortexStatus([]);
  let verified: string | null = null;
  for (const row of rows) {
    const key = strOrNull(row, 'K');
    const value = strOrNull(row, 'V');
    const at = strOrNull(row, 'VERIFIED_AT');
    if (at !== null && (verified === null || at > verified)) verified = at;
    if (key === 'complete_fn') status.complete = value;
    else if (key === 'complete_model') status.complete_model = value;
    else if (key === 'embed_fn') status.embed = value;
    else if (key === 'transcribe_fn') status.transcribe = value;
  }
  status.verified_at = verified === null ? null : withOffset(verified);
  return status;
}
