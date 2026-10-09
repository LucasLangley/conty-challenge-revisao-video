export const PIECE_KINDS = ["script", "video", "cover", "caption"] as const;
export type PieceKind = (typeof PIECE_KINDS)[number];

export type VersionStatus = "in_review" | "approved" | "changes_requested";
export type DeliveryStatus = "in_production" | "awaiting_approval" | "approved";

export type Campaign = {
  id: string;
  name: string;
  required_pieces: PieceKind[];
  created_at: string;
};

export type Delivery = {
  id: string;
  campaign_id: string;
  creator_id: string;
  created_at: string;
  // Momento em que a marca assinou a entrega. Sozinho não diz que a entrega está
  // aprovada: o status é sempre recalculado a partir da versão atual de cada peça.
  signed_off_at: string | null;
};

export type Version = {
  id: string;
  delivery_id: string;
  kind: PieceKind;
  number: number;
  url: string;
  duration_seconds: number | null;
  status: VersionStatus;
  decision_note: string | null;
  created_at: string;
  decided_at: string | null;
};

export type Comment = {
  id: string;
  version_id: string;
  at_second: number;
  body: string;
  created_at: string;
};

export type DeliveryEventType =
  | "version.submitted"
  | "version.approved"
  | "version.changes_requested"
  | "delivery.approved"
  | "delivery.approval_revoked"
  | "delivery.approval_restored";

export type DeliveryEvent = {
  id: string;
  delivery_id: string;
  type: DeliveryEventType;
  at: string;
  data: Record<string, unknown>;
};

export type PendingReason = "no_version" | "in_review" | "changes_requested";

export type PendingPiece = {
  kind: PieceKind;
  reason: PendingReason;
  version_id: string | null;
  message: string;
};

export type ErrorCode = "invalid" | "not_found" | "conflict" | "required_pieces_pending";

export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function isPieceKind(value: unknown): value is PieceKind {
  return typeof value === "string" && (PIECE_KINDS as readonly string[]).includes(value);
}

export function parseRequiredPieces(value: unknown): PieceKind[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new DomainError("invalid", "required_pieces precisa ser uma lista não vazia de peças");
  }
  const invalid = value.filter((kind) => !isPieceKind(kind));
  if (invalid.length > 0) {
    throw new DomainError("invalid", `peça desconhecida: ${invalid.join(", ")}`, { allowed: PIECE_KINDS });
  }
  if (new Set(value).size !== value.length) {
    throw new DomainError("invalid", "required_pieces tem peça repetida");
  }
  return value as PieceKind[];
}

// A versão atual de uma peça é sempre a de maior número; as anteriores ficam como histórico.
export function currentVersions(versions: Version[]): Map<PieceKind, Version> {
  const current = new Map<PieceKind, Version>();
  for (const version of versions) {
    const seen = current.get(version.kind);
    if (!seen || version.number > seen.number) current.set(version.kind, version);
  }
  return current;
}

export function nextVersionNumber(versions: Version[], kind: PieceKind): number {
  return versions.filter((v) => v.kind === kind).reduce((max, v) => Math.max(max, v.number), 0) + 1;
}

// Só as peças que a campanha exige entram aqui; peça extra nunca bloqueia.
export function pendingPieces(campaign: Campaign, versions: Version[]): PendingPiece[] {
  const current = currentVersions(versions);
  const pending: PendingPiece[] = [];
  for (const kind of campaign.required_pieces) {
    const version = current.get(kind);
    if (!version) {
      pending.push({ kind, reason: "no_version", version_id: null, message: `${kind}: nenhuma versão enviada` });
    } else if (version.status === "in_review") {
      pending.push({
        kind,
        reason: "in_review",
        version_id: version.id,
        message: `${kind}: versão ${version.number} ainda em revisão`,
      });
    } else if (version.status === "changes_requested") {
      pending.push({
        kind,
        reason: "changes_requested",
        version_id: version.id,
        message: `${kind}: versão ${version.number} com ajustes pedidos`,
      });
    }
  }
  return pending;
}

export function deliveryStatus(delivery: Delivery, campaign: Campaign, versions: Version[]): DeliveryStatus {
  if (pendingPieces(campaign, versions).length > 0) return "in_production";
  return delivery.signed_off_at ? "approved" : "awaiting_approval";
}

export function isPayable(status: DeliveryStatus): boolean {
  return status === "approved";
}

export function assertCanApproveDelivery(campaign: Campaign, versions: Version[]): void {
  const pending = pendingPieces(campaign, versions);
  if (pending.length === 0) return;
  throw new DomainError(
    "required_pieces_pending",
    `a entrega não pode ser aprovada: ${pending.map((p) => p.message).join("; ")}`,
    { pending },
  );
}

// Só a versão atual e ainda em revisão recebe decisão: decidir uma versão substituída
// ou mudar de ideia sobre uma já decidida exigiria uma versão nova.
export function assertDecidable(version: Version, siblings: Version[]): void {
  const current = currentVersions(siblings).get(version.kind);
  if (current && current.id !== version.id) {
    throw new DomainError("conflict", `versão ${version.number} foi substituída pela versão ${current.number}`, {
      current_version_id: current.id,
    });
  }
  if (version.status !== "in_review") {
    throw new DomainError("conflict", `versão ${version.number} já foi decidida (${version.status})`);
  }
}

export function parseDuration(kind: PieceKind, value: unknown): number | null {
  if (kind !== "video") {
    if (value !== undefined && value !== null) {
      throw new DomainError("invalid", "duration_seconds só vale para versão de vídeo");
    }
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new DomainError("invalid", "versão de vídeo precisa de duration_seconds maior que zero");
  }
  return value;
}

export function assertCommentSecond(version: Version, atSecond: unknown): number {
  if (version.duration_seconds === null) {
    throw new DomainError("invalid", "comentário com tempo só existe em versão de vídeo");
  }
  if (typeof atSecond !== "number" || !Number.isFinite(atSecond)) {
    throw new DomainError("invalid", "at_second precisa ser um número");
  }
  if (atSecond < 0 || atSecond > version.duration_seconds) {
    throw new DomainError(
      "invalid",
      `at_second precisa estar entre 0 e ${version.duration_seconds} (duração da versão ${version.number})`,
    );
  }
  return atSecond;
}
