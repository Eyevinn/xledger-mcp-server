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
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { gql } from "./graphql.js";
import { validateDate, today } from "./validation.js";

const server = new McpServer({
  name: "xledger",
  version: "1.0.0",
});

// ─── Tool: get_ar_transactions ───────────────────────────────────────────────

server.tool(
  "get_ar_transactions",
  "Get customer invoices (Accounts Receivable) from Xledger. Returns invoice number, date, due date, amount, remaining balance, customer name, and currency. Filter by date range or outstanding only.",
  {
    first: z
      .number()
      .optional()
      .default(50)
      .describe("Number of records to return (max 200)"),
    outstandingOnly: z
      .boolean()
      .optional()
      .default(false)
      .describe("Only return unpaid invoices (invoiceRemaining > 0)"),
    fromDate: z
      .string()
      .optional()
      .describe("Filter invoices from this date (YYYY-MM-DD)"),
    toDate: z
      .string()
      .optional()
      .describe("Filter invoices to this date (YYYY-MM-DD)"),
  },
  {
    readOnlyHint: true,
    openWorldHint: true,
  },
  async ({ first, outstandingOnly, fromDate, toDate }) => {
    validateDate(fromDate, "fromDate");
    validateDate(toDate, "toDate");

    const filters: string[] = [];
    if (outstandingOnly) filters.push('invoiceRemaining_gt: "0"');
    if (fromDate) filters.push(`invoiceDate_gte: "${fromDate}"`);
    if (toDate) filters.push(`invoiceDate_lte: "${toDate}"`);

    const filterStr =
      filters.length > 0 ? `, filter: { ${filters.join(", ")} }` : "";

    const data = await gql(`{
      arTransactions(first: ${Math.min(first, 200)}${filterStr}, orderBy: [{ field: MODIFIED_AT, direction: DESC }]) {
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

    const items = data.arTransactions.edges.map(
      (e: { node: unknown }) => e.node
    );
    return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
  }
);

// ─── Tool: get_ap_transactions ───────────────────────────────────────────────

server.tool(
  "get_ap_transactions",
  "Get supplier invoices (Accounts Payable) from Xledger. Returns invoice number, date, due date, amount, remaining balance, supplier name. Filter by date range or outstanding only.",
  {
    first: z
      .number()
      .optional()
      .default(50)
      .describe("Number of records to return (max 200)"),
    outstandingOnly: z
      .boolean()
      .optional()
      .default(false)
      .describe("Only return unpaid invoices"),
    fromDate: z
      .string()
      .optional()
      .describe("Filter from this date (YYYY-MM-DD)"),
    toDate: z
      .string()
      .optional()
      .describe("Filter to this date (YYYY-MM-DD)"),
  },
  {
    readOnlyHint: true,
    openWorldHint: true,
  },
  async ({ first, outstandingOnly, fromDate, toDate }) => {
    validateDate(fromDate, "fromDate");
    validateDate(toDate, "toDate");

    const filters: string[] = [];
    if (outstandingOnly) filters.push('invoiceRemaining_gt: "0"');
    if (fromDate) filters.push(`invoiceDate_gte: "${fromDate}"`);
    if (toDate) filters.push(`invoiceDate_lte: "${toDate}"`);

    const filterStr =
      filters.length > 0 ? `, filter: { ${filters.join(", ")} }` : "";

    const data = await gql(`{
      apTransactions(first: ${Math.min(first, 200)}${filterStr}, orderBy: [{ field: MODIFIED_AT, direction: DESC }]) {
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

    const items = data.apTransactions.edges.map(
      (e: { node: unknown }) => e.node
    );
    return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
  }
);

// ─── Tool: get_account_balances ──────────────────────────────────────────────
// Note: Xledger API v2 removed fiscalYear/periodNumber from AccountBalance_Filter.
// We fetch all balances and filter client-side.

server.tool(
  "get_account_balances",
  "Get General Ledger account balances from Xledger. Returns account code, description, and balance amounts by fiscal year and period. Use for P&L, balance sheet, and financial reporting.",
  {
    fiscalYear: z
      .number()
      .optional()
      .describe("Fiscal year (e.g. 2025). Defaults to current year."),
    periodNumber: z
      .number()
      .optional()
      .describe("Period number 1-12 (month). Returns YTD if omitted."),
    first: z
      .number()
      .optional()
      .default(200)
      .describe("Number of records to return (max 500)"),
  },
  {
    readOnlyHint: true,
    openWorldHint: true,
  },
  async ({ fiscalYear, periodNumber, first }) => {
    const year = fiscalYear || new Date().getFullYear();

    // Paginate using offset (Xledger v2 doesn't expose endCursor)
    const pageSize = 500;
    let collected: Record<string, unknown>[] = [];
    const maxPages = 6;

    for (let page = 0; page < maxPages; page++) {
      const offset = page * pageSize;
      const offsetClause = offset > 0 ? `, offset: ${offset}` : "";
      const data = await gql(`{
        accountBalances(first: ${pageSize}${offsetClause}, orderBy: [{ field: PERIOD_ID, direction: DESC }]) {
          edges {
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
      }`);

      const nodes = data.accountBalances.edges.map(
        (e: { node: Record<string, any> }) => e.node
      );

      if (nodes.length === 0) break;

      collected = collected.concat(
        nodes.filter((b: Record<string, any>) => b.fiscalYear === year)
      );

      const minYear = nodes.reduce(
        (m: number, b: Record<string, any>) =>
          Math.min(m, b.fiscalYear ?? 9999),
        9999
      );
      if (minYear < year) break;
      if (nodes.length < pageSize) break;
    }

    if (periodNumber) {
      collected = collected.filter(
        (b: Record<string, any>) => b.periodNumber === periodNumber
      );
    }

    collected = collected.slice(0, first);

    return {
      content: [{ type: "text", text: JSON.stringify(collected, null, 2) }],
    };
  }
);

// ─── Tool: get_projects ──────────────────────────────────────────────────────

server.tool(
  "get_projects",
  "Get projects from Xledger with financial data including total revenue, total cost, estimate hours, and billability. Use for project profitability analysis.",
  {
    first: z
      .number()
      .optional()
      .default(100)
      .describe("Number of records to return (max 500)"),
    activeOnly: z
      .boolean()
      .optional()
      .default(true)
      .describe("Only return active projects (end date in future or none)"),
    billableOnly: z
      .boolean()
      .optional()
      .default(false)
      .describe("Only return billable projects"),
  },
  {
    readOnlyHint: true,
    openWorldHint: true,
  },
  async ({ first, activeOnly, billableOnly }) => {
    const filters: string[] = [];
    if (activeOnly) {
      filters.push(`toDate_gte: "${today()}"`);
    }

    const filterStr =
      filters.length > 0 ? `, filter: { ${filters.join(", ")} }` : "";

    const data = await gql(`{
      projects(first: ${Math.min(first, 500)}${filterStr}, orderBy: [{ field: FROM_DATE, direction: DESC }]) {
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

    let items = data.projects.edges.map(
      (e: { node: unknown }) => e.node
    ) as Record<string, any>[];

    if (billableOnly) {
      items = items.filter((p) => p.billable === true);
    }

    return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
  }
);

// ─── Tool: get_timesheets ────────────────────────────────────────────────────

server.tool(
  "get_timesheets",
  "Get timesheet entries from Xledger. Returns hours worked per employee per project with invoice status. Use for utilization analysis and billing verification.",
  {
    first: z
      .number()
      .optional()
      .default(100)
      .describe("Number of records to return (max 500)"),
    fromDate: z
      .string()
      .optional()
      .describe("Filter from date (YYYY-MM-DD)"),
    toDate: z
      .string()
      .optional()
      .describe("Filter to date (YYYY-MM-DD)"),
    invoicedOnly: z
      .boolean()
      .optional()
      .default(false)
      .describe("Only return invoiced timesheets"),
    notInvoiced: z
      .boolean()
      .optional()
      .default(false)
      .describe("Only return not-yet-invoiced timesheets"),
  },
  {
    readOnlyHint: true,
    openWorldHint: true,
  },
  async ({ first, fromDate, toDate, invoicedOnly, notInvoiced }) => {
    validateDate(fromDate, "fromDate");
    validateDate(toDate, "toDate");

    const filters: string[] = [];
    if (invoicedOnly) filters.push("invoiced: true");
    if (notInvoiced) filters.push("invoiced: false");
    if (fromDate) filters.push(`assignmentDate_gte: "${fromDate}"`);
    if (toDate) filters.push(`assignmentDate_lte: "${toDate}"`);

    const filterStr =
      filters.length > 0 ? `, filter: { ${filters.join(", ")} }` : "";

    const data = await gql(`{
      timesheets(first: ${Math.min(first, 500)}${filterStr}, orderBy: [{ field: ASSIGNMENT_DATE, direction: DESC }]) {
        edges {
          node {
            dbId
            assignmentDate
            workingHours
            invoiceHours
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

    const items = data.timesheets.edges.map(
      (e: { node: unknown }) => e.node
    );
    return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
  }
);

// ─── Tool: get_journal_entries ───────────────────────────────────────────────
// Note: Xledger API v2 removed postedDate from JournalEntry_Filter.
// Date filtering uses createdAt as proxy.

server.tool(
  "get_journal_entries",
  "Get journal entries (raw GL transactions) from Xledger. Returns detailed accounting entries with account, amount, date, project. Use for detailed financial analysis.",
  {
    first: z
      .number()
      .optional()
      .default(50)
      .describe("Number of records to return (max 200)"),
    fromDate: z
      .string()
      .optional()
      .describe("Posted date from (YYYY-MM-DD)"),
    toDate: z
      .string()
      .optional()
      .describe("Posted date to (YYYY-MM-DD)"),
    fiscalYear: z
      .number()
      .optional()
      .describe("Filter by fiscal year (client-side)"),
  },
  {
    readOnlyHint: true,
    openWorldHint: true,
  },
  async ({ first, fromDate, toDate, fiscalYear }) => {
    validateDate(fromDate, "fromDate");
    validateDate(toDate, "toDate");

    const filters: string[] = [];
    if (fromDate) filters.push(`createdAt_gte: "${fromDate}"`);
    if (toDate) filters.push(`createdAt_lte: "${toDate}"`);

    const filterStr =
      filters.length > 0 ? `, filter: { ${filters.join(", ")} }` : "";

    const data = await gql(`{
      journalEntries(first: ${Math.min(first, 200)}${filterStr}, orderBy: [{ field: CREATED_AT, direction: DESC }]) {
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

    let items = data.journalEntries.edges.map(
      (e: { node: Record<string, any> }) => e.node
    );

    if (fiscalYear) {
      items = items.filter((e: Record<string, any>) => e.fiscalYear === fiscalYear);
    }

    return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
  }
);

// ─── Tool: get_employees ─────────────────────────────────────────────────────

server.tool(
  "get_employees",
  "Get employees from Xledger payroll system. Returns employee code, name, email, employment dates, and group. Use for payroll cost analysis and headcount reporting.",
  {
    first: z
      .number()
      .optional()
      .default(100)
      .describe("Number of records to return"),
    activeOnly: z
      .boolean()
      .optional()
      .default(true)
      .describe("Only return currently employed staff"),
  },
  {
    readOnlyHint: true,
    openWorldHint: true,
  },
  async ({ first, activeOnly }) => {
    const filters: string[] = [];
    if (activeOnly) {
      filters.push(`employmentFrom_lte: "${today()}"`);
    }

    const filterStr =
      filters.length > 0 ? `, filter: { ${filters.join(", ")} }` : "";

    const data = await gql(`{
      employees(first: ${Math.min(first, 200)}${filterStr}) {
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

    let items = data.employees.edges.map(
      (e: { node: Record<string, any> }) => e.node
    );

    if (activeOnly) {
      const d = today();
      items = items.filter((e: Record<string, any>) => !e.employmentTo || e.employmentTo >= d);
    }

    return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
  }
);

// ─── Tool: get_customers ─────────────────────────────────────────────────────
// Note: Subledger_Filter does not support description search in v2 — done client-side.

server.tool(
  "get_customers",
  "Get customers (subledgers) from Xledger. Returns customer name and basic info. Use to look up customer IDs for filtering invoices.",
  {
    first: z
      .number()
      .optional()
      .default(100)
      .describe("Number of records to return"),
    search: z
      .string()
      .optional()
      .describe("Search by customer name (partial match)"),
  },
  {
    readOnlyHint: true,
    openWorldHint: true,
  },
  async ({ first, search }) => {
    const data = await gql(`{
      subledgers(first: ${Math.min(first, 200)}, orderBy: [{ field: CREATED_AT, direction: ASC }]) {
        edges {
          node {
            dbId
            code
            description
          }
        }
      }
    }`);

    let items = data.subledgers.edges.map(
      (e: { node: Record<string, any> }) => e.node
    );

    if (search) {
      const term = search.toLowerCase();
      items = items.filter(
        (s: Record<string, any>) =>
          s.description?.toLowerCase().includes(term) ||
          s.code?.toLowerCase().includes(term)
      );
    }

    return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
  }
);

// ─── Tool: get_revenue_summary ───────────────────────────────────────────────

server.tool(
  "get_revenue_summary",
  "Get a revenue summary from Xledger AR transactions: total invoiced, total outstanding, grouped by customer. Useful for monthly reporting and cash flow analysis.",
  {
    fromDate: z.string().describe("Start date for the period (YYYY-MM-DD)"),
    toDate: z.string().describe("End date for the period (YYYY-MM-DD)"),
  },
  {
    readOnlyHint: true,
    openWorldHint: true,
  },
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

    const invoices = data.arTransactions.edges.map(
      (e: { node: Record<string, any> }) => e.node
    );

    const byCustomer: Record<
      string,
      { invoiced: number; outstanding: number; invoiceCount: number }
    > = {};
    let totalInvoiced = 0;
    let totalOutstanding = 0;

    for (const inv of invoices) {
      const customer = inv.subledger?.description || "Unknown";
      const amount = parseFloat(inv.invoiceAmount) || 0;
      const remaining = parseFloat(inv.invoiceRemaining) || 0;

      if (!byCustomer[customer]) {
        byCustomer[customer] = { invoiced: 0, outstanding: 0, invoiceCount: 0 };
      }
      byCustomer[customer].invoiced += amount;
      byCustomer[customer].outstanding += remaining;
      byCustomer[customer].invoiceCount += 1;
      totalInvoiced += amount;
      totalOutstanding += remaining;
    }

    const sorted = Object.entries(byCustomer)
      .sort((a, b) => b[1].invoiced - a[1].invoiced)
      .map(([customer, data]) => ({ customer, ...data }));

    const summary = {
      period: { from: fromDate, to: toDate },
      totals: {
        invoiced: totalInvoiced.toFixed(2),
        outstanding: totalOutstanding.toFixed(2),
        invoiceCount: invoices.length,
      },
      byCustomer: sorted,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
    };
  }
);

// ─── Start server ────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
