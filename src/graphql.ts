/**
 * Xledger GraphQL API client
 *
 * Handles HTTP communication and error handling for the Xledger GraphQL API.
 * Uses native fetch (Node 18+).
 */

const API_URL =
  process.env.XLEDGER_API_URL || "https://www.xledger.net/graphql";
const TOKEN = process.env.XLEDGER_GRAPHQL_TOKEN;

if (!TOKEN) {
  console.error(
    "ERROR: XLEDGER_GRAPHQL_TOKEN environment variable is not set"
  );
  process.exit(1);
}

export async function gql(query: string): Promise<Record<string, any>> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `token ${TOKEN}`,
    },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Xledger API error HTTP ${res.status}: ${body}`);
  }

  const json = (await res.json()) as {
    data?: Record<string, any>;
    errors?: Array<{ message: string }>;
  };

  if (json.errors) {
    throw new Error(
      `Xledger GraphQL errors: ${JSON.stringify(json.errors)}`
    );
  }

  return json.data!;
}
