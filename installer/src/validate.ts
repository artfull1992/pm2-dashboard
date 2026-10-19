import { basename, dirname, isAbsolute, join, normalize } from 'node:path';

// Strict validation of everything an operator passes in. Values that reach env files, unit instance names or paths
// are limited to characters that need no quoting/escaping anywhere — no shell is ever used, but env files and systemd
// instance names have their own syntax.

export class InputError extends Error {}

/** Linux user/group names that are also valid systemd instance names. */
const NAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const SAFE_PATH_RE = /^\/[A-Za-z0-9._/-]+$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
// eslint-disable-next-line no-control-regex -- the point is to reject control characters
const CONTROL = /[\0-\x1f\x7f]/;
const EMAIL_RE = /^[^\s@<>"'`;&|$\\]{1,64}@[a-z0-9.-]{1,253}$/i;

export function linuxName(value: string | undefined, what: string): string {
  if (value === undefined || !NAME_RE.test(value)) throw new InputError(`${what}: очікується ім'я Linux-користувача (a-z, 0-9, _ або -, до 32 символів)`);
  if (value === 'root') throw new InputError(`${what}: root не підтримується`);
  return value;
}

/** Normalized absolute path of plain characters (no "..", no spaces, no control characters). */
export function safeAbsolutePath(value: string | undefined, what: string): string {
  if (value === undefined || !SAFE_PATH_RE.test(value) || normalize(value) !== value || value.split('/').includes('..') || (value.length > 1 && value.endsWith('/'))) {
    throw new InputError(`${what}: очікується нормалізований абсолютний шлях без пробілів і спецсимволів`);
  }
  return value;
}

/** A path to an existing file given on the command line (it is only read): absolute or relative, no control characters. */
export function filePath(value: string | undefined, what: string, cwd: string): string {
  if (value === undefined || value === '' || CONTROL.test(value)) throw new InputError(`${what}: потрібен шлях до файлу`);
  return normalize(isAbsolute(value) ? value : join(cwd, value));
}

/** https origin only: no credentials, path, query or fragment; a DNS name (not an IP literal) — what TLS certificates name. */
export function httpsOrigin(value: string | undefined, what: string): string {
  let url: URL;
  try {
    url = new URL(value ?? '');
  } catch {
    throw new InputError(`${what}: потрібна адреса виду https://control.example.com`);
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || (url.pathname !== '/' && url.pathname !== '')) {
    throw new InputError(`${what}: лише https://<домен>[:порт], без шляху, параметрів і облікових даних`);
  }
  if (!isDomain(url.hostname)) throw new InputError(`${what}: потрібне доменне ім'я (не IP-адреса)`);
  return url.origin;
}

/** A DNS name: dotted labels, the last one not numeric (so an IPv4 literal is not a domain). */
const isDomain = (value: string) => HOST_RE.test(value) && !/^\d+$/.test(value.split('.').at(-1) ?? '');

export function domainName(value: string | undefined, what: string): string {
  if (value === undefined || !isDomain(value)) throw new InputError(`${what}: потрібне доменне ім'я, наприклад control.example.com`);
  return value;
}

export function email(value: string | undefined, what: string): string {
  if (value === undefined || !EMAIL_RE.test(value)) throw new InputError(`${what}: некоректна адреса`);
  return value;
}

export interface ArtifactRef { path: string; checksumFile: string; revision: string; kind: 'api' | 'agent' }

/** node-control-<kind>-<40-hex sha>.tar.gz; the checksum file is <artifact>.sha256 next to it (as build-release writes). */
export function artifactRef(path: string, kind: 'api' | 'agent'): ArtifactRef {
  const m = new RegExp(`^node-control-${kind}-([0-9a-f]{40})\\.tar\\.gz$`).exec(basename(path));
  if (!m?.[1]) throw new InputError(`--artifact: очікується файл node-control-${kind}-<40-символьна ревізія>.tar.gz, зібраний build-release.js`);
  return { path, checksumFile: join(dirname(path), `${basename(path)}.sha256`), revision: m[1], kind };
}

/** "<64 hex>  <file name>" as written by build-release.js (and accepted by sha256sum -c). */
export function parseChecksumFile(text: string, artifactName: string): string {
  const m = /^([0-9a-f]{64}) [ *]?(\S+)\n?$/.exec(text);
  if (!m?.[1] || m[2] !== artifactName) throw new InputError('файл .sha256 не відповідає артефакту (очікується "<sha256>  <ім\'я файлу>")');
  return m[1];
}
