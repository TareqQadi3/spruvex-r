import { Module } from "@nestjs/common";

import { IdentityModule } from "../identity/identity.module";
import { SiteApiKeyGuard } from "./site-api-key.guard";
import { SitePublicController } from "./site-public.controller";
import { SitePublicService } from "./site-public.service";

/**
 * Public integration surface for spruvex-site (the marketing site) — today
 * just the trial-signup endpoint. Kept separate from TenancyModule/
 * IdentityModule because its trust boundary is different: a shared API key
 * instead of a user session, and it's the only module whose controllers are
 * meant to be reachable by a caller with no SpruVex account at all.
 */
@Module({
  imports: [IdentityModule],
  controllers: [SitePublicController],
  providers: [SitePublicService, SiteApiKeyGuard],
})
export class SiteIntegrationModule {}
