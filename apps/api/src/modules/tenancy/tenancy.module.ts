import { Module } from "@nestjs/common";

import { BusinessHoursModule } from "../../shared/business-hours/business-hours.module";
import { IdentityModule } from "../identity/identity.module";
import { OnboardingController } from "./onboarding.controller";
import { OnboardingService } from "./onboarding.service";
import { TenancyController } from "./tenancy.controller";

/**
 * Tenancy module — tenants, branches, onboarding wizard,
 * dashboard-shell read endpoints.
 */
@Module({
  imports: [IdentityModule, BusinessHoursModule],
  controllers: [OnboardingController, TenancyController],
  providers: [OnboardingService],
})
export class TenancyModule {}
