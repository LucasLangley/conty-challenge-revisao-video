import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import type { Clock } from "../src/clock.ts";

type App = ReturnType<typeof createApp>;
type Json = Record<string, any>;

class FixedClock implements Clock {
  constructor(private current = new Date("2026-10-09T12:00:00.000Z")) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}

let app: App;
let clock: FixedClock;

beforeEach(() => {
  clock = new FixedClock();
  app = createApp({ clock });
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await app.request(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Json };
}

async function newDelivery(required_pieces: string[]): Promise<string> {
  const campaign = await call("POST", "/campaigns", { name: "Lançamento", required_pieces });
  expect(campaign.status).toBe(201);
  const delivery = await call("POST", "/deliveries", { campaign_id: campaign.json.id, creator_id: "crt_1" });
  expect(delivery.status).toBe(201);
  return delivery.json.delivery.id;
}

async function submit(deliveryId: string, kind: string, extra: Json = {}): Promise<string> {
  const body = kind === "video" ? { url: `fake://${kind}.mp4`, duration_seconds: 45, ...extra } : { url: `fake://${kind}`, ...extra };
  const res = await call("POST", `/deliveries/${deliveryId}/pieces/${kind}/versions`, body);
  expect(res.status).toBe(201);
  return res.json.version.id;
}

async function approve(versionId: string): Promise<void> {
  expect((await call("POST", `/versions/${versionId}/approve`)).status).toBe(200);
}

function eventTypes(view: Json): string[] {
  return view.events.map((e: Json) => e.type);
}

describe("aprovar a entrega exige cada peça da campanha", () => {
  it("recusa com 409 e lista quais peças faltam e por quê", async () => {
    const id = await newDelivery(["script", "video", "cover", "caption"]);
    await approve(await submit(id, "script"));
    const video = await submit(id, "video");
    await approve(video);
    const cover = await submit(id, "cover");
    await call("POST", `/versions/${cover}/request-changes`, { note: "logo cortado" });

    const res = await call("POST", `/deliveries/${id}/approve`);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("required_pieces_pending");
    expect(res.json.error).toBe(
      "a entrega não pode ser aprovada: cover: versão 1 com ajustes pedidos; caption: nenhuma versão enviada",
    );
    expect(res.json.pending).toEqual([
      { kind: "cover", reason: "changes_requested", version_id: cover, message: "cover: versão 1 com ajustes pedidos" },
      { kind: "caption", reason: "no_version", version_id: null, message: "caption: nenhuma versão enviada" },
    ]);

    const view = (await call("GET", `/deliveries/${id}`)).json;
    expect(view.status).toBe("in_production");
    expect(view.payable).toBe(false);
  });

  it("vídeo aprovado sozinho não libera pagamento quando a campanha também pede capa", async () => {
    const id = await newDelivery(["video", "cover"]);
    await approve(await submit(id, "video"));
    expect((await call("POST", `/deliveries/${id}/approve`)).status).toBe(409);
    expect((await call("GET", `/deliveries/${id}`)).json.payable).toBe(false);
  });

  it("campanha só de vídeo não exige roteiro e peça extra pendente não bloqueia", async () => {
    const id = await newDelivery(["video"]);
    await approve(await submit(id, "video"));
    await submit(id, "script");

    const res = await call("POST", `/deliveries/${id}/approve`);
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("approved");
    expect(res.json.payable).toBe(true);
    expect(res.json.pending).toEqual([]);
    expect(res.json.pieces.map((p: Json) => [p.kind, p.required])).toEqual([
      ["script", false],
      ["video", true],
    ]);
  });

  it("a lista de peças é dado da campanha: o mesmo envio vale numa campanha e não na outra", async () => {
    const videoOnly = await newDelivery(["video"]);
    const videoAndCaption = await newDelivery(["video", "caption"]);
    for (const id of [videoOnly, videoAndCaption]) await approve(await submit(id, "video"));

    expect((await call("POST", `/deliveries/${videoOnly}/approve`)).status).toBe(200);
    const blocked = await call("POST", `/deliveries/${videoAndCaption}/approve`);
    expect(blocked.status).toBe(409);
    expect(blocked.json.pending.map((p: Json) => p.kind)).toEqual(["caption"]);
  });

  it("valida a campanha", async () => {
    const res = await call("POST", "/campaigns", { name: "X", required_pieces: ["video", "reel"] });
    expect(res.status).toBe(422);
    expect(res.json.error).toBe("peça desconhecida: reel");
  });
});

describe("versão nova substitui a anterior", () => {
  it("numera as versões, aponta a atual e recusa decidir a substituída", async () => {
    const id = await newDelivery(["video"]);
    const v1 = await submit(id, "video");
    await call("POST", `/versions/${v1}/request-changes`, { note: "áudio baixo" });
    const v2 = await submit(id, "video");

    const second = (await call("GET", `/versions/${v2}`)).json;
    expect(second.version.number).toBe(2);
    expect(second.is_current).toBe(true);
    expect((await call("GET", `/versions/${v1}`)).json.is_current).toBe(false);

    const late = await call("POST", `/versions/${v1}/approve`);
    expect(late.status).toBe(409);
    expect(late.json.error).toBe("versão 1 foi substituída pela versão 2");

    const view = (await call("GET", `/deliveries/${id}`)).json;
    expect(view.pieces[0].current_version.id).toBe(v2);
    expect(view.pieces[0].version_ids).toEqual([v1, v2]);
    expect(view.pending[0].reason).toBe("in_review");
  });

  it("não deixa mudar a decisão de uma versão já decidida", async () => {
    const id = await newDelivery(["video"]);
    const v1 = await submit(id, "video");
    await approve(v1);
    const res = await call("POST", `/versions/${v1}/request-changes`, { note: "mudei de ideia" });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("versão 1 já foi decidida (approved)");
  });
});

describe("versão nova numa entrega aprovada", () => {
  it("revoga a aprovação, registra o evento e só volta quando a versão nova é aprovada", async () => {
    const id = await newDelivery(["video", "cover"]);
    const video1 = await submit(id, "video");
    await approve(video1);
    await approve(await submit(id, "cover"));
    expect((await call("POST", `/deliveries/${id}/approve`)).json.status).toBe("approved");

    clock.advance(60);
    const video2 = await submit(id, "video");
    let view = (await call("GET", `/deliveries/${id}`)).json;
    expect(view.status).toBe("in_production");
    expect(view.payable).toBe(false);
    expect(view.pending).toEqual([
      { kind: "video", reason: "in_review", version_id: video2, message: "video: versão 2 ainda em revisão" },
    ]);
    const revoked = view.events.find((e: Json) => e.type === "delivery.approval_revoked");
    expect(revoked).toMatchObject({
      at: "2026-10-09T12:01:00.000Z",
      data: { kind: "video", previous_version_id: video1, new_version_id: video2 },
    });

    expect((await call("POST", `/deliveries/${id}/approve`)).status).toBe(409);

    await approve(video2);
    view = (await call("GET", `/deliveries/${id}`)).json;
    expect(view.status).toBe("approved");
    expect(view.payable).toBe(true);
    expect(eventTypes(view).slice(-2)).toEqual(["version.approved", "delivery.approval_restored"]);
  });

  it("ajuste pedido na versão nova mantém a entrega fora de aprovada", async () => {
    const id = await newDelivery(["video"]);
    await approve(await submit(id, "video"));
    await call("POST", `/deliveries/${id}/approve`);
    const v2 = await submit(id, "video");
    await call("POST", `/versions/${v2}/request-changes`, { note: "corte errado" });

    const view = (await call("GET", `/deliveries/${id}`)).json;
    expect(view.status).toBe("in_production");
    expect(view.pending[0]).toMatchObject({ kind: "video", reason: "changes_requested" });
    expect(eventTypes(view)).not.toContain("delivery.approval_restored");
  });

  it("versão nova numa peça que a campanha não pediu não revoga", async () => {
    const id = await newDelivery(["video"]);
    await approve(await submit(id, "video"));
    await call("POST", `/deliveries/${id}/approve`);
    await submit(id, "caption");

    const view = (await call("GET", `/deliveries/${id}`)).json;
    expect(view.status).toBe("approved");
    expect(eventTypes(view)).not.toContain("delivery.approval_revoked");
  });
});

describe("comentário preso a um segundo da versão", () => {
  it("fica na versão em que foi feito e não migra para a nova", async () => {
    const id = await newDelivery(["video"]);
    const v1 = await submit(id, "video");
    const created = await call("POST", `/versions/${v1}/comments`, { at_second: 12, body: "logo some aqui" });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ version_id: v1, at_second: 12, body: "logo some aqui" });

    const v2 = await submit(id, "video");
    expect((await call("GET", `/versions/${v1}`)).json.comments.map((c: Json) => c.body)).toEqual(["logo some aqui"]);
    expect((await call("GET", `/versions/${v2}`)).json.comments).toEqual([]);
  });

  it("lista os comentários pela ordem do vídeo", async () => {
    const id = await newDelivery(["video"]);
    const v1 = await submit(id, "video");
    await call("POST", `/versions/${v1}/comments`, { at_second: 40, body: "fim" });
    await call("POST", `/versions/${v1}/comments`, { at_second: 0, body: "início" });
    expect((await call("GET", `/versions/${v1}`)).json.comments.map((c: Json) => c.at_second)).toEqual([0, 40]);
  });

  it("aceita o último segundo e recusa fora da duração da versão", async () => {
    const id = await newDelivery(["video"]);
    const v1 = await submit(id, "video", { duration_seconds: 30 });
    expect((await call("POST", `/versions/${v1}/comments`, { at_second: 30, body: "fim" })).status).toBe(201);

    const after = await call("POST", `/versions/${v1}/comments`, { at_second: 31, body: "depois do fim" });
    expect(after.status).toBe(422);
    expect(after.json.error).toBe("at_second precisa estar entre 0 e 30 (duração da versão 1)");
    expect((await call("POST", `/versions/${v1}/comments`, { at_second: -1, body: "antes" })).status).toBe(422);
  });

  it("vídeo sem duração é recusado", async () => {
    const id = await newDelivery(["video"]);
    const res = await call("POST", `/deliveries/${id}/pieces/video/versions`, { url: "fake://v.mp4" });
    expect(res.status).toBe(422);
    expect(res.json.error).toBe("versão de vídeo precisa de duration_seconds maior que zero");
  });
});

describe("erros de rota", () => {
  it("peça desconhecida e recursos inexistentes", async () => {
    const id = await newDelivery(["video"]);
    expect((await call("POST", `/deliveries/${id}/pieces/reel/versions`, { url: "x" })).status).toBe(422);
    expect((await call("GET", "/deliveries/dlv_999")).status).toBe(404);
    expect((await call("POST", "/versions/ver_999/approve")).status).toBe(404);
    expect((await call("POST", "/deliveries", { campaign_id: "cmp_999", creator_id: "c" })).status).toBe(404);
  });
});
