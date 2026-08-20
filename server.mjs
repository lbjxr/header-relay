import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { normalizeCodexRequest } from './codex-compat.mjs';
import { SnapshotStore } from './lib/config-snapshot.mjs';
import { createForwardHandler } from './lib/forward-handler.mjs';
import { sanitizeLogMessage } from './lib/header-utils.mjs';
import { proxyFetch } from './lib/proxy-fetch.mjs';

const DEFAULT_CONFIG_PATH = process.env.HEADER_RELAY_CONFIG || '/opt/header-relay/config.json';

function log(level, data) {
  const row = { ts: new Date().toISOString(), level, ...data };
  console.log(JSON.stringify(row));
}

function buildTargetUrl(reqUrl, route) {
  const incoming = new URL(reqUrl, 'http://127.0.0.1');
  let rest = incoming.pathname.slice(route.prefix.length);
  if (!rest.startsWith('/')) rest = '/' + rest;
  const target = new URL(route.target);
  const basePath = target.pathname.replace(/\/+$/, '');
  target.pathname = basePath + rest;
  target.search = incoming.search;
  return target;
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = new Error('request body too large: ' + size + ' > ' + limit);
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function copyRequestHeaders(req, target, route, requestId) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (['host', 'connection', 'content-length', 'accept-encoding'].includes(lower)) continue;
    headers[key] = value;
  }
  for (const h of route.removeHeaders || []) {
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === String(h).toLowerCase()) delete headers[k];
    }
  }
  for (const [key, value] of Object.entries(route.setHeaders || {})) {
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === key.toLowerCase()) delete headers[k];
    }
    headers[key] = String(value);
  }
  headers['Host'] = target.host;
  headers['X-Header-Relay-Request-ID'] = requestId;
  return headers;
}

function isResponsesTarget(target) {
  return target.pathname.replace(/\/+$/, '') === '/v1/responses';
}

async function handleLegacyRequest(req, res, snapshot, fetchImpl, logger) {
  const started = Date.now();
  const requestId = randomUUID();
  try {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const route = snapshot.routes.find(item => (
      pathname === item.prefix || pathname.startsWith(`${item.prefix}/`)
    ));
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'no route matched', requestId }));
      return;
    }

    const target = buildTargetUrl(req.url, route);
    let body = await readBody(req, snapshot.maxBodyBytes);
    let headers = copyRequestHeaders(req, target, route, requestId);

    // 全局默认 User-Agent：仅当当前 headers 尚未显式设置 User-Agent 时生效
    const globalUserAgent = snapshot.forward.defaultUserAgent;
    if (globalUserAgent && !headers['user-agent'] && !headers['User-Agent']) {
      headers['User-Agent'] = globalUserAgent;
    }

    if (route._codexCompat && isResponsesTarget(target) && !['GET', 'HEAD'].includes(req.method || '')) {
      let parsed;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        const error = new Error('Codex compatibility requires a valid JSON request body');
        error.statusCode = 400;
        throw error;
      }
      const globalDefaults = {
        userAgent: snapshot.forward.defaultUserAgent || undefined,
      };
      const normalized = normalizeCodexRequest(parsed, {
        ...globalDefaults,
        ...route._codexCompat,
        headers,
        requestId
      });
      headers = normalized.headers;
      body = Buffer.from(JSON.stringify(normalized.body));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), snapshot.requestTimeoutMs);
    let upstream;
    try {
      upstream = await fetchImpl(target, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method || '') ? undefined : body,
        signal: controller.signal,
        redirect: 'manual'
      });
    } finally {
      clearTimeout(timer);
    }

    const responseHeaders = {};
    upstream.headers.forEach((value, key) => {
      if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    });
    responseHeaders['x-header-relay-request-id'] = requestId;
    res.writeHead(upstream.status, responseHeaders);

    if (upstream.body) {
      for await (const chunk of upstream.body) res.write(chunk);
    }
    res.end();

    logger('info', {
      event: 'legacy_proxy_response',
      requestId,
      route: route.name,
      status: upstream.status,
      ms: Date.now() - started
    });
  } catch (error) {
    const status = error.statusCode || (error.name === 'AbortError' ? 504 : 502);
    logger('error', {
      event: 'legacy_proxy_error',
      requestId,
      status,
      message: sanitizeLogMessage(error.message),
      ms: Date.now() - started
    });
    if (!res.headersSent) {
      res.writeHead(status, {
        'content-type': 'application/json',
        'x-header-relay-request-id': requestId
      });
    }
    res.end(JSON.stringify({ error: 'header relay error', requestId }));
  }
}

export function createRelayHandler({
  configPath = DEFAULT_CONFIG_PATH,
  fetchImpl = globalThis.fetch,
  logger = log,
  watchConfig = true
} = {}) {
  const store = new SnapshotStore({ configPath, logger, watch: watchConfig });
  const snapshot0 = store.getSnapshot();
  const effectiveFetchImpl =
    snapshot0.forward.httpProxy && snapshot0.forward.httpProxy.host
      ? proxyFetch
      : fetchImpl;
  const forwardHandler = createForwardHandler({
    getSnapshot: () => store.getSnapshot(),
    fetchImpl: effectiveFetchImpl,
    logger
  });

  const handler = async (req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (pathname === '/ready') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(store.getReady()));
      return;
    }

    const snapshot = store.getSnapshot();
    const prefix = snapshot.forward.pathPrefix;
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      await forwardHandler(req, res);
      return;
    }

    await handleLegacyRequest(req, res, snapshot, fetchImpl, logger);
  };

  handler.getConfig = () => store.getSnapshot();
  handler.close = () => store.close();
  return handler;
}

export function createRelayServer(options = {}) {
  const handler = createRelayHandler(options);
  const server = http.createServer(handler);
  server.on('close', handler.close);
  server.relayHandler = handler;
  return server;
}

function startRelayServer() {
  const server = createRelayServer();
  const config = server.relayHandler.getConfig();
  server.listen(config.listen.port, config.listen.host, () => {
    log('info', {
      event: 'started',
      host: config.listen.host,
      port: config.listen.port,
      targetCount: config.targetRegistry.rules.length,
      generation: config.targetRegistry.generation,
      profileIds: [...config.profiles.keys()].sort()
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startRelayServer();
}
