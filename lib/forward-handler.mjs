import { randomUUID, timingSafeEqual } from 'node:crypto';

import {
  BufferBudget,
  createLimitedRequestStream,
  readBufferedJson,
} from './body-buffer.mjs';
import { RelayError } from './errors.mjs';
import {
  getHeader,
  sanitizeLogMessage,
  stripRequestHeaders,
} from './header-utils.mjs';
import { applyProfile, selectProfile } from './profile-registry.mjs';
import { copyResponseHeaders, pipeUpstreamBody } from './streaming.mjs';
import { resolveRelayTarget } from './target-registry.mjs';

const ALLOWED_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);
const NO_BODY_METHODS = new Set(['GET', 'HEAD']);
const NINEROUTER_PROXY_POOL_HEALTH = Object.freeze({
  method: 'GET',
  target: 'https://httpbin.org',
  path: '/get',
  ruleId: '9router-proxy-pool-health',
});

const TARGET_RELAY_ERROR_CONTRACTS = new Map([
  ['400:invalid_relay_target', new Set(['invalid relay target'])],
  ['400:invalid_relay_path', new Set(['invalid relay path'])],
  ['403:target_not_allowed', new Set(['target not allowed'])],
]);
const BUFFERED_RELAY_ERROR_CONTRACTS = new Map([
  ['400:invalid_json_body', new Set([
    'request body must be valid JSON',
    'request body must be a JSON object',
  ])],
  ['413:request_body_too_large', new Set(['request body too large'])],
  ['503:buffer_capacity_exhausted', new Set(['relay is busy'])],
  ['503:buffer_budget_exhausted', new Set(['relay is busy'])],
]);
function isLoopback(address) {
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1';
}

