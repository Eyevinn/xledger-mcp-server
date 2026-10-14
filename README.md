# Xledger MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that provides read-only access to the [Xledger](https://www.xledger.com) accounting system via its GraphQL API.

Use it with Claude, VS Code Copilot, or any MCP-compatible AI assistant to query your financial data: invoices, account balances, budget vs actual, projects, timesheets, invoice proposals, expenses and more.

## Features

- 19 read-only tools covering accounting, project, invoicing and HR data
- Compatible with Xledger GraphQL API v2 (cursor pagination, v2 filter syntax)
- Token-based authentication (no OAuth complexity)
- GDPR Art. 9 guard on absence data: no per-person health absence by default
- Zero runtime dependencies beyond the MCP SDK
- TypeScript with full type safety

## Tools

| Tool | Description |
|------|-------------|
| `get_ar_transactions` | Customer invoices (Accounts Receivable): filter by date, outstanding only |
| `get_ap_transactions` | Supplier invoices (Accounts Payable): filter by date, outstanding only |
| `get_account_balances` | GL account balances by fiscal year and period (cursor-paginated) |
| `get_budget_vs_actual` | Budget vs actual per account with variance, for a year or a single period |
| `get_journal_entries` | Raw GL transactions with account, amount, project |
| `get_projects` | Project financials: revenue, cost, hours, billability |
| `get_timesheets` | Timesheet entries: hours per employee per project, cost and revenue rates |
| `get_consultant_profitability` | Utilization, cost, revenue and margin per consultant and project |
| `get_employees` | Employee list with employment dates |
| `get_customers` | Customer lookup; search covers all customers, not only the first page |
| `get_revenue_summary` | Invoiced and outstanding amounts by customer for a date period |
| `get_invoice_proposals` | Not-yet-invoiced sales orders (invoice proposals) with order-level references |
| `get_invoiced_orders` | Invoiced sales orders with order-level references (PO/contract) |
| `get_expenses` | Expense lines (amount, type, project, approval) |
| `get_expense_reports` | Expense report headers (totals, period, approval, purpose) |
| `get_absences` | Absence hours per employee and type, with the GDPR Art. 9 guard |
| `get_exchange_rates` | Currency exchange rates, filtered server-side by currency pair |
| `get_cash_transactions` | Cash book transactions (only if your organization uses the cash book module) |
| `get_deltas` | Change records for the last 3 days, for incremental sync |

All tools are annotated with `readOnlyHint: true`. The server never sends GraphQL mutations.

## Quick Start

### Prerequisites

- Node.js 18+
- An Xledger account with GraphQL API access
- An API token (generate at: Xledger > Administration > System Access > GraphQL/API tokens)

### Install and Build

```bash
git clone https://github.com/Eyevinn/xledger-mcp-server.git
cd xledger-mcp-server
npm install
npm run build
```

### Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `XLEDGER_GRAPHQL_TOKEN` | Yes | — | Your Xledger API token |
| `XLEDGER_API_URL` | No | `https://www.xledger.net/graphql` | API endpoint (use `https://demo.xledger.net/graphql` for testing) |
| `XLEDGER_ALLOW_ART9_DETAIL` | No | unset | Set to `1` only if the data controller has decided to allow per-person health absence detail. See [GDPR and absence data](#gdpr-and-absence-data). |

See `.env.example`.

The server communicates over stdio. It is designed to be launched by an MCP client, not run standalone.

## Configuration

### Claude Code

Register the server at **user scope**, so the token lives in your personal Claude Code configuration and not in a repository:

```bash
claude mcp add xledger --scope user \
  -e XLEDGER_GRAPHQL_TOKEN=your-token-here \
  -- node /path/to/xledger-mcp-server/dist/index.js
```

Then run `/mcp` inside Claude Code (or restart it) and check that `xledger` is connected.

**Keep the token out of project-scoped `.mcp.json` files.** A project-scoped `.mcp.json` is meant to be committed and shared with everyone who clones the repository, so a token written there ends up in version control. If a project does need the server in its `.mcp.json`, reference an environment variable instead of the literal value, for example `"XLEDGER_GRAPHQL_TOKEN": "${XLEDGER_GRAPHQL_TOKEN}"`, and set the variable in your shell.

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "xledger": {
      "command": "node",
      "args": ["/path/to/xledger-mcp-server/dist/index.js"],
      "env": {
        "XLEDGER_GRAPHQL_TOKEN": "your-token-here"
      }
    }
  }
}
```

### VS Code (GitHub Copilot)

Add to your user-level MCP configuration (not a workspace `.vscode/mcp.json` that is committed):

```json
{
  "servers": {
    "xledger": {
      "command": "node",
      "args": ["/path/to/xledger-mcp-server/dist/index.js"],
      "env": {
        "XLEDGER_GRAPHQL_TOKEN": "your-token-here"
      }
    }
  }
}
```

### Verify that it boots

No real token is needed to list the tools:

```bash
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"diag","version":"1.0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
 | XLEDGER_GRAPHQL_TOKEN=dummy node dist/index.js | grep -oE '"name":"get_[a-z_]+"' | sort -u | wc -l
