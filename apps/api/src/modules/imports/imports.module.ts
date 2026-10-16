import { Module } from "@nestjs/common";

import { CatalogModule } from "../catalog/catalog.module";
import { LoyaltyModule } from "../loyalty/loyalty.module";
import { ImportsController } from "./imports.controller";
import { ImportsService } from "./imports.service";

/**
 * Bulk data import from an uploaded spreadsheet — see ImportsService's doc
 * comment. Imports CatalogModule/LoyaltyModule to reuse their real
 * create-entity service methods rather than re-implementing them.
 */
@Module({
  imports: [CatalogModule, LoyaltyModule],
  controllers: [ImportsController],
  providers: [ImportsService],
})
export class ImportsModule {}
