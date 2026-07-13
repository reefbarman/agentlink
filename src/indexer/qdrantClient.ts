export const DEFAULT_QDRANT_URL = "http://localhost:6333";

export interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface QdrantPayloadIndex {
  field_name: string;
  field_schema: string | Record<string, unknown>;
}

export interface EnsureQdrantCollectionOptions {
  qdrantUrl: string;
  collectionName: string;
  vectorSize: number;
  payloadIndexes: QdrantPayloadIndex[];
  fetch?: typeof fetch;
}

export function normalizeQdrantUrl(qdrantUrl: string): string {
  return qdrantUrl.replace(/\/+$/, "");
}

export async function ensureQdrantCollection(
  options: EnsureQdrantCollectionOptions,
): Promise<void> {
  const fetchImpl = options.fetch ?? fetch;
  const collectionUrl = getCollectionUrl(
    options.qdrantUrl,
    options.collectionName,
  );
  const checkResponse = await fetchImpl(collectionUrl);
  if (checkResponse.ok) return;

  const createResponse = await fetchImpl(collectionUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vectors: {
        size: options.vectorSize,
        distance: "Cosine",
        on_disk: true,
      },
      hnsw_config: {
        m: 64,
        ef_construct: 512,
        on_disk: true,
      },
    }),
  });
  if (!createResponse.ok) {
    const error = await createResponse.text();
    throw new Error(
      `Failed to create Qdrant collection ${options.collectionName}: ${error}`,
    );
  }

  for (const index of options.payloadIndexes) {
    await fetchImpl(`${collectionUrl}/index`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(index),
    });
  }
}

export async function deleteQdrantCollection(
  qdrantUrl: string,
  collectionName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await fetchImpl(getCollectionUrl(qdrantUrl, collectionName), {
    method: "DELETE",
  });
}

export async function upsertQdrantPoints(
  qdrantUrl: string,
  collectionName: string,
  points: QdrantPoint[],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(
    `${getCollectionUrl(qdrantUrl, collectionName)}/points?wait=true`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points }),
    },
  );
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Qdrant upsert failed: ${error}`);
  }
}

export async function deleteQdrantPoints(
  qdrantUrl: string,
  collectionName: string,
  pointIds: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(
    `${getCollectionUrl(qdrantUrl, collectionName)}/points/delete?wait=true`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: pointIds }),
    },
  );
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Qdrant delete failed: ${error}`);
  }
}

export async function setQdrantPointVisibility(
  qdrantUrl: string,
  collectionName: string,
  pointIds: string[],
  visible: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (pointIds.length === 0) return;
  const response = await fetchImpl(
    `${getCollectionUrl(qdrantUrl, collectionName)}/points/payload?wait=true`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: { indexVisible: visible },
        points: pointIds,
      }),
    },
  );
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Qdrant visibility update failed: ${error}`);
  }
}

export async function queryQdrantPoints<T>(
  qdrantUrl: string,
  collectionName: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<T[]> {
  let response: Response;
  try {
    response = await fetchImpl(
      `${getCollectionUrl(qdrantUrl, collectionName)}/points/query`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Qdrant is not reachable at ${qdrantUrl}. Ensure Qdrant is running. (${message})`,
    );
  }

  if (!response.ok) {
    const error = await response.text();
    if (response.status === 404) {
      throw new Error(
        `No codebase index found (collection: ${collectionName}).`,
      );
    }
    throw new Error(`Qdrant API error (${response.status}): ${error}`);
  }

  const data = (await response.json()) as { result?: { points?: T[] } };
  return data.result?.points ?? [];
}

function getCollectionUrl(qdrantUrl: string, collectionName: string): string {
  return `${normalizeQdrantUrl(qdrantUrl)}/collections/${collectionName}`;
}
