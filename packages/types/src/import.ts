/**
 * Bulk data-import catalog — a merchant moving from another POS uploads a
 * spreadsheet instead of typing everything in by hand. Each import type
 * (categories/products/customers, more later) declares its own target
 * fields here; the upload -> map -> preview -> execute flow in
 * ImportsService is generic over this catalog, so adding a new import type
 * (e.g. recipes/ingredients) is just adding a new entry below plus a small
 * row-processor in ImportsService — the mapping UI and matching logic never
 * change.
 */

export const IMPORT_DATA_TYPES = ["categories", "products", "customers"] as const;
export type ImportDataType = (typeof IMPORT_DATA_TYPES)[number];

export interface ImportFieldDef {
  /** Our internal field key — what a mapped row is keyed by. */
  key: string;
  labelAr: string;
  labelEn: string;
  required: boolean;
  /**
   * Header synonyms this field auto-matches against (normalized: lowercase,
   * trimmed, punctuation stripped) — see suggestColumnMapping below. Keep
   * this list to real-world spreadsheet header text, not a chase for every
   * possible phrasing.
   */
  aliases: string[];
}

export const IMPORT_FIELD_CATALOG: Record<ImportDataType, ImportFieldDef[]> = {
  categories: [
    {
      key: "name",
      labelAr: "اسم القسم",
      labelEn: "Category name",
      required: true,
      aliases: ["name", "category", "category name", "اسم", "القسم", "اسم القسم", "الفئة"],
    },
    {
      key: "nameEn",
      labelAr: "الاسم بالإنجليزي",
      labelEn: "English name",
      required: false,
      aliases: ["name en", "english name", "name (en)", "الاسم الانجليزي", "الاسم بالانجليزي"],
    },
  ],
  products: [
    {
      key: "name",
      labelAr: "اسم المنتج",
      labelEn: "Product name",
      required: true,
      aliases: ["name", "item name", "product name", "item", "اسم", "الصنف", "اسم المنتج", "اسم الصنف"],
    },
    {
      key: "basePrice",
      labelAr: "السعر",
      labelEn: "Price",
      required: true,
      aliases: ["price", "unit price", "cost", "سعر", "السعر"],
    },
    {
      key: "categoryName",
      labelAr: "القسم",
      labelEn: "Category",
      required: true,
      aliases: ["category", "section", "قسم", "الفئة", "التصنيف", "القسم"],
    },
    {
      key: "description",
      labelAr: "الوصف",
      labelEn: "Description",
      required: false,
      aliases: ["description", "desc", "وصف", "الوصف"],
    },
  ],
  customers: [
    {
      key: "name",
      labelAr: "اسم العميل",
      labelEn: "Customer name",
      required: false,
      aliases: ["name", "customer", "customer name", "اسم", "اسم العميل"],
    },
    {
      key: "phone",
      labelAr: "رقم الجوال",
      labelEn: "Phone",
      required: true,
      aliases: ["phone", "mobile", "phone number", "mobile number", "جوال", "رقم الجوال", "الجوال", "هاتف"],
    },
  ],
};

/** Lowercase, trim, collapse whitespace, strip punctuation — keeps Arabic/Latin letters and digits. */
function normalizeHeader(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[_\-]+/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Suggests an initial column mapping from a source file's header row: an
 * exact match (after normalization) against a field's alias list — no
 * heavier fuzzy matching. This deliberately covers the common case ("Price"
 * / "السعر" matches the `basePrice` field outright) without forcing the
 * merchant to map every obviously-named column by hand; anything
 * ambiguous is left unmapped for them to pick manually.
 */
export function suggestColumnMapping(
  headers: string[],
  type: ImportDataType,
): Record<string, string | null> {
  const fields = IMPORT_FIELD_CATALOG[type];
  const usedFields = new Set<string>();
  const mapping: Record<string, string | null> = {};

  for (const header of headers) {
    const normalized = normalizeHeader(header);
    let matchedKey: string | null = null;
    for (const field of fields) {
      if (usedFields.has(field.key)) continue;
      if (field.aliases.some((alias) => normalizeHeader(alias) === normalized)) {
        matchedKey = field.key;
        break;
      }
    }
    if (matchedKey) usedFields.add(matchedKey);
    mapping[header] = matchedKey;
  }
  return mapping;
}
