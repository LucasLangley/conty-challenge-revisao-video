import type { Campaign, Comment, Delivery, DeliveryEvent, Version } from "./domain.ts";

export interface Repository {
  nextId(prefix: string): string;
  saveCampaign(campaign: Campaign): void;
  findCampaign(id: string): Campaign | undefined;
  saveDelivery(delivery: Delivery): void;
  findDelivery(id: string): Delivery | undefined;
  saveVersion(version: Version): void;
  findVersion(id: string): Version | undefined;
  versionsOf(deliveryId: string): Version[];
  saveComment(comment: Comment): void;
  commentsOf(versionId: string): Comment[];
  appendEvent(event: DeliveryEvent): void;
  eventsOf(deliveryId: string): DeliveryEvent[];
}

export class InMemoryRepository implements Repository {
  private counters = new Map<string, number>();
  private campaigns = new Map<string, Campaign>();
  private deliveries = new Map<string, Delivery>();
  private versions = new Map<string, Version>();
  private comments = new Map<string, Comment>();
  private events: DeliveryEvent[] = [];

  nextId(prefix: string): string {
    const next = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, next);
    return `${prefix}_${next}`;
  }

  saveCampaign(campaign: Campaign): void {
    this.campaigns.set(campaign.id, structuredClone(campaign));
  }

  findCampaign(id: string): Campaign | undefined {
    return copy(this.campaigns.get(id));
  }

  saveDelivery(delivery: Delivery): void {
    this.deliveries.set(delivery.id, structuredClone(delivery));
  }

  findDelivery(id: string): Delivery | undefined {
    return copy(this.deliveries.get(id));
  }

  saveVersion(version: Version): void {
    this.versions.set(version.id, structuredClone(version));
  }

  findVersion(id: string): Version | undefined {
    return copy(this.versions.get(id));
  }

  versionsOf(deliveryId: string): Version[] {
    return [...this.versions.values()]
      .filter((v) => v.delivery_id === deliveryId)
      .map((v) => structuredClone(v));
  }

  saveComment(comment: Comment): void {
    this.comments.set(comment.id, structuredClone(comment));
  }

  commentsOf(versionId: string): Comment[] {
    return [...this.comments.values()]
      .filter((c) => c.version_id === versionId)
      .sort((a, b) => a.at_second - b.at_second)
      .map((c) => structuredClone(c));
  }

  appendEvent(event: DeliveryEvent): void {
    this.events.push(structuredClone(event));
  }

  eventsOf(deliveryId: string): DeliveryEvent[] {
    return this.events.filter((e) => e.delivery_id === deliveryId).map((e) => structuredClone(e));
  }
}

function copy<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}
