import type {
  ActionRequest,
  ActionResponse,
  CaptureResponse,
  DemoResetResponse,
  HealthResponse,
  HistoryResponse,
  PivotLogCreateRequest,
  PivotLogCreateResponse,
  PivotLogResponse,
  ProfileResponse,
  PutProfileRequest,
  PutTimetableRequest,
  RerankRequest,
  RerankResponse,
  TimetableResponse,
  TodayTimetableResponse,
} from '../types';
import type { AppConfig } from '../config';
import { createClock, type Clock } from '../clock';
import type { Backend, CaptureTextInput, CaptureVoiceInput, WarmPingResponse } from './backend';

function notImplemented(): Error {
  return new Error('live backend not implemented');
}

/**
 * Snowflake-backed implementation (source 'snowflake'). STUB: every method throws, so PipService
 * falls back to the in-memory backend. The Snowflake agent replaces these bodies.
 *
 * Helpers available: logSql (../log), ntzToIsoLocal / toNtzLocal (../clock), hydratePlan (../ranker/plan),
 * diffPlans (../ranker/diff), heuristicExtract (../ranker/extract), parseContextFromQuestion (../ranker/questions).
 */
export class LiveBackend implements Backend {
  readonly config: AppConfig;
  readonly clock: Clock;

  constructor(config: AppConfig, clock?: Clock) {
    this.config = config;
    this.clock = clock ?? createClock({ demoNow: config.demoNow, mode: config.mode });
  }

  async health(_refresh: boolean): Promise<HealthResponse> {
    throw notImplemented();
  }

  async captureText(_input: CaptureTextInput): Promise<CaptureResponse> {
    throw notImplemented();
  }

  async captureVoice(_input: CaptureVoiceInput): Promise<CaptureResponse> {
    throw notImplemented();
  }

  async rerank(_req: RerankRequest): Promise<RerankResponse> {
    throw notImplemented();
  }

  async timetableToday(_studentId: string): Promise<TodayTimetableResponse> {
    throw notImplemented();
  }

  async timetable(_studentId: string): Promise<TimetableResponse> {
    throw notImplemented();
  }

  async putTimetable(_req: PutTimetableRequest): Promise<TimetableResponse> {
    throw notImplemented();
  }

  async profile(_studentId: string): Promise<ProfileResponse> {
    throw notImplemented();
  }

  async putProfile(_req: PutProfileRequest): Promise<ProfileResponse> {
    throw notImplemented();
  }

  async recordAction(_req: ActionRequest): Promise<ActionResponse> {
    throw notImplemented();
  }

  async history(_studentId: string): Promise<HistoryResponse> {
    throw notImplemented();
  }

  async pivotLog(): Promise<PivotLogResponse> {
    throw notImplemented();
  }

  async createPivotLog(_req: PivotLogCreateRequest): Promise<PivotLogCreateResponse> {
    throw notImplemented();
  }

  async resetDemo(_studentId: string): Promise<DemoResetResponse> {
    throw notImplemented();
  }

  async warmPing(): Promise<WarmPingResponse> {
    throw notImplemented();
  }
}
