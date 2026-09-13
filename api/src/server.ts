import os from 'node:os';
import { getConfig } from './config';
import { createClock } from './clock';
import { errorMessage, log } from './log';
import { MemoryBackend } from './backends/memory';
import { LiveBackend } from './backends/live';
import { PipService } from './service';
import { createApp } from './app';

const WARM_PING_MS = 4 * 60 * 1000;

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address);
    }
  }
  return out;
}

function main(): void {
  const config = getConfig();
  const clock = createClock({ demoNow: config.demoNow, mode: config.mode });
  const memory = new MemoryBackend({ clock, snowflakeConfigured: config.snowflakeConfigured });
  const live = config.mode === 'live' ? new LiveBackend(config, clock) : undefined;
  const service = new PipService(config.mode, memory, live);
  const app = createApp(service);

  const server = app.listen(config.port, '0.0.0.0', () => {
    const clockNote = clock.pinned ? `clock pinned at ${clock.pinnedTime ?? ''}` : 'real clock';
    log.info(`mode=${config.mode} (${clockNote}), timezone=${config.timezone}`);
    const addresses = lanAddresses();
    if (addresses.length === 0) console.log(`Pip API ${config.mode} on http://localhost:${config.port}`);
    for (const ip of addresses) console.log(`Pip API ${config.mode} on http://${ip}:${config.port}`);
  });
  server.on('error', (err) => {
    log.error(`server error: ${errorMessage(err)}`);
    process.exitCode = 1;
  });

  setInterval(() => {
    service.warmPing().catch((err: unknown) => log.warn(`warm ping failed: ${errorMessage(err)}`));
  }, WARM_PING_MS);
}

main();
