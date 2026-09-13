import type { PipelineStageStatus, Task } from '../types';
import { errorMessage, log } from '../log';
import { heuristicExtract, type ExtractResult } from '../ranker/extract';
import { claudeEngine, elapsed, ENGINE, now as perfNow } from '../pipeline';
import { claudeExtract, ClaudeExtractError, createClaudeClient, type ClaudeClient, type ClaudeExtractFailure } from './claudeExtract';

export interface ClaudeStatus {
  configured: boolean;
  /** null when not configured */
  model: string | null;
}

export interface ExtractOutcome {
  result: ExtractResult;
  /** 'Claude · <model>' or 'Heuristic parser' */
  engine: string;
  /** 'fallback' when Claude was configured but failed and the heuristic parser answered */
  status: Exclude<PipelineStageStatus, 'skipped'>;
  ms: number;
  /** why Claude did not answer ("Claude timed out"), or null */
  note: string | null;
}

/** Transcript -> tasks and constraints. Shared by the memory backend and the live backend's post-Cortex fallback. */
export interface TranscriptExtractor {
  readonly claude: ClaudeStatus;
  extract(text: string, now: Date, openTasks: readonly Task[]): Promise<ExtractOutcome>;
}

export interface ClaudeExtractorConfig {
  client: ClaudeClient;
  model: string;
  timeoutMs: number;
}

const CLAUDE_NOTES: Readonly<Record<ClaudeExtractFailure, string>> = {
  timeout: 'Claude timed out',
  refusal: 'Claude declined',
  invalid_output: 'Claude output invalid',
  api_error: 'Claude unavailable',
};

/** Claude first when configured; the heuristic parser on any error, timeout or invalid output (and always without Claude). */
export function createTranscriptExtractor(claude: ClaudeExtractorConfig | null): TranscriptExtractor {
  return {
    claude: { configured: claude !== null, model: claude ? claude.model : null },
    async extract(text: string, now: Date, openTasks: readonly Task[]): Promise<ExtractOutcome> {
      const started = perfNow();
      if (claude) {
        try {
          const result = await claudeExtract(text, now, openTasks, claude);
          return { result, engine: claudeEngine(claude.model), status: 'ok', ms: elapsed(started), note: null };
        } catch (err) {
          const reason: ClaudeExtractFailure = err instanceof ClaudeExtractError ? err.reason : 'api_error';
          log.warn(`Claude extraction failed (${reason}); using the heuristic parser: ${errorMessage(err)}`);
          return { result: heuristicExtract(text, now, openTasks), engine: ENGINE.heuristic, status: 'fallback', ms: elapsed(started), note: CLAUDE_NOTES[reason] };
        }
      }
      return { result: heuristicExtract(text, now, openTasks), engine: ENGINE.heuristic, status: 'ok', ms: elapsed(started), note: null };
    },
  };
}

/** From config: Claude when ANTHROPIC_API_KEY is set, heuristic parser only otherwise. */
export function extractorFromConfig(claude: { apiKey: string | null; model: string; timeoutMs: number }): TranscriptExtractor {
  if (claude.apiKey === null) return createTranscriptExtractor(null);
  return createTranscriptExtractor({ client: createClaudeClient(claude.apiKey), model: claude.model, timeoutMs: claude.timeoutMs });
}
