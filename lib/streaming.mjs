import { RelayError } from './errors.mjs';

const RESPONSE_STRIP = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function destinationClosedPrematurely() {
  const error = new Error('destination closed prematurely');
  error.code = 'ERR_STREAM_PREMATURE_CLOSE';
  return error;
}

function defaultIdleTimeoutError() {
  return new RelayError(
    504,
    'upstream_stream_idle',
    'upstream stream timed out',
  );
}

function callIdleTimeoutErrorFactory(createIdleTimeoutError) {
  let error;
  try {
    error = createIdleTimeoutError();
  } catch (thrown) {
    if (thrown instanceof Error) return thrown;
    return new TypeError(
      'createIdleTimeoutError must throw or return an Error',
    );
  }

  if (error instanceof Error) return error;
  return new TypeError('createIdleTimeoutError must return an Error');
}

const PENDING_DESTINATION_TEARDOWN_WAIT_MS = 50;

function pendingDestinationTeardown(destination) {
  if (destination._writableState?.errorEmitted !== false) return undefined;
  if (destination.errored != null) return 'known-error';
  if (destination.destroyed && destination.closed !== true) {
    return 'unknown-destroy';
  }
  return undefined;
}

function clearLateDestinationTeardownGuards(destination) {
  destination.off('error', ignoreLateDestinationError);
  destination.off('close', ignoreLateDestinationClose);
}

function ignoreLateDestinationError() {
  clearLateDestinationTeardownGuards(this);
}

function ignoreLateDestinationClose() {
  clearLateDestinationTeardownGuards(this);
}

function guardPendingDestinationTeardown(destination) {
  const pendingTeardown = pendingDestinationTeardown(destination);
  if (pendingTeardown == null) return;
  if (destination.listenerCount('error', ignoreLateDestinationError) === 0) {
    destination.prependListener('error', ignoreLateDestinationError);
  }
  if (
    pendingTeardown === 'unknown-destroy'
    && destination.listenerCount('close', ignoreLateDestinationClose) === 0
  ) {
    destination.prependListener('close', ignoreLateDestinationClose);
  }
}

