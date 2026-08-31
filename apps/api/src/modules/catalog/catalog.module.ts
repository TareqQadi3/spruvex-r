import { Module } from "@nestjs/common";

import { CatalogController } from "./catalog.controller";
import { CategoriesService } from "./categories.service";
import { ModifiersService } from "./modifiers.service";
import { ProductsService } from "./products.service";

/**
 * Catalog module — categories, products, modifiers, per-branch pricing and
 * availability. The single source of truth for every ordering channel
 * (POS, QR menu, future channels).
 */
@Module({
  controllers: [CatalogController],
  providers: [CategoriesService, ProductsService, ModifiersService],
  exports: [CategoriesService, ProductsService],
})
export class CatalogModule {}
