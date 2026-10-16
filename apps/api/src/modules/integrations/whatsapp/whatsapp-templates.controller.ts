import { Body, Controller, Get, Post } from "@nestjs/common";
import { WHATSAPP_MESSAGE_TEMPLATES, WHATSAPP_TEMPLATE_KEYS } from "@spruvex-r/types";

import { RequirePermission } from "../../../shared/rbac/require-permission.decorator";
import { PrismaService } from "../../../shared/prisma/prisma.service";
import { TenantContextService } from "../../../shared/tenancy/tenant-context.service";
import { UpsertWhatsappTemplateOverrideDto } from "./dto/whatsapp-template-override.dto";

/** The message-template library + per-tenant customization/approval tracking — see WhatsappTemplateOverride's doc comment for the approval-status caveat. */
@RequirePermission("tenant.settings.manage")
@Controller("integrations/whatsapp/templates")
export class WhatsappTemplatesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  async list() {
    const overrides = await this.prisma.scoped.whatsappTemplateOverride.findMany();
    const byKey = new Map(overrides.map((o) => [o.templateKey, o]));
    return WHATSAPP_TEMPLATE_KEYS.map((key) => ({
      ...WHATSAPP_MESSAGE_TEMPLATES[key],
      override: byKey.get(key) ?? null,
    }));
  }

  @Post()
  async upsert(@Body() dto: UpsertWhatsappTemplateOverrideDto) {
    const existing = await this.prisma.scoped.whatsappTemplateOverride.findFirst({
      where: { templateKey: dto.templateKey },
    });
    const data = {
      ...(dto.customBodyAr !== undefined ? { customBodyAr: dto.customBodyAr } : {}),
      ...(dto.approvalStatus !== undefined ? { approvalStatus: dto.approvalStatus } : {}),
      ...(dto.metaTemplateName !== undefined ? { metaTemplateName: dto.metaTemplateName } : {}),
    };
    if (existing) {
      return this.prisma.scoped.whatsappTemplateOverride.update({ where: { id: existing.id }, data });
    }
    return this.prisma.scoped.whatsappTemplateOverride.create({
      data: { tenantId: this.tenantContext.tenantIdOrThrow, templateKey: dto.templateKey, ...data },
    });
  }
}