function observeDestination(destination) {
  let terminalOutcome;
  let finalizing = false;
  let pendingTeardownDeadline;
  let errorDelivered = destination._writableState?.errorEmitted === true;
  let teardownSettled = errorDelivered || destination.closed;
  let resolveTeardownSettlement;
  const teardownSettlement = new Promise(resolve => {
    resolveTeardownSettlement = resolve;
    if (teardownSettled) resolve();
  });
  const waiters = new Set();
  const notePendingTeardown = () => {
    if (
      pendingTeardownDeadline == null
      && pendingDestinationTeardown(destination) != null
    ) {
      pendingTeardownDeadline = Date.now()
        + PENDING_DESTINATION_TEARDOWN_WAIT_MS;
    }
  };
  const settleTeardownObservation = () => {
    if (teardownSettled) return;
    teardownSettled = true;
    resolveTeardownSettlement();
  };
  const settleOnce = outcome => {
    if (terminalOutcome != null) return;
    terminalOutcome = outcome;
    for (const resolve of waiters) resolve(outcome);
    waiters.clear();
  };
  const onError = error => {
    notePendingTeardown();
    errorDelivered = true;
    settleTeardownObservation();
    settleOnce({ kind: 'destination-error', error });
  };
  const onFinish = () => {
    const outcome = reconcile();
    if (outcome != null) return;
    if (finalizing) {
      settleOnce({ kind: 'destination-finish' });
      return;
    }
    settleOnce({
      kind: 'destination-error',
      error: destinationClosedPrematurely(),
    });
  };
  const onClose = () => {
    settleTeardownObservation();
    const outcome = reconcile();
    if (outcome != null) return;
    settleOnce({
      kind: 'destination-error',
      error: destinationClosedPrematurely(),
    });
  };

  destination.once('error', onError);
  destination.once('finish', onFinish);
  destination.once('close', onClose);

  const reconcile = () => {
    notePendingTeardown();
    if (terminalOutcome != null) return terminalOutcome;
    if (destination.errored != null) {
      settleOnce({ kind: 'destination-error', error: destination.errored });
    } else if (destination.writableFinished) {
      settleOnce(finalizing
        ? { kind: 'destination-finish' }
        : {
            kind: 'destination-error',
            error: destinationClosedPrematurely(),
          });
    } else if (destination.writableEnded && !finalizing) {
      settleOnce({
        kind: 'destination-error',
        error: destinationClosedPrematurely(),
      });
    } else if (destination.destroyed || destination.closed) {
      settleOnce({
        kind: 'destination-error',
        error: destinationClosedPrematurely(),
      });
    }
    return terminalOutcome;
  };

  reconcile();

  return {
    reconcile,
    beginFinalization() {
      const outcome = reconcile();
      if (outcome != null) return outcome;
      finalizing = true;
      return undefined;
    },
    subscribe() {
      if (terminalOutcome != null) {
        return {
          promise: Promise.resolve(terminalOutcome),
          cancel() {},
        };
      }

      let active = true;
      let resolveWaiter;
      let statePoll;
      const pending = new Promise(resolve => {
        resolveWaiter = resolve;
        waiters.add(resolve);
      });
      statePoll = setInterval(reconcile, 10);
      statePoll.unref?.();
      reconcile();
      const promise = pending.then(outcome => {
        clearInterval(statePoll);
        return outcome;
      });
      return {
        promise,
        cancel() {
          if (!active) return;
          active = false;
          clearInterval(statePoll);
          waiters.delete(resolveWaiter);
        },
      };
    },
    async wait() {
      const subscription = this.subscribe();
      try {
        return await subscription.promise;
      } finally {
        subscription.cancel();
      }
    },
    async waitForPendingTeardown() {
      notePendingTeardown();
      if (
        !teardownSettled
        && pendingDestinationTeardown(destination) != null
        && pendingTeardownDeadline != null
      ) {
        const remainingMs = pendingTeardownDeadline - Date.now();
        if (remainingMs <= 0) return;
        let timer;
        const deadlineElapsed = new Promise(resolve => {
          timer = setTimeout(resolve, remainingMs);
          timer.unref?.();
        });
        try {
          await Promise.race([teardownSettlement, deadlineElapsed]);
        } finally {
          clearTimeout(timer);
        }
      }
    },
    cleanup() {
      if (!errorDelivered && pendingDestinationTeardown(destination) != null) {
        guardPendingDestinationTeardown(destination);
      }
      destination.off('error', onError);
      destination.off('finish', onFinish);
      destination.off('close', onClose);
    },
  };
}

function throwDestinationOutcome(outcome) {
  if (outcome.kind === 'destination-error') throw outcome.error;
  throw destinationClosedPrematurely();
}

async function readWithIdleTimeout(
  reader,
  destinationObserver,
  idleTimeoutMs,
  createIdleTimeoutError,
) {
  let timer;
  const destinationSubscription = destinationObserver.subscribe();
  const readOutcome = Promise.resolve()
    .then(() => reader.read())
    .then(
      result => ({ kind: 'read', result }),
      error => ({ kind: 'source-error', error }),
    );
  const timeoutOutcome = new Promise(resolve => {
    timer = setTimeout(() => {
      const destinationOutcome = destinationObserver.reconcile();
      if (destinationOutcome != null) {
        resolve(destinationOutcome);
        return;
      }
      resolve({
        kind: 'timeout',
        error: callIdleTimeoutErrorFactory(createIdleTimeoutError),
      });
    }, idleTimeoutMs);
    timer.unref?.();
  });

  try {
    const outcome = await Promise.race([
      readOutcome,
      timeoutOutcome,
      destinationSubscription.promise,
    ]);
    if (outcome.kind === 'read') return outcome.result;
    if (outcome.kind === 'source-error' || outcome.kind === 'timeout') {
      throw outcome.error;
    }
    throwDestinationOutcome(outcome);
  } finally {
    clearTimeout(timer);
    destinationSubscription.cancel();
  }
}

