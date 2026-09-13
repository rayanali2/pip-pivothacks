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
  Sourced,
  TimetableResponse,
  TodayTimetableResponse,
} from '../types';

export interface AudioUpload {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}

export interface CaptureTextInput {
  student_id: string;
  text: string;
  followup_plan_id: string | null;
}

export interface CaptureVoiceInput {
  student_id: string;
  audio: AudioUpload | null;
  followup_plan_id: string | null;
  /** iOS on-device speech result (multipart field client_transcript); null or absent when the app sent none */
  client_transcript?: string | null;
}

export interface WarmPingResponse extends Sourced {
  ok: boolean;
}

/**
 * One implementation per data source. MemoryBackend (source 'fallback') and LiveBackend (source 'snowflake').
 * Every method resolves to a full response body including `source`; PipService adds fallback on errors.
 */
export interface Backend {
  health(refresh: boolean): Promise<HealthResponse>;
  captureText(input: CaptureTextInput): Promise<CaptureResponse>;
  captureVoice(input: CaptureVoiceInput): Promise<CaptureResponse>;
  rerank(req: RerankRequest): Promise<RerankResponse>;
  timetableToday(studentId: string): Promise<TodayTimetableResponse>;
  timetable(studentId: string): Promise<TimetableResponse>;
  putTimetable(req: PutTimetableRequest): Promise<TimetableResponse>;
  profile(studentId: string): Promise<ProfileResponse>;
  putProfile(req: PutProfileRequest): Promise<ProfileResponse>;
  recordAction(req: ActionRequest): Promise<ActionResponse>;
  history(studentId: string): Promise<HistoryResponse>;
  pivotLog(): Promise<PivotLogResponse>;
  createPivotLog(req: PivotLogCreateRequest): Promise<PivotLogCreateResponse>;
  resetDemo(studentId: string): Promise<DemoResetResponse>;
  warmPing(): Promise<WarmPingResponse>;
}
