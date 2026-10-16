import { Injectable, Logger } from "@nestjs/common";
import { WHATSAPP_MESSAGE_TEMPLATES, type WhatsappTemplateKey } from "@spruvex-r/types";

import { PrismaService } from "../../../shared/prisma/prisma.service";
import { ConnectionsService } from "../connections.service";
import { sendWhatsappTemplate } from "./whatsapp-cloud-api.client";

/**
 * Sends one of the system-defined WhatsApp message templates to a customer.
 * Every call here is best-effort and swallows its own failures — a
 * WhatsApp send is a courtesy notification, never something the order or
 * receipt pipeline should fail because of. Silently does nothing when:
 * the order has no phone number, the tenant hasn't connected WhatsApp, or
 * the template hasn't been approved in the tenant's own Meta Business
 * Manager yet (approvalStatus is a manually-set flag — see
 * WhatsappTemplateOverride's doc comment — this system cannot verify Meta's
 * real approval state without live credentials to check against).
 */
@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    private readonly connections: ConnectionsService,
    private readonly prisma: PrismaService,
  ) {}

  async sendTemplate(
    templateKey: WhatsappTemplateKey,
    phone: string | null | undefined,
    variables: Record<string, string>,
  ): Promise<void> {
    if (!phone) return;

    const connection = await this.connections.findActive("whatsapp");
    if (!connection || !connection.secretEnc) return;

    const override = await this.prisma.scoped.whatsappTemplateOverride.findFirst({
      where: { templateKey },
    });
    if (!override || override.approvalStatus !== "approved" || !override.metaTemplateName) {
      return;
    }

    const template = WHATSAPP_MESSAGE_TEMPLATES[templateKey];
    const bodyParams = template.variables.map((variable) => variables[variable.key] ?? "");

    const decrypted = await this.connections.getDecrypted(connection.id);
    const config = decrypted.config as { phoneNumberId?: string };
    if (!config.phoneNumberId || !decrypted.secret) return;

    try {
      await sendWhatsappTemplate({
        phoneNumberId: config.phoneNumberId,
        accessToken: decrypted.secret,
        to: phone,
        templateName: override.metaTemplateName,
        languageCode: "ar",
        bodyParams,
      });
      await this.connections.recordSuccess(connection.id, "synced");
    } catch (error) {
      const message = error instanceof Error ? error.message : "WhatsApp send failed";
      this.logger.warn(`WhatsApp template "${templateKey}" send failed: ${message}`);
      await this.connections.recordError(connection.id, message);
    }
  }

  /**
   * Shared table-session orders have several phones on one order — every
   * status update goes to everyone who actually ordered, not just whoever
   * scanned first. One phone's failure/missing number never blocks another's.
   */
  async sendTemplateToMany(
    templateKey: WhatsappTemplateKey,
    phones: Array<string | null | undefined>,
    variables: Record<string, string>,
  ): Promise<void> {
    const unique = [...new Set(phones.filter((p): p is string => Boolean(p)))];
    for (const phone of unique) {
      await this.sendTemplate(templateKey, phone, variables);
    }
  }
}
