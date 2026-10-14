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

/**
 * Normalise a name before any pattern is tested: Unicode NFD, combining marks
 * stripped, lower-cased. "Läkarbesök", NFD-decomposed "Läkarbesök" and the
 * ASCII spelling "Lakarbesok" all become "lakarbesok", so every pattern below
 * is written in plain ASCII lower case and matches all three forms.
 */
export const norm = (s: string | undefined | null): string =>
  (s || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * Explicit absence terms (Swedish + English, ASCII after norm()), used to
 * COUNT absence hours and to label rows "Absence". Deliberately narrower than
 * the redaction predicate: it does not use HEALTH_RE's broad stems ("medical",
 * "hospital", "temporary", "tillf"), so a customer project such as "Medical
 * imaging" is not counted as absence.
 */
export const ABSENCE_RE =
  /franvaro|semester|sjuk|karens|foraldra|vab|vard av barn|vard av anhorig|narstaende|tjanstled|ledig|komp(ledig|tid|ensationsledig)|\btoil\b|permission|lakar|\blak\.|tandlak|graviditet|smittbarar|arbetsskada|rehab|absence|vacation|holiday|sick|illness|medical leave|medical appointment|doctor appointment|doctor'?s appointment|dentist|hospital visit|occupational injury|parental|paternity|maternity|pregnan|\bleave\b|childcare|child care|care of (a )?(sick )?child|time off/;

/**
 * Absence types that reveal health information (own, a child's or a close
 * relative's). Checked before NON_HEALTH_RE, so health wins: temporary
 * parental benefit/leave ("Tillfällig föräldrapenning", "Temporary parental
 * leave") is care of a sick child and must not be disclosed via the
 * parental-leave match. ASCII after norm().
 */
export const HEALTH_RE =
  /sjuk|karens|\bvab\b|vard av barn|vard av anhorig|tillf|graviditet|smittbarar|arbetsskada|lakar|lak\.|tandlak|narstaende|anhorig|rehab|psyk|doctor|dentist|hospital|injury|sick|illness|medical|pregnan|child care|childcare|care of (a )?(sick )?child|temporary/;

/** Absence types positively recognised as non-health. ASCII after norm(). */
export const NON_HEALTH_RE =
  /semester|foraldra|komp(ledig|tid|ensationsledig)|tjanstled|vacation|holiday|annual leave|parental|paternity|maternity|time off in lieu|\btoil\b|leave of absence/;

type NamedRow = {
  project?: { description?: string } | null;
  timeType?: { description?: string } | null;
};

/** Project and time-type names of a row, normalised with norm(). */
const rowNames = (row: NamedRow) => [norm(row.project?.description), norm(row.timeType?.description)];

const isHealthName = (n: string) => HEALTH_RE.test(n);
const isNonHealthName = (n: string) => NON_HEALTH_RE.test(n);

export function isAbsenceProject(projectDescription: string | undefined): boolean {
  return ABSENCE_RE.test(norm(projectDescription));
}

/**
 * Counting predicate: a timesheet-like row is absence if its project OR its
 * time type matches an explicit absence term. Used by get_absences,
 * get_consultant_profitability and for the "Absence" label, so the tools agree.
 */
export function isAbsenceRow(row: NamedRow): boolean {
  return rowNames(row).some((n) => ABSENCE_RE.test(n));
}

/**
 * Redaction predicate (fails closed, broad): true if the project OR time type
 * matches any absence, health or non-health absence term. This errs on the
 * safe side: a customer project whose name contains e.g. "Medical" or
 * "Temporary" is redacted too, although it is not counted as absence.
 */
export function shouldRedact(row: NamedRow): boolean {
  return rowNames(row).some((n) => ABSENCE_RE.test(n) || isHealthName(n) || isNonHealthName(n));
}

/** True only for types that may be shown per named employee. */
export function isDisclosableAbsenceType(absenceType: string | undefined): boolean {
  const t = norm(absenceType);
  return isNonHealthName(t) && !isHealthName(t);
}

/**
 * Row-level disclosability, classified on BOTH the project and the time-type
 * name: a health term on either name wins, and at least one name must be a
 * recognised non-health type. get_absences reports one of the two names as
 * the absence type, so checking only that name would let a health project
 * with a non-health time type (or the reverse) through.
 */
export function isDisclosableAbsenceRow(row: NamedRow): boolean {
  const names = rowNames(row);
  return !names.some(isHealthName) && names.some(isNonHealthName);
}

export interface AbsenceRow {
  date: string;
  hours: number;
  employee: string;
  email: string;
  absenceType: string;
  /**
   * Set when the row as a whole is not disclosable (isDisclosableAbsenceRow
   * false), e.g. a health project booked with a non-health time type. Such
   * rows always go to the anonymous aggregate, whatever absenceType says.
   */
  restricted?: boolean;
}

export interface AbsenceAggregate {
  employee: string;
  email: string;
  absenceType: string;
  totalHours: number;
  days: number;
  firstDate: string;
  lastDate: string;
  restricted?: boolean;
}

