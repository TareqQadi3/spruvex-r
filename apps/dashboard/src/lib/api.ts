/**
 * Minimal typed API client. Access token lives in memory only; the refresh
 * token is persisted and exchanged on 401 (single retry). Replaced by the
 * generated OpenAPI client (packages/api-client) in a later phase.
 */

const BASE = "/api/v1";
const REFRESH_KEY = "spruvex:refreshToken";

let accessToken: string | null = null;
let onSessionExpired: (() => void) | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY);
}

export function setRefreshToken(token: string | null) {
  if (token) {
    localStorage.setItem(REFRESH_KEY, token);
  } else {
    localStorage.removeItem(REFRESH_KEY);
  }
}

export function setSessionExpiredHandler(handler: () => void) {
  onSessionExpired = handler;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function rawRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  return fetch(`${BASE}${path}`, { ...options, headers });
}

async function tryRefresh(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  const res = await fetch(`${BASE}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) {
    setRefreshToken(null);
    setAccessToken(null);
    return false;
  }
  const body = (await res.json()) as { accessToken: string; refreshToken: string };
  setAccessToken(body.accessToken);
  setRefreshToken(body.refreshToken);
  return true;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let res = await rawRequest(path, options);

  if (res.status === 401 && !path.startsWith("/auth/")) {
    if (await tryRefresh()) {
      res = await rawRequest(path, options);
    } else {
      onSessionExpired?.();
    }
  }

  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = Array.isArray(body.message) ? body.message.join("، ") : (body.message ?? message);
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) {
    return undefined as T;
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const post = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });

async function rawUpload(path: string, file: File): Promise<Response> {
  const form = new FormData();
  form.append("file", file);
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  // No Content-Type here on purpose — the browser sets the multipart
  // boundary itself; overriding it breaks the upload.
  return fetch(`${BASE}${path}`, { method: "POST", headers, body: form });
}

/** Uploads an image file and returns its public URL. */
export async function uploadImage(file: File): Promise<string> {
  let res = await rawUpload("/uploads/image", file);
  if (res.status === 401 && (await tryRefresh())) {
    res = await rawUpload("/uploads/image", file);
  }
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = Array.isArray(body.message) ? body.message.join("، ") : (body.message ?? message);
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, message);
  }
  const { url } = (await res.json()) as { url: string };
  return url;
}

/** Uploads a file to any multipart endpoint that doesn't return a URL (e.g.
 * a private document attachment) — same auth/retry handling as uploadImage. */
export async function uploadFile(path: string, file: File): Promise<void> {
  let res = await rawUpload(path, file);
  if (res.status === 401 && (await tryRefresh())) {
    res = await rawUpload(path, file);
  }
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = Array.isArray(body.message) ? body.message.join("، ") : (body.message ?? message);
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, message);
  }
}

/** Downloads a binary endpoint (QR PNG / PDF sheet) and saves it via the browser. */
export async function downloadFile(path: string, filename: string): Promise<void> {
  let res = await rawRequest(path);
  if (res.status === 401 && (await tryRefresh())) {
    res = await rawRequest(path);
  }
  if (!res.ok) {
    throw new ApiError(res.status, res.statusText);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
