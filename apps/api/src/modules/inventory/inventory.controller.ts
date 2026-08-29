import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from "@nestjs/common";

import { RequirePermission } from "../../shared/rbac/require-permission.decorator";
import { PrismaService } from "../../shared/prisma/prisma.service";
import {
  CreateIngredientDto,
  UpdateIngredientDto,
} from "./dto/ingredient.dto";
import {
  RecordAdjustmentDto,
  RecordPurchaseDto,
  RecordWasteDto,
} from "./dto/stock-movement.dto";
import {
  CreateStockLocationDto,
  UpdateStockLocationDto,
} from "./dto/stock-location.dto";
import { IngredientsService } from "./ingredients.service";
import { InventoryService } from "./inventory.service";
import { StockLocationsService } from "./stock-locations.service";

@Controller("inventory")
export class InventoryController {
  constructor(
    private readonly ingredients: IngredientsService,
    private readonly locations: StockLocationsService,
    private readonly inventory: InventoryService,
    private readonly prisma: PrismaService,
  ) {}

  /** Global unit-of-measure catalog — read-only, seeded (see units.ts). */
  @RequirePermission("inventory.view")
  @Get("units")
  units() {
    return this.prisma.unitOfMeasure.findMany({ orderBy: [{ type: "asc" }, { toBaseFactor: "asc" }] });
  }

  // --- Ingredients ---

  @RequirePermission("inventory.view")
  @Get("ingredients")
  listIngredients() {
    return this.ingredients.list();
  }

  @RequirePermission("inventory.view")
  @Get("ingredients/:id")
  getIngredient(@Param("id", ParseUUIDPipe) id: string) {
    return this.ingredients.get(id);
  }

  @RequirePermission("inventory.manage")
  @Post("ingredients")
  createIngredient(@Body() dto: CreateIngredientDto) {
    return this.ingredients.create(dto);
  }

  @RequirePermission("inventory.manage")
  @Patch("ingredients/:id")
  updateIngredient(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateIngredientDto) {
    return this.ingredients.update(id, dto);
  }

  @RequirePermission("inventory.manage")
  @Delete("ingredients/:id")
  deleteIngredient(@Param("id", ParseUUIDPipe) id: string) {
    return this.ingredients.softDelete(id);
  }

  // --- Stock locations ---

  @RequirePermission("inventory.view")
  @Get("locations")
  listLocations(@Query("branchId") branchId?: string) {
    return this.locations.list(branchId);
  }

  @RequirePermission("inventory.manage")
  @Post("locations")
  createLocation(@Body() dto: CreateStockLocationDto) {
    return this.locations.create(dto);
  }

  @RequirePermission("inventory.manage")
  @Patch("locations/:id")
  updateLocation(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateStockLocationDto) {
    return this.locations.update(id, dto);
  }

  @RequirePermission("inventory.manage")
  @Delete("locations/:id")
  deleteLocation(@Param("id", ParseUUIDPipe) id: string) {
    return this.locations.softDelete(id);
  }

  // --- Stock levels & movements ---

  @RequirePermission("inventory.view")
  @Get("stock-levels")
  levels(@Query("branchId") branchId?: string, @Query("locationId") locationId?: string) {
    return this.inventory.levels(branchId, locationId);
  }

  @RequirePermission("inventory.view")
  @Get("movements")
  movements(
    @Query("branchId") branchId?: string,
    @Query("ingredientId") ingredientId?: string,
    @Query("limit") limit?: string,
  ) {
    return this.inventory.movements({
      branchId,
      ingredientId,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @RequirePermission("inventory.manage")
  @Post("stock/purchase")
  recordPurchase(@Body() dto: RecordPurchaseDto) {
    return this.inventory.recordPurchase(dto);
  }

  @RequirePermission("inventory.manage")
  @Post("stock/waste")
  recordWaste(@Body() dto: RecordWasteDto) {
    return this.inventory.recordWaste(dto);
  }

  @RequirePermission("inventory.manage")
  @Post("stock/adjustment")
  recordAdjustment(@Body() dto: RecordAdjustmentDto) {
    return this.inventory.recordAdjustment(dto);
  }

  /** Products currently auto-hidden by the critical-ingredient stockout engine — dashboard alert list. */
  @RequirePermission("inventory.view")
  @Get("auto-hidden")
  listAutoHidden(@Query("branchId") branchId?: string) {
    return this.inventory.listAutoHidden(branchId);
  }
}
