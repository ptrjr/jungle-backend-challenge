export const NO_NUL = /^[^\u0000]*$/;
export const CORRELATION_ID = /^\S(?:[\s\S]*\S)?$/;

export function validCorrelationId(value: string): boolean {
  return value.length <= 128 && CORRELATION_ID.test(value) && NO_NUL.test(value);
}
