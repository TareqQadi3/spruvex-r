import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import type { Request } from "express";

const API_KEY_HEADER = "x-spruvex-site-key";

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Different lengths would short-circuit timingSafeEqual — compare against
  // a same-length dummy first so the response time never leaks the length.
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Authenticates server-to-server calls from the spruvex-site marketing site
 * (no end-user session exists yet at that point — this IS the entry point
 * that creates one). A single shared secret, sent as `x-spruvex-site-key`,
 * distinct from tenant JWTs and the platform-admin JWT: this guard grants no
 * tenant/user identity, only "caller is the trusted marketing site."
 *
 * Modeled on PlatformAdminGuard (separate auth universe from tenant RBAC) —
 * routes here are @Public() so PermissionsGuard doesn't also demand a
 * permission grant, and rely solely on this guard.
 */
@Injectable()
export class SiteApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.SPRUVEX_SITE_API_KEY;
    if (!expected) {
      // Fails closed: a misconfigured deployment must not silently accept any key.
      throw new UnauthorizedException("Site integration is not configured");
    }

    const req = context.switchToHttp().getRequest<Request>();
    const provided = req.headers[API_KEY_HEADER];
    if (typeof provided !== "string" || !timingSafeStringEqual(provided, expected)) {
      throw new UnauthorizedException("Invalid or missing site API key");
    }

    return true;
  }
}
