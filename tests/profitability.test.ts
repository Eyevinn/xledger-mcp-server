import { describe, it, expect } from "vitest";
import { aggregateConsultants } from "../src/profitability.js";

const row = (employee: string, project: string, hours: number, billable: boolean, timeType = "Normal") => ({
  assignmentDate: "2026-03-02",
  workingHours: String(hours),
  invoiceHours: billable ? String(hours) : "0",
  employee: { description: employee, email: "p@example.com" },
  project: { description: project, billable, customer: { description: billable ? "Customer" : "Own company" } },
  timeType: { description: timeType },
});

const entries = [
  row("Person A", "Customer project X", 120, true),
  row("Person A", "Internal development", 20, false),
  row("Person A", "Sjukfrånvaro", 16, false),
  row("Person A", "Tillfällig föräldrapenning", 8, false),
  row("Person B", "Semester", 40, false),
];

const base = { fromDate: "2026-03-01", toDate: "2026-03-31", periodMonths: 1, hourlyRate: 1000 };

describe("aggregateConsultants", () => {
  it("default: absence counts into hours.absence but never appears in projects", () => {
    const [a, b] = aggregateConsultants(entries, base);
    expect(a.hours.absence).toBe(24);
    expect(a.hours.total).toBe(164);
    expect(a.hours.billable).toBe(120);
    expect(a.hours.utilizationRate).toBe("85.7%");
    expect(a.projects.map((p) => p.project)).toEqual(["Customer project X", "Internal development"]);
    expect(b.hours.absence).toBe(40);
    expect(b.projects).toEqual([]);
    expect(JSON.stringify([a, b])).not.toMatch(/Sjuk|Tillfällig|Semester/);
  });

  it("allowAbsenceDetail (two-key gate satisfied): absence projects listed under their names", () => {
    const [a] = aggregateConsultants(entries, { ...base, allowAbsenceDetail: true });
    expect(a.projects.map((p) => p.project)).toContain("Sjukfrånvaro");
    expect(a.hours.absence).toBe(24);
  });

  it("revenue and cost are computed from billable hours only", () => {
    const [a] = aggregateConsultants(entries, { ...base, monthlySalary: 50000, agAvgPct: 30 });
    expect(a.financials.totalRevenue).toBe(120000);
    expect(a.financials.totalCost).toBe(65000);
    expect(a.financials.margin).toBe(55000);
  });
});

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
  // ASCII spellings (no diacritics) and upper case.
  "Vard av barn",
  "Lakarbesok",
  "Smittbararpenning",
  "Tandlakare",
  "LAKARBESOK",
  // NFD-decomposed forms (combining marks), as some exports deliver them.
  "Läkarbesök".normalize("NFD"),
  "Vård av barn".normalize("NFD"),
  "Smittbärarpenning".normalize("NFD"),
  "Tandläkare".normalize("NFD"),
  "Närståendepenning".normalize("NFD"),
  // Further health stems that are also counted as absence.
  "Tandläkare",
  "Läk. besök",
  "Närståendepenning",
  "Vård av anhörig",
  "Rehab",
  "Rehabilitering",
  "Sjukhusbesök",
  "Doctor appointment",
  "Doctor's appointment",
  "Dentist",
  "Medical appointment",
  "Hospital visit",
  "Occupational injury",
];

// Health stems used for redaction only: redacted (errs safe), never disclosed,
// but not counted as absence, so a customer project with such a name is work.
const REDACT_ONLY_NAMES = ["Medical imaging", "Hospital systems", "Doctor portal", "Psykiatri", "Injury claims", "Anhörigstöd"];

describe("aggregateConsultants: every absence name, project or time type", () => {
  const rows = [
    row("Person A", "Customer project X", 100, true),
    ...HEALTH_ABSENCE_NAMES.map((n) => row("Person A", n, 1, false)),
    ...HEALTH_ABSENCE_NAMES.map((n) => row("Person A", "Intern", 1, false, n)),
    row("Person A", "Intern", 2, false, "Sjuk"),
    row("Person A", "Medical imaging", 10, true),
  ];

  it("counts all of them as absence and never names them in projects", () => {
    const [a] = aggregateConsultants(rows, base);
    expect(a.hours.absence).toBe(HEALTH_ABSENCE_NAMES.length * 2 + 2);
    expect(a.hours.billable).toBe(110);
    expect(a.hours.nonBillable).toBe(0);
    const out = JSON.stringify(a.projects);
    for (const n of [...HEALTH_ABSENCE_NAMES, "Sjuk", "Intern"]) expect(out).not.toContain(n);
  });

  it('"Medical imaging" counts as billable, not absence, and is listed as Redacted', () => {
    const [a] = aggregateConsultants(rows, base);
    expect(a.projects.map((p) => p.project)).toEqual(["Customer project X", "Redacted (billable)"]);
    expect(a.projects[1]).toMatchObject({ hours: 10, customer: "-", billable: true });
    expect(JSON.stringify(a)).not.toMatch(/Medical/);
  });

  it("two-key gate satisfied: real names shown", () => {
    const [a] = aggregateConsultants(rows, { ...base, allowAbsenceDetail: true });
    expect(a.projects.map((p) => p.project)).toContain("Medical imaging");
    expect(a.projects.map((p) => p.project)).toContain("Läkarbesök");
  });
});

describe("aggregateConsultants: redaction-only health stems", () => {
  it("count as ordinary work but are listed as Redacted, as project or time type", () => {
    const rows = [
      ...REDACT_ONLY_NAMES.map((n) => row("Person B", n, 1, true)),
      ...REDACT_ONLY_NAMES.map((n) => row("Person B", "Customer project Y", 1, false, n)),
      row("Person B", "Kompetensutveckling", 4, false),
    ];
    const [b] = aggregateConsultants(rows, base);
    expect(b.hours.absence).toBe(0);
    expect(b.hours.billable).toBe(REDACT_ONLY_NAMES.length);
    expect(b.projects.map((p) => p.project).sort()).toEqual(
      ["Kompetensutveckling", "Redacted (billable)", "Redacted (non-billable)"].sort()
    );
    const out = JSON.stringify(b);
    for (const n of REDACT_ONLY_NAMES) expect(out).not.toContain(n);
  });
});