function tokenMatches(pathname, snapshot) {
  const actual = Buffer.from(pathname);
  const expected = Buffer.from(`${snapshot.forward.pathPrefix}/${snapshot.token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function requestPathname(requestTarget) {
  if (
    typeof requestTarget !== 'string'
    || /[\r\n]/.test(requestTarget)
    || requestTarget.includes('#')
  ) {
    return undefined;
  }
  const queryIndex = requestTarget.indexOf('?');
  return queryIndex === -1
    ? requestTarget
    : requestTarget.slice(0, queryIndex);
}

function endpointNeedsBuffer(pathname) {
  const clean = pathname.replace(/\/+$/, '');
  return clean.endsWith('/v1/responses')
    || clean.endsWith('/v1/chat/completions');
}

function is9routerProxyPoolHealthProbe(method, targetHeader, pathHeader) {
  return method === NINEROUTER_PROXY_POOL_HEALTH.method
    && targetHeader === NINEROUTER_PROXY_POOL_HEALTH.target
    && pathHeader === NINEROUTER_PROXY_POOL_HEALTH.path;
}

function sendJson(res, status, payload, requestId) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'x-header-relay-request-id': requestId,
  };
  if (status === 503) headers['retry-after'] = '1';
  res.writeHead(status, headers);
  res.end(JSON.stringify(payload));
}

function logSafely(logger, level, row) {
  try {
    const result = logger(level, row);
    result?.catch?.(() => {});
  } catch {
    // Logging must never change proxy behavior.
  }
}

function safeErrorLogMessage(trustedContract) {
  const message = trustedContract?.publicMessage
    ?? 'upstream request failed';
  return sanitizeLogMessage(message);
}

function safeErrorStatus(trustedContract) {
  return trustedContract?.statusCode ?? 502;
}

function untrustedFetchError(error) {
  return new Error('upstream request failed', { cause: error });
}

function createReadonlyRequestBody(requestBody) {
  const ignoreUnhandledError = () => {};
  requestBody.on('error', ignoreUnhandledError);
  requestBody.once('close', () => {
    requestBody.off('error', ignoreUnhandledError);
  });
  return Object.freeze({
    [Symbol.asyncIterator]() {
      return requestBody[Symbol.asyncIterator]();
    },
  });
}

function safeTeardownError(trustedContract) {
  if (trustedContract == null) return undefined;
  return new RelayError(
    trustedContract.statusCode,
    trustedContract.code,
    trustedContract.publicMessage,
  );
}

function destroyResponseSafely(res, trustedContract) {
  if (res.destroyed) return;
  const error = safeTeardownError(trustedContract);
  if (error == null) res.destroy();
  else res.destroy(error);
}

function teardownSafeDestination(destination, trustedContractFor) {
  const destroy = error => {
    destroyResponseSafely(destination, trustedContractFor(error));
    return destination;
  };
  return new Proxy(destination, {
    get(target, property) {
      if (property === 'destroy') return destroy;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function'
        ? value.bind(target)
        : value;
    },
  });
}

function canonicalRelayError(
  error,
  contracts,
  createTrustedRelayError,
  trustedContractFor,
) {
  if (trustedContractFor(error) != null) return error;
  if (!(error instanceof RelayError)) return error;
  for (const [contractKey, publicMessages] of contracts) {
    const separator = contractKey.indexOf(':');
    const statusCode = Number(contractKey.slice(0, separator));
    const code = contractKey.slice(separator + 1);
    if (error.statusCode !== statusCode || error.code !== code) continue;
    for (const publicMessage of publicMessages) {
      if (error.publicMessage === publicMessage) {
        return createTrustedRelayError(
          statusCode,
          code,
          publicMessage,
          { cause: error },
        );
      }
    }
  }
  return error;
}

function targetRegistryForResolution(registry) {
  return {
    rules: registry.rules.map(rule => ({
      ruleId: String(rule.ruleId),
      origin: String(rule.origin),
      basePath: String(rule.basePath),
      families: Array.from(rule.families, value => String(value)),
      overrides: {
        context1m: rule.overrides?.context1m,
      },
    })),
  };
}

async function* bufferedRequestChunks(req) {
  try {
    for await (const chunk of req) {
      yield Buffer.from(chunk);
    }
  } catch (error) {
    throw new Error('request body source failed', { cause: error });
  }
}

function disposeLimitedRequestBody(requestBody) {
  if (requestBody == null || requestBody.destroyed) return;
  const ignoreCleanupError = () => {};
  const clearCleanupGuard = () => {
    requestBody.off('error', ignoreCleanupError);
  };
  requestBody.once('error', ignoreCleanupError);
  requestBody.once('close', clearCleanupGuard);
  try {
    requestBody.destroy();
  } catch {
    // Request-body cleanup must not replace the primary proxy outcome.
  }
}

function disposeLimitedRequestBodyWhenSocketCloses(socket, requestBody) {
  if (
    requestBody == null
    || requestBody.destroyed
    || typeof socket?.once !== 'function'
  ) {
    return;
  }
  const clearSocketCloseListener = () => {
    socket.off('close', onSocketClose);
  };
  const onSocketClose = () => {
    requestBody.off('close', clearSocketCloseListener);
    disposeLimitedRequestBody(requestBody);
  };
  requestBody.once('close', clearSocketCloseListener);
  if (socket.destroyed) onSocketClose();
  else socket.once('close', onSocketClose);
}

function observeAbort(signal) {
  let active = true;
  let onAbort;
  const promise = new Promise(resolve => {
    onAbort = () => resolve({ kind: 'abort', reason: signal.reason });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  return {
    promise,
    cancel() {
      if (!active) return;
      active = false;
      signal.removeEventListener('abort', onAbort);
    },
  };
}

function cancelUpstreamResponse(response, reason) {
  let cancellation;
  try {
    const body = response?.body;
    if (body == null) return;
    cancellation = body.cancel(reason);
  } catch {
    return;
  }
  void Promise.resolve(cancellation).catch(() => {});
}

function discardLateFetchOutcome(fetchOutcome, reason) {
  void fetchOutcome
    .then(outcome => {
      if (outcome.kind === 'response') {
        cancelUpstreamResponse(outcome.response, reason);
      }
    })
    .catch(() => {});
}

export function createForwardHandler({
  getSnapshot,
  fetchImpl = globalThis.fetch,
  logger = () => {},
}) {
  let budgetKey = '';
  let budget;

  function getBudget(snapshot) {
    const nextKey = [
      snapshot.forward.maxBufferedRequests,
      snapshot.forward.maxBufferedBytes,
    ].join(':');
    if (nextKey !== budgetKey) {
      budgetKey = nextKey;
      budget = new BufferBudget({
        maxRequests: snapshot.forward.maxBufferedRequests,
        maxBytes: snapshot.forward.maxBufferedBytes,
      });
    }
    return budget;
  }

  return async function forwardHandler(req, res) {
    const started = Date.now();
    const requestId = randomUUID();
    const trustedRelayErrorContracts = new WeakMap();
    const createTrustedRelayError = (
      statusCode,
      code,
      publicMessage,
      options,
    ) => {
      const contract = Object.freeze({ statusCode, code, publicMessage });
      const error = new RelayError(
        contract.statusCode,
        contract.code,
        contract.publicMessage,
        options,
      );
      trustedRelayErrorContracts.set(error, contract);
      return error;
    };
    const trustedContractFor = error => (
      trustedRelayErrorContracts.get(error)
    );
    let method = 'GET';
    let generation;
    let profileId = 'transparent';
    let ruleId = null;
    let limitedRequestBody;
    let receivedUpstreamResponse = false;
    let releaseBufferedBody = () => {};
    let removeDownstreamListeners = () => {};
    try {
      if (!isLoopback(req.socket?.remoteAddress)) {
        throw createTrustedRelayError(404, 'not_found', 'not found');
      }

      const snapshot = getSnapshot();
      const pathname = requestPathname(req.url);
      if (pathname == null) {
        throw createTrustedRelayError(404, 'not_found', 'not found');
      }
      if (!tokenMatches(pathname, snapshot)) {
        throw createTrustedRelayError(404, 'not_found', 'not found');
      }
      method = String(req.method || 'GET').toUpperCase();
      const targetRegistry = snapshot.targetRegistry;
      generation = targetRegistry.generation;

      if (!ALLOWED_METHODS.has(method)) {
        throw createTrustedRelayError(
          405,
          'method_not_allowed',
          'method not allowed',
        );
      }

      const requestHeaders = req.headers;
      const targetHeader = getHeader(requestHeaders, 'x-relay-target');
      const pathHeader = getHeader(requestHeaders, 'x-relay-path');
      if (is9routerProxyPoolHealthProbe(method, targetHeader, pathHeader)) {
        ruleId = NINEROUTER_PROXY_POOL_HEALTH.ruleId;
        sendJson(res, 200, { ok: true }, requestId);
        logSafely(logger, 'info', {
          event: 'proxy_response',
          requestId,
          ruleId,
          profileId,
          method,
          status: 200,
          ms: Date.now() - started,
          generation,
        });
        return;
      }
      const resolutionRegistry = targetRegistryForResolution(targetRegistry);
      let resolved;
      try {
        resolved = resolveRelayTarget({
          targetHeader,
          pathHeader,
          registry: resolutionRegistry,
        });
      } catch (error) {
        throw canonicalRelayError(
          error,
          TARGET_RELAY_ERROR_CONTRACTS,
          createTrustedRelayError,
          trustedContractFor,
        );
      }
      ruleId = resolved.rule.ruleId;

      const declaredLength = Number(getHeader(requestHeaders, 'content-length'));
      if (
        Number.isFinite(declaredLength)
        && declaredLength > snapshot.forward.maxBodyBytes
      ) {
        throw createTrustedRelayError(
          413,
          'request_body_too_large',
          'request body too large',
        );
      }

      const hasBody = !NO_BODY_METHODS.has(method);
      const needsBuffer = hasBody && endpointNeedsBuffer(resolved.url.pathname);
      let rawBody;
      let parsedBody;
      if (needsBuffer) {
        const requestBudget = getBudget(snapshot);
        const maxBodyBytes = snapshot.forward.maxBodyBytes;
        let buffered;
        try {
          buffered = await readBufferedJson(bufferedRequestChunks(req), {
            budget: requestBudget,
            maxBodyBytes,
          });
        } catch (error) {
          throw canonicalRelayError(
            error,
            BUFFERED_RELAY_ERROR_CONTRACTS,
            createTrustedRelayError,
            trustedContractFor,
          );
        }
        rawBody = buffered.raw;
        parsedBody = buffered.body;
        releaseBufferedBody = buffered.release;
      }

      const profile = selectProfile({
        pathname: resolved.url.pathname,
        families: resolved.rule.families,
        body: parsedBody,
      }, snapshot.profiles);
      profileId = profile?.id || 'transparent';
      const applied = applyProfile({
        profile,
        headers: stripRequestHeaders(requestHeaders, requestId),
        rawBody,
        body: parsedBody,
        requestId,
        overrides: resolved.rule.overrides,
      });

      // Strip provider-specific model prefix (e.g. "gxgpt/gpt-5.6-sol" -> "gpt-5.6-sol")
      if (parsedBody && typeof parsedBody.model === 'string' && parsedBody.model.includes('/')) {
        parsedBody.model = parsedBody.model.split('/').pop();
        applied.bodyBuffer = Buffer.from(JSON.stringify(parsedBody));
      }

      let requestBody;
      let streamingBody = false;
      if (hasBody) {
        if (needsBuffer) {
          requestBody = applied.bodyBuffer;
        } else {
          limitedRequestBody = createLimitedRequestStream(
            req,
            snapshot.forward.maxBodyBytes,
            {
              createOverflowError: () => createTrustedRelayError(
                413,
                'request_body_too_large',
                'request body too large',
              ),
            },
          );
          requestBody = createReadonlyRequestBody(limitedRequestBody);
          streamingBody = true;
        }
      }

      const controller = new AbortController();
      const abortDownstream = () => {
        if (!controller.signal.aborted) {
          controller.abort(createTrustedRelayError(
            499,
            'downstream_closed',
            'downstream closed',
          ));
        }
      };
      const onResponseClose = () => {
        if (!res.writableEnded) abortDownstream();
      };
      req.once('aborted', abortDownstream);
      res.once('close', onResponseClose);
      removeDownstreamListeners = () => {
        req.off('aborted', abortDownstream);
        res.off('close', onResponseClose);
      };
      if (req.aborted || res.destroyed || res.closed) abortDownstream();
      if (controller.signal.aborted) throw controller.signal.reason;

      const headerTimeoutError = createTrustedRelayError(
        504,
        'upstream_header_timeout',
        'upstream timed out',
      );
      const headerTimer = setTimeout(() => {
        if (controller.signal.aborted) return;
        controller.abort(headerTimeoutError);
      }, snapshot.forward.upstreamHeaderTimeoutMs);
      headerTimer.unref?.();

      const abortObservation = observeAbort(controller.signal);
      const fetchOutcome = Promise.resolve()
        .then(() => fetchImpl(resolved.url, {
          method,
          headers: applied.headers,
          body: requestBody,
          signal: controller.signal,
          redirect: 'manual',
          ...(streamingBody ? { duplex: 'half' } : {}),
        }))
        .then(
          response => ({ kind: 'response', response }),
          error => ({ kind: 'error', error }),
        );

      let upstream;
      try {
        const outcome = await Promise.race([
          fetchOutcome,
          abortObservation.promise,
        ]);
        if (outcome.kind === 'abort') {
          discardLateFetchOutcome(fetchOutcome, outcome.reason);
          throw outcome.reason;
        }
        if (controller.signal.aborted) {
          if (outcome.kind === 'response') {
            cancelUpstreamResponse(
              outcome.response,
              controller.signal.reason,
            );
          }
          throw controller.signal.reason;
        }
        if (outcome.kind === 'response') {
          upstream = outcome.response;
          receivedUpstreamResponse = true;
          limitedRequestBody?.resume();
          disposeLimitedRequestBodyWhenSocketCloses(
            req.socket,
            limitedRequestBody,
          );
        } else {
          const { error } = outcome;
          const requestBodyError = streamingBody
            ? limitedRequestBody?.errored
            : undefined;
          const requestBodyContract = trustedContractFor(requestBodyError);
          if (
            requestBodyContract?.statusCode === 413
            && requestBodyContract.code === 'request_body_too_large'
            && requestBodyContract.publicMessage === 'request body too large'
            && (
              error === requestBodyError
              || error?.cause === requestBodyError
            )
          ) {
            throw requestBodyError;
          }
          throw untrustedFetchError(error);
        }
      } finally {
        abortObservation.cancel();
        clearTimeout(headerTimer);
        if (!receivedUpstreamResponse) {
          disposeLimitedRequestBody(limitedRequestBody);
        }
        releaseBufferedBody();
        releaseBufferedBody = () => {};
      }

      res.writeHead(
        upstream.status,
        copyResponseHeaders(upstream.headers, requestId),
      );
      await pipeUpstreamBody(
        upstream.body,
        teardownSafeDestination(res, trustedContractFor),
        {
          idleTimeoutMs: snapshot.forward.streamIdleTimeoutMs,
          controller,
          createIdleTimeoutError: () => createTrustedRelayError(
            504,
            'upstream_stream_idle',
            'upstream stream timed out',
          ),
        },
      );
      logSafely(logger, 'info', {
        event: 'proxy_response',
        requestId,
        ruleId,
        profileId,
        method,
        status: upstream.status,
        ms: Date.now() - started,
        generation,
      });
    } catch (error) {
      const trustedContract = trustedContractFor(error);
      const status = safeErrorStatus(trustedContract);
      const publicError = trustedContract != null
        ? {
            message: trustedContract.publicMessage,
            type: trustedContract.code,
          }
        : {
            message: 'header relay error',
            type: 'header_relay_error',
          };
      logSafely(logger, 'error', {
        event: 'proxy_error',
        requestId,
        ruleId,
        profileId,
        method,
        status,
        message: safeErrorLogMessage(trustedContract),
        ms: Date.now() - started,
      });
      if (
        trustedContract?.code === 'downstream_closed'
      ) {
        destroyResponseSafely(res, trustedContract);
        return;
      }
      if (res.headersSent || res.destroyed || res.writableEnded) {
        destroyResponseSafely(res, trustedContract);
        return;
      }
      sendJson(res, status, {
        error: publicError,
        requestId,
      }, requestId);
    } finally {
      removeDownstreamListeners();
      if (!receivedUpstreamResponse) {
        disposeLimitedRequestBody(limitedRequestBody);
      }
      releaseBufferedBody();
    }
  };
}
