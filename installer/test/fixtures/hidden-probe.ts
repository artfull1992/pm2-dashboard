// Child process for the real-PTY test of processInput.hidden: reads one hidden value, then reports ONLY metadata
// (outcome, whether it equals the expected value, raw-mode state and leftover listeners) — never the value itself.
import { processInput } from '../../src/secrets.js';

const expected = process.env.PROBE_EXPECT ?? '';
const before = { data: process.stdin.listenerCount('data'), end: process.stdin.listenerCount('end') };
let outcome: string;
let matches = false;
let length = 0;
try {
  const value = await processInput.hidden('KEY: ');
  outcome = 'value';
  matches = value === expected;
  length = value.length;
} catch (error) {
  outcome = `cancel:${error instanceof Error ? error.message : 'unknown'}`;
}
process.stdout.write(`\nRESULT ${JSON.stringify({
  outcome, matches, length,
  rawAfter: process.stdin.isRaw,
  dataListeners: process.stdin.listenerCount('data') - before.data,
  endListeners: process.stdin.listenerCount('end') - before.end,
})}\n`);
process.exit(0);
