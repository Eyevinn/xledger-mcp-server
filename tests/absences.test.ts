import { describe, it, expect } from "vitest";
import {
  aggregateAbsences,
  applyArt9Gate,
  isAbsenceProject,
  isDisclosableAbsenceType,
  type AbsenceAggregate,
} from "../src/absences.js";

const mk = (employee: string, absenceType: string, totalHours: number): AbsenceAggregate => ({
  employee,
  email: `${employee.toLowerCase().replace(/ /g, ".")}@example.com`,
  absenceType,
  totalHours,
  days: 1,
  firstDate: "2026-01-02",
  lastDate: "2026-09-04",
});

// Synthetic people; absence types mirror real Swedish + English Xledger setups.
const sample: AbsenceAggregate[] = [
  mk("Person A", "Semester", 192),
  mk("Person B", "Föräldraledig", 120),
  mk("Person C", "Sjukfrånvaro dag 15->", 220),
  mk("Person D", "Sjukdag 2-14", 120),
  mk("Person E", "VAB", 16),
  mk("Person F", "Karensdag", 56),
  mk("Person D", "Karensdag", 48),
  mk("Person G", "Kompledig uttag", 48.5),
  mk("Person H", "Tjänstledig", 25),
];

const HEALTH = /sjuk|karensdag|vab/i;
const names = (r: { byEmployeeAndType: AbsenceAggregate[] }) =>
  r.byEmployeeAndType.map((a) => `${a.employee}/${a.absenceType}`);

describe("applyArt9Gate", () => {
  it("default: no health absence per named employee, aggregate instead", () => {
    const r = applyArt9Gate(sample, { env: {} });
    expect(names(r).some((n) => HEALTH.test(n))).toBe(false);
    expect(r.byEmployeeAndType).toHaveLength(4);
    expect(r.healthRelatedAbsence?.totalHours).toBe(460);
    expect(r.healthRelatedAbsence?.employeeCount).toBe(4);
    expect(JSON.stringify(r.healthRelatedAbsence)).not.toMatch(/Person/);
    expect(r.healthDetailRefused).toBeUndefined();
  });

  it("flag set without env var: refused, still aggregated", () => {
    const r = applyArt9Gate(sample, { includeHealthDetail: true, env: {} });
    expect(names(r).some((n) => HEALTH.test(n))).toBe(false);
    expect(typeof r.healthDetailRefused).toBe("string");
  });

  it("env var set to something other than 1: refused", () => {
    const r = applyArt9Gate(sample, {
      includeHealthDetail: true,
      env: { XLEDGER_ALLOW_ART9_DETAIL: "true" },
    });
    expect(names(r).some((n) => HEALTH.test(n))).toBe(false);
    expect(typeof r.healthDetailRefused).toBe("string");
  });

  it("env var set but flag not set: still aggregated", () => {
    const r = applyArt9Gate(sample, { env: { XLEDGER_ALLOW_ART9_DETAIL: "1" } });
    expect(names(r).some((n) => HEALTH.test(n))).toBe(false);
    expect(r.healthRelatedAbsence).toBeDefined();
  });

  it("flag AND env var: full per-person detail, no aggregate, no refusal", () => {
    const r = applyArt9Gate(sample, {
      includeHealthDetail: true,
      env: { XLEDGER_ALLOW_ART9_DETAIL: "1" },
    });
    expect(names(r).some((n) => HEALTH.test(n))).toBe(true);
    expect(r.byEmployeeAndType).toHaveLength(sample.length);
    expect(r.healthRelatedAbsence).toBeUndefined();
    expect(r.healthDetailRefused).toBeUndefined();
  });

  it("fails closed: unrecognised absence types are aggregated, not shown per person", () => {
    const r = applyArt9Gate([mk("Person X", "Frånvaro", 8), mk("Person Y", "Rehab", 4)], {
      env: {},
    });
    expect(r.byEmployeeAndType).toHaveLength(0);
    expect(r.healthRelatedAbsence?.totalHours).toBe(12);
    expect(r.healthRelatedAbsence?.employeeCount).toBe(2);
  });

  it("respects the row limit", () => {
    const r = applyArt9Gate(sample, { first: 2, env: {} });
    expect(r.byEmployeeAndType).toHaveLength(2);
  });
});

describe("absence classification", () => {
  it("recognises English and Swedish non-health types", () => {
    for (const t of ["Vacation", "Annual leave", "Parental leave", "Semester", "Föräldraledig", "Tjänstledig"]) {
      expect(isDisclosableAbsenceType(t)).toBe(true);
    }
  });

  it("never discloses health types", () => {
    for (const t of ["Sick leave", "Sjukdag", "VAB", "Karensdag", "Child care (sick child)", "Medical appointment", "Sick parental leave"]) {
      expect(isDisclosableAbsenceType(t)).toBe(false);
    }
  });

  it("detects absence projects", () => {
    expect(isAbsenceProject("Frånvaro")).toBe(true);
    expect(isAbsenceProject("Absence")).toBe(true);
    expect(isAbsenceProject("Customer project X")).toBe(false);
    expect(isAbsenceProject(undefined)).toBe(false);
  });
});

describe("aggregateAbsences", () => {
  it("groups by employee and type and tracks date range", () => {
    const agg = aggregateAbsences([
      { date: "2026-03-02", hours: 8, employee: "P", email: "", absenceType: "Semester" },
      { date: "2026-03-01", hours: 4.04, employee: "P", email: "", absenceType: "Semester" },
      { date: "2026-03-05", hours: 8, employee: "P", email: "", absenceType: "VAB" },
    ]);
    const sem = agg.find((a) => a.absenceType === "Semester")!;
    expect(agg).toHaveLength(2);
    expect(sem.totalHours).toBe(12);
    expect(sem.days).toBe(2);
    expect(sem.firstDate).toBe("2026-03-01");
    expect(sem.lastDate).toBe("2026-03-02");
  });
});
