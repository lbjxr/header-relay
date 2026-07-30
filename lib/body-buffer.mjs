import { Transform } from 'node:stream';
import { TextDecoder } from 'node:util';

import { RelayError } from './errors.mjs';

const STRICT_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function requireNonNegativeSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function requirePositiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function requestStreamClosedPrematurely() {
  const error = new Error('request stream closed prematurely');
  error.code = 'ERR_STREAM_PREMATURE_CLOSE';
  return error;
}

function defaultOverflowError() {
  return new RelayError(
    413,
    'request_body_too_large',
    'request body too large',
  );
}

const SOURCE_OBSERVER_INTERVAL_MS = 25;
const SOURCE_OBSERVER_MAX_ATTEMPTS = 8;
const sourceDestroyManagers = new WeakMap();

function ignoreLateSourceError() {}

function retainLateSourceErrorGuard(source) {
  if (!source.listeners('error').includes(ignoreLateSourceError)) {
    source.on('error', ignoreLateSourceError);
  }
}

function subscribeToSourceDestroy(source, subscriber) {
  let manager = sourceDestroyManagers.get(source);
  if (manager == null || source.destroy !== manager.observedDestroy) {
    const originalDestroy = source.destroy;
    const originalDestroyDescriptor = Object.getOwnPropertyDescriptor(source, 'destroy');
    const subscribers = new Set();
    let notificationScheduled = false;

    const scheduleSubscribers = () => {
      if (notificationScheduled) return;
      notificationScheduled = true;
      queueMicrotask(() => {
        notificationScheduled = false;
        for (const currentSubscriber of [...subscribers]) {
          if (subscribers.has(currentSubscriber)) currentSubscriber();
        }
      });
    };
    const observedDestroy = function observedSourceDestroy(...args) {
      try {
        return originalDestroy.apply(this, args);
      } finally {
        if (this === source) scheduleSubscribers();
      }
    };

    try {
      source.destroy = observedDestroy;
    } catch {
      return () => {};
    }
    if (source.destroy !== observedDestroy) return () => {};

    manager = {
      observedDestroy,
      originalDestroyDescriptor,
      subscribers,
    };
    sourceDestroyManagers.set(source, manager);
  }

  manager.subscribers.add(subscriber);
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    manager.subscribers.delete(subscriber);
    if (manager.subscribers.size !== 0) return;

    if (source.destroy === manager.observedDestroy) {
      try {
        if (manager.originalDestroyDescriptor == null) delete source.destroy;
        else Object.defineProperty(source, 'destroy', manager.originalDestroyDescriptor);
      } catch {
        // Do not replace a source destroy method that became immutable.
      }
    }
    if (sourceDestroyManagers.get(source) === manager) {
      sourceDestroyManagers.delete(source);
    }
  };
}

export class BufferBudget {
  constructor(options) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('BufferBudget options must be an object');
    }
    const { maxRequests, maxBytes } = options;
    requirePositiveSafeInteger(maxRequests, 'maxRequests');
    requireNonNegativeSafeInteger(maxBytes, 'maxBytes');
    this.maxRequests = maxRequests;
    this.maxBytes = maxBytes;
    this.activeRequests = 0;
    this.bufferedBytes = 0;
  }

  open() {
    if (this.activeRequests >= this.maxRequests) {
      throw new RelayError(503, 'buffer_capacity_exhausted', 'relay is busy');
    }

    this.activeRequests += 1;
    let ownedBytes = 0;
    let released = false;

    return {
      add: bytes => {
        if (released) throw new Error('buffer lease already released');
        requireNonNegativeSafeInteger(bytes, 'bytes');
        if (bytes > this.maxBytes - this.bufferedBytes) {
          throw new RelayError(503, 'buffer_budget_exhausted', 'relay is busy');
        }
        this.bufferedBytes += bytes;
        ownedBytes += bytes;
      },
      release: () => {
        if (released) return;
        released = true;
        this.activeRequests -= 1;
        this.bufferedBytes -= ownedBytes;
      },
    };
  }
}

export async function readBufferedJson(req, { budget, maxBodyBytes }) {
  requireNonNegativeSafeInteger(maxBodyBytes, 'maxBodyBytes');
  const lease = budget.open();
  const chunks = [];
  let size = 0;

  try {
    for await (const chunk of req) {
      const buffer = Buffer.from(chunk);
      if (buffer.length > maxBodyBytes - size) {
        throw new RelayError(413, 'request_body_too_large', 'request body too large');
      }
      size += buffer.length;
      lease.add(buffer.length);
      chunks.push(buffer);
    }

    const raw = Buffer.concat(chunks, size);
    let body;
    try {
      body = JSON.parse(STRICT_UTF8_DECODER.decode(raw));
    } catch {
      throw new RelayError(400, 'invalid_json_body', 'request body must be valid JSON');
    }

    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new RelayError(400, 'invalid_json_body', 'request body must be a JSON object');
    }

    return { raw, body, release: lease.release };
  } catch (error) {
    lease.release();
    throw error;
  }
}

