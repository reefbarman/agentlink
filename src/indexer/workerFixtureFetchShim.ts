type FixtureObservation =
  | {
      type: "fixtureFetch";
      operation: "embedding";
      attempt: number;
    }
  | {
      type: "fixtureFetch";
      operation: "qdrantDelete";
      pointCount: number;
    };

let embeddingAttempts = 0;

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = { "Content-Type": "application/json" },
): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers,
  });
}

function observe(observation: FixtureObservation): void {
  process.send?.(observation);
}

globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url === "https://api.openai.com/v1/embeddings") {
    embeddingAttempts++;
    observe({
      type: "fixtureFetch",
      operation: "embedding",
      attempt: embeddingAttempts,
    });
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    if (authorization.includes("delay")) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (authorization.includes("retry") && embeddingAttempts === 1) {
      return response(429, "retry");
    }
    const request = JSON.parse(String(init?.body)) as {
      input?: string | string[];
    };
    const inputs = Array.isArray(request.input)
      ? request.input
      : [request.input];
    return response(200, {
      data: inputs.map((_, index) => ({ index, embedding: [0.1] })),
    });
  }

  if (url.includes("fixture-qdrant.invalid")) {
    if (url.endsWith("/points/delete?wait=true") && init?.method === "POST") {
      const request = JSON.parse(String(init.body)) as { points?: string[] };
      observe({
        type: "fixtureFetch",
        operation: "qdrantDelete",
        pointCount: request.points?.length ?? 0,
      });
      if (url.includes("delete-delay")) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (url.includes("delete-failure")) {
        return response(500, "fixture delete failure", {
          "Content-Type": "text/plain",
        });
      }
    }
    if (
      url.includes("partial-failure") &&
      url.endsWith("/points") &&
      init?.method === "PUT"
    ) {
      return response(500, "fixture upsert failure", {
        "Content-Type": "text/plain",
      });
    }
    return response(200, { result: {} });
  }

  throw new Error(
    `Unexpected fixture request: ${init?.method ?? "GET"} ${url}`,
  );
};
