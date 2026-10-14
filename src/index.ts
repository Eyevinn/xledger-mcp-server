#!/usr/bin/env node
/**
 * Xledger MCP Server
 *
 * Exposes the Xledger GraphQL API as read-only MCP tools for use with
 * Claude and other MCP-compatible AI assistants.
 *
 * Auth: Token via XLEDGER_GRAPHQL_TOKEN environment variable
 * API:  https://www.xledger.net/graphql (configurable via XLEDGER_API_URL)
 *
 * Compatible with Xledger GraphQL API v2:
 * - Filter syntax uses direct field suffixes (e.g. invoiceDate_gte)
 * - orderBy uses array of { field, direction } enums
 * - SystemValue uses .name (not .description)
 * - Connections use cursor pagination (no offset, no endCursor)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { gql } from "./graphql.js";
import { validateDate, today, monthChunks, monthSpan } from "./validation.js";
import { connNodes, paginateAll, truncationWarning, type Node } from "./pagination.js";
import {
  ART9_ENV_VAR,
  INCLUDE_HEALTH_DETAIL_DESCRIPTION,
  aggregateAbsences,
  applyArt9Gate,
  art9DetailAllowed,
  art9Refusal,
  guardAbsenceRowsPayload,
  isAbsenceRow,
  type AbsenceRow,
} from "./absences.js";
import { aggregateConsultants } from "./profitability.js";

const VERSION = "1.1.0";

const server = new McpServer({
  name: "xledger",
  version: VERSION,
});

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function filterClause(filters: string[]): string {
  return filters.length > 0 ? `, filter: { ${filters.join(", ")} }` : "";
}

// Wrap an array result with a warning when pagination was cut short. The shape
// only changes when there is something to warn about.
function withTruncation(items: unknown[], truncated: boolean, what: string) {
  return truncated ? json({ warning: truncationWarning(what), truncated: true, items }) : json(items);
}

const includeHealthDetailParam = z
  .boolean()
  .optional()
  .default(false)
  .describe(INCLUDE_HEALTH_DETAIL_DESCRIPTION);

// Per-person row lists that can contain absence rows go through this guard.
function guardedRows(rows: Node[], includeHealthDetail: boolean, textFields?: string[]) {
  return json(guardAbsenceRowsPayload(rows, { includeHealthDetail, textFields }));
}

// Timesheet rows per month are fetched with first: 500. If a month hits the
// limit, the result is flagged as truncated rather than silently undercounted.
const TIMESHEET_PAGE = 500;

// ─── Tool: get_ar_transactions ───────────────────────────────────────────────

server.tool(
  "get_ar_transactions",
  "Get customer invoices (Accounts Receivable) from Xledger. Returns invoice number, date, due date, amount, remaining balance, customer name, and currency. Filter by date range or outstanding only.",
  {
    first: z.number().optional().default(50).describe("Number of records to return (max 200)"),
    outstandingOnly: z
      .boolean()
      .optional()
      .default(false)
      .describe("Only return unpaid invoices (invoiceRemaining > 0)"),
    fromDate: z.string().optional().describe("Filter invoices from this date (YYYY-MM-DD)"),
    toDate: z.string().optional().describe("Filter invoices to this date (YYYY-MM-DD)"),
  },
  READ_ONLY,
  async ({ first, outstandingOnly, fromDate, toDate }) => {
    validateDate(fromDate, "fromDate");
    validateDate(toDate, "toDate");

    const filters: string[] = [];
    if (outstandingOnly) filters.push('invoiceRemaining_gt: "0"');
    if (fromDate) filters.push(`invoiceDate_gte: "${fromDate}"`);
    if (toDate) filters.push(`invoiceDate_lte: "${toDate}"`);

    const data = await gql(`{
      arTransactions(first: ${Math.min(first, 200)}${filterClause(filters)}, orderBy: [{ field: MODIFIED_AT, direction: DESC }]) {
        edges {
          node {
            dbId
            invoiceNumber
            invoiceDate
            dueDate
            invoiceAmount
            invoiceRemaining
            text
            paymentStatus { code name }
            subledger { description }
            currency { code }
          }
        }
      }
    }`);

    return json(connNodes(data.arTransactions));
  }
);

// ─── Tool: get_ap_transactions ───────────────────────────────────────────────

server.tool(
  "get_ap_transactions",
  "Get supplier invoices (Accounts Payable) from Xledger. Returns invoice number, date, due date, amount, remaining balance, supplier name. Filter by date range or outstanding only.",
  {
    first: z.number().optional().default(50).describe("Number of records to return (max 200)"),
    outstandingOnly: z.boolean().optional().default(false).describe("Only return unpaid invoices"),
    fromDate: z.string().optional().describe("Filter from this date (YYYY-MM-DD)"),
    toDate: z.string().optional().describe("Filter to this date (YYYY-MM-DD)"),
  },
  READ_ONLY,
  async ({ first, outstandingOnly, fromDate, toDate }) => {
    validateDate(fromDate, "fromDate");
    validateDate(toDate, "toDate");

    const filters: string[] = [];
    if (outstandingOnly) filters.push('invoiceRemaining_gt: "0"');
    if (fromDate) filters.push(`invoiceDate_gte: "${fromDate}"`);
    if (toDate) filters.push(`invoiceDate_lte: "${toDate}"`);

    const data = await gql(`{
      apTransactions(first: ${Math.min(first, 200)}${filterClause(filters)}, orderBy: [{ field: MODIFIED_AT, direction: DESC }]) {
        edges {
          node {
            dbId
            invoiceNumber
            invoiceDate
            dueDate
            invoiceAmount
            invoiceRemaining
            text
            paymentStatus { code name }
            subledger { description }
            currency { code }
          }
        }
      }
    }`);

    return json(connNodes(data.apTransactions));
  }
);

// ─── Tool: get_account_balances ──────────────────────────────────────────────
// AccountBalance_Filter has no fiscalYear/periodNumber, so we page through
// balances newest-first and filter client-side.

server.tool(
  "get_account_balances",
  "Get General Ledger account balances from Xledger. Returns account code, description, and balance amounts by fiscal year and period. Use for P&L, balance sheet, and financial reporting.",
  {
    fiscalYear: z.number().optional().describe("Fiscal year (e.g. 2025). Defaults to current year."),
    periodNumber: z
      .number()
      .optional()
      .describe("Period number 1-12 (month). Returns all periods of the year if omitted."),
    first: z.number().optional().default(200).describe("Number of records to return (max 500)"),
  },
  READ_ONLY,
  async ({ fiscalYear, periodNumber, first }) => {
    const year = fiscalYear || new Date().getFullYear();

    const nodes = await paginateAll(
      gql,
      (afterClause) => `{
        accountBalances(first: 500${afterClause}, orderBy: [{ field: PERIOD_ID, direction: DESC }]) {
          pageInfo { hasNextPage }
          edges {
            cursor
            node {
              dbId
              fiscalYear
              periodNumber
              amount
              quantity
              account { code description }
              company { description }
            }
          }
        }
      }`,
      (d) => d.accountBalances,
      { stopWhen: (page) => Math.max(...page.map((b) => b.fiscalYear ?? 0)) < year }
    );

    let collected = nodes.filter((b) => b.fiscalYear === year);
    if (periodNumber) collected = collected.filter((b) => b.periodNumber === periodNumber);

    return withTruncation(collected.slice(0, Math.min(first, 500)), nodes.truncated, "accountBalances");
  }
);

// ─── Tool: get_projects ──────────────────────────────────────────────────────

server.tool(
  "get_projects",
  "Get projects from Xledger with financial data including total revenue, total cost, estimate hours, and billability. Use for project profitability analysis.",
  {
    first: z.number().optional().default(100).describe("Number of records to return (max 500)"),
    activeOnly: z
      .boolean()
      .optional()
      .default(true)
      .describe("Only return active projects (end date in future or none)"),
    billableOnly: z.boolean().optional().default(false).describe("Only return billable projects"),
  },
  READ_ONLY,
  async ({ first, activeOnly, billableOnly }) => {
    const filters: string[] = [];
    if (activeOnly) filters.push(`toDate_gte: "${today()}"`);

    const data = await gql(`{
      projects(first: ${Math.min(first, 500)}${filterClause(filters)}, orderBy: [{ field: FROM_DATE, direction: DESC }]) {
        edges {
          node {
            dbId
            code
            description
            fromDate
            toDate
            billable
            totalRevenue
            totalCost
            totalEstimateHours
            yearlyRevenue
            yearlyCost
            yearlyEstimateHours
            pctCompleted
            customer { description }
            projectManager { description email }
            currency { code }
          }
        }
      }
    }`);

    let items = connNodes(data.projects);
    if (billableOnly) items = items.filter((p) => p.billable === true);

    return json(items);
  }
);

// ─── Tool: get_timesheets ────────────────────────────────────────────────────

server.tool(
  "get_timesheets",
  `Get timesheet entries from Xledger. Returns hours worked per employee per project with invoice status, hourly cost rate (hourlyCost), and hourly revenue rate (hourlyRevenueCurrency). Use for utilization analysis, billing verification, and profitability analysis. GDPR Art. 9: rows whose project or time type names an absence or a health-related term are returned with project and time type shown as "Absence" (rows counted as absence) or "Redacted" (other matches; the match errs on the safe side) and without text/comment, unless includeHealthDetail is set AND ${ART9_ENV_VAR}=1 in the server environment.`,
  {
    first: z.number().optional().default(100).describe("Number of records to return (max 500)"),
    fromDate: z.string().optional().describe("Filter from date (YYYY-MM-DD)"),
    toDate: z.string().optional().describe("Filter to date (YYYY-MM-DD)"),
    invoicedOnly: z.boolean().optional().default(false).describe("Only return invoiced timesheets"),
    notInvoiced: z
      .boolean()
      .optional()
      .default(false)
      .describe("Only return not-yet-invoiced timesheets"),
    includeHealthDetail: includeHealthDetailParam,
  },
  READ_ONLY,
  async ({ first, fromDate, toDate, invoicedOnly, notInvoiced, includeHealthDetail }) => {
    validateDate(fromDate, "fromDate");
    validateDate(toDate, "toDate");

    const filters: string[] = [];
    if (invoicedOnly) filters.push("invoiced: true");
    if (notInvoiced) filters.push("invoiced: false");
    if (fromDate) filters.push(`assignmentDate_gte: "${fromDate}"`);
    if (toDate) filters.push(`assignmentDate_lte: "${toDate}"`);

    const data = await gql(`{
      timesheets(first: ${Math.min(first, 500)}${filterClause(filters)}, orderBy: [{ field: ASSIGNMENT_DATE, direction: DESC }]) {
        edges {
          node {
            dbId
            assignmentDate
            workingHours
            invoiceHours
            hourlyCost
            hourlyRevenueCurrency
            invoiced
            approved
            text
            comment
            employee { description email }
            project { code description customer { description } billable }
            timeType { description }
          }
        }
      }
    }`);

    return guardedRows(connNodes(data.timesheets), includeHealthDetail);
  }
);

// ─── Tool: get_consultant_profitability ─────────────────────────────────────

server.tool(
  "get_consultant_profitability",
  `Get consultant profitability analysis from Xledger timesheets. Calculates utilization (billable hours / total hours excluding absence), cost from a monthly salary plus employer social security contributions, and revenue from a provided hourly rate. Returns a per-consultant and per-project breakdown with contribution margin and utilization rate. Absence hours (project or time type is an absence, same rule as get_timesheets and get_absences) are reported only as hours.absence; absence projects are not listed in the per-consultant project breakdown, and other projects whose name matches a health-related term are listed as "Redacted (billable)" / "Redacted (non-billable)" (GDPR Art. 9), unless includeHealthDetail is set AND ${ART9_ENV_VAR}=1 in the server environment. Salary and hourly rate are inputs because payroll data is usually outside the API token's scope. Amounts are in the company's base currency.`,
  {
    fromDate: z.string().describe("Period start date (YYYY-MM-DD)"),
    toDate: z.string().describe("Period end date (YYYY-MM-DD)"),
    employeeName: z
      .string()
      .optional()
      .describe("Filter by employee name (partial match, case-insensitive)"),
    monthlySalary: z
      .number()
      .optional()
      .describe("Monthly gross salary in base currency. Used to calculate cost. If omitted, only hours are returned."),
    hourlyRate: z
      .number()
      .optional()
      .describe("Hourly billing rate in base currency. Used to calculate revenue. If omitted, revenue is not calculated."),
    agAvgPct: z
      .number()
      .optional()
      .default(31.42)
      .describe("Employer social security contribution in percent of salary. Default 31.42 (Swedish standard rate)."),
    includeHealthDetail: includeHealthDetailParam,
  },
  READ_ONLY,
  async ({ fromDate, toDate, employeeName, monthlySalary, hourlyRate, agAvgPct, includeHealthDetail }) => {
    validateDate(fromDate, "fromDate");
    validateDate(toDate, "toDate");

    // Fetch in monthly chunks to stay under the per-request row limit.
    const allEntries: Node[] = [];
    const truncatedMonths: string[] = [];
    for (const { start, end } of monthChunks(fromDate, toDate)) {
      const data = await gql(`{
        timesheets(first: ${TIMESHEET_PAGE}, filter: {
          assignmentDate_gte: "${start}"
          assignmentDate_lte: "${end}"
        }, orderBy: [{ field: ASSIGNMENT_DATE, direction: ASC }]) {
          edges {
            node {
              assignmentDate
              workingHours
              invoiceHours
              invoiced
              employee { description email }
              project { description billable customer { description } }
              timeType { description }
            }
          }
        }
      }`);
      const entries = connNodes(data.timesheets);
      if (entries.length >= TIMESHEET_PAGE) truncatedMonths.push(start.slice(0, 7));
      allEntries.push(...entries);
    }

    const filtered = employeeName
      ? allEntries.filter((e) =>
          e.employee?.description?.toLowerCase().includes(employeeName.toLowerCase())
        )
      : allEntries;

    const consultants = aggregateConsultants(filtered, {
      fromDate,
      toDate,
      periodMonths: monthSpan(fromDate, toDate),
      monthlySalary,
      hourlyRate,
      agAvgPct,
      allowAbsenceDetail: art9DetailAllowed(includeHealthDetail),
    });
    const healthDetailRefused = art9Refusal(includeHealthDetail);

    if (truncatedMonths.length > 0) {
      return json({
        warning: `Timesheet rows hit the ${TIMESHEET_PAGE}-row limit in ${truncatedMonths.join(", ")}. Hours for those months are incomplete; narrow the date range or filter by employee.`,
        truncatedMonths,
        ...(healthDetailRefused ? { healthDetailRefused } : {}),
        consultants,
      });
    }
    if (healthDetailRefused) return json({ healthDetailRefused, consultants });
    return json(consultants);
  }
);

// ─── Tool: get_journal_entries ───────────────────────────────────────────────
// JournalEntry_Filter has no postedDate; date filtering uses createdAt as proxy.

server.tool(
  "get_journal_entries",
  `Get journal entries (raw GL transactions) from Xledger. Returns detailed accounting entries with account, amount, date, project. Use for detailed financial analysis. GDPR Art. 9: entries whose project names an absence or a health-related term are returned with the project shown as "Absence" or "Redacted" and without text, unless includeHealthDetail is set AND ${ART9_ENV_VAR}=1 in the server environment. Account names (which can include e.g. sick-pay accounts), employee subledgers and free text on other entries are NOT filtered.`,
  {
    first: z.number().optional().default(50).describe("Number of records to return (max 200)"),
    fromDate: z.string().optional().describe("Created date from (YYYY-MM-DD); postedDate is not filterable"),
    toDate: z.string().optional().describe("Created date to (YYYY-MM-DD); postedDate is not filterable"),
    fiscalYear: z.number().optional().describe("Filter by fiscal year (client-side)"),
    includeHealthDetail: includeHealthDetailParam,
  },
  READ_ONLY,
  async ({ first, fromDate, toDate, fiscalYear, includeHealthDetail }) => {
    validateDate(fromDate, "fromDate");
    validateDate(toDate, "toDate");

    const filters: string[] = [];
    if (fromDate) filters.push(`createdAt_gte: "${fromDate}"`);
    if (toDate) filters.push(`createdAt_lte: "${toDate}"`);

    const data = await gql(`{
      journalEntries(first: ${Math.min(first, 200)}${filterClause(filters)}, orderBy: [{ field: CREATED_AT, direction: DESC }]) {
        edges {
          node {
            dbId
            transactionNumber
            postedDate
            invoiceDate
            text
            amount
            invoiceAmount
            taxAmount
            fiscalYear
            fiscalPeriod
            account { code description }
            project { code description }
            subledger { description }
            currency { code }
          }
        }
      }
    }`);

    const conn = data?.journalEntries;
    if (!conn || conn.edges == null) {
      return json({
        items: [],
        note: "journalEntries returned no edges. Either no rows match the filter, or the API token's owner-scope does not cover GL transactions. An Xledger administrator can widen the API user's owner-scope. For aggregate per-account figures, get_account_balances is an alternative.",
      });
    }

    let items = connNodes(conn);
    if (fiscalYear) items = items.filter((e) => e.fiscalYear === fiscalYear);

    return guardedRows(items, includeHealthDetail, ["text"]);
  }
);

// ─── Tool: get_employees ─────────────────────────────────────────────────────

server.tool(
  "get_employees",
  "Get employees from Xledger. Returns employee code, name, email, employment dates, and group. Use for headcount reporting.",
  {
    first: z.number().optional().default(100).describe("Number of records to return (max 200)"),
    activeOnly: z.boolean().optional().default(true).describe("Only return currently employed staff"),
  },
  READ_ONLY,
  async ({ first, activeOnly }) => {
    const filters: string[] = [];
    if (activeOnly) filters.push(`employmentFrom_lte: "${today()}"`);

    const data = await gql(`{
      employees(first: ${Math.min(first, 200)}${filterClause(filters)}) {
        edges {
          node {
            dbId
            code
            description
            email
            employmentFrom
            employmentTo
            employeeGroup { description }
          }
        }
      }
    }`);

    let items = connNodes(data.employees);
    if (activeOnly) {
      const d = today();
      items = items.filter((e) => !e.employmentTo || e.employmentTo >= d);
    }

    return json(items);
  }
);

// ─── Tool: get_customers ─────────────────────────────────────────────────────
// Reads `customers`, not `subledgers` (which also holds suppliers, employees and
// tax authorities). Customer dbIds equal the AR transactions' subledger dbIds.
// Customer_Filter has no description field, so search is client-side and must
// run over ALL customers, not only the first page.

server.tool(
  "get_customers",
  "Get customers from Xledger (newest first). Returns customer dbId, code and name. Search matches all customers, not just the returned page. Use to look up customer IDs for filtering invoices.",
  {
    first: z.number().optional().default(100).describe("Max number of records to return (after search)"),
    search: z
      .string()
      .optional()
      .describe("Search by customer name or code (partial match, case-insensitive)"),
  },
  READ_ONLY,
  async ({ first, search }) => {
    const all = await paginateAll(
      gql,
      (afterClause) => `{
        customers(first: 500${afterClause}, orderBy: [{ field: CREATED_AT, direction: DESC }]) {
          pageInfo { hasNextPage }
          edges {
            cursor
            node {
              dbId
              code
              description
            }
          }
        }
      }`,
      (d) => d.customers
    );

    let items: Node[] = all;
    const totalCustomers = items.length;
    if (search) {
      const term = search.toLowerCase();
      items = items.filter(
        (s) => s.description?.toLowerCase().includes(term) || s.code?.toLowerCase().includes(term)
      );
    }
    const matched = items.length;
    items = items.slice(0, first);

    return json({
      ...(all.truncated ? { warning: truncationWarning("customers"), truncated: true } : {}),
      totalCustomers,
      matched,
      returned: items.length,
      customers: items,
    });
  }
);

// ─── Tool: get_revenue_summary ───────────────────────────────────────────────

server.tool(
  "get_revenue_summary",
  "Get a revenue summary from Xledger AR transactions: total invoiced, total outstanding, grouped by customer. Based on invoices (AR), so credit notes and invoice timing affect it; for accrual-based figures use get_budget_vs_actual.",
  {
    fromDate: z.string().describe("Start date for the period (YYYY-MM-DD)"),
    toDate: z.string().describe("End date for the period (YYYY-MM-DD)"),
  },
  READ_ONLY,
  async ({ fromDate, toDate }) => {
    validateDate(fromDate, "fromDate");
    validateDate(toDate, "toDate");

    const data = await gql(`{
      arTransactions(first: 500, filter: {
        invoiceDate_gte: "${fromDate}"
        invoiceDate_lte: "${toDate}"
      }) {
        edges {
          node {
            invoiceAmount
            invoiceRemaining
            invoiceDate
            subledger { description }
            currency { code }
          }
        }
      }
    }`);

    const invoices = connNodes(data.arTransactions);

    const byCustomer: Record<string, { invoiced: number; outstanding: number; invoiceCount: number }> = {};
    let totalInvoiced = 0;
    let totalOutstanding = 0;

    for (const inv of invoices) {
      const customer = inv.subledger?.description || "Unknown";
      const amount = parseFloat(inv.invoiceAmount) || 0;
      const remaining = parseFloat(inv.invoiceRemaining) || 0;
      if (!byCustomer[customer]) byCustomer[customer] = { invoiced: 0, outstanding: 0, invoiceCount: 0 };
      byCustomer[customer].invoiced += amount;
      byCustomer[customer].outstanding += remaining;
      byCustomer[customer].invoiceCount += 1;
      totalInvoiced += amount;
      totalOutstanding += remaining;
    }

    const sorted = Object.entries(byCustomer)
      .sort((a, b) => b[1].invoiced - a[1].invoiced)
      .map(([customer, d]) => ({ customer, ...d }));

    return json({
      period: { from: fromDate, to: toDate },
      totals: {
        invoiced: totalInvoiced.toFixed(2),
        outstanding: totalOutstanding.toFixed(2),
        invoiceCount: invoices.length,
      },
      ...(invoices.length >= 500
        ? { warning: "Hit the 500-invoice limit; totals are incomplete. Use a shorter period." }
        : {}),
      byCustomer: sorted,
    });
  }
);

// ─── Tool: get_budget_vs_actual ──────────────────────────────────────────────

server.tool(
  "get_budget_vs_actual",
  "Compare budget vs actual for a fiscal year. Returns budget amounts and actual GL balances per account with variance. Use for budget follow-up and forecast deviation analysis. periodNumber returns that single period only; omit it for all periods of the year.",
  {
    fiscalYear: z.number().optional().describe("Fiscal year (e.g. 2026). Defaults to current year."),
    periodNumber: z
      .number()
      .optional()
      .describe("Limit to a single period 1-12. Returns all periods of the year if omitted."),
    first: z.number().optional().default(200).describe("Max account rows to return"),
  },
  READ_ONLY,
  async ({ fiscalYear, periodNumber, first }) => {
    const year = fiscalYear || new Date().getFullYear();
    const stopWhen = (page: Node[]) => Math.max(...page.map((b) => b.fiscalYear ?? 0)) < year;

    const budgetNodes = await paginateAll(
      gql,
      (afterClause) => `{
        budgetBalances(first: 500${afterClause}, orderBy: [{ field: PERIOD_ID, direction: DESC }]) {
          pageInfo { hasNextPage }
          edges { cursor node { fiscalYear periodNumber amount account { code description } } }
        }
      }`,
      (d) => d.budgetBalances,
      { stopWhen }
    );

    const actualNodes = await paginateAll(
      gql,
      (afterClause) => `{
        accountBalances(first: 500${afterClause}, orderBy: [{ field: PERIOD_ID, direction: DESC }]) {
          pageInfo { hasNextPage }
          edges { cursor node { fiscalYear periodNumber amount account { code description } } }
        }
      }`,
      (d) => d.accountBalances,
      { stopWhen }
    );

    const inScope = (b: Node) =>
      b.fiscalYear === year && (!periodNumber || b.periodNumber === periodNumber);

    const budgetByAccount: Record<string, { description: string; budget: number }> = {};
    for (const b of budgetNodes.filter(inScope)) {
      const key = b.account?.code || "?";
      if (!budgetByAccount[key]) budgetByAccount[key] = { description: b.account?.description || "", budget: 0 };
      budgetByAccount[key].budget += parseFloat(b.amount) || 0;
    }

    const actualByAccount: Record<string, { description: string; actual: number }> = {};
    for (const a of actualNodes.filter(inScope)) {
      const key = a.account?.code || "?";
      if (!actualByAccount[key]) actualByAccount[key] = { description: a.account?.description || "", actual: 0 };
      actualByAccount[key].actual += parseFloat(a.amount) || 0;
    }

    const allKeys = new Set([...Object.keys(budgetByAccount), ...Object.keys(actualByAccount)]);
    const rows = Array.from(allKeys)
      .map((code) => {
        const budget = budgetByAccount[code]?.budget || 0;
        const actual = actualByAccount[code]?.actual || 0;
        return {
          accountCode: code,
          description: budgetByAccount[code]?.description || actualByAccount[code]?.description || "",
          budget: budget.toFixed(2),
          actual: actual.toFixed(2),
          variance: (actual - budget).toFixed(2),
        };
      })
      .sort((a, b) => a.accountCode.localeCompare(b.accountCode))
      .slice(0, first);

    const truncatedSources = [
      ...(budgetNodes.truncated ? ["budgetBalances"] : []),
      ...(actualNodes.truncated ? ["accountBalances"] : []),
    ];
    return json({
      ...(truncatedSources.length > 0
        ? { warning: truncationWarning(truncatedSources.join(" and ")), truncated: true }
        : {}),
      fiscalYear: year,
      periodNumber: periodNumber || "all",
      rows,
    });
  }
);

// ─── Tool: get_expenses ──────────────────────────────────────────────────────

const EXPENSE_SCOPE_NOTE =
  "If you expect data here, check the API token's owner-scope for expenses: when it is limited to MINE, the token only sees the integration user's own expense records. An Xledger administrator can widen the API user's Expense owner-scope (e.g. to ALL).";

server.tool(
  "get_expenses",
  `Get employee expense lines from Xledger. Returns expense lines with amount, date, employee, expense type, project, and approval status. Use for cost analysis and travel & expense reporting. Results depend on the API token's Expense owner-scope. GDPR Art. 9: lines whose project names an absence or a health-related term are returned with the project shown as "Absence" or "Redacted" and without text/comment, unless includeHealthDetail is set AND ${ART9_ENV_VAR}=1 in the server environment. The expense type per named employee (which can be health-related) and free text on other lines are NOT filtered.`,
  {
    first: z.number().optional().default(100).describe("Number of records to return (max 500)"),
    fromDate: z.string().optional().describe("Filter from date (YYYY-MM-DD)"),
    toDate: z.string().optional().describe("Filter to date (YYYY-MM-DD)"),
    approvedOnly: z.boolean().optional().default(false).describe("Only return approved expenses"),
    includeHealthDetail: includeHealthDetailParam,
  },
  READ_ONLY,
  async ({ first, fromDate, toDate, approvedOnly, includeHealthDetail }) => {
    validateDate(fromDate, "fromDate");
    validateDate(toDate, "toDate");

    const filters: string[] = [];
    if (fromDate) filters.push(`date_gte: "${fromDate}"`);
    if (toDate) filters.push(`date_lte: "${toDate}"`);
    if (approvedOnly) filters.push("approved: true");

    const data = await gql(`{
      expenseDetails(first: ${Math.min(first, 500)}${filterClause(filters)}, orderBy: [{ field: MODIFIED_AT, direction: DESC }]) {
        edges {
          node {
            dbId
            date
            amount
            taxAmount
            text
            comment
            billable
            approved
            approvedDate
            employee { description email }
            expenseType { description }
            project { code description customer { description } }
            currency { code }
          }
        }
      }
    }`);

    const conn = data?.expenseDetails;
    if (!conn || conn.edges == null) {
      return json({ items: [], note: `No expense lines returned. ${EXPENSE_SCOPE_NOTE}` });
    }
    return guardedRows(connNodes(conn), includeHealthDetail);
  }
);

// ─── Tool: get_expense_reports ───────────────────────────────────────────────

server.tool(
  "get_expense_reports",
  "Get expense report HEADERS from Xledger: one row per expense report with total amount, tax, period dates, employee, approval status and purpose. Header level only; for individual expense lines use get_expenses. Results depend on the API token's Expense owner-scope.",
  {
    first: z.number().optional().default(50).describe("Number of expense reports to return (max 500)"),
    fromDate: z.string().optional().describe("Filter modified-from date (YYYY-MM-DD)"),
    toDate: z.string().optional().describe("Filter modified-to date (YYYY-MM-DD)"),
    approvedOnly: z.boolean().optional().default(false).describe("Only return approved reports"),
  },
  READ_ONLY,
  async ({ first, fromDate, toDate, approvedOnly }) => {
    validateDate(fromDate, "fromDate");
    validateDate(toDate, "toDate");

    const filters: string[] = [];
    if (fromDate) filters.push(`modifiedAt_gte: "${fromDate}T00:00:00"`);
    if (toDate) filters.push(`modifiedAt_lte: "${toDate}T23:59:59"`);

    const data = await gql(`{
      expenseBases(first: ${Math.min(first, 500)}${filterClause(filters)}, orderBy: [{ field: MODIFIED_AT, direction: DESC }]) {
        edges {
          node {
            dbId
            text
            amount
            invoiceAmount
            taxAmount
            regularAmount
            dateFrom
            dateTo
            approved
            approvedAt
            reference
            comment
            overview
            employee { description }
            currency { code }
          }
        }
      }
    }`);

    const conn = data?.expenseBases;
    if (!conn || conn.edges == null) {
      return json({ items: [], note: `No expense report headers returned for this filter. ${EXPENSE_SCOPE_NOTE}` });
    }

    let items = connNodes(conn);
    if (approvedOnly) items = items.filter((r) => r.approved === true);

    if (items.length === 0) {
      return json({ items, note: `0 reports for this filter. ${EXPENSE_SCOPE_NOTE}` });
    }
    return json(items);
  }
);

// ─── Tool: get_absences ──────────────────────────────────────────────────────

server.tool(
  "get_absences",
  `Get employee absences from Xledger, derived from timesheet rows whose project or time type is an absence. Returns absence hours per employee and absence type. GDPR Art. 9: health-related absence types (e.g. sick leave, care of a sick child), and any type not recognised as non-health, are NEVER returned per named employee by default. They are collapsed into one anonymous aggregate (total hours + employee count). Recognised non-health types (vacation, parental leave, time off in lieu, leave of absence) are returned per employee. totalAbsenceHours always includes all absence. Per-person health detail requires ${ART9_ENV_VAR}=1 in the server environment, set by the data controller.`,
  {
    first: z.number().optional().default(100).describe("Number of rows to return (max 500)"),
    fromDate: z
      .string()
      .optional()
      .describe("Filter absences from date (YYYY-MM-DD). Defaults to 1 January of the current year."),
    toDate: z.string().optional().describe("Filter absences to date (YYYY-MM-DD). Defaults to today."),
    includeHealthDetail: includeHealthDetailParam,
  },
  READ_ONLY,
  async ({ first, fromDate, toDate, includeHealthDetail }) => {
    validateDate(fromDate, "fromDate");
    validateDate(toDate, "toDate");

    const from = fromDate || `${new Date().getUTCFullYear()}-01-01`;
    const to = toDate || today();

    const rows: AbsenceRow[] = [];
    const truncatedMonths: string[] = [];
    for (const { start, end } of monthChunks(from, to)) {
      const data = await gql(`{
        timesheets(first: ${TIMESHEET_PAGE}, filter: {
          assignmentDate_gte: "${start}"
          assignmentDate_lte: "${end}"
        }, orderBy: [{ field: ASSIGNMENT_DATE, direction: ASC }]) {
          edges { node {
            assignmentDate
            workingHours
            employee { description email }
            project { description }
            timeType { description }
          } }
        }
      }`);
      const nodes = connNodes(data.timesheets);
      if (nodes.length >= TIMESHEET_PAGE) truncatedMonths.push(start.slice(0, 7));
      for (const n of nodes) {
        if (isAbsenceRow(n)) {
          rows.push({
            date: n.assignmentDate,
            hours: parseFloat(n.workingHours || "0"),
            employee: n.employee?.description || "Unknown",
            email: n.employee?.email || "",
            absenceType: n.timeType?.description || n.project?.description || "Absence",
          });
        }
      }
    }

    const gate = applyArt9Gate(aggregateAbsences(rows), {
      includeHealthDetail,
      first: Math.min(first, 500),
    });

    return json({
      source: "Derived from timesheet rows whose project or time type is an absence",
      period: { from, to },
      totalAbsenceHours: Math.round(rows.reduce((s, r) => s + r.hours, 0) * 10) / 10,
      ...(truncatedMonths.length > 0
        ? {
            warning: `Timesheet rows hit the ${TIMESHEET_PAGE}-row limit in ${truncatedMonths.join(", ")}; absence totals for those months may be incomplete.`,
          }
        : {}),
      ...gate,
    });
  }
);

// ─── Tool: get_exchange_rates ────────────────────────────────────────────────

server.tool(
  "get_exchange_rates",
  "Get currency exchange rates from Xledger. Returns rate between currency pairs with valid date range. Use for FX exposure analysis and currency risk monitoring.",
  {
    first: z.number().optional().default(50).describe("Number of records to return (max 200)"),
    fromCurrency: z.string().optional().describe("Filter by source currency code (e.g. GBP, USD)"),
    toCurrency: z.string().optional().describe("Filter by target currency code (e.g. SEK)"),
  },
  READ_ONLY,
  async ({ first, fromCurrency, toCurrency }) => {
    // Currency filters MUST be applied server-side: the rate feed holds hundreds
    // of rows per day ordered by source currency, so a client-side filter over
    // the first page returns [] for most realistic queries.
    const filters: string[] = [];
    if (fromCurrency) filters.push(`currencyFromCode: "${fromCurrency.toUpperCase()}"`);
    if (toCurrency) filters.push(`currencyToCode: "${toCurrency.toUpperCase()}"`);

    const data = await gql(`{
      exchangeRates(first: ${Math.min(first, 200)}${filterClause(filters)}, orderBy: [{ field: MODIFIED_AT, direction: DESC }]) {
        edges {
          node {
            dbId
            fromDate
            toDate
            exchangeRate
            unitRate
            currencyUnit
            currencyFromCode
            currencyToCode
            currencyFrom { code }
            currencyTo { code }
          }
        }
      }
    }`);

    let items = connNodes(data.exchangeRates);
    if (fromCurrency) {
      const fc = fromCurrency.toUpperCase();
      items = items.filter(
        (r) => r.currencyFromCode?.toUpperCase() === fc || r.currencyFrom?.code?.toUpperCase() === fc
      );
    }
    if (toCurrency) {
      const tc = toCurrency.toUpperCase();
      items = items.filter(
        (r) => r.currencyToCode?.toUpperCase() === tc || r.currencyTo?.code?.toUpperCase() === tc
      );
    }

    return json(items);
  }
);

// ─── Tool: get_cash_transactions ─────────────────────────────────────────────

server.tool(
  "get_cash_transactions",
  "Get cash book transactions from Xledger (bank debits/credits). Only returns data if your organization uses the Xledger cash book module. NOTE: fromDate/toDate filter on createdAt (when the row was created in Xledger), NOT on postedBankDate, which is not filterable in the Xledger API.",
  {
    first: z.number().optional().default(100).describe("Number of records to return (max 500)"),
    fromDate: z
      .string()
      .optional()
      .describe("Filter from this record-creation date (YYYY-MM-DD). Filters createdAt, not bank date."),
    toDate: z
      .string()
      .optional()
      .describe("Filter to this record-creation date (YYYY-MM-DD). Filters createdAt, not bank date."),
  },
  READ_ONLY,
  async ({ first, fromDate, toDate }) => {
    validateDate(fromDate, "fromDate");
    validateDate(toDate, "toDate");

    // CashBookTransaction_Filter supports createdAt (DateTimeString, ISO 8601 with
    // time). Date-only strings are rejected silently (null data), so expand them.
    // postedBankDate is NOT a filter field.
    const filters: string[] = [];
    if (fromDate) filters.push(`createdAt_gte: "${fromDate}T00:00:00Z"`);
    if (toDate) filters.push(`createdAt_lte: "${toDate}T23:59:59Z"`);

    const query = (filterStr: string) => `{
      cashBookTransactions(first: ${Math.min(first, 500)}${filterStr}, orderBy: [{ field: MODIFIED_AT, direction: DESC }]) {
        edges {
          node {
            dbId
            text
            fiscalYear
            paymentReference
            bankAmount
            debit_v2
            credit_v2
            postedBankDate
            bankCode
            bankAccount { description }
            period { monthNumber fiscalYear }
          }
        }
      }
    }`;

    let items: Node[];
    try {
      const data = await gql(query(filterClause(filters)));
      items = connNodes(data.cashBookTransactions);
    } catch {
      // Fallback: fetch without filter and filter client-side on postedBankDate.
      const data = await gql(query(""));
      items = connNodes(data.cashBookTransactions);
      if (fromDate || toDate) {
        items = items.filter((item) => {
          const d = item.postedBankDate;
          if (!d) return false;
          if (fromDate && d < fromDate) return false;
          if (toDate && d > toDate) return false;
          return true;
        });
      }
    }

    // Explain an empty result instead of returning a bare [], so "no rows" is not
    // read as "no cash moved".
    if (items.length === 0) {
      return json({
        rows: 0,
        reason:
          "No cash book rows matched. If your organization does not use the Xledger cash book module (or stopped using it), any period without entries returns nothing. This does not mean no cash moved.",
        filter_applied: filters.length > 0 ? filters.join(", ") : "(none)",
        filter_semantics:
          "fromDate/toDate filter createdAt (row creation in Xledger). postedBankDate is not filterable in the Xledger API.",
        use_instead: [
          "get_ar_transactions: open customer invoices (drop outstandingOnly to also see credit notes)",
          "get_account_balances: balances on the GL bank/cash accounts",
          "Your bank's own statements for actual bank transactions",
        ],
      });
    }

    return json(items);
  }
);

// ─── Tool: get_deltas ────────────────────────────────────────────────────────

server.tool(
  "get_deltas",
  "Get change records (deltas) from Xledger for the last 3 days. Supports: arTransactions, timesheets, projects, apTransactions, employees, accounts. Use for incremental sync and change detection.",
  {
    entity: z
      .enum(["arTransactions", "timesheets", "projects", "apTransactions", "employees", "accounts"])
      .describe("Which entity to get deltas for"),
    first: z.number().optional().default(50).describe("Number of delta records to return (max 200)"),
  },
  READ_ONLY,
  async ({ entity, first }) => {
    const limit = Math.min(first, 200);
    const queryMap: Record<string, string> = {
      arTransactions: `arTransaction_deltas(first: ${limit}) {
        edges { node { dbId invoiceNumber invoiceDate invoiceAmount invoiceRemaining subledger { description } } }
      }`,
      timesheets: `timesheet_deltas(first: ${limit}) {
        edges { node { dbId assignmentDate workingHours invoiced approved employee { description } } }
      }`,
      projects: `project_deltas(first: ${limit}) {
        edges { node { dbId code description billable totalRevenue totalCost customer { description } } }
      }`,
      apTransactions: `apTransaction_deltas(first: ${limit}) {
        edges { node { dbId invoiceNumber invoiceDate invoiceAmount invoiceRemaining subledger { description } } }
      }`,
      employees: `employee_deltas(first: ${limit}) {
        edges { node { dbId description email employmentFrom employmentTo } }
      }`,
      accounts: `account_deltas(first: ${limit}) {
        edges { node { dbId code description } }
      }`,
    };

    const data = await gql(`{ ${queryMap[entity]} }`);
    const key = Object.keys(data)[0];
    const items = connNodes(data[key]);

    return json({ entity, count: items.length, deltas: items });
  }
);

// ─── Shared: sales orders (invoice overview at order level) ─────────────────
// The salesOrders connection is the order-level view of the Xledger UI's invoice
// overview. invoiceNumber "0" (or null/empty) means NOT yet invoiced (an invoice
// proposal); any other value means the order has been invoiced. Reference fields
// (yourReference, contract) are populated at ORDER level; line items have them
// empty until invoicing, so compare references here.

const SALES_ORDER_NODE_FIELDS = `
            dbId
            orderNumber
            invoiceDate
            dueDate
            invoiceNumber
            invoiceAmount
            taxAmount
            yourReference
            contract
            orderedBy
            extOrderNumber
            paymentReference
            text
            subledger { description }
            currency { code }
            soOrderType { name }`;

function isUninvoiced(node: Node): boolean {
  return !node.invoiceNumber || node.invoiceNumber === "0";
}

async function fetchSalesOrders(filters: string[]) {
  return paginateAll(
    gql,
    (afterClause) => `{
      salesOrders(first: 500${afterClause}${filterClause(filters)}, orderBy: [{ field: ORDER_NUMBER, direction: ASC }]) {
        pageInfo { hasNextPage }
        edges {
          cursor
          node {${SALES_ORDER_NODE_FIELDS}
          }
        }
      }
    }`,
    (d) => d.salesOrders
  );
}

// ─── Tool: get_invoice_proposals ─────────────────────────────────────────────

server.tool(
  "get_invoice_proposals",
  "Get uninvoiced invoice proposals at sales-order level from Xledger: the invoice overview rows that have NOT yet been invoiced (invoiceNumber is 0). Returns order number, invoice date, amounts (invoiceAmount is NET excl. VAT; taxAmount is the VAT), customer, and the order-level reference fields (yourReference, contract) needed for pre-invoicing review. Use before an invoice run; NOT for booked/sent invoices (use get_invoiced_orders or get_ar_transactions).",
  {
    invoiceDate: z
      .string()
      .optional()
      .describe("Exact invoice date to match (YYYY-MM-DD). Proposals for a month often all carry the last day of the month."),
    fromDate: z
      .string()
      .optional()
      .describe("Alternative to invoiceDate: window start (YYYY-MM-DD, invoiceDate_gte)"),
    toDate: z.string().optional().describe("Window end (YYYY-MM-DD, invoiceDate_lte). Used with fromDate."),
    first: z.number().optional().default(200).describe("Max number of proposals to return"),
  },
  READ_ONLY,
  async ({ invoiceDate, fromDate, toDate, first }) => {
    validateDate(invoiceDate, "invoiceDate");
    validateDate(fromDate, "fromDate");
    validateDate(toDate, "toDate");
    if (!invoiceDate && !fromDate) {
      throw new Error(
        "Provide either invoiceDate (exact match, e.g. last day of month) or fromDate/toDate. The salesOrders table is large and requires a date filter."
      );
    }

    const filters: string[] = [];
    if (invoiceDate) {
      filters.push(`invoiceDate: "${invoiceDate}"`);
    } else {
      filters.push(`invoiceDate_gte: "${fromDate}"`);
      if (toDate) filters.push(`invoiceDate_lte: "${toDate}"`);
    }

    const nodes = await fetchSalesOrders(filters);
    return withTruncation(nodes.filter(isUninvoiced).slice(0, first), nodes.truncated, "salesOrders");
  }
);

// ─── Tool: get_invoiced_orders ───────────────────────────────────────────────

server.tool(
  "get_invoiced_orders",
  "Get invoiced sales orders (sent/booked invoices) with references from Xledger: the invoice overview rows that HAVE been invoiced (invoiceNumber set). Returns invoice number, order number, invoice date, amounts (invoiceAmount is NET excl. VAT; taxAmount is the VAT), customer, and order-level reference fields (yourReference, contract), useful for verifying that sent invoices carry the correct client references (e.g. PO/contract numbers). NOT for uninvoiced proposals (use get_invoice_proposals) and NOT for payment status/AR aging (use get_ar_transactions).",
  {
    fromDate: z.string().describe("Invoice date window start (YYYY-MM-DD, invoiceDate_gte)"),
    toDate: z.string().describe("Invoice date window end (YYYY-MM-DD, invoiceDate_lte)"),
    first: z.number().optional().default(200).describe("Max number of invoiced orders to return"),
  },
  READ_ONLY,
  async ({ fromDate, toDate, first }) => {
    validateDate(fromDate, "fromDate");
    validateDate(toDate, "toDate");

    const nodes = await fetchSalesOrders([
      `invoiceDate_gte: "${fromDate}"`,
      `invoiceDate_lte: "${toDate}"`,
    ]);
    return withTruncation(
      nodes.filter((n) => !isUninvoiced(n)).slice(0, first),
      nodes.truncated,
      "salesOrders"
    );
  }
);

// ─── Start server ────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
