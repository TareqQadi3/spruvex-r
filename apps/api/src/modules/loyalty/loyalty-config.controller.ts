import { Body, Controller, Delete, Get, Param, Put, Query } from "@nestjs/common";

import { RequirePermission } from "../../shared/rbac/require-permission.decorator";
import { UpsertLoyaltyConfigDto } from "./dto/loyalty-config.dto";
import { LoyaltyConfigService } from "./loyalty-config.service";

@Controller("loyalty/configs")
export class LoyaltyConfigController {
  constructor(private readonly config: LoyaltyConfigService) {}

  @RequirePermission("loyalty.manage")
  @Get()
  list(@Query("branchId") branchId?: string) {
    return branchId ? this.config.listForBranch(branchId) : this.config.list();
  }

  @RequirePermission("loyalty.manage")
  @Put(":type")
  upsert(@Param("type") type: string, @Body() dto: UpsertLoyaltyConfigDto) {
    return this.config.upsert(type, dto);
  }

  @RequirePermission("loyalty.manage")
  @Delete(":type")
  removeOverride(@Param("type") type: string, @Query("branchId") branchId: string) {
    return this.config.removeBranchOverride(type, branchId);
  }
}
