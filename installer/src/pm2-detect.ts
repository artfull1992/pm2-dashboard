import type { Host } from './host.js';

// Read-only discovery of running PM2 daemons for the Agent wizard. Only the process TITLE PM2 sets for its daemon
// ("PM2 vX.Y.Z: God Daemon (<PM2_HOME>)") and the process's real UID are used — never its environment, never a pm2
// command (any pm2 invocation may start a daemon). A candidate is a suggestion that the operator confirms.

const DAEMON_TITLE = /^PM2 v[0-9][0-9A-Za-z.+-]*: God Daemon \((\/[^()]*)\)$/;

export interface Pm2Daemon { pid: number; uid: number; owner: string | null; home: string | null; pm2Home: string }

export function findPm2Daemons(host: Host): Pm2Daemon[] {
  const seen = new Set<string>();
  const out: Pm2Daemon[] = [];
  for (const p of host.processes()) {
    const m = DAEMON_TITLE.exec(p.title);
    if (!m?.[1]) continue;
    const key = `${String(p.uid)}:${m[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const user = host.userById(p.uid);
    out.push({ pid: p.pid, uid: p.uid, owner: user?.name ?? null, home: user?.home ?? null, pm2Home: m[1] });
  }
  return out.sort((a, b) => (a.owner ?? '').localeCompare(b.owner ?? '') || a.pm2Home.localeCompare(b.pm2Home));
}
