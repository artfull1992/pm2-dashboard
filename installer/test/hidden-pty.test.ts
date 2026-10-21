import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// processInput.hidden on a REAL pseudo terminal (python3 pty + tsx, no extra dependency): the child switches the
// terminal to raw mode, so Ctrl+D arrives as the byte 0x04 (no "end" event) and Ctrl+C as 0x03. Each must end the
// prompt without hanging, restore the terminal mode and leave no listener behind; a typed value never appears in the
// output. Review 2026-10-21 (P2): Ctrl+D used to be appended to the secret while the prompt kept waiting.

const ROOT = join(import.meta.dirname, '..', '..');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const PROBE = join(import.meta.dirname, 'fixtures', 'hidden-probe.ts');
const SECRET = 'ncag_SyntheticPtyValue_0123456789';

// Waits for the prompt in the pty, types `keys`, then collects the output until the child exits (or 20 s pass).
const DRIVER = String.raw`
import os, pty, select, sys, time
keys = sys.argv[1].encode("latin-1").decode("unicode_escape").encode("latin-1")
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[2], sys.argv[2:])
out, sent, end = b"", False, time.time() + 20
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 0.1)
    if r:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break  # EIO: the child closed the terminal (it exited)
        if not chunk:
            break
        out += chunk
    if not sent and b"KEY: " in out:
        time.sleep(0.3)
        os.write(fd, keys)
        sent = True
for _ in range(50):
    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        sys.stdout.write(out.decode("utf-8", "replace"))
        sys.exit(0)
    time.sleep(0.1)
os.kill(pid, 9)
sys.stdout.write(out.decode("utf-8", "replace") + "\nHANG\n")
`;

function typeAtPrompt(keys: string) {
  const r = spawnSync('python3', ['-c', DRIVER, keys, TSX, PROBE], { encoding: 'utf8', env: { ...process.env, PROBE_EXPECT: SECRET }, timeout: 40_000 });
  const out = r.stdout;
  const line = /RESULT (\{.*\})/.exec(out)?.[1];
  return { out, hang: out.includes('HANG'), result: line ? JSON.parse(line) as Record<string, unknown> : null };
}

describe('hidden input on a real PTY', () => {
  it('Ctrl+D (0x04 in raw mode) cancels: no hang, nothing appended, terminal mode and listeners restored', () => {
    const r = typeAtPrompt(String.raw`abc\x04`);
    expect(r.hang, r.out).toBe(false);
    expect(r.result).toMatchObject({ outcome: 'cancel:скасовано', rawAfter: false, dataListeners: 0, endListeners: 0 });
  }, 45_000);

  it('Ctrl+C cancels the same way', () => {
    const r = typeAtPrompt(String.raw`abc\x03`);
    expect(r.hang, r.out).toBe(false);
    expect(r.result).toMatchObject({ outcome: 'cancel:скасовано', rawAfter: false, dataListeners: 0, endListeners: 0 });
  }, 45_000);

  it('a typed value + Enter is returned exactly (backspace honoured, other control bytes ignored) and never echoed', () => {
    const r = typeAtPrompt(`${SECRET}X\\x7f\\x01\\r`);
    expect(r.hang, r.out).toBe(false);
    expect(r.result).toMatchObject({ outcome: 'value', matches: true, length: SECRET.length, rawAfter: false, dataListeners: 0, endListeners: 0 });
    expect(r.out).not.toContain(SECRET);
  }, 45_000);
});
