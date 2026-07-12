import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_QDRANT_URL,
  deleteQdrantCollection,
  deleteQdrantPoints,
  ensureQdrantCollection,
  normalizeQdrantUrl,
  queryQdrantPoints,
  upsertQdrantPoints,
  type QdrantPayloadIndex,
  type QdrantPoint,
} from "./qdrantClient.js";

function response(options: {
  ok?: boolean;
  status?: number;
  text?: string;
  json?: unknown;
}): Response {
  return {
    ok: options.ok ?? false,
    status: options.status ?? 500,
    text: vi.fn(async () => options.text ?? "error"),
    json: vi.fn(async () => options.json),
  } as unknown as Response;
}

const points: QdrantPoint[] = [
  {
    id: "point-1",
    vector: [0.1, 0.2],
    payload: { filePath: "src/index.ts" },
  },
];

const payloadIndexes: QdrantPayloadIndex[] = [
  { field_name: "filePath", field_schema: "keyword" },
  {
    field_name: "codeChunk",
    field_schema: { type: "text", tokenizer: "word" },
  },
];

describe("Qdrant URL configuration", () => {
  it("pins the default URL", () => {
    expect(DEFAULT_QDRANT_URL).toBe("http://localhost:6333");
  });

  it.each([
    ["http://localhost:6333", "http://localhost:6333"],
    ["http://localhost:6333/", "http://localhost:6333"],
    ["http://localhost:6333///", "http://localhost:6333"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeQdrantUrl(input)).toBe(expected);
  });
});

describe("ensureQdrantCollection", () => {
  it("does nothing when the collection check succeeds", async () => {
    const fetchMock = vi.fn(async () => response({ ok: true }));

    await ensureQdrantCollection({
      qdrantUrl: "http://qdrant///",
      collectionName: "al-workspace",
      vectorSize: 1536,
      payloadIndexes,
      fetch: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://qdrant/collections/al-workspace",
    );
  });

  it("creates a missing collection and all payload indexes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ status: 404 }))
      .mockResolvedValueOnce(response({ ok: true }))
      .mockResolvedValue(response({ status: 500 }));

    await ensureQdrantCollection({
      qdrantUrl: "http://qdrant/",
      collectionName: "al-workspace",
      vectorSize: 1536,
      payloadIndexes,
      fetch: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://qdrant/collections/al-workspace",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vectors: {
            size: 1536,
            distance: "Cosine",
            on_disk: true,
          },
          hnsw_config: {
            m: 64,
            ef_construct: 512,
            on_disk: true,
          },
        }),
      },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "http://qdrant/collections/al-workspace/index",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadIndexes[0]),
      },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "http://qdrant/collections/al-workspace/index",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadIndexes[1]),
      },
    );
  });

  it("attempts creation after any unsuccessful collection check", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ status: 500 }))
      .mockResolvedValueOnce(response({ ok: true }));

    await ensureQdrantCollection({
      qdrantUrl: "http://qdrant",
      collectionName: "al-workspace",
      vectorSize: 1536,
      payloadIndexes: [],
      fetch: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves the collection creation error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ status: 404 }))
      .mockResolvedValueOnce(response({ status: 400, text: "bad config" }));

    await expect(
      ensureQdrantCollection({
        qdrantUrl: "http://qdrant",
        collectionName: "al-workspace",
        vectorSize: 1536,
        payloadIndexes,
        fetch: fetchMock,
      }),
    ).rejects.toThrow(
      "Failed to create Qdrant collection al-workspace: bad config",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("Qdrant collection and point writes", () => {
  it("deletes a collection without interpreting the response status", async () => {
    const fetchMock = vi.fn(async () => response({ status: 500 }));

    await expect(
      deleteQdrantCollection("http://qdrant/", "al-workspace", fetchMock),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://qdrant/collections/al-workspace",
      { method: "DELETE" },
    );
  });

  it("upserts points with the existing request contract", async () => {
    const fetchMock = vi.fn(async () => response({ ok: true }));

    await upsertQdrantPoints(
      "http://qdrant/",
      "al-workspace",
      points,
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://qdrant/collections/al-workspace/points",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points }),
      },
    );
  });

  it("preserves the upsert error", async () => {
    const fetchMock = vi.fn(async () =>
      response({ status: 500, text: "write failed" }),
    );

    await expect(
      upsertQdrantPoints("http://qdrant", "al-workspace", points, fetchMock),
    ).rejects.toThrow("Qdrant upsert failed: write failed");
  });

  it("deletes point IDs with the existing request contract", async () => {
    const fetchMock = vi.fn(async () => response({ ok: true }));

    await deleteQdrantPoints(
      "http://qdrant/",
      "al-workspace",
      ["point-1", "point-2"],
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://qdrant/collections/al-workspace/points/delete?wait=true",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points: ["point-1", "point-2"] }),
      },
    );
  });

  it("preserves the point deletion error", async () => {
    const fetchMock = vi.fn(async () =>
      response({ status: 500, text: "delete failed" }),
    );

    await expect(
      deleteQdrantPoints(
        "http://qdrant",
        "al-workspace",
        ["point-1"],
        fetchMock,
      ),
    ).rejects.toThrow("Qdrant delete failed: delete failed");
  });
});

describe("queryQdrantPoints", () => {
  const body = { query: [0.1, 0.2], limit: 5 };

  it("posts a query and returns points", async () => {
    const result = [{ id: "point-1", score: 0.9 }];
    const fetchMock = vi.fn(async () =>
      response({ ok: true, json: { result: { points: result } } }),
    );

    await expect(
      queryQdrantPoints("http://qdrant/", "al-workspace", body, fetchMock),
    ).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://qdrant/collections/al-workspace/points/query",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  });

  it.each([{ result: {} }, {}, { result: { points: undefined } }])(
    "returns an empty list for a response without points",
    async (json) => {
      const fetchMock = vi.fn(async () => response({ ok: true, json }));

      await expect(
        queryQdrantPoints("http://qdrant", "al-workspace", body, fetchMock),
      ).resolves.toEqual([]);
    },
  );

  it("wraps transport failures with the configured URL", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      queryQdrantPoints("http://qdrant/", "al-workspace", body, fetchMock),
    ).rejects.toThrow(
      "Qdrant is not reachable at http://qdrant/. Ensure Qdrant is running. (ECONNREFUSED)",
    );
  });

  it("preserves the missing collection error", async () => {
    const fetchMock = vi.fn(async () =>
      response({ status: 404, text: "not found" }),
    );

    await expect(
      queryQdrantPoints("http://qdrant", "al-workspace", body, fetchMock),
    ).rejects.toThrow("No codebase index found (collection: al-workspace).");
  });

  it("preserves generic Qdrant API errors", async () => {
    const fetchMock = vi.fn(async () =>
      response({ status: 500, text: "unavailable" }),
    );

    await expect(
      queryQdrantPoints("http://qdrant", "al-workspace", body, fetchMock),
    ).rejects.toThrow("Qdrant API error (500): unavailable");
  });
});
