import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import {
  IMPORT_FIELD_CATALOG,
  suggestColumnMapping,
  type ImportDataType,
} from "@spruvex-r/types";

import { AuditService } from "../../shared/audit/audit.service";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { TenantContextService } from "../../shared/tenancy/tenant-context.service";
import { CategoriesService } from "../catalog/categories.service";
import { PRICE_RULE } from "../catalog/dto/product.dto";
import { ProductsService } from "../catalog/products.service";
import { LoyaltyCustomerService } from "../loyalty/loyalty-customer.service";
import { MAX_IMPORT_FILE_BYTES, parseSpreadsheet } from "./file-parser";

const PHONE_RULE = /^\+?[0-9]{8,15}$/;

type RowStatus = "created" | "would_create" | "skipped_duplicate";

interface RowOutcome {
  status: RowStatus;
  identifier: string;
}

export interface RowResult {
  rowNumber: number;
  status: RowStatus | "failed";
  identifier?: string;
  error?: string;
}

/** Which existing permission gates each import type — see the class doc comment. */
function requiredPermissionFor(type: ImportDataType): "menu.manage" | "loyalty.manage" {
  return type === "customers" ? "loyalty.manage" : "menu.manage";
}

const JOB_LIST_SELECT = {
  id: true,
  type: true,
  status: true,
  filename: true,
  rowCount: true,
  successCount: true,
  skippedCount: true,
  failedCount: true,
  createdAt: true,
  completedAt: true,
} satisfies Prisma.ImportJobSelect;

const JOB_SUMMARY_SELECT = {
  ...JOB_LIST_SELECT,
  headers: true,
  mapping: true,
  results: true,
} satisfies Prisma.ImportJobSelect;

/**
 * Bulk data import from an uploaded spreadsheet — a merchant moving from
 * another POS uploads categories/products/customers instead of typing them
 * in by hand. Flow: upload (parse + suggest a column mapping) -> mapping
 * (merchant confirms/adjusts it) -> preview (first 10 mapped rows, format
 * errors only, no writes) -> execute (every row, one at a time).
 *
 * Every row that passes validation is created through the EXACT service
 * method a manual entry would use (CategoriesService.create,
 * ProductsService.create, LoyaltyCustomerService.getOrCreateByPhone) — this
 * class only adds the things manual entry doesn't need: column-name
 * matching, per-row continue-on-error, and a "skip, don't overwrite"
 * duplicate check (a same-name match during a bulk import is exactly the
 * "did I already import this?" case; manual entry doesn't need that guard).
 *
 * Each row's `import*Row` method takes a `dryRun` flag and returns before
 * the final create() call when true — `preview()` and `execute()` run the
 * literal same function, so there is no separate "would this succeed"
 * logic to keep in sync with the real one.
 *
 * One transaction per row, not one for the whole file: `prisma.scoped`
 * already wraps every individual write in its own tiny transaction (see
 * PrismaService's doc comment), so calling the real create() methods in a
 * loop already gives per-row atomicity for free — a bad row fails and is
 * recorded, the rows before and after it are unaffected. A single
 * whole-file transaction would instead have to roll back everything
 * already written the moment one row fails, defeating the "which rows
 * failed" report this feature exists to produce.
 */
