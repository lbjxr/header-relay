import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { sanitizeLogMessage } from './header-utils.mjs';
import { loadProfiles } from './profile-registry.mjs';
import { loadTargetRegistry } from './target-registry.mjs';

const FORWARD_PREFIX_BASE_ORIGIN = 'http://127.0.0.1';
const MAX_PREFIX_DECODE_PASSES = 4;

function readSource(filename, unavailableMessage) {
  try {
    return fs.readFileSync(filename, 'utf8');
  } catch {
    throw new TypeError(unavailableMessage);
  }
}

function parseJson(raw, invalidMessage) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new TypeError(invalidMessage);
  }
}

function readConfigSource(configPath) {
  const raw = readSource(configPath, 'configuration unavailable');
  return {
    raw,
    value: parseJson(raw, 'invalid configuration JSON')
  };
}

function positiveInteger(value, name, fallback) {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return selected;
}

function configuredPath(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty path`);
  }
  return path.resolve(value);
}

function normalizeListen(value) {
  if (value?.host !== '127.0.0.1') {
    throw new TypeError('listen.host must be 127.0.0.1');
  }
  return Object.freeze({
    host: value.host,
    port: positiveInteger(value.port, 'listen.port')
  });
}

function invalidForwardPrefix() {
  throw new TypeError('forward.pathPrefix must be a non-root absolute path');
}

function isUnsafePrefixSegment(segment) {
  return segment.includes('/')
    || segment.includes('\\')
    || segment === '.'
    || segment === '..'
    || /[?#\u0000-\u001f\u007f-\u009f]/.test(segment);
}

function hasAmbiguousPrefixEncoding(prefix) {
  for (const originalSegment of prefix.split('/')) {
    let segment = originalSegment;

    for (let pass = 0; pass < MAX_PREFIX_DECODE_PASSES; pass += 1) {
      if (isUnsafePrefixSegment(segment)) return true;
      if (!segment.includes('%')) break;

      try {
        segment = decodeURIComponent(segment);
      } catch {
        return true;
      }
    }

    if (isUnsafePrefixSegment(segment) || segment.includes('%')) return true;
  }
  return false;
}

function normalizeForwardPrefix(value) {
  const selected = value ?? '/forward';
  if (typeof selected !== 'string') invalidForwardPrefix();

  const prefix = selected.replace(/\/+$/, '');
  if (
    prefix === ''
    || !prefix.startsWith('/')
    || prefix.startsWith('//')
    || prefix.includes('//')
    || /[?#\r\n]/.test(prefix)
  ) {
    invalidForwardPrefix();
  }

  let parsed;
  try {
    parsed = new URL(prefix, FORWARD_PREFIX_BASE_ORIGIN);
  } catch {
    invalidForwardPrefix();
  }
  if (
    parsed.origin !== FORWARD_PREFIX_BASE_ORIGIN
    || parsed.pathname !== prefix
    || parsed.search
    || parsed.hash
    || hasAmbiguousPrefixEncoding(prefix)
  ) {
    invalidForwardPrefix();
  }

  return prefix;
}

function normalizeForward(value) {
  if (value?.enabled !== true) throw new TypeError('forward.enabled required');
  return Object.freeze({
    enabled: true,
    pathPrefix: normalizeForwardPrefix(value.pathPrefix),
    tokenFile: configuredPath(value.tokenFile, 'forward.tokenFile'),
    targetsFile: configuredPath(value.targetsFile, 'forward.targetsFile'),
    profilesDir: configuredPath(value.profilesDir, 'forward.profilesDir'),
    maxBodyBytes: positiveInteger(
      value.maxBodyBytes,
      'forward.maxBodyBytes',
      134217728
    ),
    maxBufferedRequests: positiveInteger(
      value.maxBufferedRequests,
      'forward.maxBufferedRequests',
      4
    ),
    maxBufferedBytes: positiveInteger(
      value.maxBufferedBytes,
      'forward.maxBufferedBytes',
      268435456
    ),
    upstreamHeaderTimeoutMs: positiveInteger(
      value.upstreamHeaderTimeoutMs,
      'forward.upstreamHeaderTimeoutMs',
      180000
    ),
    streamIdleTimeoutMs: positiveInteger(
      value.streamIdleTimeoutMs,
      'forward.streamIdleTimeoutMs',
      300000
    )
  });
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function normalizeRoutes(config, configPath) {
  if (!Array.isArray(config.routes)) throw new TypeError('routes must be an array');

  const routes = config.routes.map(route => {
    if (
      !route
      || typeof route.name !== 'string'
      || route.name.length === 0
      || typeof route.prefix !== 'string'
      || route.prefix.length === 0
      || typeof route.target !== 'string'
      || route.target.length === 0
    ) {
      throw new TypeError('route name/prefix/target required');
    }

    const normalized = structuredClone(route);
    normalized.prefix = normalized.prefix.replace(/\/+$/, '') || '/';
    try {
      new URL(normalized.target);
    } catch {
      throw new TypeError('route target must be an absolute URL');
    }

    if (normalized.codexCompat && normalized.codexCompat.enabled !== false) {
      const settings = normalized.codexCompat === true ? {} : normalized.codexCompat;
      const instructionsFile = settings.instructionsFile
        || path.join(path.dirname(configPath), 'codex-instructions.txt');
      normalized._codexCompat = {
        ...settings,
        instructionsFile,
        instructions: readSource(
          instructionsFile,
          'legacy Codex instructions unavailable'
        )
      };
    }
    return deepFreeze(normalized);
  });

  routes.sort((left, right) => right.prefix.length - left.prefix.length);
  return Object.freeze(routes);
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function profileSource(profiles) {
  return canonicalJson(
    [...profiles.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, profile]) => [id, profile])
  );
}

function loadProfileSource(directory) {
  try {
    return loadProfiles(directory);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new TypeError('invalid profile source JSON');
    }
    throw new TypeError('invalid profile source');
  }
}

function buildSnapshot({
  configPath,
  configSource,
  token,
  startupTokenFile,
  startupListen
}) {
  const config = configSource.value;
  const listen = normalizeListen(config.listen);
  const forward = normalizeForward(config.forward);
  if (listen.host !== startupListen.host || listen.port !== startupListen.port) {
    throw new TypeError('listen change requires restart');
  }
  if (forward.tokenFile !== startupTokenFile) {
    throw new TypeError('tokenFile change requires restart');
  }

  const requestTimeoutMs = positiveInteger(
    config.requestTimeoutMs,
    'requestTimeoutMs',
    120000
  );
  const maxBodyBytes = positiveInteger(
    config.maxBodyBytes,
    'maxBodyBytes',
    104857600
  );
  const sync = deepFreeze(structuredClone(config.sync || {}));
  const routes = normalizeRoutes(config, configPath);

  const targetRaw = readSource(forward.targetsFile, 'target registry unavailable');
  const targetValue = parseJson(targetRaw, 'invalid target registry JSON');
  const targetRegistry = loadTargetRegistry(targetValue);
  const profiles = loadProfileSource(forward.profilesDir);
  const normalizedProfiles = profileSource(profiles);
  const normalizedRoutes = canonicalJson(routes);
  const sourceDigest = createHash('sha256')
    .update('config\0')
    .update(configSource.raw)
    .update('\0targets\0')
    .update(targetRaw)
    .update('\0profiles\0')
    .update(normalizedProfiles)
    .update('\0legacy-routes\0')
    .update(normalizedRoutes)
    .digest('hex');

  return Object.freeze({
    configPath,
    sourceDigest,
    token,
    listen,
    requestTimeoutMs,
    maxBodyBytes,
    forward,
    sync,
    routes,
    targetRegistry,
    profiles
  });
}

function logSafely(logger, level, row) {
  try {
    const result = logger(level, row);
    result?.catch?.(() => {});
  } catch {
    // Logging must never change configuration state or reload results.
  }
}

export class SnapshotStore {
  constructor({ configPath, logger = () => {}, watch = false, watchIntervalMs = 2000 }) {
    this.configPath = path.resolve(configPath);
    this.logger = logger;

    const configSource = readConfigSource(this.configPath);
    this.listen = normalizeListen(configSource.value.listen);
    const startupForward = normalizeForward(configSource.value.forward);
    this.tokenFile = startupForward.tokenFile;
    this.token = readSource(this.tokenFile, 'relay token unavailable').trim();
    if (!this.token) throw new TypeError('relay token must not be empty');

    this.current = buildSnapshot({
      configPath: this.configPath,
      configSource,
      token: this.token,
      startupTokenFile: this.tokenFile,
      startupListen: this.listen
    });
    this.timer = null;
    if (watch) this.startWatching(watchIntervalMs);
  }

  getSnapshot() {
    return this.current;
  }

  getReady() {
    return {
      ok: true,
      generation: this.current.targetRegistry.generation,
      targetCount: this.current.targetRegistry.rules.length,
      profileIds: [...this.current.profiles.keys()].sort()
    };
  }

  reload() {
    let candidate;
    try {
      candidate = buildSnapshot({
        configPath: this.configPath,
        configSource: readConfigSource(this.configPath),
        token: this.token,
        startupTokenFile: this.tokenFile,
        startupListen: this.listen
      });
    } catch (error) {
      logSafely(this.logger, 'error', {
        event: 'config_reload_failed',
        message: sanitizeLogMessage(error?.message)
      });
      return false;
    }

    if (candidate.sourceDigest === this.current.sourceDigest) return false;

    this.current = candidate;
    logSafely(this.logger, 'info', {
      event: 'config_reloaded',
      generation: candidate.targetRegistry.generation,
      targetCount: candidate.targetRegistry.rules.length,
      profileIds: [...candidate.profiles.keys()].sort()
    });
    return true;
  }

  startWatching(intervalMs = 2000) {
    if (this.timer) return;
    const selectedInterval = positiveInteger(intervalMs, 'watchIntervalMs', 2000);
    this.timer = setInterval(() => this.reload(), selectedInterval);
    this.timer.unref?.();
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
