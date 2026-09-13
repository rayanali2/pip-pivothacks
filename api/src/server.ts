import os from 'node:os';
import { getConfig } from './config';
import { createClock } from './clock';
import { errorMessage, log } from './log';
import { MemoryBackend } from './backends/memory';
import { LiveBackend } from './backends/live';
import { preloadSnowflakeSdk } from './snowflake/client';
import { UniMateService } from './service';
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

async function main(): Promise<void> {
  const config = getConfig();
  const clock = createClock({ demoNow: config.demoNow, mode: config.mode });
  const memory = new MemoryBackend({ clock, snowflakeConfigured: config.snowflakeConfigured });
  if (config.mode === 'live') {
    // snowflake-sdk is large and its require() is synchronous: load it before listening so no request waits behind it.
    const ms = await preloadSnowflakeSdk();
    log.info(`snowflake-sdk loaded in ${ms} ms`);
  }
  const live = config.mode === 'live' ? new LiveBackend(config, clock) : undefined;
  const service = new UniMateService(config.mode, memory, live);
  const app = createApp(service);

  const server = app.listen(config.port, '0.0.0.0', () => {
    const clockNote = clock.pinned ? `clock pinned at ${clock.pinnedTime ?? ''}` : 'real clock';
    log.info(`mode=${config.mode} (${clockNote}), timezone=${config.timezone}`);
    const addresses = lanAddresses();
    if (addresses.length === 0) console.log(`UniMate API ${config.mode} on http://localhost:${config.port}`);
    for (const ip of addresses) console.log(`UniMate API ${config.mode} on http://${ip}:${config.port}`);
  });
  server.on('error', (err) => {
    log.error(`server error: ${errorMessage(err)}`);
    process.exitCode = 1;
  });

  if (live) {
    // Non-blocking: connects, verifies which Cortex functions work, MERGEs CORTEX_CONFIG and logs the result.
    log.info('live: verifying Snowflake Cortex functions in the background');
    live.verifyCortexInBackground().catch((err: unknown) => log.warn(`Cortex verification failed: ${errorMessage(err)}`));
    setInterval(() => {
      service.warmPing().catch((err: unknown) => log.warn(`warm ping failed: ${errorMessage(err)}`));
    }, WARM_PING_MS);
  }
}

main().catch((err: unknown) => {
  log.error(`startup failed: ${errorMessage(err)}`);
  process.exitCode = 1;
});
