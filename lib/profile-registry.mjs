import fs from 'node:fs';
import { validateHeaderValue } from 'node:http';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { normalizeCodexRequest } from '../codex-compat.mjs';
import { deleteHeader, getHeader, mergeCsvHeader, setHeader } from './header-utils.mjs';

const CONTEXT_1M = 'context-1m-2025-08-07';
const REQUIRED_PROFILE_IDS = [
  'codex-full-v1',
  'codex-headers-v1',
  'claude-safe-v1',
  'claude-headers-v1'
];
const BODY_MODES = new Set([
  'codex-responses',
  'passthrough-buffered',
  'passthrough-stream'
]);
const GENERIC_BODY_MODES = new Set(['passthrough-buffered', 'passthrough-stream']);
const PROFILE_FAMILIES = new Set(['codex', 'claude']);
const GENERIC_PROFILE_FIELDS = new Set([
  'id',
  'family',
  'clientVersion',
  'bodyMode',
  'headers',
  'sessionHeader',
  'acceptFromStream',
  'beta'
]);
const AUTHENTICATION_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'cookie'
]);
const TRANSPORT_HEADER_NAMES = new Set([
  'host',
  'content-length',
  'connection',
  'accept-encoding',
  'keep-alive',
  'proxy-authenticate',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);
const PROFILE_PROTECTED_BUSINESS_HEADERS = new Set([
  'content-type'
]);
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const PINNED_PROFILE_CONTRACTS = {
  'codex-full-v1': {
    id: 'codex-full-v1',
    family: 'codex',
    clientVersion: '0.136.0',
    bodyMode: 'codex-responses',
    instructionsFile: '../codex-instructions.txt',
    headers: {
      'User-Agent': 'codex_cli_rs/0.136.0',
      originator: 'codex_cli_rs',
      Accept: 'text/event-stream'
    },
    sessionHeader: 'session_id',
    reasoningEffort: 'low',
    verbosity: 'low'
  },
  'codex-headers-v1': {
    id: 'codex-headers-v1',
    family: 'codex',
    clientVersion: '0.136.0',
    bodyMode: 'passthrough-buffered',
    headers: {
      'User-Agent': 'codex_cli_rs/0.136.0',
      originator: 'codex_cli_rs'
    },
    sessionHeader: 'session_id',
    acceptFromStream: true
  },
  'claude-safe-v1': {
    id: 'claude-safe-v1',
    family: 'claude',
    clientVersion: '2.1.92',
    bodyMode: 'passthrough-stream',
    headers: {
      'User-Agent': 'claude-cli/2.1.92 (external, sdk-cli)',
      'Anthropic-Version': '2023-06-01',
      'Anthropic-Dangerous-Direct-Browser-Access': 'true',
      'X-App': 'cli',
      'X-Stainless-Helper-Method': 'stream',
      'X-Stainless-Retry-Count': '0',
      'X-Stainless-Runtime-Version': 'v24.14.0',
      'X-Stainless-Package-Version': '0.80.0',
      'X-Stainless-Runtime': 'node',
      'X-Stainless-Lang': 'js',
      'X-Stainless-Arch': 'arm64',
      'X-Stainless-Os': 'Linux',
      'X-Stainless-Timeout': '600'
    },
    sessionHeader: 'X-Claude-Code-Session-Id',
    beta: [
      'claude-code-20250219',
      'oauth-2025-04-20',
      'interleaved-thinking-2025-05-14',
      'context-management-2025-06-27',
      'prompt-caching-scope-2026-01-05',
      'advanced-tool-use-2025-11-20',
      'effort-2025-11-24',
      'structured-outputs-2025-12-15',
      'fast-mode-2026-02-01',
      'redact-thinking-2026-02-12',
      'token-efficient-tools-2026-03-28',
      'context-1m-2025-08-07'
    ]
  },
  'claude-headers-v1': {
    id: 'claude-headers-v1',
    family: 'claude',
    clientVersion: '2.1.92',
    bodyMode: 'passthrough-buffered',
    headers: {
      'User-Agent': 'claude-cli/2.1.92 (external, sdk-cli)',
      'X-App': 'cli',
      'X-Stainless-Helper-Method': 'stream',
      'X-Stainless-Retry-Count': '0',
      'X-Stainless-Runtime-Version': 'v24.14.0',
      'X-Stainless-Package-Version': '0.80.0',
      'X-Stainless-Runtime': 'node',
      'X-Stainless-Lang': 'js',
      'X-Stainless-Arch': 'arm64',
      'X-Stainless-Os': 'Linux',
      'X-Stainless-Timeout': '600'
    },
    sessionHeader: 'X-Claude-Code-Session-Id',
    acceptFromStream: true
  }
};

class ReadonlyProfileMap extends Map {
  constructor(entries) {
    super();
    for (const [key, value] of entries) Map.prototype.set.call(this, key, value);
    Object.freeze(this);
  }

  set() {
    throw new TypeError('profile registry is read-only');
  }

  delete() {
    throw new TypeError('profile registry is read-only');
  }

  clear() {
    throw new TypeError('profile registry is read-only');
  }
}

function invalidProfile(filename, message) {
  throw new TypeError(`invalid profile manifest: ${filename}: ${message}`);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function isForbiddenManifestHeader(name) {
  const lower = String(name).toLowerCase();
  return AUTHENTICATION_HEADER_NAMES.has(lower)
    || TRANSPORT_HEADER_NAMES.has(lower)
    || PROFILE_PROTECTED_BUSINESS_HEADERS.has(lower)
    || lower.startsWith('x-relay-')
    || lower.startsWith('x-header-relay-');
}

function isProfileSessionHeader(profile, name) {
  const lower = String(name).toLowerCase();
  if (profile.family === 'codex') return lower === 'session_id' || lower === 'session-id';
  return lower === profile.sessionHeader.toLowerCase();
}

function validateProfileManifest(profile, filename) {
  if (!isPlainObject(profile)) invalidProfile(filename, 'manifest must be a plain object');
  for (const field of ['id', 'family', 'clientVersion', 'bodyMode', 'sessionHeader']) {
    if (typeof profile[field] !== 'string' || !profile[field]) {
      invalidProfile(filename, `${field} must be a non-empty string`);
    }
  }
  if (!PROFILE_FAMILIES.has(profile.family)) invalidProfile(filename, 'unsupported family');
  if (!BODY_MODES.has(profile.bodyMode)) invalidProfile(filename, 'unsupported bodyMode');
  if (!HTTP_TOKEN.test(profile.sessionHeader) || isForbiddenManifestHeader(profile.sessionHeader)) {
    invalidProfile(filename, 'unsafe sessionHeader');
  }
  if (!isPlainObject(profile.headers)) invalidProfile(filename, 'headers must be a plain object');
  for (const [name, value] of Object.entries(profile.headers)) {
    if (!HTTP_TOKEN.test(name)) invalidProfile(filename, `invalid header name: ${name}`);
    if (typeof value !== 'string') invalidProfile(filename, `header value must be a string: ${name}`);
    try {
      validateHeaderValue(name, value);
    } catch {
      invalidProfile(filename, `invalid header value: ${name}`);
    }
    if (isForbiddenManifestHeader(name)) invalidProfile(filename, `forbidden header: ${name}`);
    if (isProfileSessionHeader(profile, name)) {
      invalidProfile(filename, `static session header forbidden: ${name}`);
    }
  }
  if ('acceptFromStream' in profile && typeof profile.acceptFromStream !== 'boolean') {
    invalidProfile(filename, 'acceptFromStream must be boolean');
  }
  if ('beta' in profile) {
    if (!Array.isArray(profile.beta)
        || profile.beta.some(value => typeof value !== 'string' || !HTTP_TOKEN.test(value))
        || new Set(profile.beta).size !== profile.beta.length) {
      invalidProfile(filename, 'beta must contain unique HTTP tokens');
    }
  }

  const pinned = PINNED_PROFILE_CONTRACTS[profile.id];
  if (pinned) {
    if (!isDeepStrictEqual(profile, pinned)) invalidProfile(filename, 'pinned v1 contract mismatch');
    return;
  }

  for (const field of Object.keys(profile)) {
    if (!GENERIC_PROFILE_FIELDS.has(field)) invalidProfile(filename, `unsupported field: ${field}`);
  }
  const expectedSessionHeader = profile.family === 'codex'
    ? 'session_id'
    : 'X-Claude-Code-Session-Id';
  if (profile.sessionHeader !== expectedSessionHeader) {
    invalidProfile(filename, 'generic profile sessionHeader mismatch');
  }
  if (!GENERIC_BODY_MODES.has(profile.bodyMode)) {
    invalidProfile(filename, 'generic profiles must use a passthrough bodyMode');
  }
  if ('beta' in profile && profile.family !== 'claude') {
    invalidProfile(filename, 'beta is only valid for Claude profiles');
  }
}

function loadPinnedInstructions(directory, profile, filename) {
  if (profile.id !== 'codex-full-v1'
      || profile.instructionsFile !== '../codex-instructions.txt'
      || path.isAbsolute(profile.instructionsFile)) {
    invalidProfile(filename, 'unsafe instructionsFile');
  }

  const resolvedDirectory = path.resolve(directory);
  const projectRoot = path.dirname(resolvedDirectory);
  const expectedPath = path.join(projectRoot, 'codex-instructions.txt');
  const requestedPath = path.resolve(resolvedDirectory, profile.instructionsFile);
  if (requestedPath !== expectedPath) invalidProfile(filename, 'instructionsFile path mismatch');

  let fileStats;
  let realProjectRoot;
  let realInstructionsPath;
  try {
    fileStats = fs.lstatSync(requestedPath);
    realProjectRoot = fs.realpathSync(projectRoot);
    realInstructionsPath = fs.realpathSync(requestedPath);
  } catch (error) {
    throw new TypeError(`invalid profile manifest: ${filename}: instructionsFile unavailable`, {
      cause: error
    });
  }

  const expectedRealPath = path.join(realProjectRoot, 'codex-instructions.txt');
  const relativeRealPath = path.relative(realProjectRoot, realInstructionsPath);
  if (!fileStats.isFile()
      || fileStats.isSymbolicLink()
      || realInstructionsPath !== expectedRealPath
      || relativeRealPath === '..'
      || relativeRealPath.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativeRealPath)) {
    invalidProfile(filename, 'instructionsFile must be the real project Codex instructions file');
  }

  try {
    return fs.readFileSync(realInstructionsPath, 'utf8');
  } catch (error) {
    throw new TypeError(`invalid profile manifest: ${filename}: instructionsFile unreadable`, {
      cause: error
    });
  }
}

export function loadProfiles(directory) {
  const profiles = new Map();
  const filenames = fs.readdirSync(directory)
    .filter(name => name.endsWith('.json'))
    .sort();

  for (const name of filenames) {
    const filename = path.join(directory, name);
    const profile = JSON.parse(fs.readFileSync(filename, 'utf8'));
    validateProfileManifest(profile, filename);
    if (profiles.has(profile.id)) throw new TypeError(`duplicate profile id: ${profile.id}`);
    if (profile.instructionsFile) {
      profile.instructions = loadPinnedInstructions(directory, profile, filename);
    }
    profiles.set(profile.id, deepFreeze(profile));
  }

  for (const required of REQUIRED_PROFILE_IDS) {
    if (!profiles.has(required)) throw new TypeError(`required profile missing: ${required}`);
  }

  return new ReadonlyProfileMap(profiles);
}

export function selectProfile({ pathname, families = [], body }, profiles) {
  const cleanPath = String(pathname || '').replace(/\/+$/, '');
  if (cleanPath.endsWith('/v1/responses')) return profiles.get('codex-full-v1');
  if (cleanPath.endsWith('/v1/messages')) return profiles.get('claude-safe-v1');
  if (cleanPath.endsWith('/v1/chat/completions')) {
    return /claude/i.test(String(body?.model || ''))
      ? profiles.get('claude-headers-v1')
      : profiles.get('codex-headers-v1');
  }

  const uniqueFamilies = new Set(families);
  if (uniqueFamilies.size !== 1) return null;
  const family = [...uniqueFamilies][0];
  if (family === 'anthropic') return profiles.get('claude-headers-v1');
  if (family === 'openai-chat' || family === 'openai-responses') {
    return profiles.get('codex-headers-v1');
  }
  return null;
}

function canonicalizeCodexSessionHeaders(headers, fallback) {
  const candidates = [
    getHeader(headers, 'session_id'),
    getHeader(headers, 'session-id'),
    fallback
  ];
  deleteHeader(headers, 'session_id');
  deleteHeader(headers, 'session-id');

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      setHeader(headers, 'session_id', candidate.trim());
      return;
    }
  }
}

