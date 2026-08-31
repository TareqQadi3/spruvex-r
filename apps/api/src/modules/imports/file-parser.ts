import { BadRequestException } from "@nestjs/common";
import ExcelJS from "exceljs";
import { Readable } from "node:stream";

/** Cap on data rows per import — this whole feature runs synchronously
 * inside one HTTP request (no background job queue exists in this
 * codebase), so a bound here keeps `execute()` from running unbounded. */
export const MAX_IMPORT_ROWS = 2000;
export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024; // 5 MB

export interface ParsedSpreadsheet {
  /** Raw header row, left-to-right, exactly as it appears in the file. */
  headers: string[];
  /** One object per data row, keyed by the original header text. */
  rows: Record<string, string>[];
}

function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("richText" in value) {
      return (value.richText ?? []).map((part) => part.text).join("").trim();
    }
    if ("text" in value) return String((value as { text: unknown }).text ?? "").trim();
    if ("result" in value) return String((value as { result: unknown }).result ?? "").trim();
    if ("hyperlink" in value) return String((value as { text?: unknown }).text ?? "").trim();
  }
  return String(value).trim();
}

/**
 * Reads the first worksheet of an uploaded .xlsx/.xls/.csv file: row 1 is
 * the header row, everything after is data. Rows that are entirely blank
 * (a trailing empty line Excel sometimes keeps) are skipped.
 */
export async function parseSpreadsheet(buffer: Buffer, originalName: string): Promise<ParsedSpreadsheet> {
  const isCsv = originalName.toLowerCase().endsWith(".csv");

  let sheet: ExcelJS.Worksheet | undefined;
  try {
    if (isCsv) {
      const workbook = new ExcelJS.Workbook();
      sheet = await workbook.csv.read(Readable.from(buffer));
    } else {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
      sheet = workbook.worksheets[0];
    }
  } catch {
    throw new BadRequestException(
      "تعذّرت قراءة الملف — تأكد أنه ملف Excel (.xlsx) أو CSV صالح",
    );
  }
  if (!sheet) {
    throw new BadRequestException("الملف لا يحتوي على أي ورقة بيانات");
  }

  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  const headerColumnIndexes: number[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const text = cellToString(cell.value);
    if (text) {
      headers.push(text);
      headerColumnIndexes.push(colNumber);
    }
  });
  if (headers.length === 0) {
    throw new BadRequestException("لم يُعثر على صف عناوين — تأكد أن أول سطر بالملف هو أسماء الأعمدة");
  }
  if (new Set(headers).size !== headers.length) {
    throw new BadRequestException("يوجد عمودان بنفس الاسم بصف العناوين — أعد تسمية أحدهما وحاول مجددًا");
  }

  const rows: Record<string, string>[] = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const record: Record<string, string> = {};
    let hasValue = false;
    headers.forEach((header, i) => {
      const cell = row.getCell(headerColumnIndexes[i]);
      const text = cellToString(cell.value);
      record[header] = text;
      if (text) hasValue = true;
    });
    if (hasValue) rows.push(record);
  }

  if (rows.length === 0) {
    throw new BadRequestException("الملف لا يحتوي على أي صف بيانات تحت صف العناوين");
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new BadRequestException(
      `الملف يحتوي على ${rows.length} صفًا — الحد الأقصى ${MAX_IMPORT_ROWS} صفًا لكل عملية استيراد`,
    );
  }

  return { headers, rows };
}
