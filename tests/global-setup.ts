import { reapLeakedTestBrokers } from './broker-reaper.ts';

// Runs in the test-runner process after every test file has finished
// (node --test-global-setup). The per-file afterEach reapers are the primary
// cleanup; this net catches anything that slips through so a suite run can
// never strand broker processes on the machine.
export async function globalTeardown(): Promise<void> {
  const { reaped, details } = await reapLeakedTestBrokers({
    removeDeadSessionDirs: true,
  });
  if (reaped > 0) {
    console.error(
      `[broker-reaper] global teardown reaped ${reaped} leaked test broker(s): ${details.join(', ')} - a test is missing its cleanup`,
    );
  }
}
