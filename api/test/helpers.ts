import { fixedClock } from '../src/clock';
import { MemoryBackend } from '../src/backends/memory';
import type { Backend } from '../src/backends/backend';
import { UniMateService } from '../src/service';

/** Today at 13:13 local time, explicitly pinned for demo tests. */
export function demoNow(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 13, 13, 0, 0);
}

export function mockService(): UniMateService {
  const memory = new MemoryBackend({ clock: fixedClock(demoNow()), snowflakeConfigured: false });
  return new UniMateService('mock', memory);
}

export function liveServiceWith(live: Backend): UniMateService {
  const memory = new MemoryBackend({ clock: fixedClock(demoNow()), snowflakeConfigured: true });
  return new UniMateService('live', memory, live);
}
