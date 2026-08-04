export class AtlasError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AtlasError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function fail(status, code, message, details) {
  throw new AtlasError(status, code, message, details);
}

export function errorBody(error) {
  const known = error instanceof AtlasError;
  const body = {
    error: {
      code: known ? error.code : 'INTERNAL_ERROR',
      message: known ? error.message : 'An internal error occurred.',
    },
  };
  if (known && error.details !== undefined) body.error.details = error.details;
  return { status: known ? error.status : 500, body };
}
