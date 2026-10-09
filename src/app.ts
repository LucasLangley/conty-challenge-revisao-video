import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { systemClock, type Clock } from "./clock.ts";
import { DomainError, type ErrorCode } from "./domain.ts";
import { ReviewService } from "./service.ts";
import { InMemoryRepository, type Repository } from "./store.ts";

const STATUS_BY_CODE: Record<ErrorCode, ContentfulStatusCode> = {
  invalid: 422,
  not_found: 404,
  conflict: 409,
  required_pieces_pending: 409,
};

async function body(c: Context): Promise<Record<string, unknown>> {
  const parsed = await c.req.json().catch(() => null);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DomainError("invalid", "corpo precisa ser um objeto JSON");
  }
  return parsed as Record<string, unknown>;
}

export function createApp(deps: { repo?: Repository; clock?: Clock } = {}) {
  const service = new ReviewService(deps.repo ?? new InMemoryRepository(), deps.clock ?? systemClock);
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof DomainError) {
      return c.json({ error: err.message, code: err.code, ...err.details }, STATUS_BY_CODE[err.code]);
    }
    console.error(err);
    return c.json({ error: "erro interno" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/campaigns", async (c) => c.json(service.createCampaign(await body(c)), 201));

  app.post("/deliveries", async (c) => c.json(service.createDelivery(await body(c)), 201));

  app.get("/deliveries/:id", (c) => c.json(service.getDelivery(c.req.param("id"))));

  app.post("/deliveries/:id/approve", (c) => c.json(service.approveDelivery(c.req.param("id"))));

  app.post("/deliveries/:id/pieces/:kind/versions", async (c) =>
    c.json(service.submitVersion(c.req.param("id"), c.req.param("kind"), await body(c)), 201),
  );

  app.get("/versions/:id", (c) => c.json(service.getVersion(c.req.param("id"))));

  app.post("/versions/:id/approve", (c) => c.json(service.approveVersion(c.req.param("id"))));

  app.post("/versions/:id/request-changes", async (c) => {
    const input = await c.req.json().catch(() => ({}));
    return c.json(service.requestChanges(c.req.param("id"), (input ?? {}) as Record<string, unknown>));
  });

  app.post("/versions/:id/comments", async (c) =>
    c.json(service.addComment(c.req.param("id"), await body(c)), 201),
  );

  return app;
}
