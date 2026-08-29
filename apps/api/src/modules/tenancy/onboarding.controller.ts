import { Body, Controller, Get, HttpCode, Post } from "@nestjs/common";

import { RequireAuthenticated } from "../../shared/rbac/require-authenticated.decorator";
import { RequirePermission } from "../../shared/rbac/require-permission.decorator";
import {
  CreateBranchDto,
  CreateRestaurantDto,
  CreateStaffDto,
  MarkSetupStepDto,
} from "./dto/onboarding.dto";
import { OnboardingService } from "./onboarding.service";

@Controller("onboarding")
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @RequireAuthenticated()
  @Get("status")
  status() {
    return this.onboarding.status();
  }

  /** Step 2 — the user is authenticated but has no tenant yet. */
  @RequireAuthenticated()
  @Post("restaurant")
  createRestaurant(@Body() dto: CreateRestaurantDto) {
    return this.onboarding.createRestaurant(dto);
  }

  /** Step 3 — from here on the owner token carries tenant permissions. */
  @RequirePermission("branches.manage")
  @Post("branch")
  createBranch(@Body() dto: CreateBranchDto) {
    return this.onboarding.createBranch(dto);
  }

  /** Step 4. */
  @RequirePermission("users.manage")
  @Post("staff")
  createStaff(@Body() dto: CreateStaffDto) {
    return this.onboarding.createStaff(dto.users);
  }

  /** Step 5. */
  @RequirePermission("tenant.settings.manage")
  @HttpCode(200)
  @Post("complete")
  complete() {
    return this.onboarding.complete();
  }

  /** Drives the dashboard's "missing setup" reminder banner. */
  @RequirePermission("tenant.settings.manage")
  @Get("setup-status")
  setupStatus() {
    return this.onboarding.getSetupStatus();
  }

  @RequirePermission("tenant.settings.manage")
  @HttpCode(200)
  @Post("setup-status")
  markSetupStep(@Body() dto: MarkSetupStepDto) {
    return this.onboarding.markSetupStep(dto.step, dto.status);
  }
}
