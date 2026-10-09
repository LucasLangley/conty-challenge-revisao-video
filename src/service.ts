import type { Clock } from "./clock.ts";
import {
  DomainError,
  assertCanApproveDelivery,
  assertCommentSecond,
  assertDecidable,
  currentVersions,
  deliveryStatus,
  isPayable,
  isPieceKind,
  nextVersionNumber,
  parseDuration,
  parseRequiredPieces,
  pendingPieces,
  PIECE_KINDS,
  type Campaign,
  type Comment,
  type Delivery,
  type DeliveryEventType,
  type DeliveryStatus,
  type PieceKind,
  type Version,
  type VersionStatus,
} from "./domain.ts";
import type { Repository } from "./store.ts";

export type DeliveryView = {
  delivery: Delivery;
  campaign: Campaign;
  status: DeliveryStatus;
  payable: boolean;
  pending: ReturnType<typeof pendingPieces>;
  pieces: Array<{ kind: PieceKind; required: boolean; current_version: Version | null; version_ids: string[] }>;
  events: ReturnType<Repository["eventsOf"]>;
};

export type VersionView = { version: Version; is_current: boolean; comments: Comment[] };

export class ReviewService {
  constructor(
    private readonly repo: Repository,
    private readonly clock: Clock,
  ) {}

  createCampaign(input: { name?: unknown; required_pieces?: unknown }): Campaign {
    const campaign: Campaign = {
      id: this.repo.nextId("cmp"),
      name: requiredText(input.name, "name"),
      required_pieces: parseRequiredPieces(input.required_pieces),
      created_at: this.now(),
    };
    this.repo.saveCampaign(campaign);
    return campaign;
  }

  createDelivery(input: { campaign_id?: unknown; creator_id?: unknown }): DeliveryView {
    const campaignId = requiredText(input.campaign_id, "campaign_id");
    if (!this.repo.findCampaign(campaignId)) throw new DomainError("not_found", "campanha não encontrada");
    const delivery: Delivery = {
      id: this.repo.nextId("dlv"),
      campaign_id: campaignId,
      creator_id: requiredText(input.creator_id, "creator_id"),
      created_at: this.now(),
      signed_off_at: null,
    };
    this.repo.saveDelivery(delivery);
    return this.getDelivery(delivery.id);
  }

  submitVersion(deliveryId: string, kind: string, input: { url?: unknown; duration_seconds?: unknown }): VersionView {
    if (!isPieceKind(kind)) {
      throw new DomainError("invalid", `peça desconhecida: ${kind}`, { allowed: PIECE_KINDS });
    }
    const { delivery, campaign, versions } = this.loadDelivery(deliveryId);
    const before = deliveryStatus(delivery, campaign, versions);
    const previous = currentVersions(versions).get(kind) ?? null;

    const version: Version = {
      id: this.repo.nextId("ver"),
      delivery_id: delivery.id,
      kind,
      number: nextVersionNumber(versions, kind),
      url: requiredText(input.url, "url"),
      duration_seconds: parseDuration(kind, input.duration_seconds),
      status: "in_review",
      decision_note: null,
      created_at: this.now(),
      decided_at: null,
    };
    this.repo.saveVersion(version);
    this.record(delivery.id, "version.submitted", {
      version_id: version.id,
      kind,
      number: version.number,
      replaces_version_id: previous?.id ?? null,
    });

    const after = deliveryStatus(delivery, campaign, [...versions, version]);
    // A aprovação vale para a versão atual de cada peça: versão nova numa peça exigida
    // tira a entrega de "approved" até essa versão ser aprovada.
    if (before === "approved" && after !== "approved") {
      this.record(delivery.id, "delivery.approval_revoked", {
        kind,
        previous_version_id: previous?.id ?? null,
        new_version_id: version.id,
        reason: `versão ${version.number} de ${kind} enviada depois da aprovação`,
      });
    }
    return this.getVersion(version.id);
  }

  approveVersion(versionId: string): VersionView {
    return this.decide(versionId, "approved", null);
  }

  requestChanges(versionId: string, input: { note?: unknown }): VersionView {
    const note = typeof input.note === "string" && input.note.trim() ? input.note.trim() : null;
    return this.decide(versionId, "changes_requested", note);
  }

