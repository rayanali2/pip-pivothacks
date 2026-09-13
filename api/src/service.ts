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
} from './types';
import type { Mode } from './config';
import type { Clock } from './clock';
import { errorMessage, log } from './log';
import type { Backend, CaptureTextInput, CaptureVoiceInput, WarmPingResponse } from './backends/backend';
import type { MemoryBackend } from './backends/memory';

/**
 * mock: everything is served by the in-memory backend (source 'fallback').
 * live: the live backend first; on ANY error, log a warning and run the same operation on memory (source 'fallback').
 */
export class PipService {
  readonly mode: Mode;
  readonly memory: MemoryBackend;
  readonly live: Backend | null;

  constructor(mode: Mode, memory: MemoryBackend, live?: Backend) {
    this.mode = mode;
    this.memory = memory;
    this.live = live ?? null;
  }

  get clock(): Clock {
    return this.memory.clock;
  }

  private async run<T>(op: string, fn: (backend: Backend) => Promise<T>): Promise<T> {
    if (this.mode === 'mock' || !this.live) return fn(this.memory);
    try {
      return await fn(this.live);
    } catch (err) {
      log.warn(`live ${op} failed, using local fallback: ${errorMessage(err)}`);
      return fn(this.memory);
    }
  }

  async health(refresh: boolean): Promise<HealthResponse> {
    if (this.mode === 'mock' || !this.live) {
      const h = await this.memory.health(refresh);
      return { ...h, mode: this.mode === 'mock' ? 'mock' : 'live' };
    }
    try {
      return await this.live.health(refresh);
    } catch (err) {
      const message = errorMessage(err);
      log.warn(`live health failed: ${message}`);
      const h = await this.memory.health(refresh);
      return {
        ...h,
        mode: 'live',
        snowflake: { ...h.snowflake, connected: false, error: message },
        cortex: { ...h.cortex, errors: [message] },
      };
    }
  }

  captureText(input: CaptureTextInput): Promise<CaptureResponse> {
    return this.run('captureText', (b) => b.captureText(input));
  }

  captureVoice(input: CaptureVoiceInput): Promise<CaptureResponse> {
    return this.run('captureVoice', (b) => b.captureVoice(input));
  }

  rerank(req: RerankRequest): Promise<RerankResponse> {
    return this.run('rerank', (b) => b.rerank(req));
  }

  timetableToday(studentId: string): Promise<TodayTimetableResponse> {
    return this.run('timetableToday', (b) => b.timetableToday(studentId));
  }

  timetable(studentId: string): Promise<TimetableResponse> {
    return this.run('timetable', (b) => b.timetable(studentId));
  }

  putTimetable(req: PutTimetableRequest): Promise<TimetableResponse> {
    return this.run('putTimetable', (b) => b.putTimetable(req));
  }

  profile(studentId: string): Promise<ProfileResponse> {
    return this.run('profile', (b) => b.profile(studentId));
  }

  putProfile(req: PutProfileRequest): Promise<ProfileResponse> {
    return this.run('putProfile', (b) => b.putProfile(req));
  }

  recordAction(req: ActionRequest): Promise<ActionResponse> {
    return this.run('recordAction', (b) => b.recordAction(req));
  }

  history(studentId: string): Promise<HistoryResponse> {
    return this.run('history', (b) => b.history(studentId));
  }

  pivotLog(): Promise<PivotLogResponse> {
    return this.run('pivotLog', (b) => b.pivotLog());
  }

  createPivotLog(req: PivotLogCreateRequest): Promise<PivotLogCreateResponse> {
    return this.run('createPivotLog', (b) => b.createPivotLog(req));
  }

  resetDemo(studentId: string): Promise<DemoResetResponse> {
    return this.run('resetDemo', (b) => b.resetDemo(studentId));
  }

  warmPing(): Promise<WarmPingResponse> {
    return this.run('warmPing', (b) => b.warmPing());
  }
}