@Injectable()
export class ImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly categories: CategoriesService,
    private readonly products: ProductsService,
    private readonly loyaltyCustomers: LoyaltyCustomerService,
  ) {}

  // --------------------------------------------------------------------- //
  // Upload
  // --------------------------------------------------------------------- //

  async createJob(type: ImportDataType, file?: Express.Multer.File) {
    this.assertTypePermission(type);
    if (!file) {
      throw new BadRequestException("لم يُرفع أي ملف (الحقل المطلوب: file)");
    }
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      throw new BadRequestException(
        `حجم الملف كبير جدًا — الحد الأقصى ${Math.floor(MAX_IMPORT_FILE_BYTES / (1024 * 1024))} ميغابايت`,
      );
    }

    const { headers, rows } = await parseSpreadsheet(file.buffer, file.originalname);
    const suggestedMapping = suggestColumnMapping(headers, type);

    const ctx = this.tenantContext.contextOrThrow;
    const job = await this.prisma.scoped.importJob.create({
      data: {
        tenantId: this.tenantContext.tenantIdOrThrow,
        type,
        status: "uploaded",
        filename: file.originalname,
        headers,
        rows,
        rowCount: rows.length,
        mapping: suggestedMapping,
        createdBy: ctx.userId,
      },
      select: JOB_SUMMARY_SELECT,
    });

    return { ...job, availableFields: IMPORT_FIELD_CATALOG[type] };
  }

  // --------------------------------------------------------------------- //
  // Mapping
  // --------------------------------------------------------------------- //

  async setMapping(id: string, mapping: Record<string, string | null>) {
    const job = await this.findFullOrThrow(id);
    this.assertTypePermission(job.type);
    if (job.status === "completed") {
      throw new ConflictException("انتهى تنفيذ هذا الاستيراد بالفعل");
    }

    const headers = job.headers as string[];
    const fields = IMPORT_FIELD_CATALOG[job.type];
    const validKeys = new Set(fields.map((f) => f.key));

    for (const [header, target] of Object.entries(mapping)) {
      if (!headers.includes(header)) {
        throw new BadRequestException(`عمود غير معروف بالملف: "${header}"`);
      }
      if (target !== null && !validKeys.has(target)) {
        throw new BadRequestException(`حقل غير معروف: "${target}"`);
      }
    }
    const mappedTargets = new Set(
      Object.values(mapping).filter((v): v is string => v !== null),
    );
    const missingRequired = fields.filter((f) => f.required && !mappedTargets.has(f.key));
    if (missingRequired.length > 0) {
      throw new BadRequestException(
        `حقول مطلوبة لم تُربط بأي عمود: ${missingRequired.map((f) => f.labelAr).join("، ")}`,
      );
    }

    const updated = await this.prisma.scoped.importJob.update({
      where: { id },
      data: { mapping, status: "mapped" },
      select: JOB_SUMMARY_SELECT,
    });
    return { ...updated, availableFields: fields };
  }

  // --------------------------------------------------------------------- //
  // Preview (first 10 rows, no writes)
  // --------------------------------------------------------------------- //

  async preview(id: string) {
    const job = await this.findFullOrThrow(id);
    this.assertTypePermission(job.type);
    const mapping = job.mapping as Record<string, string | null> | null;
    if (!mapping) {
      throw new ConflictException("اربط الأعمدة أولًا قبل المعاينة");
    }

    const rawRows = job.rows as Record<string, string>[];
    const previewRows = rawRows.slice(0, 10);
    const results: RowResult[] = [];

    for (let i = 0; i < previewRows.length; i++) {
      const rowNumber = i + 2; // row 1 is the header row in the source file
      const mapped = this.applyMapping(previewRows[i], mapping);
      try {
        const outcome = await this.importOneRow(job.type, mapped, true);
        results.push({ rowNumber, status: outcome.status, identifier: outcome.identifier });
      } catch (error) {
        results.push({ rowNumber, status: "failed", error: errorMessage(error) });
      }
    }

    return { rows: results };
  }

  // --------------------------------------------------------------------- //
  // Execute (every row, real writes)
  // --------------------------------------------------------------------- //

  async execute(id: string) {
    const job = await this.findFullOrThrow(id);
    this.assertTypePermission(job.type);
    if (job.status === "completed") {
      throw new ConflictException("انتهى تنفيذ هذا الاستيراد بالفعل");
    }
    const mapping = job.mapping as Record<string, string | null> | null;
    if (!mapping) {
      throw new ConflictException("اربط الأعمدة أولًا قبل التنفيذ");
    }

    const rawRows = job.rows as Record<string, string>[];
    const results: RowResult[] = [];
    let successCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < rawRows.length; i++) {
      const rowNumber = i + 2;
      const mapped = this.applyMapping(rawRows[i], mapping);
      try {
        const outcome = await this.importOneRow(job.type, mapped, false);
        if (outcome.status === "created") {
          successCount++;
        } else {
          skippedCount++;
        }
        results.push({ rowNumber, status: outcome.status, identifier: outcome.identifier });
      } catch (error) {
        failedCount++;
        results.push({ rowNumber, status: "failed", identifier: mapped.name, error: errorMessage(error) });
      }
    }

    const updated = await this.prisma.scoped.importJob.update({
      where: { id },
      data: {
        status: "completed",
        results: results as unknown as Prisma.InputJsonValue,
        successCount,
        skippedCount,
        failedCount,
        completedAt: new Date(),
      },
      select: JOB_LIST_SELECT,
    });

    await this.audit.log({
      action: "import.completed",
      entityType: "import_job",
      entityId: id,
      meta: {
        type: job.type,
        filename: job.filename,
        totalRows: rawRows.length,
        successCount,
        skippedCount,
        failedCount,
      },
    });

    return updated;
  }

  // --------------------------------------------------------------------- //
  // Reads
  // --------------------------------------------------------------------- //

  async list() {
    const { permissions } = this.tenantContext.contextOrThrow;
    const allowedTypes: ImportDataType[] = [
      ...(permissions.has("menu.manage") ? (["categories", "products"] as const) : []),
      ...(permissions.has("loyalty.manage") ? (["customers"] as const) : []),
    ];
    if (allowedTypes.length === 0) {
      throw new ForbiddenException(`Missing permission(s): menu.manage, loyalty.manage`);
    }
    return this.prisma.scoped.importJob.findMany({
      where: { type: { in: allowedTypes } },
      orderBy: { createdAt: "desc" },
      select: JOB_LIST_SELECT,
    });
  }

  async get(id: string) {
    const job = await this.findFullOrThrow(id);
    this.assertTypePermission(job.type);
    const { rows: _rows, ...summary } = job;
    return { ...summary, availableFields: IMPORT_FIELD_CATALOG[job.type] };
  }

  async failedRowsCsv(id: string) {
    const job = await this.findFullOrThrow(id);
    this.assertTypePermission(job.type);
    if (job.status !== "completed") {
      throw new ConflictException("لم يُنفَّذ هذا الاستيراد بعد");
    }

    const results = (job.results as RowResult[] | null) ?? [];
    const problemRows = results.filter((r) => r.status === "failed" || r.status === "skipped_duplicate");

    const statusLabel: Record<string, string> = {
      failed: "فشل",
      skipped_duplicate: "تم تخطيه (مكرر)",
    };

    const lines: string[][] = [
      ["رقم الصف", "الحالة", "الاسم", "السبب"],
      ...problemRows.map((r) => [
        String(r.rowNumber),
        statusLabel[r.status] ?? r.status,
        r.identifier ?? "",
        r.error ?? "",
      ]),
    ];
    const csv = lines.map((row) => row.map(csvEscape).join(",")).join("\r\n");
    return {
      filename: `import-${job.type}-${job.id.slice(0, 8)}-issues.csv`,
      csv,
    };
  }

  // --------------------------------------------------------------------- //
  // Row processors — each takes a dryRun flag and returns before the real
  // create() call when true, so preview() and execute() share one code path.
  // --------------------------------------------------------------------- //

  private async importOneRow(
    type: ImportDataType,
    mapped: Record<string, string>,
    dryRun: boolean,
  ): Promise<RowOutcome> {
    switch (type) {
      case "categories":
        return this.importCategoryRow(mapped, dryRun);
      case "products":
        return this.importProductRow(mapped, dryRun);
      case "customers":
        return this.importCustomerRow(mapped, dryRun);
    }
  }

  private async importCategoryRow(mapped: Record<string, string>, dryRun: boolean): Promise<RowOutcome> {
    const name = (mapped.name ?? "").trim();
    if (!name) {
      throw new BadRequestException("اسم القسم مطلوب");
    }

    const existing = await this.prisma.scoped.category.findFirst({
      where: { name: { equals: name, mode: "insensitive" }, deletedAt: null },
    });
    if (existing) {
      return { status: "skipped_duplicate", identifier: name };
    }
    if (dryRun) {
      return { status: "would_create", identifier: name };
    }

    const nameEn = mapped.nameEn?.trim();
    const category = await this.categories.create({ name, nameEn: nameEn || undefined });
    return { status: "created", identifier: category.name };
  }

  private async importProductRow(mapped: Record<string, string>, dryRun: boolean): Promise<RowOutcome> {
    const name = (mapped.name ?? "").trim();
    if (!name) {
      throw new BadRequestException("اسم المنتج مطلوب");
    }

    const priceRaw = normalizePriceCell(mapped.basePrice ?? "");
    if (!PRICE_RULE.test(priceRaw)) {
      throw new BadRequestException(`سعر غير صالح: "${mapped.basePrice ?? ""}"`);
    }

    const categoryName = (mapped.categoryName ?? "").trim();
    if (!categoryName) {
      throw new BadRequestException("القسم مطلوب");
    }
    const category = await this.prisma.scoped.category.findFirst({
      where: { name: { equals: categoryName, mode: "insensitive" }, deletedAt: null },
    });
    if (!category) {
      throw new BadRequestException(
        `القسم غير موجود: "${categoryName}" — استورد الأقسام أولًا أو أضِفه يدويًا`,
      );
    }

    const existing = await this.prisma.scoped.product.findFirst({
      where: { name: { equals: name, mode: "insensitive" }, deletedAt: null },
    });
    if (existing) {
      return { status: "skipped_duplicate", identifier: name };
    }
    if (dryRun) {
      return { status: "would_create", identifier: name };
    }

    const description = mapped.description?.trim();
    const product = await this.products.create({
      name,
      categoryId: category.id,
      basePrice: priceRaw,
      description: description || undefined,
    });
    return { status: "created", identifier: product.name };
  }

  private async importCustomerRow(mapped: Record<string, string>, dryRun: boolean): Promise<RowOutcome> {
    const phone = (mapped.phone ?? "").replace(/[\s-]/g, "");
    if (!PHONE_RULE.test(phone)) {
      throw new BadRequestException(`رقم جوال غير صالح: "${mapped.phone ?? ""}"`);
    }
    const name = mapped.name?.trim() || undefined;

    if (dryRun) {
      const existing = await this.prisma.scoped.loyaltyCustomer.findFirst({ where: { phone } });
      return existing
        ? { status: "skipped_duplicate", identifier: phone }
        : { status: "would_create", identifier: phone };
    }

    const { customer, created } = await this.loyaltyCustomers.getOrCreateByPhone(phone, name);
    return created
      ? { status: "created", identifier: customer.phone }
      : { status: "skipped_duplicate", identifier: customer.phone };
  }

  // --------------------------------------------------------------------- //
  // Helpers
  // --------------------------------------------------------------------- //

  private applyMapping(
    rawRow: Record<string, string>,
    mapping: Record<string, string | null>,
  ): Record<string, string> {
    const mapped: Record<string, string> = {};
    for (const [header, target] of Object.entries(mapping)) {
      if (target) mapped[target] = rawRow[header] ?? "";
    }
    return mapped;
  }

  private async findFullOrThrow(id: string) {
    const job = await this.prisma.scoped.importJob.findFirst({ where: { id } });
    if (!job) {
      throw new NotFoundException("عملية الاستيراد غير موجودة");
    }
    return job as typeof job & { type: ImportDataType };
  }

  private assertTypePermission(type: ImportDataType) {
    const required = requiredPermissionFor(type);
    const { permissions } = this.tenantContext.contextOrThrow;
    if (!permissions.has(required)) {
      throw new ForbiddenException(`Missing permission(s): ${required}`);
    }
  }
}

/** Strips currency symbols/commas/whitespace so "32.00 SAR" or "1,200" still validate. */
function normalizePriceCell(raw: string): string {
  return raw.replace(/[^\d.]/g, "").trim();
}

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "خطأ غير معروف";
}
