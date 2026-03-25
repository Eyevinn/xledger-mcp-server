/**
 * Input validation helpers
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateDate(
  value: string | undefined,
  name: string
): void {
  if (value && !DATE_RE.test(value)) {
    throw new Error(
      `Invalid date format for ${name}: expected YYYY-MM-DD, got "${value}"`
    );
  }
}

export function today(): string {
  return new Date().toISOString().split("T")[0];
}
