import { describe, expect, it } from 'vitest';
import { appendMissing, assertEnvValue, missingKeys, renderEnv } from '../src/envfile.js';
import { renderNginxSite } from '../src/nginx.js';
import { singleLine } from '../src/secrets.js';
import { artifactRef, email, httpsOrigin, linuxName, parseChecksumFile, safeAbsolutePath } from '../src/validate.js';

// Input validation and env-file handling: injection-like values never reach env files, unit names or paths.

describe('validation', () => {
  it('names: Linux users usable as systemd instance names; root refused', () => {
    expect(linuxName('deploy', 'x')).toBe('deploy');
    for (const bad of ['root', 'Deploy', 'a b', 'a;b', 'a/b', '../x', '-x', 'x'.repeat(33), '', 'a\nb', 'a@b']) expect(() => linuxName(bad, 'x')).toThrow();
  });

  it('paths: normalized absolute plain paths only', () => {
    expect(safeAbsolutePath('/home/deploy/.pm2', 'x')).toBe('/home/deploy/.pm2');
    for (const bad of ['relative/x', '/a/../b', '/a/./b', '/a//b', '/a b', '/a\nb', '/a;b', '/a$(id)', '/a/', '/a`b`']) expect(() => safeAbsolutePath(bad, 'x')).toThrow();
  });

  it('origins: https + DNS name only (no IP, path, query, credentials)', () => {
    expect(httpsOrigin('https://control.example.com', 'x')).toBe('https://control.example.com');
    expect(httpsOrigin('https://control.example.com:8443/', 'x')).toBe('https://control.example.com:8443');
    for (const bad of ['http://control.example.com', 'https://203.0.113.10', 'https://[2001:db8::1]', 'https://u:p@control.example.com', 'https://control.example.com/x',
      'https://control.example.com?a=1', 'https://control.example.com#f', 'https://localhost', 'not a url', '']) expect(() => httpsOrigin(bad, 'x')).toThrow();
  });

  it('email: no shell or quoting characters', () => {
    expect(email('admin@example.com', 'x')).toBe('admin@example.com');
    for (const bad of ['a@b;reboot', '$(id)@example.com', 'a b@example.com', 'a@example.com\n', '"a"@example.com', 'no-at']) expect(() => email(bad, 'x')).toThrow();
  });

  it('artifact name carries the full revision; the checksum file must name the same artifact', () => {
    const sha = 'f'.repeat(40);
    expect(artifactRef(`/t/node-control-api-${sha}.tar.gz`, 'api')).toEqual({ path: `/t/node-control-api-${sha}.tar.gz`, checksumFile: `/t/node-control-api-${sha}.tar.gz.sha256`, revision: sha, kind: 'api' });
    expect(() => artifactRef(`/t/node-control-agent-${sha}.tar.gz`, 'api')).toThrow();
    expect(() => artifactRef('/t/node-control-api-abc.tar.gz', 'api')).toThrow();
    const digest = 'e'.repeat(64);
    expect(parseChecksumFile(`${digest}  a.tar.gz\n`, 'a.tar.gz')).toBe(digest);
    expect(() => parseChecksumFile(`${digest}  b.tar.gz\n`, 'a.tar.gz')).toThrow();
    expect(() => parseChecksumFile(`${digest}  a.tar.gz\n${digest}  a.tar.gz\n`, 'a.tar.gz')).toThrow();
  });

  it('secret input: exactly one line, no control characters', () => {
    expect(singleLine('abc\n', 'x')).toBe('abc');
    expect(singleLine('abc\r\n', 'x')).toBe('abc');
    for (const bad of ['', '\n', 'a\nb', 'a\u0000b', 'a\tb\n']) expect(() => singleLine(bad, 'x')).toThrow();
  });
});

describe('env files: only missing keys are appended, nothing else changes', () => {
  it('appendMissing keeps every existing byte (comments, order, odd spacing) and adds only what is missing', () => {
    const text = '# comment\nDB_PASS=keep-me\nAUTH_ALLOWED_ORIGINS=\nX=1';
    const r = appendMissing(text, [['AUTH_ALLOWED_ORIGINS', 'https://a.example.com'], ['AUTH_COOKIE_SECURE', 'true']]);
    expect(r.text).toBe(`${text}\nAUTH_COOKIE_SECURE=true\n`);
    expect(r.added).toEqual(['AUTH_COOKIE_SECURE']);
    expect(appendMissing(r.text, [['AUTH_COOKIE_SECURE', 'false']]).added).toEqual([]);
    expect(missingKeys('A=1\n', ['A', 'B'])).toEqual(['B']);
  });

  it('values that could break the file or inject keys are refused', () => {
    for (const bad of ['a b', 'a\nB=1', 'a#b', '"a"', "a'b", 'a$b', 'a`b`', 'a\\b']) expect(() => { assertEnvValue('K', bad); }).toThrow();
    expect(() => { assertEnvValue('lower', 'x'); }).toThrow();
    expect(renderEnv([['K', 'https://a.example.com:8443'], ['B64', 'ab+/c=']], '# h')).toBe('# h\nK=https://a.example.com:8443\nB64=ab+/c=\n');
  });
});

describe('nginx site', () => {
  it('validated names and paths only; X-Forwarded-For replaced, loopback API', () => {
    const text = renderNginxSite({ serverName: 'control.example.com', certificate: '/etc/ssl/a.pem', certificateKey: '/etc/ssl/a.key' });
    expect(text).toMatch(/server_name control\.example\.com;/);
    expect(text).not.toMatch(/proxy_add_x_forwarded_for\s*;/);
    for (const bad of [{ serverName: 'a.example.com;}', certificate: '/a', certificateKey: '/b' }, { serverName: 'a.example.com', certificate: '/a;b', certificateKey: '/b' }]) {
      expect(() => renderNginxSite(bad)).toThrow();
    }
  });
});
