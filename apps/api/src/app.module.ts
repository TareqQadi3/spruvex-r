import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";

import { validateEnv } from "./config/env.validation";
import { HealthModule } from "./health/health.module";
import { AuthContextMiddleware } from "./modules/identity/auth-context.middleware";
import { BillingModule } from "./modules/billing/billing.module";
import { CatalogModule } from "./modules/catalog/catalog.module";
import { FeedbackModule } from "./modules/feedback/feedback.module";
import { IdentityModule } from "./modules/identity/identity.module";
import { ImportsModule } from "./modules/imports/imports.module";
import { IntegrationsModule } from "./modules/integrations/integrations.module";
import { InventoryModule } from "./modules/inventory/inventory.module";
import { LoyaltyModule } from "./modules/loyalty/loyalty.module";
import { OrderingModule } from "./modules/ordering/ordering.module";
import { PaymentsModule } from "./modules/payments/payments.module";
import { PlatformModule } from "./modules/platform/platform.module";
import { PurchasesModule } from "./modules/purchases/purchases.module";
import { ReportsModule } from "./modules/reports/reports.module";
import { ShiftsModule } from "./modules/shifts/shifts.module";
import { TablesModule } from "./modules/tables/tables.module";
import { TenancyModule } from "./modules/tenancy/tenancy.module";
import { UploadsModule } from "./modules/uploads/uploads.module";
import { AuditModule } from "./shared/audit/audit.module";
import { BillingKernelModule } from "./shared/billing/billing-kernel.module";
import { EventsModule } from "./shared/events/events.module";
import { PlatformSettingsModule } from "./shared/platform-settings/platform-settings.module";
import { PrismaModule } from "./shared/prisma/prisma.module";
import { RbacModule } from "./shared/rbac/rbac.module";
import { RealtimeModule } from "./shared/realtime/realtime.module";
import { SecurityModule } from "./shared/security/security.module";
import { TenantContextModule } from "./shared/tenancy/tenant-context.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ScheduleModule.forRoot(),
    EventsModule,
    TenantContextModule,
    PrismaModule,
    SecurityModule,
    RbacModule,
    BillingKernelModule,
    AuditModule,
    PlatformSettingsModule,
    HealthModule,
    IdentityModule,
    RealtimeModule,
    TenancyModule,
    CatalogModule,
    TablesModule,
    OrderingModule,
    ShiftsModule,
    PaymentsModule,
    InventoryModule,
    PurchasesModule,
    ReportsModule,
    BillingModule,
    PlatformModule,
    UploadsModule,
    IntegrationsModule,
    FeedbackModule,
    LoyaltyModule,
    ImportsModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthContextMiddleware).forRoutes("*");
  }
}
