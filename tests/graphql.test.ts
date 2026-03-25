import { describe, it, expect, vi, beforeEach } from "vitest";

describe("gql helper", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("sends correct headers and body", async () => {
    vi.stubEnv("XLEDGER_GRAPHQL_TOKEN", "test-token-123");
    vi.stubEnv("XLEDGER_API_URL", "https://mock.xledger.net/graphql");

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: { arTransactions: { edges: [] } },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    // Re-import to pick up stubbed env
    const { gql } = await import("../src/graphql.js");

    const query = "{ arTransactions { edges { node { dbId } } } }";
    await gql(query);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://mock.xledger.net/graphql",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "token test-token-123",
        },
        body: JSON.stringify({ query }),
      }
    );
  });

  it("throws on HTTP errors", async () => {
    vi.stubEnv("XLEDGER_GRAPHQL_TOKEN", "test-token");
    vi.stubEnv("XLEDGER_API_URL", "https://mock.xledger.net/graphql");

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { gql } = await import("../src/graphql.js");

    await expect(gql("{ test }")).rejects.toThrow(
      "Xledger API error HTTP 401: Unauthorized"
    );
  });

  it("throws on GraphQL errors", async () => {
    vi.stubEnv("XLEDGER_GRAPHQL_TOKEN", "test-token");
    vi.stubEnv("XLEDGER_API_URL", "https://mock.xledger.net/graphql");

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          errors: [{ message: "Field not found" }],
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { gql } = await import("../src/graphql.js");

    await expect(gql("{ test }")).rejects.toThrow("Xledger GraphQL errors");
  });
});
