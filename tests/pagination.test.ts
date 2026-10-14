import { describe, it, expect, vi } from "vitest";
import { connNodes, paginateAll, truncationWarning } from "../src/pagination.js";

describe("connNodes", () => {
  it("handles null edges (Xledger's empty result)", () => {
    expect(connNodes({ edges: null })).toEqual([]);
    expect(connNodes(null)).toEqual([]);
    expect(connNodes(undefined)).toEqual([]);
  });

  it("extracts nodes", () => {
    expect(connNodes({ edges: [{ node: { a: 1 } }, { node: { a: 2 } }] })).toEqual([{ a: 1 }, { a: 2 }]);
  });
});

describe("paginateAll", () => {
  const page = (ids: number[], hasNextPage: boolean, year = 2026) => ({
    things: {
      pageInfo: { hasNextPage },
      edges: ids.map((id) => ({ cursor: `c${id}`, node: { id, fiscalYear: year } })),
    },
  });

  it("follows cursors until hasNextPage is false", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(page([1, 2], true))
      .mockResolvedValueOnce(page([3], false));
    const nodes = await paginateAll(run, (after) => `{ things(first: 2${after}) }`, (d) => d.things);
    expect(nodes.map((n) => n.id)).toEqual([1, 2, 3]);
    expect(nodes.truncated).toBe(false);
    expect(run).toHaveBeenNthCalledWith(1, "{ things(first: 2) }");
    expect(run).toHaveBeenNthCalledWith(2, '{ things(first: 2, after: "c2") }');
  });

  it("stops early when stopWhen is satisfied", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(page([1], true, 2026))
      .mockResolvedValueOnce(page([2], true, 2024))
      .mockResolvedValueOnce(page([3], false, 2023));
    const nodes = await paginateAll(run, (a) => a, (d) => d.things, {
      stopWhen: (p) => Math.max(...p.map((n) => n.fiscalYear)) < 2025,
    });
    expect(nodes.map((n) => n.id)).toEqual([1, 2]);
    expect(nodes.truncated).toBe(false);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("respects maxPages and flags the result as truncated", async () => {
    const run = vi.fn().mockResolvedValue(page([1], true));
    const nodes = await paginateAll(run, (a) => a, (d) => d.things, { maxPages: 3 });
    expect(run).toHaveBeenCalledTimes(3);
    expect(nodes).toHaveLength(3);
    expect(nodes.truncated).toBe(true);
  });

  it("is not truncated when the last allowed page is also the last page", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(page([1], true))
      .mockResolvedValueOnce(page([2], false));
    const nodes = await paginateAll(run, (a) => a, (d) => d.things, { maxPages: 2 });
    expect(nodes.truncated).toBe(false);
  });

  it("flags truncation when hasNextPage is set but no cursor is returned", async () => {
    const run = vi.fn().mockResolvedValue({
      things: { pageInfo: { hasNextPage: true }, edges: [{ node: { id: 1 } }] },
    });
    const nodes = await paginateAll(run, (a) => a, (d) => d.things);
    expect(run).toHaveBeenCalledTimes(1);
    expect(nodes.truncated).toBe(true);
  });

  it("truncationWarning names the source", () => {
    expect(truncationWarning("salesOrders")).toMatch(/^salesOrders: .*incomplete/);
  });

  it("survives a null connection", async () => {
    const run = vi.fn().mockResolvedValue({ things: { edges: null } });
    const nodes = await paginateAll(run, (a) => a, (d) => d.things);
    expect(nodes).toEqual([]);
    expect(nodes.truncated).toBe(false);
  });
});
