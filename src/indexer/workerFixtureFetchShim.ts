interface FixtureObservation {
  type: "fixtureFetch";
  operation: "embedding";
  attempt: number;
  phase: "start" | "complete";
  activeRequests: number;
  firstInput?: string;
}

let embeddingAttempts = 0;
let activeEmbeddingRequests = 0;

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
  if (url !== "https://api.openai.com/v1/embeddings") {
    throw new Error(
      `Unexpected fixture request: ${init?.method ?? "GET"} ${url}`,
    );
  }

  const attempt = ++embeddingAttempts;
  const authorization = new Headers(init?.headers).get("authorization") ?? "";
  const request = JSON.parse(String(init?.body)) as {
    input?: string | string[];
  };
  const inputs = Array.isArray(request.input) ? request.input : [request.input];
  activeEmbeddingRequests++;
  observe({
    type: "fixtureFetch",
    operation: "embedding",
    attempt,
    phase: "start",
    activeRequests: activeEmbeddingRequests,
    firstInput: inputs[0],
  });
  try {
    if (authorization.includes("rolling")) {
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          inputs.some((value) => value?.includes("SLOW_EMBEDDING")) ? 250 : 25,
        ),
      );
    } else if (authorization.includes("delay")) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (authorization.includes("retry") && attempt === 1) {
      return response(429, "retry", {
        "Content-Type": "text/plain",
        "Retry-After": "0",
      });
    }
    if (
      authorization.includes("partial-embedding") &&
      inputs.some((value) => value?.includes("FAIL_PARTIAL_EMBEDDING"))
    ) {
      return response(422, "fixture partial embedding failure", {
        "Content-Type": "text/plain",
      });
    }
    return response(200, {
      data: inputs.map((value, index) => {
        const marker = /EMBEDDING_ORDER_(\d+)/.exec(value ?? "");
        const vectorHead = marker ? Number(marker[1]) : 0.1;
        return {
          index,
          embedding:
            authorization.includes("invalid-embedding") &&
            value?.includes("INVALID_EMBEDDING")
              ? Array.from({ length: 1536 }, (_, dimension) =>
                  dimension === 0 ? Number.NaN : 0,
                )
              : Array.from({ length: 1536 }, (_, dimension) =>
                  dimension === 0 ? vectorHead : 0,
                ),
        };
      }),
    });
  } finally {
    activeEmbeddingRequests--;
    observe({
      type: "fixtureFetch",
      operation: "embedding",
      attempt,
      phase: "complete",
      activeRequests: activeEmbeddingRequests,
      firstInput: inputs[0],
    });
  }
};
