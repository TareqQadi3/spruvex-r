import { Injectable, NotFoundException } from "@nestjs/common";

import { AuditService } from "../../../shared/audit/audit.service";
import { PrismaService } from "../../../shared/prisma/prisma.service";
import { TenantContextService } from "../../../shared/tenancy/tenant-context.service";
import { encryptSecret } from "../../../shared/security/crypto-vault";
import { UpdateZatcaSettingsDto } from "./dto/zatca-settings.dto";

@Injectable()
export class ZatcaSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
  ) {}

  /** Never returns the decrypted secrets — only whether each is configured. */
  async get() {
    const tenant = await this.prisma.scoped.tenant.findUnique({
      where: { id: this.tenantContext.tenantIdOrThrow },
      select: {
        zatcaPhase2Enabled: true,
        zatcaEnvironment: true,
        zatcaCsidCertificateEnc: true,
        zatcaCsidPrivateKeyEnc: true,
        zatcaCsidTokenEnc: true,
        zatcaCsidSecretEnc: true,
        zatcaCsidRequestId: true,
      },
    });
    if (!tenant) {
      throw new NotFoundException("Tenant not found");
    }
    return {
      enabled: tenant.zatcaPhase2Enabled,
      environment: tenant.zatcaEnvironment,
      hasCertificate: Boolean(tenant.zatcaCsidCertificateEnc),
      hasPrivateKey: Boolean(tenant.zatcaCsidPrivateKeyEnc),
      hasToken: Boolean(tenant.zatcaCsidTokenEnc),
      hasSecret: Boolean(tenant.zatcaCsidSecretEnc),
      requestNote: tenant.zatcaCsidRequestId,
      /** True once every credential Phase 2 needs to actually sign+submit is present. */
      fullyConfigured: Boolean(
        tenant.zatcaCsidCertificateEnc &&
          tenant.zatcaCsidPrivateKeyEnc &&
          tenant.zatcaCsidTokenEnc &&
          tenant.zatcaCsidSecretEnc,
      ),
    };
  }

  async update(dto: UpdateZatcaSettingsDto) {
    const ctx = this.tenantContext.contextOrThrow;
    const tenantId = this.tenantContext.tenantIdOrThrow;

    const tenant = await this.prisma.scoped.tenant.update({
      where: { id: tenantId },
      data: {
        ...(dto.enabled !== undefined ? { zatcaPhase2Enabled: dto.enabled } : {}),
        ...(dto.environment ? { zatcaEnvironment: dto.environment } : {}),
        ...(dto.certificatePem ? { zatcaCsidCertificateEnc: encryptSecret(dto.certificatePem) } : {}),
        ...(dto.privateKeyPem ? { zatcaCsidPrivateKeyEnc: encryptSecret(dto.privateKeyPem) } : {}),
        ...(dto.csidToken ? { zatcaCsidTokenEnc: encryptSecret(dto.csidToken) } : {}),
        ...(dto.csidSecret ? { zatcaCsidSecretEnc: encryptSecret(dto.csidSecret) } : {}),
        ...(dto.requestNote !== undefined ? { zatcaCsidRequestId: dto.requestNote } : {}),
        updatedBy: ctx.userId,
      },
      select: { id: true },
    });

    await this.audit.log({
      action: "tenant.zatca_settings_updated",
      entityType: "tenant",
      entityId: tenant.id,
      // Never log the actual secret values — only which fields changed.
      meta: {
        changedFields: Object.keys(dto).filter((k) => dto[k as keyof UpdateZatcaSettingsDto] !== undefined),
      },
    });

    return this.get();
  }
}
