import { Module } from "@nestjs/common";

import { FoodCostService } from "./food-cost.service";
import { IngredientsService } from "./ingredients.service";
import { InventoryController } from "./inventory.controller";
import { InventoryService } from "./inventory.service";
import { RecipesController } from "./recipes.controller";
import { RecipesService } from "./recipes.service";
import { StockDeductionListener } from "./stock-deduction.listener";
import { StockLocationsService } from "./stock-locations.service";
import { StockTransfersController } from "./stock-transfers.controller";
import { StockTransfersService } from "./stock-transfers.service";

/**
 * Inventory & Recipe module (Phase 7) — ingredients, stock locations/levels/
 * movements (purchase/waste/adjustment, append-only ledger), product
 * recipes, live food-cost/margin calculation, automatic stock deduction on
 * order completion (event-driven, non-blocking), and inter-branch stock
 * transfers (see StockTransfersService's doc comment for the state machine).
 */
@Module({
  controllers: [InventoryController, RecipesController, StockTransfersController],
  providers: [
    IngredientsService,
    StockLocationsService,
    InventoryService,
    RecipesService,
    FoodCostService,
    StockDeductionListener,
    StockTransfersService,
  ],
  exports: [InventoryService, FoodCostService],
})
export class InventoryModule {}
