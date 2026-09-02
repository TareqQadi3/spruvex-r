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
      // non-JSON error body (e.g. a bare "Too Many Requests" from a proxy)
    }
    if (!message) {
      // Empty statusText on 4xx/5xx leaves the UI silently doing nothing —
      // give the user something actionable instead (rate limits especially).
      message =
        res.status === 429
          ? "عدد كبير من المحاولات — انتظر دقيقة ثم أعد المحاولة"
          : res.status >= 500
            ? "خطأ في الخادم — أعد المحاولة بعد قليل"
            : "تعذّر إكمال الطلب";
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