async function waitForDrain(destination, destinationObserver) {
  let onDrain;
  const destinationSubscription = destinationObserver.subscribe();
  const drain = new Promise(resolve => {
    onDrain = () => resolve({ kind: 'drain' });
    destination.once('drain', onDrain);
  });

  try {
    const outcome = await Promise.race([
      drain,
      destinationSubscription.promise,
    ]);
    if (outcome.kind !== 'drain') throwDestinationOutcome(outcome);
  } finally {
    destination.off('drain', onDrain);
    destinationSubscription.cancel();
  }
}

function releaseReader(reader) {
  try {
    reader.releaseLock();
  } catch {
    // A pending read will release after cancellation settles.
  }
}

function cancelReader(reader, reason) {
  let cancellation;
  try {
    cancellation = reader.cancel(reason);
  } catch {
    releaseReader(reader);
    return;
  }

  releaseReader(reader);
  void Promise.resolve(cancellation)
    .catch(() => {})
    .finally(() => releaseReader(reader));
}

export function copyResponseHeaders(upstreamHeaders, requestId) {
  const headers = Object.create(null);
  const fallbackSetCookies = [];
  const connectionTokens = (upstreamHeaders.get('connection') || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);

  upstreamHeaders.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === 'x-header-relay-request-id') return;
    if (lower === 'set-cookie') {
      if (!connectionTokens.includes(lower)) fallbackSetCookies.push(value);
      return;
    }
    if (!RESPONSE_STRIP.has(lower) && !connectionTokens.includes(lower)) {
      headers[key] = value;
    }
  });
  const setCookies = upstreamHeaders.getSetCookie?.() ?? fallbackSetCookies;
  if (!connectionTokens.includes('set-cookie')) {
    if (setCookies.length === 1) headers['set-cookie'] = setCookies[0];
    else if (setCookies.length > 1) headers['set-cookie'] = setCookies;
  }
  headers['x-header-relay-request-id'] = requestId;
  return headers;
}

export async function pipeUpstreamBody(
  body,
  destination,
  {
    idleTimeoutMs,
    controller,
    createIdleTimeoutError = defaultIdleTimeoutError,
  },
) {
  if (typeof createIdleTimeoutError !== 'function') {
    throw new TypeError('createIdleTimeoutError must be a function');
  }

  if (body == null) {
    const destinationObserver = observeDestination(destination);

    try {
      const initialOutcome = destinationObserver.beginFinalization();
      if (initialOutcome != null) {
        throwDestinationOutcome(initialOutcome);
      }
      destination.end();
      const outcome = await destinationObserver.wait();
      if (outcome.kind !== 'destination-finish') {
        throwDestinationOutcome(outcome);
      }
      return;
    } catch (error) {
      if (!controller.signal.aborted) controller.abort(error);
      await destinationObserver.waitForPendingTeardown();
      throw error;
    } finally {
      destinationObserver.cleanup();
    }
  }

  const reader = body.getReader();
  const destinationObserver = observeDestination(destination);
  let failed = false;

  try {
    while (true) {
      const { done, value } = await readWithIdleTimeout(
        reader,
        destinationObserver,
        idleTimeoutMs,
        createIdleTimeoutError,
      );
      if (done) break;
      if (!destination.write(value)) {
        await waitForDrain(destination, destinationObserver);
      }
    }

    const initialOutcome = destinationObserver.beginFinalization();
    if (initialOutcome != null) throwDestinationOutcome(initialOutcome);
    destination.end();
    const outcome = await destinationObserver.wait();
    if (outcome.kind !== 'destination-finish') throwDestinationOutcome(outcome);
  } catch (error) {
    failed = true;
    if (!controller.signal.aborted) controller.abort(error);
    cancelReader(reader, error);
    if (!destination.destroyed && !destination.writableFinished) {
      try {
        destination.destroy(error);
      } catch {
        // Cleanup failures must not replace the primary streaming error.
      }
    }
    try {
      destinationObserver.reconcile();
      await destinationObserver.waitForPendingTeardown();
    } catch {
      // Cleanup failures must not replace the primary streaming error.
    }
    throw error;
  } finally {
    destinationObserver.cleanup();
    if (!failed) releaseReader(reader);
  }
}