export function aggregateAbsences(rows: AbsenceRow[]): AbsenceAggregate[] {
  const agg: Record<string, AbsenceAggregate> = {};
  for (const r of rows) {
    const key = `${r.employee}||${r.absenceType}||${r.restricted ? 1 : 0}`;
    if (!agg[key]) {
      agg[key] = {
        employee: r.employee,
        email: r.email,
        absenceType: r.absenceType,
        totalHours: 0,
        days: 0,
        firstDate: r.date,
        lastDate: r.date,
        ...(r.restricted ? { restricted: true } : {}),
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

/** Label that replaces absence project and time-type names in per-person rows. */
export const ABSENCE_LABEL = "Absence";

/** Label for rows redacted because a name matched a health term but the row is not counted as absence. */
export const REDACTED_LABEL = "Redacted";

type Env = Record<string, string | undefined>;

/**
 * The two-key gate: per-person absence detail is allowed only when the caller
 * sets includeHealthDetail AND the operator set XLEDGER_ALLOW_ART9_DETAIL=1.
 */
export function art9DetailAllowed(includeHealthDetail: boolean | undefined, env: Env = process.env): boolean {
  return includeHealthDetail === true && env[ART9_ENV_VAR] === "1";
}

/** Refusal message when the caller asked for detail but the operator did not allow it. */
export function art9Refusal(includeHealthDetail: boolean | undefined, env: Env = process.env): string | undefined {
  if (includeHealthDetail === true && !art9DetailAllowed(includeHealthDetail, env)) {
    return `includeHealthDetail was set but ${ART9_ENV_VAR} is not 1 in the server environment. Per-person health absence detail is withheld. Enabling it is a decision for the data controller, not for the calling assistant.`;
  }
  return undefined;
}

/** Shared parameter description for includeHealthDetail on every guarded tool. */
export const INCLUDE_HEALTH_DETAIL_DESCRIPTION = `Leave unset. Per-person health absence is special-category personal data (GDPR Art. 9). It is returned only if this flag is set AND the server was started with ${ART9_ENV_VAR}=1 by the data controller; otherwise the request is refused.`;

export interface RedactionResult<T> {
  items: T[];
  absenceRowsRedacted: number;
  healthDetailRefused?: string;
}

/**
 * Redact rows in per-person row lists (timesheets, expense lines, journal
 * entries). Rows where shouldRedact() is true get their project/time-type
 * names replaced ("Absence" when isAbsenceRow(), otherwise "Redacted") and
 * lose free-text fields, which could otherwise name the absence reason.
 * Hours, dates and the employee stay, so totals still add up. Unless the
 * two-key gate is satisfied.
 */
export function redactAbsenceRows<T extends Record<string, any>>(
  rows: T[],
  {
    includeHealthDetail = false,
    env = process.env,
    textFields = ["text", "comment"],
  }: { includeHealthDetail?: boolean; env?: Env; textFields?: string[] } = {}
): RedactionResult<T> {
  const healthDetailRefused = art9Refusal(includeHealthDetail, env);
  if (art9DetailAllowed(includeHealthDetail, env)) {
    return { items: rows, absenceRowsRedacted: 0 };
  }
  let absenceRowsRedacted = 0;
  const items = rows.map((row) => {
    if (!shouldRedact(row)) return row;
    absenceRowsRedacted++;
    const label = isAbsenceRow(row) ? ABSENCE_LABEL : REDACTED_LABEL;
    const out: Record<string, any> = { ...row };
    if (out.project) out.project = { ...out.project, code: null, description: label };
    if (out.timeType) out.timeType = { ...out.timeType, description: label };
    for (const f of textFields) delete out[f];
    return out as T;
  });
  return { items, absenceRowsRedacted, ...(healthDetailRefused ? { healthDetailRefused } : {}) };
}

export interface Art9GateResult {
  byEmployeeAndType: AbsenceAggregate[];
  healthRelatedAbsence?: {
    totalHours: number;
    employeeCount: number;
    note: string;
  };
  healthDetailRefused?: string;
}

export const ABSENCE_REDACTION_NOTE =
  'GDPR Art. 9: rows whose project or time type names an absence or a health-related term have project and time-type names replaced and free-text fields removed, because the absence reason tied to a named person can be health data. The label is "Absence" for rows counted as absence and "Redacted" for rows redacted only because a name matched a health term (the match errs on the safe side, so some of these are ordinary projects). Hours and dates are unchanged. Use get_absences for the guarded per-type breakdown.';

/**
 * Tool payload for a guarded row list: the plain array when nothing was
 * redacted or refused, otherwise { absenceRowsRedacted, note,
 * healthDetailRefused?, items }.
 */
export function guardAbsenceRowsPayload<T extends Record<string, any>>(
  rows: T[],
  opts: { includeHealthDetail?: boolean; env?: Env; textFields?: string[] } = {}
): T[] | Record<string, unknown> {
  const r = redactAbsenceRows(rows, opts);
  if (r.absenceRowsRedacted === 0 && !r.healthDetailRefused) return r.items;
  return {
    ...(r.absenceRowsRedacted > 0
      ? { absenceRowsRedacted: r.absenceRowsRedacted, note: ABSENCE_REDACTION_NOTE }
      : {}),
    ...(r.healthDetailRefused ? { healthDetailRefused: r.healthDetailRefused } : {}),
    items: r.items,
  };
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
    env?: Env;
  } = {}
): Art9GateResult {
  const allowDetail = art9DetailAllowed(includeHealthDetail, env);

  const isDisclosable = (a: AbsenceAggregate) => !a.restricted && isDisclosableAbsenceType(a.absenceType);
  const disclosable = aggregates.filter(isDisclosable);
  const restricted = aggregates.filter((a) => !isDisclosable(a));

  const byEmployeeAndType = [...(allowDetail ? aggregates : disclosable)]
    .sort((a, b) => a.employee.localeCompare(b.employee) || b.totalHours - a.totalHours)
    .slice(0, first)
    .map(({ restricted: _r, ...a }) => a);

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

  const refused = art9Refusal(includeHealthDetail, env);
  if (refused) result.healthDetailRefused = refused;

  return result;
}