export function createLimitedRequestStream(req, maxBodyBytes, options = {}) {
  requireNonNegativeSafeInteger(maxBodyBytes, 'maxBodyBytes');
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }
  const { createOverflowError = defaultOverflowError } = options;
  if (typeof createOverflowError !== 'function') {
    throw new TypeError('createOverflowError must be a function');
  }
  const getOverflowError = () => {
    try {
      const error = createOverflowError();
      if (!(error instanceof Error)) {
        return new TypeError('createOverflowError must return an Error');
      }
      return error;
    } catch (error) {
      if (error instanceof Error) return error;
      return new TypeError('createOverflowError must throw or return an Error');
    }
  };
  let size = 0;
  let sourceEnded = req.readableEnded === true;
  let sourceClosed = req.closed === true;
  let sourceFailed = req.errored != null;
  let sourceErrorObserved = false;
  let sourceStopRequested = false;
  let limiterClosed = false;
  let listenersRemoved = false;
  let primaryError;
  let sourceObserverTimer;
  let sourceObserverAttempts = 0;
  let reconcileScheduled = false;
  let unsubscribeSourceDestroy = () => {};

  const stopSourceObserver = () => {
    if (sourceObserverTimer == null) return;
    clearTimeout(sourceObserverTimer);
    sourceObserverTimer = undefined;
  };
  const stopSource = () => {
    req.unpipe(limiter);
    if (!sourceClosed && !req.destroyed) {
      sourceStopRequested = true;
      req.destroy();
    }
  };
  const releaseLifecycle = retainErrorGuard => {
    if (listenersRemoved) return;
    listenersRemoved = true;
    stopSourceObserver();
    if (retainErrorGuard) retainLateSourceErrorGuard(req);
    unsubscribeSourceDestroy();
    req.off('error', onSourceError);
    req.off('end', onSourceEnd);
    req.off('close', onSourceClose);
  };
  const cleanupListeners = () => {
    if (
      listenersRemoved
      || !limiterClosed
      || (!sourceClosed && !sourceErrorObserved)
    ) {
      return;
    }
    releaseLifecycle(false);
  };
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.from(chunk);
      if (buffer.length > maxBodyBytes - size) {
        primaryError = getOverflowError();
        stopSource();
        callback(primaryError);
        return;
      }
      size += buffer.length;
      callback(null, buffer);
    },
    destroy(error, callback) {
      if (primaryError == null && error != null) primaryError = error;
      stopSource();
      callback(primaryError ?? error);
    },
  });

  const onSourceError = error => {
    sourceFailed = true;
    sourceErrorObserved = true;
    if (primaryError == null) primaryError = error;
    limiter.destroy(primaryError);
    cleanupListeners();
  };
  const onSourceEnd = () => {
    sourceEnded = true;
    reconcileSourceState();
  };
  const onSourceClose = () => {
    sourceClosed = true;
    if (
      !sourceEnded
      && !sourceFailed
      && !sourceStopRequested
      && !limiter.destroyed
    ) {
      sourceFailed = true;
      limiter.destroy(requestStreamClosedPrematurely());
    }
    cleanupListeners();
  };
  const reconcileSourceState = () => {
    if (listenersRemoved) return;
    const currentError = req.errored;
    if (currentError != null) {
      sourceFailed = true;
      if (primaryError == null) primaryError = currentError;
      limiter.destroy(primaryError);
    }
    if (req.readableEnded === true) sourceEnded = true;
    if (
      req.destroyed === true
      && !sourceEnded
      && !sourceStopRequested
      && !limiter.destroyed
    ) {
      sourceFailed = true;
      if (primaryError == null) {
        primaryError = currentError ?? requestStreamClosedPrematurely();
      }
      limiter.destroy(primaryError);
    }
    if (req.closed === true) {
      sourceClosed = true;
      if (
        !sourceEnded
        && !sourceFailed
        && !sourceStopRequested
        && !limiter.destroyed
      ) {
        sourceFailed = true;
        limiter.destroy(requestStreamClosedPrematurely());
      }
    }
    cleanupListeners();
    if (
      !listenersRemoved
      && limiterClosed
      && sourceObserverAttempts >= SOURCE_OBSERVER_MAX_ATTEMPTS
    ) {
      releaseLifecycle(true);
      return;
    }
    if (
      !listenersRemoved
      && limiterClosed
      && !sourceClosed
      && (req.destroyed === true || sourceEnded)
      && sourceObserverTimer == null
    ) {
      sourceObserverTimer = setTimeout(() => {
        sourceObserverTimer = undefined;
        if (limiterClosed) sourceObserverAttempts += 1;
        reconcileSourceState();
      }, SOURCE_OBSERVER_INTERVAL_MS);
      sourceObserverTimer.unref?.();
    }
  };
  const scheduleReconcileSourceState = () => {
    if (listenersRemoved || reconcileScheduled) return;
    reconcileScheduled = true;
    queueMicrotask(() => {
      reconcileScheduled = false;
      reconcileSourceState();
    });
  };
  unsubscribeSourceDestroy = subscribeToSourceDestroy(
    req,
    scheduleReconcileSourceState,
  );
  req.on('error', onSourceError);
  req.once('end', onSourceEnd);
  req.once('close', onSourceClose);
  limiter.once('close', () => {
    limiterClosed = true;
    reconcileSourceState();
  });

  reconcileSourceState();
  if (!limiter.destroyed) req.pipe(limiter);
  reconcileSourceState();
  return limiter;
}
