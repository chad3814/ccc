// Domain errors that endpoints can map to HTTP statuses. Concepts may throw
// their own Error subclasses too; those map to 500 unless an endpoint
// translates them.
export class DomainError extends Error {
  readonly status: number = 400;

  constructor(message?: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class Invalid extends DomainError {
  override readonly status = 400;
}

export class Unauthorized extends DomainError {
  override readonly status = 401;
}

export class NotFound extends DomainError {
  override readonly status = 404;
}

export class Conflict extends DomainError {
  override readonly status = 409;
}

export function httpStatusOf(err: Error): number {
  return err instanceof DomainError ? err.status : 500;
}