export function applyProfile({ profile, headers, rawBody, body, requestId, overrides = {} }) {
  const nextHeaders = { ...(headers || {}) };
  if (!profile) return { headers: nextHeaders, bodyBuffer: rawBody };

  for (const [name, value] of Object.entries(profile.headers)) {
    setHeader(nextHeaders, name, value);
  }

  if (profile.family === 'codex' && profile.sessionHeader === 'session_id') {
    const fallback = profile.bodyMode === 'codex-responses' ? undefined : requestId;
    canonicalizeCodexSessionHeaders(nextHeaders, fallback);
  } else if (profile.sessionHeader && !getHeader(nextHeaders, profile.sessionHeader)) {
    setHeader(nextHeaders, profile.sessionHeader, requestId);
  }

  if (Array.isArray(profile.beta)) {
    const removed = overrides.context1m === false ? [CONTEXT_1M] : [];
    const required = overrides.context1m === false
      ? profile.beta.filter(value => value !== CONTEXT_1M)
      : profile.beta;
    const merged = mergeCsvHeader(
      getHeader(nextHeaders, 'anthropic-beta'),
      required,
      removed
    );
    deleteHeader(nextHeaders, 'anthropic-beta');
    if (merged) setHeader(nextHeaders, 'Anthropic-Beta', merged);
  }

  if (profile.acceptFromStream && body?.stream === true) {
    setHeader(nextHeaders, 'Accept', 'text/event-stream');
  }

  if (profile.bodyMode === 'codex-responses') {
    const normalized = normalizeCodexRequest(body, {
      instructions: profile.instructions,
      reasoningEffort: profile.reasoningEffort,
      verbosity: profile.verbosity,
      userAgent: profile.headers['User-Agent'],
      originator: profile.headers.originator,
      headers: nextHeaders,
      requestId
    });
    return {
      headers: normalized.headers,
      bodyBuffer: Buffer.from(JSON.stringify(normalized.body))
    };
  }

  return { headers: nextHeaders, bodyBuffer: rawBody };
}
