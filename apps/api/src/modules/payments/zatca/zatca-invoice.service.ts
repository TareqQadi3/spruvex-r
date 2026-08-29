import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { PrismaService } from "../../../shared/prisma/prisma.service";
import { decryptSecret } from "../../../shared/security/crypto-vault";
import { buildZatcaQrPayload, buildZatcaPhase2QrPayload } from "./tlv";
import { buildUblXml, numberLines, type UblInvoiceLine, type ZatcaDocumentKind } from "./ubl-invoice";
import { hashXml, lockInvoiceChainTip, writeInvoiceChainHash } from "./hash-chain";
import { signInvoiceHash, type ZatcaCsid } from "./signing";
import {
  clearInvoice,
  reportInvoice,
  type ZatcaEnvironment,
  type ZatcaSubmissionCredentials,
  type ZatcaSubmissionRequest,
} from "./submission-client";

/** The subset of Tenant fields the ZATCA flow needs — kept narrow so callers don't have to select the whole row. */
export interface ZatcaTenantContext {
  id: string;
  name: string;
  legalName: string | null;
  vatNumber: string | null;
  crNumber: string | null;
  address: string | null;
  currency: string;
  zatcaPhase2Enabled: boolean;
  zatcaEnvironment: string;
  zatcaCsidCertificateEnc: string | null;
  zatcaCsidPrivateKeyEnc: string | null;
  zatcaCsidTokenEnc: string | null;
  zatcaCsidSecretEnc: string | null;
}

export interface ZatcaIssueInput {
  tenant: ZatcaTenantContext;
  branchId: string;
  kind: ZatcaDocumentKind;
  documentNumber: number;
  issueDateTime: Date;
  lines: Omit<UblInvoiceLine, "lineId">[];
  subtotal: string;
  vatRate: string;
  vatAmount: string;
  total: string;
  buyer?: { name: string; vatNumber?: string | null } | null;
  precedingDocumentUuid?: string | null;
}

export interface ZatcaIssuedFields {
  documentUuid: string;
  isStandardInvoice: boolean;
  buyerName: string | null;
  buyerVatNumber: string | null;
  qrPayload: string | null;
  xmlContent: string | null;
  invoiceHash: string | null;
  previousInvoiceHash: string | null;
  cryptographicStamp: string | null;
  zatcaStatus: string;
  zatcaResponse: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  /** Set only when Phase 2 actually signed a document — the caller submits
   * this to ZATCA AFTER its transaction commits (a network call has no
   * business running inside a DB transaction) and records the outcome via
   * `submitAndRecordResult`. */
  pendingSubmission: {
    model: "receipt" | "creditNote" | "debitNote";
    isStandardInvoice: boolean;
    creds: ZatcaSubmissionCredentials;
    request: ZatcaSubmissionRequest;
  } | null;
}

function tryDecrypt(enc: string | null): string | null {
  if (!enc) return null;
  try {
    return decryptSecret(enc);
  } catch {
    return null;
  }
}

