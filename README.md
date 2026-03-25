# Xledger MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that provides read-only access to the [Xledger](https://www.xledger.com) accounting system via its GraphQL API.

Use it with Claude, VS Code Copilot, or any MCP-compatible AI assistant to query your financial data — invoices, account balances, projects, timesheets, and more.

## Features

- 9 read-only tools covering core accounting data
- Compatible with Xledger GraphQL API v2
- Token-based authentication (no OAuth complexity)
- Zero runtime dependencies beyond the MCP SDK
- TypeScript with full type safety

## Tools

| Tool | Description |
|------|-------------|
| `get_ar_transactions` | Customer invoices (Accounts Receivable) — filter by date, outstanding only |
| `get_ap_transactions` | Supplier invoices (Accounts Payable) — filter by date, outstanding only |
| `get_account_balances` | GL account balances by fiscal year and period |
| `get_projects` | Project financials — revenue, cost, hours, billability |
| `get_timesheets` | Timesheet entries — hours per employee per project |
| `get_journal_entries` | Raw GL transactions with account, amount, project |
| `get_employees` | Employee list with employment dates |
| `get_customers` | Customer lookup with name search |
| `get_revenue_summary` | Aggregated revenue by customer for a date period |

All tools are annotated with `readOnlyHint: true` — they never modify data in Xledger.

## Quick Start

### Prerequisites

- Node.js 18+
- A Xledger account with GraphQL API access
- An API token (generate at: Xledger > Administration > System Access > GraphQL/API tokens)

### Install and Build

```bash
git clone https://github.com/Eyevinn/xledger-mcp-server.git
cd xledger-mcp-server
npm install
npm run build
```

### Configure

Set the required environment variable:

```bash
export XLEDGER_GRAPHQL_TOKEN=your-token-here
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `XLEDGER_GRAPHQL_TOKEN` | Yes | — | Your Xledger API token |
| `XLEDGER_API_URL` | No | `https://www.xledger.net/graphql` | API endpoint (use `https://demo.xledger.net/graphql` for testing) |

### Run

```bash
npm start
```

The server communicates over stdio — it's designed to be launched by an MCP client, not run standalone.

## Configuration

### Claude Desktop / Claude Code

Add to your Claude configuration (`~/.claude/settings.json` or Claude Desktop config):

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

Add to `.vscode/mcp.json`:

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

## Tool Details

### get_ar_transactions

Get customer invoices with optional filters.

**Parameters:**
- `first` (number, default: 50) — Number of records (max 200)
- `outstandingOnly` (boolean, default: false) — Only unpaid invoices
- `fromDate` (string, YYYY-MM-DD) — Invoice date from
- `toDate` (string, YYYY-MM-DD) — Invoice date to

### get_ap_transactions

Get supplier invoices with optional filters. Same parameters as `get_ar_transactions`.

### get_account_balances

Get GL account balances.

**Parameters:**
- `fiscalYear` (number) — Fiscal year, defaults to current year
- `periodNumber` (number, 1-12) — Month. Returns YTD if omitted
- `first` (number, default: 200) — Number of records (max 500)

### get_projects

Get projects with financial data.

**Parameters:**
- `first` (number, default: 100) — Number of records (max 500)
- `activeOnly` (boolean, default: true) — Only active projects
- `billableOnly` (boolean, default: false) — Only billable projects

### get_timesheets

Get timesheet entries.

**Parameters:**
- `first` (number, default: 100) — Number of records (max 500)
- `fromDate` / `toDate` (string, YYYY-MM-DD) — Date range
- `invoicedOnly` (boolean) — Only invoiced entries
- `notInvoiced` (boolean) — Only uninvoiced entries

### get_journal_entries

Get raw GL transactions.

**Parameters:**
- `first` (number, default: 50) — Number of records (max 200)
- `fromDate` / `toDate` (string, YYYY-MM-DD) — Date range (uses `createdAt` as proxy since `postedDate` is not filterable in API v2)
- `fiscalYear` (number) — Client-side fiscal year filter

### get_employees

Get employee list.

**Parameters:**
- `first` (number, default: 100) — Number of records
- `activeOnly` (boolean, default: true) — Only currently employed

### get_customers

Get customers (subledgers).

**Parameters:**
- `first` (number, default: 100) — Number of records
- `search` (string) — Partial name/code match (client-side)

### get_revenue_summary

Get aggregated revenue by customer.

**Parameters:**
- `fromDate` (string, YYYY-MM-DD, required) — Period start
- `toDate` (string, YYYY-MM-DD, required) — Period end

## Xledger API v2 Notes

This server is compatible with Xledger's GraphQL API v2 schema, which introduced several changes:

- **Filter syntax**: Direct field suffixes (e.g., `invoiceDate_gte`) instead of `{ AND: [{ field, op, value }] }`
- **OrderBy**: Array of `{ field, direction }` enums instead of single object
- **Removed filters**: Some fields are no longer filterable (`fiscalYear` on account balances, `description` on subledgers, `billable` on projects, `postedDate` on journal entries). These are handled with client-side filtering.
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

- The API token grants read access scoped to your Xledger tenant
- Never commit tokens to version control — use environment variables
- All tools are read-only (no mutations)
- Consider using Xledger's token scope controls to limit access to only the data you need

## License

MIT — see [LICENSE](LICENSE)

## About Eyevinn Technology

[Eyevinn Technology](https://www.eyevinn.se) is a Stockholm-based consultancy specializing in video streaming technology. We contribute to the open source community through our [GitHub organization](https://github.com/Eyevinn) and [Open Source Cloud](https://www.osaas.io) platform.
