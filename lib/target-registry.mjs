import { RelayError } from './errors.mjs';

const REGISTRY_BASE_ORIGIN = 'https://registry.invalid';
const MAX_PATH_DECODE_PASSES = 4;
const ORIGIN_TEXT = /^(https?):\/\/([^/?#\\@\s]+)(\/?)$/i;

const hasOwn = (value, property) => Object.prototype.hasOwnProperty.call(value, property);

function fail(message) {
  throw new TypeError(`invalid target registry: ${message}`);
}

function invalidRelayTarget() {
  throw new RelayError(400, 'invalid_relay_target', 'invalid relay target');
}

function invalidRelayPath() {
  throw new RelayError(400, 'invalid_relay_path', 'invalid relay path');
}

function isDangerousPathSegment(segment) {
  return segment.includes('/')
    || segment.includes('\\')
    || segment === '.'
    || segment === '..';
}

function hasAmbiguousPathEncoding(pathname) {
  for (const originalSegment of pathname.split('/')) {
    let segment = originalSegment;

    for (let pass = 0; pass < MAX_PATH_DECODE_PASSES; pass += 1) {
      if (isDangerousPathSegment(segment)) return true;
      if (!/%[0-9a-f]{2}/i.test(segment)) break;

      try {
        segment = decodeURIComponent(segment);
      } catch {
        return true;
      }
    }

    if (
      isDangerousPathSegment(segment)
      || /%(?:25|2f|5c)/i.test(segment)
      || /^(?:\.|%2e){1,2}$/i.test(segment)
    ) {
      return true;
    }
  }

  return false;
}

function normalizeOrigin(value, onInvalid = invalidRelayTarget) {
  let raw;
  let parsed;
  try {
    raw = String(value);
  } catch {
    onInvalid();
  }

  const match = ORIGIN_TEXT.exec(raw);
  if (!match || match[2].endsWith(':')) onInvalid();

  try {
    parsed = new URL(raw);
  } catch {
    onInvalid();
  }

  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || raw.includes('?')
    || raw.includes('#')
    || parsed.search
    || parsed.hash
  ) {
    onInvalid();
  }

  return parsed.origin;
}

function normalizeBasePath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('basePath must be a non-empty string');
  }
  const raw = value;
  if (!raw.startsWith('/') || raw.startsWith('//') || /[\r\n]/.test(raw)) {
    fail('invalid basePath');
  }
  if (raw.includes('?') || raw.includes('#')) {
    fail('basePath must not contain query or fragment');
  }
  if (hasAmbiguousPathEncoding(raw)) fail('ambiguous basePath encoding');

  let parsed;
  try {
    parsed = new URL(raw, REGISTRY_BASE_ORIGIN);
  } catch {
    fail('invalid basePath');
  }
  if (parsed.origin !== REGISTRY_BASE_ORIGIN || parsed.search || parsed.hash) {
    fail('invalid basePath');
  }

  let pathname = parsed.pathname.replace(/\/+$/, '');
  if (!pathname) pathname = '/';
  return pathname;
}

function pathWithin(pathname, basePath) {
  return basePath === '/'
    || pathname === basePath
    || pathname.startsWith(`${basePath}/`);
}

export function loadTargetRegistry(value) {
  if (!value || value.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (typeof value.generation !== 'string' || !value.generation.trim()) {
    fail('generation required');
  }
  if (!Array.isArray(value.rules)) fail('rules must be an array');

  const rules = value.rules.map((rule, index) => {
    if (!rule?.ruleId) fail(`rules[${index}].ruleId required`);
    if (!Array.isArray(rule.connectionIds)) {
      fail(`rules[${index}].connectionIds must be an array`);
    }
    if (!hasOwn(rule, 'basePath')) fail(`rules[${index}].basePath required`);
    if (!Array.isArray(rule.families)) {
      fail(`rules[${index}].families must be an array`);
    }

    const hasOverrides = hasOwn(rule, 'overrides');
    if (
      hasOverrides
      && (
        rule.overrides === null
        || typeof rule.overrides !== 'object'
        || Array.isArray(rule.overrides)
      )
    ) {
      fail(`rules[${index}].overrides must be an object`);
    }

    const origin = normalizeOrigin(
      rule.origin,
      () => fail(`rules[${index}].origin invalid`)
    );
    const basePath = normalizeBasePath(rule.basePath);
    const families = [...new Set(rule.families.map(String))];
    const hasContext1m = hasOverrides && hasOwn(rule.overrides, 'context1m');
    const context1m = hasContext1m ? rule.overrides.context1m : undefined;
    if (hasContext1m && typeof context1m !== 'boolean') {
      fail(`rules[${index}].overrides.context1m must be boolean`);
    }

    return Object.freeze({
      ruleId: String(rule.ruleId),
      connectionIds: Object.freeze(rule.connectionIds.map(String)),
      origin,
      basePath,
      families: Object.freeze(families),
      overrides: Object.freeze({ context1m: context1m !== false })
    });
  });

  return Object.freeze({
    schemaVersion: 1,
    generation: value.generation,
    generatedAt: String(value.generatedAt || ''),
    rules: Object.freeze(rules)
  });
}

export function resolveRelayTarget({ targetHeader, pathHeader, registry }) {
  const origin = normalizeOrigin(targetHeader);
  const rawPath = String(pathHeader || '');
  if (
    !rawPath.startsWith('/')
    || rawPath.startsWith('//')
    || /[\r\n]/.test(rawPath)
  ) {
    invalidRelayPath();
  }

  const queryIndex = rawPath.indexOf('?');
  const rawPathname = queryIndex === -1 ? rawPath : rawPath.slice(0, queryIndex);
  if (hasAmbiguousPathEncoding(rawPathname)) invalidRelayPath();

  let url;
  try {
    url = new URL(rawPath, origin);
  } catch {
    invalidRelayPath();
  }
  if (
    url.origin !== origin
    || hasAmbiguousPathEncoding(url.pathname)
    || rawPath.includes('#')
    || url.hash
  ) {
    invalidRelayPath();
  }

  const matching = registry.rules
    .filter(rule => rule.origin === origin && pathWithin(url.pathname, rule.basePath))
    .sort((left, right) => right.basePath.length - left.basePath.length);

  if (matching.length === 0) {
    throw new RelayError(403, 'target_not_allowed', 'target not allowed');
  }

  return { url, rule: matching[0] };
}