  addComment(versionId: string, input: { at_second?: unknown; body?: unknown }): Comment {
    const version = this.repo.findVersion(versionId);
    if (!version) throw new DomainError("not_found", "versão não encontrada");
    const comment: Comment = {
      id: this.repo.nextId("cmt"),
      version_id: version.id,
      at_second: assertCommentSecond(version, input.at_second),
      body: requiredText(input.body, "body"),
      created_at: this.now(),
    };
    this.repo.saveComment(comment);
    return comment;
  }

  getVersion(versionId: string): VersionView {
    const version = this.repo.findVersion(versionId);
    if (!version) throw new DomainError("not_found", "versão não encontrada");
    const current = currentVersions(this.repo.versionsOf(version.delivery_id)).get(version.kind);
    return { version, is_current: current?.id === version.id, comments: this.repo.commentsOf(version.id) };
  }

  approveDelivery(deliveryId: string): DeliveryView {
    const { delivery, campaign, versions } = this.loadDelivery(deliveryId);
    assertCanApproveDelivery(campaign, versions);
    if (!delivery.signed_off_at) {
      delivery.signed_off_at = this.now();
      this.repo.saveDelivery(delivery);
      this.record(delivery.id, "delivery.approved", {
        version_ids: Object.fromEntries([...currentVersions(versions)].map(([kind, v]) => [kind, v.id])),
      });
    }
    return this.getDelivery(delivery.id);
  }

  getDelivery(deliveryId: string): DeliveryView {
    const { delivery, campaign, versions } = this.loadDelivery(deliveryId);
    const current = currentVersions(versions);
    const status = deliveryStatus(delivery, campaign, versions);
    const kinds = PIECE_KINDS.filter((kind) => campaign.required_pieces.includes(kind) || current.has(kind));
    return {
      delivery,
      campaign,
      status,
      payable: isPayable(status),
      pending: pendingPieces(campaign, versions),
      pieces: kinds.map((kind) => ({
        kind,
        required: campaign.required_pieces.includes(kind),
        current_version: current.get(kind) ?? null,
        version_ids: versions
          .filter((v) => v.kind === kind)
          .sort((a, b) => a.number - b.number)
          .map((v) => v.id),
      })),
      events: this.repo.eventsOf(delivery.id),
    };
  }

  private decide(versionId: string, status: VersionStatus, note: string | null): VersionView {
    const version = this.repo.findVersion(versionId);
    if (!version) throw new DomainError("not_found", "versão não encontrada");
    const { delivery, campaign, versions } = this.loadDelivery(version.delivery_id);
    assertDecidable(version, versions);
    const before = deliveryStatus(delivery, campaign, versions);

    version.status = status;
    version.decision_note = note;
    version.decided_at = this.now();
    this.repo.saveVersion(version);
    this.record(delivery.id, status === "approved" ? "version.approved" : "version.changes_requested", {
      version_id: version.id,
      kind: version.kind,
      number: version.number,
      note,
    });

    const after = deliveryStatus(delivery, campaign, this.repo.versionsOf(delivery.id));
    if (before !== "approved" && after === "approved") {
      this.record(delivery.id, "delivery.approval_restored", { version_id: version.id, kind: version.kind });
    }
    return this.getVersion(version.id);
  }

  private loadDelivery(deliveryId: string): { delivery: Delivery; campaign: Campaign; versions: Version[] } {
    const delivery = this.repo.findDelivery(deliveryId);
    if (!delivery) throw new DomainError("not_found", "entrega não encontrada");
    const campaign = this.repo.findCampaign(delivery.campaign_id);
    if (!campaign) throw new DomainError("not_found", "campanha da entrega não encontrada");
    return { delivery, campaign, versions: this.repo.versionsOf(delivery.id) };
  }

  private record(deliveryId: string, type: DeliveryEventType, data: Record<string, unknown>): void {
    this.repo.appendEvent({ id: this.repo.nextId("evt"), delivery_id: deliveryId, type, at: this.now(), data });
  }

  private now(): string {
    return this.clock.now().toISOString();
  }
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new DomainError("invalid", `${field} é obrigatório`);
  return value.trim();
}
