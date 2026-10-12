import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Development and E2E only: the UI and /api are served from ONE loopback origin through this proxy,
// so the browser's Origin header is the Vite origin itself (which the backend must list in
// AUTH_ALLOWED_ORIGINS). The proxy does not rewrite Origin. Production serves dist/ via host Nginx.
const LOOPBACK_URL_RE = /^http:\/\/127\.0\.0\.1:\d{2,5}$/;

function apiTarget(): string {
  const target = process.env.NC_API_URL ?? 'http://127.0.0.1:3100';
  if (!LOOPBACK_URL_RE.test(target)) throw new Error('NC_API_URL must be http://127.0.0.1:<port>');
  return target;
}

function port(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`${name} must be a port 1024-65535`);
  return value;
}

const proxy = { '/api': { target: apiTarget(), changeOrigin: false, xfwd: false } };

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: { host: '127.0.0.1', port: port('NC_UI_PORT', 5173), strictPort: true, proxy },
  preview: { host: '127.0.0.1', port: port('NC_PREVIEW_PORT', 4173), strictPort: true, proxy },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, assetsDir: 'assets', target: 'es2022' },
});
