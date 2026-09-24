/** Authenticated Connection fetch adapter; no parallel HTTP listener is created. */
import type { ConnectionFetchRoute } from "@deepseek-ai/dsh-client-connection";
import { PlannerEngine, PlannerError } from "./engine.ts";

/** Build the exact API route. @param engine Queued planner owner. @param report Unexpected-error logger. @returns Buffered authenticated route definition. */
export function plannerRoute(
  engine: PlannerEngine,
  report: (error: unknown) => void,
): ConnectionFetchRoute {
  return {
    path: "/api/dsh-daily-planner",
    methods: ["GET", "POST"],
    requestBody: "buffered",
    async fetch(request) {
      try {
        if (request.method === "GET") return json(await engine.read());
        if (request.method !== "POST")
          throw new PlannerError(
            "invalid-request",
            "Unsupported planner request.",
          );
        const mediaType = request.headers
          .get("content-type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase();
        if (mediaType !== "application/json")
          throw new PlannerError(
            "invalid-request",
            "The request body must be JSON.",
          );
        const input = await readJson(request);
        return json(await engine.mutate(input));
      } catch (error) {
        if (error instanceof PlannerError)
          return json(
            { error: { code: error.code, message: error.message } },
            error.status,
          );
        report(error);
        return json(
          {
            error: {
              code: "internal-error",
              message:
                "The planner could not save or read its data. Try again.",
            },
          },
          500,
        );
      }
    },
  };
}
/** Planner commands may contain at most 64 KiB of encoded JSON. */
const requestByteLimit = 64 * 1024;
async function readJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader)
    throw new PlannerError("invalid-request", "The request body is required.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > requestByteLimit) {
        await reader.cancel();
        throw new PlannerError(
          "invalid-request",
          "The planner request exceeds 64 KiB.",
        );
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch (error) {
    throw new PlannerError(
      "invalid-request",
      "The request body is not valid JSON.",
    );
  }
}
function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
