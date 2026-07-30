export class RelayError extends Error {
  constructor(statusCode, code, publicMessage = code, options = {}) {
    super(publicMessage, options);
    this.name = 'RelayError';
    this.statusCode = statusCode;
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

export function relayErrorStatus(error) {
  if (Number.isInteger(error?.statusCode)) return error.statusCode;
  if (error?.name === 'AbortError') return 504;
  return 502;
}
