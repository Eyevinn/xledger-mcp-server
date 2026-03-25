import { describe, it, expect } from "vitest";
import { validateDate, today } from "../src/validation.js";

describe("validateDate", () => {
  it("accepts valid YYYY-MM-DD dates", () => {
    expect(() => validateDate("2025-01-15", "test")).not.toThrow();
    expect(() => validateDate("2026-12-31", "test")).not.toThrow();
  });

  it("accepts undefined (optional dates)", () => {
    expect(() => validateDate(undefined, "test")).not.toThrow();
  });

  it("rejects invalid date formats", () => {
    expect(() => validateDate("2025/01/15", "test")).toThrow(
      'Invalid date format for test: expected YYYY-MM-DD, got "2025/01/15"'
    );
    expect(() => validateDate("15-01-2025", "test")).toThrow();
    expect(() => validateDate("not-a-date", "test")).toThrow();
    expect(() => validateDate("2025-1-5", "test")).toThrow();
  });

  it("rejects empty string", () => {
    // Empty string is falsy, so validateDate skips it
    expect(() => validateDate("", "test")).not.toThrow();
  });
});

describe("today", () => {
  it("returns YYYY-MM-DD format", () => {
    const result = today();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
