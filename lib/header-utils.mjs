const ALWAYS_STRIP = new Set([
  'host', 'connection', 'content-length', 'accept-encoding', 'keep-alive',
  'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade'
]);

export function getHeader(headers, name) {
  const wanted = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === wanted && value !== undefined && value !== null) return String(value);
  }
  return undefined;
}

export function deleteHeader(headers, name) {
  const wanted = String(name).toLowerCase();
  for (const key of Object.keys(headers || {})) {
    if (key.toLowerCase() === wanted) delete headers[key];
  }
}

export function setHeader(headers, name, value) {
  deleteHeader(headers, name);
  headers[name] = String(value);
}

export function stripRequestHeaders(input, requestId) {
  const headers = { ...(input || {}) };
  const connectionTokens = (getHeader(headers, 'connection') || '')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if (ALWAYS_STRIP.has(lower) || connectionTokens.includes(lower)
        || lower.startsWith('x-relay-') || lower.startsWith('x-header-relay-')) delete headers[key];
  }
  setHeader(headers, 'X-Header-Relay-Request-ID', requestId);
  return headers;
}

export function mergeCsvHeader(existing, required = [], removed = []) {
  const removedSet = new Set(removed.map(value => String(value).trim()).filter(Boolean));
  const seen = new Set();
  const output = [];
  const values = [...String(existing || '').split(','), ...required];
  for (const raw of values) {
    const value = String(raw).trim();
    if (!value || removedSet.has(value) || seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output.join(',');
}

export function sanitizeLogMessage(value, maxLength = 500) {
  return String(value || '')
    .replace(
      /\/forward\/(?:[^\s?]|[\u0000-\u001f\u007f-\u009f])+(?:\?(?:[^\s]|[\u0000-\u001f\u007f-\u009f])*)?/g,
      '/forward/[redacted]'
    )
    .replace(
      /https?:\/\/(?:[^\s]|[\u0000-\u001f\u007f-\u009f])+/gi,
      '[url-redacted]'
    )
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}
