import { Injectable, UnauthorizedException } from "@nestjs/common";
import { AsyncLocalStorage } from "node:async_hooks";

import type { PermissionKey } from "@spruvex-r/types";

/**
 * Per-request context, resolved from the JWT (never from client parameters).
 * Populated by AuthContextMiddleware; tests populate it via `run()`.
 *
 * `tenantId` is absent only during onboarding: a freshly registered owner is
 * authenticated but has no restaurant yet. Everything tenant-scoped throws
 * until a tenant exists in the token.
 */
export interface RequestContext {
  userId: string;
  tenantId?: string;
  branchId?: string;
  permissions: ReadonlySet<PermissionKey | string>;
}

/**
 * Sentinel user id for guest (QR) requests: they run inside a tenant context
 * but have no user account. Persisted actor columns store null instead.
 */
export const GUEST_ACTOR = "00000000-0000-0000-0000-000000000000";

/**
 * Sentinel actor for money a delivery platform or payment gateway collected
 * on the tenant's behalf — never a cashier, never touches a real shift's
 * cash drawer. Also marks Shift.openedBy for the one perpetual "online
 * payments" shift per branch that such payments attach to (see
 * modules/integrations/online-payment.service.ts) instead of requiring a
 * cashier to have a shift open.
 */
export const ONLINE_PAYMENTS_ACTOR = "00000000-0000-0000-0000-000000000002";

/** Maps a sentinel actor to null for created_by/changed_by columns. */
export function actorOrNull(userId: string | undefined): string | null {
  return !userId || userId === GUEST_ACTOR || userId === ONLINE_PAYMENTS_ACTOR ? null : userId;
}

@Injectable()
export class TenantContextService {
  private readonly als = new AsyncLocalStorage<RequestContext>();

  /** Runs `fn` with the given context — the entry point for the auth middleware and tests. */
  run<T>(context: RequestContext, fn: () => T): T {
    return this.als.run(context, fn);
  }

  get context(): RequestContext | undefined {
    return this.als.getStore();
  }

  get contextOrThrow(): RequestContext {
    const ctx = this.context;
    if (!ctx) {
      throw new UnauthorizedException("No tenant context — request is not authenticated");
    }
    return ctx;
  }

  get tenantIdOrThrow(): string {
    const { tenantId } = this.contextOrThrow;
    if (!tenantId) {
      throw new UnauthorizedException("No tenant selected — complete onboarding first");
    }
    return tenantId;
  }
}
