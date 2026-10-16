import { Module } from "@nestjs/common";

import { LoyaltyModule } from "../loyalty/loyalty.module";
import { OrderingModule } from "../ordering/ordering.module";
import { ConnectionsController } from "./connections.controller";
import { ConnectionsService } from "./connections.service";
import { DeliveryMappingController } from "./delivery/delivery-mapping.controller";
import { DeliveryWebhookController } from "./delivery/delivery-webhook.controller";
import { DeliveryWebhookService } from "./delivery/delivery-webhook.service";
import { HungerstationProvider } from "./delivery/hungerstation.provider";
import { OnlinePaymentService } from "./online-payment.service";
import { GatewayCheckoutController } from "./payment-gateway/gateway-checkout.controller";
import { GatewayWebhookController } from "./payment-gateway/gateway-webhook.controller";
import { GatewayService } from "./payment-gateway/gateway.service";
import { HyperpayProvider } from "./payment-gateway/hyperpay.provider";
import { MoyasarProvider } from "./payment-gateway/moyasar.provider";
import { TapProvider } from "./payment-gateway/tap.provider";
import { ReorderAlertListener } from "./whatsapp/reorder-alert.listener";
import { WhatsappOrderListener } from "./whatsapp/whatsapp-order.listener";
import { WhatsappTemplatesController } from "./whatsapp/whatsapp-templates.controller";
import { WhatsappService } from "./whatsapp/whatsapp.service";

/**
 * Third-party integrations & add-ons: delivery platforms, digital-menu
 * payment gateways, NFC card terminals, and WhatsApp. Every category shares
 * one generic connection CRUD (ConnectionsController/ConnectionsService) —
 * NFC terminals in particular have no category-specific controller at all,
 * since "connect a terminal" is exactly the same generic upsert as every
 * other category (see NFC_PROVIDERS in @spruvex-r/types and the doc comment
 * on ConnectionsService). A successful NFC charge is recorded through the
 * EXISTING POST /orders/:id/payments endpoint (method: "card") — no new
 * backend surface needed there either; only the physical terminal SDK
 * integration itself (out of scope without a certified provider
 * partnership — see NfcProviderMeta's doc comment) remains to be wired up.
 */
@Module({
  imports: [OrderingModule, LoyaltyModule],
  controllers: [
    ConnectionsController,
    DeliveryMappingController,
    DeliveryWebhookController,
    GatewayCheckoutController,
    GatewayWebhookController,
    WhatsappTemplatesController,
  ],
  providers: [
    ConnectionsService,
    OnlinePaymentService,
    HungerstationProvider,
    DeliveryWebhookService,
    MoyasarProvider,
    TapProvider,
    HyperpayProvider,
    GatewayService,
    WhatsappService,
    WhatsappOrderListener,
    ReorderAlertListener,
  ],
  exports: [ConnectionsService, WhatsappService],
})
export class IntegrationsModule {}
