import { describe, expect, it } from "vitest";
import {
  DomainError,
  assertCanApproveDelivery,
  assertCommentSecond,
  currentVersions,
  deliveryStatus,
  parseRequiredPieces,
  pendingPieces,
  type Campaign,
  type Delivery,
  type PieceKind,
  type Version,
  type VersionStatus,
} from "../src/domain.ts";

const AT = "2026-10-09T12:00:00.000Z";

function campaign(required_pieces: PieceKind[]): Campaign {
  return { id: "cmp_1", name: "Lançamento", required_pieces, created_at: AT };
}

function delivery(signed_off_at: string | null = null): Delivery {
  return { id: "dlv_1", campaign_id: "cmp_1", creator_id: "crt_1", created_at: AT, signed_off_at };
}

let seq = 0;
function version(kind: PieceKind, number: number, status: VersionStatus): Version {
  seq += 1;
  return {
    id: `ver_${seq}`,
    delivery_id: "dlv_1",
    kind,
    number,
    url: `fake://${kind}-v${number}`,
    duration_seconds: kind === "video" ? 30 : null,
    status,
    decision_note: null,
    created_at: AT,
    decided_at: null,
  };
}

describe("peças exigidas vêm da campanha", () => {
  it("a mesma entrega está pronta numa campanha só de vídeo e pendente numa que pede roteiro", () => {
    const versions = [version("video", 1, "approved")];
    expect(pendingPieces(campaign(["video"]), versions)).toEqual([]);
    expect(pendingPieces(campaign(["script", "video"]), versions).map((p) => p.kind)).toEqual(["script"]);
  });

  it("explica por que cada peça exigida está pendente", () => {
    const versions = [version("video", 1, "in_review"), version("cover", 1, "changes_requested")];
    const pending = pendingPieces(campaign(["script", "video", "cover"]), versions);
    expect(pending.map((p) => [p.kind, p.reason])).toEqual([
      ["script", "no_version"],
      ["video", "in_review"],
      ["cover", "changes_requested"],
    ]);
  });

  it("peça não exigida pendente não bloqueia", () => {
    const versions = [version("video", 1, "approved"), version("caption", 1, "in_review")];
    expect(() => assertCanApproveDelivery(campaign(["video"]), versions)).not.toThrow();
  });

  it("recusa aprovar com peça exigida pendente e lista as pendências", () => {
    const versions = [version("video", 1, "approved")];
    const error = captureError(() => assertCanApproveDelivery(campaign(["script", "video", "caption"]), versions));
    expect(error.code).toBe("required_pieces_pending");
    expect(error.message).toContain("script: nenhuma versão enviada");
    expect(error.message).toContain("caption: nenhuma versão enviada");
    expect((error.details.pending as Array<{ kind: string }>).map((p) => p.kind)).toEqual(["script", "caption"]);
  });

  it("valida a lista de peças da campanha", () => {
    expect(parseRequiredPieces(["video", "cover"])).toEqual(["video", "cover"]);
    expect(() => parseRequiredPieces([])).toThrow(DomainError);
    expect(() => parseRequiredPieces(["video", "thumbnail"])).toThrow(/thumbnail/);
    expect(() => parseRequiredPieces(["video", "video"])).toThrow(/repetida/);
  });
});

describe("versão atual", () => {
  it("a versão de maior número substitui a anterior", () => {
    const v1 = version("video", 1, "approved");
    const v2 = version("video", 2, "in_review");
    expect(currentVersions([v2, v1]).get("video")?.id).toBe(v2.id);
  });

  it("status da entrega é recalculado: versão nova depois da assinatura volta a produção", () => {
    const required = campaign(["video"]);
    const signed = delivery(AT);
    const v1 = version("video", 1, "approved");
    expect(deliveryStatus(signed, required, [v1])).toBe("approved");
    const v2 = version("video", 2, "in_review");
    expect(deliveryStatus(signed, required, [v1, v2])).toBe("in_production");
    expect(deliveryStatus(signed, required, [v1, { ...v2, status: "approved" }])).toBe("approved");
  });

  it("todas as peças aprovadas sem assinatura da marca ficam aguardando aprovação", () => {
    expect(deliveryStatus(delivery(), campaign(["video"]), [version("video", 1, "approved")])).toBe(
      "awaiting_approval",
    );
  });
});

describe("segundo do comentário", () => {
  const video = version("video", 1, "in_review");

  it("aceita de 0 até a duração da versão", () => {
    expect(assertCommentSecond(video, 0)).toBe(0);
    expect(assertCommentSecond(video, 30)).toBe(30);
    expect(assertCommentSecond(video, 12.5)).toBe(12.5);
  });

  it("recusa segundo negativo, depois do fim ou que não é número", () => {
    expect(() => assertCommentSecond(video, -1)).toThrow(/entre 0 e 30/);
    expect(() => assertCommentSecond(video, 30.1)).toThrow(/entre 0 e 30/);
    expect(() => assertCommentSecond(video, "10")).toThrow(/número/);
  });

  it("recusa comentário com tempo em peça que não é vídeo", () => {
    expect(() => assertCommentSecond(version("cover", 1, "in_review"), 0)).toThrow(/vídeo/);
  });
});

function captureError(fn: () => void): DomainError {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("esperava DomainError");
}
