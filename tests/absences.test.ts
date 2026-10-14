import { describe, it, expect } from "vitest";
import {
  aggregateAbsences,
  applyArt9Gate,
  guardAbsenceRowsPayload,
  isAbsenceProject,
  isAbsenceRow,
  isDisclosableAbsenceType,
  redactAbsenceRows,
  shouldRedact,
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

  it("treats temporary parental benefit / care of a sick child as health, even though it says parental", () => {
    for (const t of [
      "Tillfällig föräldrapenning",
      "Tillf. föräldraledighet",
      "Temporary parental leave",
      "Temporary parental benefit",
      "Vård av barn",
      "VAB-dag",
      "Care of sick child",
      "Care of a child",
    ]) {
      expect(isDisclosableAbsenceType(t)).toBe(false);
    }
  });

  it("temporary parental leave is aggregated, not shown per person", () => {
    const r = applyArt9Gate(
      [mk("Person P", "Föräldraledig", 40), mk("Person Q", "Tillfällig föräldrapenning", 16)],
      { env: {} }
    );
    expect(names(r)).toEqual(["Person P/Föräldraledig"]);
    expect(r.healthRelatedAbsence?.totalHours).toBe(16);
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

// Timesheet-shaped rows, as returned by get_timesheets.
const ts = (employee: string, project: string, timeType: string, extra: Record<string, unknown> = {}) => ({
  assignmentDate: "2026-03-02",
  workingHours: "8",
  text: `${project} note`,
  comment: `${timeType} comment`,
  employee: { description: employee, email: "x@example.com" },
  project: { code: "P1", description: project, customer: { description: "Own company" }, billable: false },
  timeType: { description: timeType },
  ...extra,
});

describe("redactAbsenceRows (get_timesheets / get_expenses / get_journal_entries)", () => {
  const rows = [
    ts("Person A", "Customer project X", "Normal time"),
    ts("Person B", "Frånvaro", "Sjukdag 2-14"),
    ts("Person C", "Internal", "Tillfällig föräldrapenning"),
  ];

  it("default: absence rows lose project/time-type names and free text; others untouched", () => {
    const r = redactAbsenceRows(rows, { env: {} });
    expect(r.absenceRowsRedacted).toBe(2);
    expect(r.items[0]).toEqual(rows[0]);
    for (const row of r.items.slice(1)) {
      expect(row.project.description).toBe("Absence");
      expect(row.project.code).toBeNull();
      expect(row.timeType.description).toBe("Absence");
      expect(row).not.toHaveProperty("text");
      expect(row).not.toHaveProperty("comment");
      expect(row.workingHours).toBe("8");
      expect(row.employee.description).toMatch(/Person/);
    }
    const out = JSON.stringify(r.items.slice(1));
    expect(out).not.toMatch(/Sjuk|Frånvaro|Tillfällig|föräldra/i);
    expect(r.healthDetailRefused).toBeUndefined();
  });

  it("does not mutate the input rows", () => {
    redactAbsenceRows(rows, { env: {} });
    expect(rows[1].project.description).toBe("Frånvaro");
    expect(rows[1].text).toBe("Frånvaro note");
  });

  it("flag without env var: still redacted, refusal reported", () => {
    const r = redactAbsenceRows(rows, { includeHealthDetail: true, env: {} });
    expect(r.absenceRowsRedacted).toBe(2);
    expect(typeof r.healthDetailRefused).toBe("string");
  });

  it("env var without flag: still redacted", () => {
    const r = redactAbsenceRows(rows, { env: { XLEDGER_ALLOW_ART9_DETAIL: "1" } });
    expect(r.absenceRowsRedacted).toBe(2);
  });

  it("flag AND env var: rows returned unchanged", () => {
    const r = redactAbsenceRows(rows, {
      includeHealthDetail: true,
      env: { XLEDGER_ALLOW_ART9_DETAIL: "1" },
    });
    expect(r.absenceRowsRedacted).toBe(0);
    expect(r.items).toEqual(rows);
    expect(r.healthDetailRefused).toBeUndefined();
  });

  it("journal-entry shape: only the listed text fields are dropped", () => {
    const je = { text: "Sjuklön", amount: "100", project: { code: "9", description: "Sjukfrånvaro" } };
    const r = redactAbsenceRows([je], { env: {}, textFields: ["text"] });
    expect(r.items[0]).toEqual({ amount: "100", project: { code: null, description: "Absence" } });
  });

  it("payload: plain array when nothing is redacted, wrapped with a note otherwise", () => {
    expect(guardAbsenceRowsPayload([rows[0]], { env: {} })).toEqual([rows[0]]);
    const p = guardAbsenceRowsPayload(rows, { env: {} }) as Record<string, any>;
    expect(p.absenceRowsRedacted).toBe(2);
    expect(typeof p.note).toBe("string");
    expect(p.items).toHaveLength(3);
    const refused = guardAbsenceRowsPayload([rows[0]], { includeHealthDetail: true, env: {} }) as Record<string, any>;
    expect(typeof refused.healthDetailRefused).toBe("string");
  });
});

// Health and leave names that must be treated as absence AND redacted,
// whether they appear as the project or as the time type.
const HEALTH_ABSENCE_NAMES = [
  "Vård av barn",
  "Karens",
  "Karensdag",
  "Illness",
  "Medical leave",
  "Läkarbesök",
  "Graviditetspenning",
  "Smittbärarpenning",
  "Arbetsskada",
  "Ledighet",
  "Leave",
  "Childcare",
];

describe("isAbsenceRow / shouldRedact on every absence name", () => {
  for (const name of HEALTH_ABSENCE_NAMES) {
    it(`${name}: absence and redacted as project and as time type`, () => {
      const asProject = { project: { description: name }, timeType: { description: "Normal" } };
      const asTimeType = { project: { description: "Intern" }, timeType: { description: name } };
      expect(isAbsenceRow(asProject)).toBe(true);
      expect(isAbsenceRow(asTimeType)).toBe(true);
      expect(shouldRedact(asProject)).toBe(true);
      expect(shouldRedact(asTimeType)).toBe(true);
      expect(isDisclosableAbsenceType(name)).toBe(false);
    });
  }

  it("timeType-only Sjuk on project Intern is absence", () => {
    expect(isAbsenceRow({ project: { description: "Intern" }, timeType: { description: "Sjuk" } })).toBe(true);
  });

  it('customer project "Medical imaging" is redacted (errs safe) but NOT counted as absence', () => {
    const row = { project: { description: "Medical imaging" }, timeType: { description: "Normal" } };
    expect(isAbsenceRow(row)).toBe(false);
    expect(shouldRedact(row)).toBe(true);
  });

  it("ordinary rows are neither", () => {
    const row = { project: { description: "Customer project X" }, timeType: { description: "Normal" } };
    expect(isAbsenceRow(row)).toBe(false);
    expect(shouldRedact(row)).toBe(false);
  });
});

describe("guardAbsenceRowsPayload on every absence name", () => {
  const rows = [
    ...HEALTH_ABSENCE_NAMES.map((n) => ts("Person A", n, "Normal")),
    ...HEALTH_ABSENCE_NAMES.map((n) => ts("Person B", "Intern", n)),
    ts("Person C", "Intern", "Sjuk"),
  ];

  it("redacts every row, project or time type, and leaks no name", () => {
    const p = guardAbsenceRowsPayload(rows, { env: {} }) as Record<string, any>;
    expect(p.absenceRowsRedacted).toBe(rows.length);
    for (const row of p.items) {
      expect(row.project.description).toBe("Absence");
      expect(row.timeType.description).toBe("Absence");
      expect(row).not.toHaveProperty("text");
      expect(row).not.toHaveProperty("comment");
    }
    const out = JSON.stringify(p.items);
    for (const n of [...HEALTH_ABSENCE_NAMES, "Sjuk"]) expect(out).not.toContain(n);
  });

  it('"Medical imaging" is redacted with the "Redacted" label, not "Absence"', () => {
    const p = guardAbsenceRowsPayload([ts("Person D", "Medical imaging", "Normal")], { env: {} }) as Record<
      string,
      any
    >;
    expect(p.absenceRowsRedacted).toBe(1);
    expect(p.items[0].project.description).toBe("Redacted");
    expect(p.items[0].timeType.description).toBe("Redacted");
    expect(JSON.stringify(p.items)).not.toMatch(/Medical/);
  });
});

describe("get_absences row selection agrees with the payload guard", () => {
  it("every absence name, as project or time type, lands in the anonymous aggregate", () => {
    const tsRows = [
      ...HEALTH_ABSENCE_NAMES.map((n) => ts("Person A", n, "Normal")),
      ...HEALTH_ABSENCE_NAMES.map((n) => ts("Person B", "Intern", n)),
      ts("Person C", "Intern", "Sjuk"),
      ts("Person D", "Medical imaging", "Normal"),
    ];
    // Same selection and absenceType rule as the get_absences tool.
    const absRows = tsRows.filter(isAbsenceRow).map((n) => ({
      date: n.assignmentDate,
      hours: parseFloat(n.workingHours),
      employee: n.employee.description,
      email: n.employee.email,
      absenceType: n.timeType.description || n.project.description,
    }));
    expect(absRows).toHaveLength(HEALTH_ABSENCE_NAMES.length * 2 + 1);
    const r = applyArt9Gate(aggregateAbsences(absRows), { env: {} });
    expect(JSON.stringify(r.byEmployeeAndType)).not.toMatch(/Person/);
    expect(r.healthRelatedAbsence?.totalHours).toBe(absRows.length * 8);
  });
});
