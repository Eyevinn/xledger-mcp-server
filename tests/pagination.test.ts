import { describe, it, expect, vi } from "vitest";
import { connNodes, paginateAll } from "../src/pagination.js";

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
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("respects maxPages", async () => {
    const run = vi.fn().mockResolvedValue(page([1], true));
    await paginateAll(run, (a) => a, (d) => d.things, { maxPages: 3 });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("survives a null connection", async () => {
    const run = vi.fn().mockResolvedValue({ things: { edges: null } });
    expect(await paginateAll(run, (a) => a, (d) => d.things)).toEqual([]);
  });
});
