/**
 * Connection helpers for the Xledger GraphQL API.
 */

export type Node = Record<string, any>;
export type Connection =
  | {
      edges?: Array<{ cursor?: string; node: Node }> | null;
      pageInfo?: { hasNextPage?: boolean } | null;
    }
  | null
  | undefined;

/**
 * Safe node extraction.
 *
 * Xledger returns `{ edges: null }` (not `{ edges: [] }`) when a filter matches
 * zero rows, without a GraphQL `errors` block. A bare `conn.edges.map(...)`
 * would then throw. Always extract nodes through this helper.
 */
export function connNodes(conn: Connection): Node[] {
  return (conn?.edges ?? []).map((e) => e.node);
}

/**
 * Cursor pagination.
 *
 * Xledger connections expose edges.cursor + pageInfo.hasNextPage, but not
 * endCursor/totalCount, and they reject an `offset` argument. So we page via
 * the last edge's cursor + `after:`. `stopWhen` lets a caller stop early once
 * a whole page is outside the range it needs (e.g. rows come back newest-first).
 */
export async function paginateAll(
  run: (query: string) => Promise<Record<string, any>>,
  buildQuery: (afterClause: string) => string,
  pick: (data: Record<string, any>) => Connection,
  {
    maxPages = 20,
    stopWhen,
  }: { maxPages?: number; stopWhen?: (pageNodes: Node[]) => boolean } = {}
): Promise<Node[]> {
  const nodes: Node[] = [];
  let after: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const data = await run(buildQuery(after ? `, after: "${after}"` : ""));
    const conn = pick(data);
    const edges = conn?.edges ?? [];
    for (const e of edges) nodes.push(e.node);
    if (!conn?.pageInfo?.hasNextPage || edges.length === 0) break;
    if (stopWhen && stopWhen(edges.map((e) => e.node))) break;
    after = edges[edges.length - 1].cursor ?? null;
    if (!after) break;
  }
  return nodes;
}
