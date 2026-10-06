export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message = code,
  ) {
    super(message);
  }
}
export function ensure(value: unknown, status: number, code: string): asserts value {
  if (!value) throw new ApiError(status, code);
}
