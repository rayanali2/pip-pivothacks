import { fixedClock } from '../src/clock';
import { MemoryBackend } from '../src/backends/memory';
import type { Backend } from '../src/backends/backend';
import { PipService } from '../src/service';

/** Today at 13:13 local time, pinned (the default MOCK_MODE clock). */
export function demoNow(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 13, 13, 0, 0);
}

export function mockService(): PipService {
  const memory = new MemoryBackend({ clock: fixedClock(demoNow()), snowflakeConfigured: false });
  return new PipService('mock', memory);
}

export function liveServiceWith(live: Backend): PipService {
  const memory = new MemoryBackend({ clock: fixedClock(demoNow()), snowflakeConfigured: true });
  return new PipService('live', memory, live);
}
