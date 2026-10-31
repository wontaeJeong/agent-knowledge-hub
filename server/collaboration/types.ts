import type { PoolClient } from "pg";
import type { Context } from "../service";
export type Resource = {
  kind: "page" | "source";
  id: string;
  version?: number;
};
export type Authorizer = (
  db: PoolClient,
  ctx: Context,
  action: string,
  resource?: Resource,
) => Promise<void>;
export interface RecipientProof {
  ctx: Readonly<Context>;
  address: string | null;
  issuer: string;
  subject: string;
  verifiedAt: string;
  validUntil: string;
  /** Current directory/product/session assertion, DB-only, never grants roles. */
  assertCurrent: (db: PoolClient) => Promise<void>;
}
export interface Responsibility {
  ownerId: string | null;
  backupId: string | null;
  revision: string;
}
export interface CollaborationHooks {
  authorize: Authorizer;
  /** Actual configured server dispatch identity; not a forged recipient Context. */
  assertDispatcher: (db: PoolClient) => Promise<void>;
  /** Live directory subject→address binding. Network is allowed ONLY here, outside DB locks. */
  verifyRecipient: (
    identity: Readonly<{ workspaceId: string; principalId: string }>,
    options: { signal: AbortSignal },
  ) => Promise<RecipientProof>;
  /** DB-only business responsibility; absence is explicit, NEVER infer namespace Owner. */
  resolveReviewResponsibility: (
    db: PoolClient,
    input: { workspaceId: string; pageId: string; documentType: string },
  ) => Promise<Responsibility>;
}
export type Cadence = "daily" | "weekly";
export interface Preferences {
  mentions: boolean;
  subscriptions: boolean;
  dailyDigest: boolean;
  weeklyDigest: boolean;
  timezone: string;
  dailyAt: string;
  weeklyAt: string;
  weeklyDay: number;
  quietHours: { enabled: boolean; start: string; end: string };
}
export interface DigestPayload {
  deliveryId: string;
  recipient: {
    principalId: string;
    issuer: string;
    subject: string;
    address: string;
  };
  cadence: Cadence;
  window: { from: string; to: string };
  format: "text/plain";
  subject: string;
  items: { pageId: string; title: string; url: string; eventIds: string[] }[];
}
export interface DeliveryReceipt {
  deliveryId: string;
  receiptId: string;
  status: "accepted" | "delivered";
}
export interface DigestGateway {
  /** finalize MUST execute immediately before request creation; null means zero bytes sent. */
  send(input: {
    deliveryId: string;
    signal: AbortSignal;
    finalize: () => Promise<DigestPayload | null>;
  }): Promise<DeliveryReceipt | null>;
  status(input: {
    deliveryId: string;
    signal: AbortSignal;
  }): Promise<DeliveryReceipt | null>;
}
export interface DeliveryLease {
  id: string;
  workerId: string;
  fence: number;
}
