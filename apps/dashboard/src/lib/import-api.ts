import type { ImportDataType, ImportFieldDef } from "@spruvex-r/types";

import { api, downloadFile, uploadFileForJson } from "./api";

export type ImportJobStatus = "uploaded" | "mapped" | "completed";

export interface ImportJobSummary {
  id: string;
  type: ImportDataType;
  status: ImportJobStatus;
  filename: string;
  rowCount: number;
  successCount: number | null;
  skippedCount: number | null;
  failedCount: number | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ImportJobDetail extends ImportJobSummary {
  headers: string[];
  mapping: Record<string, string | null> | null;
  results: ImportRowResult[] | null;
  availableFields: ImportFieldDef[];
}

export interface ImportRowResult {
  rowNumber: number;
  status: "created" | "would_create" | "skipped_duplicate" | "failed";
  identifier?: string;
  error?: string;
}

export const importApi = {
  upload: (type: ImportDataType, file: File) =>
    uploadFileForJson<ImportJobDetail>(`/imports/${type}`, file),

  list: () => api<ImportJobSummary[]>("/imports"),

  get: (id: string) => api<ImportJobDetail>(`/imports/${id}`),

  setMapping: (id: string, mapping: Record<string, string | null>) =>
    api<ImportJobDetail>(`/imports/${id}/mapping`, {
      method: "PATCH",
      body: JSON.stringify({ mapping }),
    }),

  preview: (id: string) => api<{ rows: ImportRowResult[] }>(`/imports/${id}/preview`),

  execute: (id: string) => api<ImportJobSummary>(`/imports/${id}/execute`, { method: "POST" }),

  downloadFailedRows: (id: string, filename: string) =>
    downloadFile(`/imports/${id}/failed-rows.csv`, filename),
};
