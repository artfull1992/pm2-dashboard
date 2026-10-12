// Minimal pg_hba.conf parser: enough to audit and idempotently append one scoped rule.
// Does not support quoted values containing spaces (not used on this server).

export const WEAK_METHODS = Object.freeze(['trust', 'password', 'md5']);
const BROAD_KEYWORDS = Object.freeze(['all', 'sameuser', 'samerole', 'samegroup', 'replication']);
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

export function parseHba(text) {
  return text.split('\n').flatMap((raw, index) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return [];
    const fields = line.split(/\s+/);
    const [type, database, user] = fields;
    const lineNo = index + 1;

    if (type.startsWith('include')) return [{ line: lineNo, type, target: fields[1] }];
    if (type === 'local') {
      return [{ line: lineNo, type, database, user, address: null, method: fields[3], options: fields.slice(4) }];
    }

    let address = fields[3];
    let rest = fields.slice(4);
    // Old-style "address netmask" form.
    if (IPV4_RE.test(address) && IPV4_RE.test(rest[0] ?? '')) {
      address = `${address} ${rest[0]}`;
      rest = rest.slice(1);
    }
    return [{ line: lineNo, type, database, user, address, method: rest[0], options: rest.slice(1) }];
  });
}

export function formatRule({ type, database, user, address, method }) {
  return [type.padEnd(8), database.padEnd(16), user.padEnd(20), (address ?? '').padEnd(16), method]
    .join('')
    .trimEnd();
}

export function sameRule(a, b) {
  return ['type', 'database', 'user', 'address', 'method'].every((key) => a[key] === b[key]);
}

export function hasRule(text, rule) {
  return parseHba(text).some((existing) => sameRule(existing, rule));
}

// Appends the rule at the end of the file unless an identical one already exists.
export function ensureRule(text, rule, comment) {
  if (hasRule(text, rule)) return { text, changed: false };
  const body = text.replace(/\n*$/, '\n');
  const header = comment ? `\n# ${comment}\n` : '\n';
  return { text: `${body}${header}${formatRule(rule)}\n`, changed: true };
}

function isBroad(value) {
  return value.split(',').some((part) => BROAD_KEYWORDS.includes(part) || part.startsWith('+') || part.startsWith('@'));
}

// Errors that make a rule unacceptable as "scoped to one database and one user".
export function scopedRuleErrors(rule) {
  const errors = [];
  if (!rule.database || isBroad(rule.database) || rule.database.includes(',')) errors.push('database is not a single named database');
  if (!rule.user || isBroad(rule.user) || rule.user.includes(',')) errors.push('user is not a single named role');
  if (rule.method !== 'scram-sha-256') errors.push(`method is ${rule.method}, expected scram-sha-256`);
  if (rule.type !== 'local' && rule.type !== 'hostssl') errors.push(`type is ${rule.type}, expected hostssl for network access`);
  return errors;
}

// Rules that apply to the given database by name (not via "all").
export function rulesForDatabase(rules, database) {
  return rules.filter((rule) => rule.database?.split(',').includes(database));
}

export function weakRules(rules) {
  return rules.filter((rule) => WEAK_METHODS.includes(rule.method));
}
