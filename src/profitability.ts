/**
 * Consultant profitability aggregation over timesheet rows.
 *
 * Absence rows count into absenceHours only. They never appear in the
 * per-consultant `projects` breakdown, because an absence project name tied to
 * a named person can reveal health data (GDPR Art. 9). The breakdown includes
 * them under their real name only when the two-key gate in absences.ts is
 * satisfied.
 */

import { isAbsenceProject } from "./absences.js";
import type { Node } from "./pagination.js";

export interface ProfitabilityOptions {
  fromDate: string;
  toDate: string;
  periodMonths: number;
  monthlySalary?: number;
  hourlyRate?: number;
  agAvgPct?: number;
  /** Result of art9DetailAllowed(); false unless both keys are set. */
  allowAbsenceDetail?: boolean;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function aggregateConsultants(entries: Node[], opts: ProfitabilityOptions) {
  const { fromDate, toDate, periodMonths, monthlySalary, hourlyRate, allowAbsenceDetail = false } = opts;
  const contributionPct = opts.agAvgPct ?? 31.42;
  const monthlyCost = monthlySalary ? monthlySalary * (1 + contributionPct / 100) : null;
  const totalCostForPeriod = monthlyCost ? monthlyCost * periodMonths : null;

  type ProjAgg = { customer: string; billable: boolean; hours: number; invoiceHours: number };
  type EmpAgg = {
    email: string;
    totalHours: number;
    billableHours: number;
    nonBillableHours: number;
    absenceHours: number;
    projects: Record<string, ProjAgg>;
  };
  const byEmployee: Record<string, EmpAgg> = {};

  for (const entry of entries) {
    const name = entry.employee?.description || "Unknown";
    if (!byEmployee[name]) {
      byEmployee[name] = {
        email: entry.employee?.email || "",
        totalHours: 0,
        billableHours: 0,
        nonBillableHours: 0,
        absenceHours: 0,
        projects: {},
      };
    }
    const emp = byEmployee[name];
    const hours = parseFloat(entry.workingHours || "0");
    const invHours = parseFloat(entry.invoiceHours || "0");
    const isAbsence = isAbsenceProject(entry.project?.description);
    const isBillable = entry.project?.billable === true;

    emp.totalHours += hours;
    if (isAbsence) emp.absenceHours += hours;
    else if (isBillable) emp.billableHours += hours;
    else emp.nonBillableHours += hours;

    // Absence stays out of the named project breakdown unless the gate allows it.
    if (isAbsence && !allowAbsenceDetail) continue;

    const projKey = entry.project?.description || "Unknown";
    if (!emp.projects[projKey]) {
      emp.projects[projKey] = {
        customer: entry.project?.customer?.description || "-",
        billable: isBillable,
        hours: 0,
        invoiceHours: 0,
      };
    }
    emp.projects[projKey].hours += hours;
    emp.projects[projKey].invoiceHours += invHours;
  }

  return Object.entries(byEmployee)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, d]) => {
      const base = d.totalHours - d.absenceHours;
      const utilizationRate = base > 0 ? Math.round((d.billableHours / base) * 1000) / 10 : 0;
      const totalRevenue = hourlyRate ? Math.round(d.billableHours * hourlyRate) : null;
      const totalCost = totalCostForPeriod;
      const margin = totalRevenue !== null && totalCost !== null ? totalRevenue - totalCost : null;
      const marginPct =
        margin !== null && totalRevenue ? Math.round((margin / totalRevenue) * 1000) / 10 : null;
      const breakevenRate =
        totalCost !== null && d.billableHours > 0 ? Math.round(totalCost / d.billableHours) : null;

      return {
        employee: name,
        email: d.email,
        period: { from: fromDate, to: toDate, months: periodMonths },
        assumptions: {
          monthlySalary: monthlySalary ?? null,
          agAvgPct: contributionPct,
          monthlyCostWithContributions: monthlyCost ? Math.round(monthlyCost) : null,
          hourlyRate: hourlyRate ?? null,
        },
        hours: {
          total: round1(d.totalHours),
          billable: round1(d.billableHours),
          nonBillable: round1(d.nonBillableHours),
          absence: round1(d.absenceHours),
          utilizationRate: `${utilizationRate}%`,
        },
        financials: {
          totalCost,
          totalRevenue,
          margin,
          marginPct: marginPct !== null ? `${marginPct}%` : null,
          breakevenHourlyRate: breakevenRate,
        },
        projects: Object.entries(d.projects)
          .sort(([, a], [, b]) => b.hours - a.hours)
          .map(([proj, pd]) => ({
            project: proj,
            customer: pd.customer,
            billable: pd.billable,
            hours: round1(pd.hours),
            revenue: hourlyRate && pd.billable ? Math.round(pd.invoiceHours * hourlyRate) : null,
          })),
      };
    });
}
