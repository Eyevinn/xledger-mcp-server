/**
 * Absence classification and the GDPR Art. 9 guard.
 *
 * Absences are derived from timesheet rows booked to absence projects. An
 * absence type tied to a named person can reveal health data (sick leave,
 * care of a sick child), which is special-category personal data under
 * GDPR Art. 9. Tool results are sent to an AI model provider, so the split
 * is done here, before data leaves the server, rather than relying on a
 * downstream instruction.
 *
 * The guard fails closed: only absence types positively recognised as
 * non-health are returned per person. Health-related types, and any type the
 * server does not recognise, are collapsed into one anonymous aggregate.
 */

/** Projects whose description marks the row as absence (Swedish + English). */
export const ABSENCE_RE =
  /frånvaro|semester|sjuk|föräldra|vab|tjänstled|permission|absence|vacation|holiday|sick|parental/i;

/** Absence types that reveal health information (own or a child's). */
export const HEALTH_RE =
  /sjuk|karens|\bvab\b|graviditet|smittbärar|sick|illness|medical|pregnan|child care|childcare/i;

/** Absence types positively recognised as non-health. */
export const NON_HEALTH_RE =
  /semester|föräldra|komp|tjänstled|vacation|holiday|annual leave|parental|paternity|maternity|time off in lieu|toil|leave of absence/i;

export function isAbsenceProject(projectDescription: string | undefined): boolean {
  return ABSENCE_RE.test(projectDescription || "");
}

/** True only for types that may be shown per named employee. */
export function isDisclosableAbsenceType(absenceType: string | undefined): boolean {
  const t = absenceType || "";
  return NON_HEALTH_RE.test(t) && !HEALTH_RE.test(t);
}

export interface AbsenceRow {
  date: string;
  hours: number;
  employee: string;
  email: string;
  absenceType: string;
}

export interface AbsenceAggregate {
  employee: string;
  email: string;
  absenceType: string;
  totalHours: number;
  days: number;
  firstDate: string;
  lastDate: string;
}

export function aggregateAbsences(rows: AbsenceRow[]): AbsenceAggregate[] {
  const agg: Record<string, AbsenceAggregate> = {};
  for (const r of rows) {
    const key = `${r.employee}||${r.absenceType}`;
    if (!agg[key]) {
      agg[key] = {
        employee: r.employee,
        email: r.email,
        absenceType: r.absenceType,
        totalHours: 0,
        days: 0,
        firstDate: r.date,
        lastDate: r.date,
      };
    }
    agg[key].totalHours += r.hours;
    agg[key].days += 1;
    if (r.date < agg[key].firstDate) agg[key].firstDate = r.date;
    if (r.date > agg[key].lastDate) agg[key].lastDate = r.date;
  }
  return Object.values(agg).map((a) => ({
    ...a,
    totalHours: Math.round(a.totalHours * 10) / 10,
  }));
}

export const ART9_ENV_VAR = "XLEDGER_ALLOW_ART9_DETAIL";

export interface Art9GateResult {
  byEmployeeAndType: AbsenceAggregate[];
  healthRelatedAbsence?: {
    totalHours: number;
    employeeCount: number;
    note: string;
  };
  healthDetailRefused?: string;
}

/**
 * Apply the Art. 9 guard. Per-person detail for every absence type is only
 * returned when the caller sets includeHealthDetail AND the server operator
 * has set XLEDGER_ALLOW_ART9_DETAIL=1. Either one alone is not enough.
 */
export function applyArt9Gate(
  aggregates: AbsenceAggregate[],
  {
    includeHealthDetail = false,
    first = 100,
    env = process.env,
  }: {
    includeHealthDetail?: boolean;
    first?: number;
    env?: Record<string, string | undefined>;
  } = {}
): Art9GateResult {
  const allowDetail = includeHealthDetail === true && env[ART9_ENV_VAR] === "1";

  const disclosable = aggregates.filter((a) => isDisclosableAbsenceType(a.absenceType));
  const restricted = aggregates.filter((a) => !isDisclosableAbsenceType(a.absenceType));

  const byEmployeeAndType = [...(allowDetail ? aggregates : disclosable)]
    .sort((a, b) => a.employee.localeCompare(b.employee) || b.totalHours - a.totalHours)
    .slice(0, first);

  const result: Art9GateResult = { byEmployeeAndType };

  if (!allowDetail && restricted.length > 0) {
    result.healthRelatedAbsence = {
      totalHours:
        Math.round(restricted.reduce((s, a) => s + a.totalHours, 0) * 10) / 10,
      employeeCount: new Set(restricted.map((a) => a.employee)).size,
      note:
        "Aggregated per GDPR Art. 9. Health-related absence types, and any absence type not recognised as non-health, are returned only as total hours and headcount. Names and absence codes are withheld by design. These hours ARE included in totalAbsenceHours.",
    };
  }

  if (includeHealthDetail === true && !allowDetail) {
    result.healthDetailRefused = `includeHealthDetail was set but ${ART9_ENV_VAR} is not 1 in the server environment. Per-person health absence detail is withheld. Enabling it is a decision for the data controller, not for the calling assistant.`;
  }

  return result;
}
