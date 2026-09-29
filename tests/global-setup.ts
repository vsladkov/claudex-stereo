import { reapLeakedTestBrokers } from './broker-reaper.ts';

// Runs in the test-runner process after every test file has finished
// (node --test-global-setup). The per-file afterEach reapers are the primary
// cleanup; this net catches anything of this run that slips through (brokers
// carrying its STEREO_TEST_RUN_ID; a concurrent run's are left alone) so a
// suite run can never strand broker processes on the machine. A nonzero
// count is a bug in a test file.
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
