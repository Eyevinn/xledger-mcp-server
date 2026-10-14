import { describe, it, expect } from "vitest";
import { aggregateConsultants } from "../src/profitability.js";

const row = (employee: string, project: string, hours: number, billable: boolean) => ({
  assignmentDate: "2026-03-02",
  workingHours: String(hours),
  invoiceHours: billable ? String(hours) : "0",
  employee: { description: employee, email: "p@example.com" },
  project: { description: project, billable, customer: { description: billable ? "Customer" : "Own company" } },
  timeType: { description: "Normal" },
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