@Injectable()
export class ZatcaInvoiceService {
  private readonly logger = new Logger(ZatcaInvoiceService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Computes everything that goes on the receipt/credit-note/debit-note row
   * at issuance time. Must run inside the same tenant-scoped transaction
   * that creates that row (the hash chain lock has to cover both). Never
   * makes a network call itself — see `pendingSubmission`.
   */
  async issue(tx: Prisma.TransactionClient, input: ZatcaIssueInput): Promise<ZatcaIssuedFields> {
    const { tenant } = input;
    const sellerName = tenant.legalName ?? tenant.name;

    const phase1Qr =
      tenant.vatNumber && !input.buyer
        ? buildZatcaQrPayload({
            sellerName,
            vatNumber: tenant.vatNumber,
            timestamp: input.issueDateTime.toISOString(),
            total: input.total,
            vatAmount: input.vatAmount,
          })
        : null;

    const documentUuid = randomUUID();
    const isStandardInvoice = Boolean(input.buyer);

    const notEnabled: ZatcaIssuedFields = {
      documentUuid,
      isStandardInvoice,
      buyerName: input.buyer?.name ?? null,
      buyerVatNumber: input.buyer?.vatNumber ?? null,
      qrPayload: phase1Qr,
      xmlContent: null,
      invoiceHash: null,
      previousInvoiceHash: null,
      cryptographicStamp: null,
      zatcaStatus: "not_submitted",
      zatcaResponse: Prisma.JsonNull,
      pendingSubmission: null,
    };

    if (!tenant.zatcaPhase2Enabled || !tenant.vatNumber) {
      return notEnabled;
    }

    const csid: ZatcaCsid | null =
      tenant.zatcaCsidCertificateEnc && tenant.zatcaCsidPrivateKeyEnc
        ? {
            certificatePem: tryDecrypt(tenant.zatcaCsidCertificateEnc) ?? "",
            privateKeyPem: tryDecrypt(tenant.zatcaCsidPrivateKeyEnc) ?? "",
          }
        : null;
    const csidToken = tryDecrypt(tenant.zatcaCsidTokenEnc);
    const csidSecret = tryDecrypt(tenant.zatcaCsidSecretEnc);

    if (!csid || !csid.certificatePem || !csid.privateKeyPem || !csidToken || !csidSecret) {
      this.logger.warn(
        `Tenant ${tenant.id} has ZATCA Phase 2 enabled but no complete CSID credentials — falling back to Phase 1 QR only until credentials are uploaded.`,
      );
      return notEnabled;
    }

    // Hold the branch's chain-tip lock for the rest of this function.
    const { previousHash, rowExists } = await lockInvoiceChainTip(tx, input.branchId);

    const lines = numberLines(input.lines);
    const xml = buildUblXml({
      kind: input.kind,
      documentUuid,
      documentNumber: input.documentNumber,
      issueDateTime: input.issueDateTime,
      currency: tenant.currency,
      seller: {
        name: sellerName,
        vatNumber: tenant.vatNumber,
        crNumber: tenant.crNumber,
        address: tenant.address,
      },
      buyer: input.buyer,
      precedingDocumentUuid: input.precedingDocumentUuid,
      lines,
      subtotal: input.subtotal,
      vatRate: input.vatRate,
      vatAmount: input.vatAmount,
      total: input.total,
      qrPayload: phase1Qr ?? "",
      previousInvoiceHash: previousHash,
    });

    const invoiceHashBuffer = hashXml(xml);
    const invoiceHashHex = invoiceHashBuffer.toString("hex");
    const { signature, publicKey } = signInvoiceHash(invoiceHashBuffer, csid);

    await writeInvoiceChainHash(tx, tenant.id, input.branchId, invoiceHashHex, rowExists);

    const phase2Qr = buildZatcaPhase2QrPayload({
      sellerName,
      vatNumber: tenant.vatNumber,
      timestamp: input.issueDateTime.toISOString(),
      total: input.total,
      vatAmount: input.vatAmount,
      invoiceHash: invoiceHashBuffer,
      signature,
      publicKey,
    });

    const environment = (["sandbox", "simulation", "production"] as const).includes(
      tenant.zatcaEnvironment as ZatcaEnvironment,
    )
      ? (tenant.zatcaEnvironment as ZatcaEnvironment)
      : "sandbox";

    return {
      documentUuid,
      isStandardInvoice,
      buyerName: input.buyer?.name ?? null,
      buyerVatNumber: input.buyer?.vatNumber ?? null,
      qrPayload: phase2Qr,
      xmlContent: xml,
      invoiceHash: invoiceHashHex,
      previousInvoiceHash: previousHash,
      cryptographicStamp: signature.toString("base64"),
      zatcaStatus: "pending",
      zatcaResponse: Prisma.JsonNull,
      pendingSubmission: {
        model: input.kind === "invoice" ? "receipt" : input.kind === "credit_note" ? "creditNote" : "debitNote",
        isStandardInvoice,
        creds: { environment, csidToken, csidSecret },
        request: {
          invoiceHash: invoiceHashHex,
          documentUuid,
          invoiceBase64: Buffer.from(xml, "utf8").toString("base64"),
        },
      },
    };
  }

  /**
   * Call once, after the transaction that created the row has committed.
   * Best-effort: a network failure leaves the row at `zatcaStatus: "pending"`
   * (already its value from `issue()`) rather than throwing — the document
   * itself is valid and already handed to the customer; submission can be
   * retried later. No retry scheduler exists yet (see docs/DEPLOYMENT.md);
   * this is the hook a future one would call.
   */
  async submitAndRecordResult(
    tenantId: string,
    pending: NonNullable<ZatcaIssuedFields["pendingSubmission"]>,
    rowId: string,
  ): Promise<void> {
    const result = pending.isStandardInvoice
      ? await clearInvoice(pending.creds, pending.request)
      : await reportInvoice(pending.creds, pending.request);

    const zatcaStatus = result.outcome === "error" ? "pending" : result.outcome;
    const db = this.prisma.forTenant(tenantId);
    const data = { zatcaStatus, zatcaResponse: result.raw as Prisma.InputJsonValue, zatcaSubmittedAt: new Date() };
    try {
      if (pending.model === "receipt") await db.receipt.update({ where: { id: rowId }, data });
      else if (pending.model === "creditNote") await db.creditNote.update({ where: { id: rowId }, data });
      else await db.debitNote.update({ where: { id: rowId }, data });
    } catch (error) {
      this.logger.error(`Failed to record ZATCA submission result for ${pending.model} ${rowId}`, error as Error);
    }
  }
}
