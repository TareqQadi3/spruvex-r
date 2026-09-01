/** Base URL of the tenant dashboard app — used in transactional emails and API responses. */
export function dashboardUrl(): string {
  return process.env.DASHBOARD_BASE_URL ?? "http://localhost:5173";
}