# Expected: 19
```

## GDPR and absence data

`get_absences` derives absence from timesheet rows booked to absence projects. An absence type tied to a named person can reveal health information (sick leave, care of a sick child). That is special-category personal data under GDPR Art. 9, and every tool result is sent to the AI model provider your MCP client uses.

The server therefore enforces the following before any data leaves it, instead of relying on an instruction to the assistant:

- **Default:** only absence types positively recognised as non-health (vacation, parental leave, time off in lieu, leave of absence) are returned per employee. Health-related types, **and any type the server does not recognise**, are collapsed into one anonymous aggregate (`healthRelatedAbsence`: total hours and number of employees, no names, no absence codes). The guard fails closed.
- `totalAbsenceHours` always includes all absence, so utilization calculations are unaffected.
- **Override:** per-person detail for all types is returned only when the caller sets `includeHealthDetail: true` **and** the server was started with `XLEDGER_ALLOW_ART9_DETAIL=1`. Either one alone is refused, and the response says so (`healthDetailRefused`). The environment variable is a decision for the data controller, made with a documented lawful basis; the assistant cannot set it.

Absence projects and types are matched on common Swedish and English names (for example `Frånvaro`/`Absence`, `Semester`/`Vacation`, `Sjuk`/`Sick`, `VAB`, `Föräldraledig`/`Parental leave`). See `src/absences.ts` if your Xledger setup uses other names.

## Tool notes

- **`get_account_balances` / `get_budget_vs_actual`:** Xledger v2 has no year filter on balances and no `offset`, so the server pages through balances newest-first with cursors and filters client-side. `periodNumber` returns that single period only; omit it for all periods of the year.
- **`get_revenue_summary`** is based on AR invoices, so credit notes and invoice timing affect it. For accrual-based monthly figures, use `get_budget_vs_actual`.
- **`get_customers`** reads all customers (cursor-paginated) before applying `search`, so a match is never missed because it was outside the first page.
- **`get_invoice_proposals` / `get_invoiced_orders`** read the `salesOrders` connection (the order-level invoice overview). `invoiceNumber` `0` means not yet invoiced. `invoiceAmount` is net excluding VAT; `taxAmount` is the VAT. Reference fields (`yourReference`, `contract`) are compared at order level.
- **`get_consultant_profitability`** takes `monthlySalary` and `hourlyRate` as inputs, because payroll data is usually outside the API token's scope. `agAvgPct` (employer social security contribution) defaults to the Swedish standard rate of 31.42 %.
- **`get_consultant_profitability` / `get_absences`** fetch timesheets in monthly chunks of up to 500 rows. If a month reaches that limit, the response includes a `warning` and `truncatedMonths` instead of silently undercounting.
- **`get_expenses` / `get_expense_reports`:** if the API token's Expense owner-scope is `MINE`, it only sees the integration user's own expenses. An Xledger administrator can widen the scope.
- **`get_cash_transactions`:** `fromDate`/`toDate` filter on `createdAt`, not on the bank date (`postedBankDate` is not filterable). An empty result explains this instead of returning a bare `[]`.
- **Empty results:** Xledger returns `edges: null` (not `[]`) when nothing matches. All tools handle this and return an empty list or an explanatory note.

## Xledger API v2 Notes

- **Filter syntax**: Direct field suffixes (e.g., `invoiceDate_gte`) instead of `{ AND: [{ field, op, value }] }`
- **OrderBy**: Array of `{ field, direction }` enums instead of single object
- **Pagination**: Connections expose `edges.cursor` and `pageInfo.hasNextPage` but not `endCursor`/`totalCount`, and reject `offset`. Page with `after: <last edge cursor>`.
- **Removed filters**: Some fields are no longer filterable (`fiscalYear` on account balances, `description` on customers, `billable` on projects, `postedDate` on journal entries). These are handled client-side.
- **SystemValue**: Uses `.name` instead of `.description`

## Development

```bash
npm install
npm run build        # Compile TypeScript
npm test             # Run tests
npm run dev          # Watch mode (recompile on changes)
npm run lint         # Type-check without emitting
```

## Security

- The API token grants read access scoped to your Xledger tenant and to the token user's owner-scopes
- Never commit tokens to version control. Use user-scoped MCP configuration or environment variables
- All tools are read-only (no mutations)
- Use Xledger's token scope controls to limit access to only the data you need
- Absence data is filtered for GDPR Art. 9 before it leaves the server (see above)

## License

MIT — see [LICENSE](LICENSE)

## About Eyevinn Technology

[Eyevinn Technology](https://www.eyevinn.se) is a Stockholm-based consultancy specializing in video streaming technology. We contribute to the open source community through our [GitHub organization](https://github.com/Eyevinn) and [Open Source Cloud](https://www.osaas.io) platform.
