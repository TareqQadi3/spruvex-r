/**
 * ZATCA Phase 2 — submission to the Fatoora API (Reporting for Simplified/B2C
 * invoices, Clearance for Standard/B2B). Structured to match ZATCA's
 * documented request/response shape, but never exercised against a real
 * ZATCA environment in this build — no sandbox account/CSID was available.
 * Smoke-test against ZATCA's actual sandbox before relying on it in
 * production; the base URLs and exact response field names are the most
 * likely things to need correcting once that happens.
 */

export type ZatcaEnvironment = "sandbox" | "simulation" | "production";

const BASE_URLS: Record<ZatcaEnvironment, string> = {
  sandbox: "https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal",
  simulation: "https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation",
  production: "https://gw-fatoora.zatca.gov.sa/e-invoicing/core",
};

export interface ZatcaSubmissionCredentials {
  environment: ZatcaEnvironment;
  /** The CSID binary security token (Basic-auth username). */
  csidToken: string;
  /** The CSID secret (Basic-auth password). */
  csidSecret: string;
}

export interface ZatcaSubmissionRequest {
  /** Hex SHA-256 of the canonical XML. */
  invoiceHash: string;
  documentUuid: string;
  /** Full signed XML, base64-encoded. */
  invoiceBase64: string;
}

export type ZatcaSubmissionOutcome = "cleared" | "reported" | "rejected" | "error";

export interface ZatcaSubmissionResult {
  outcome: ZatcaSubmissionOutcome;
  /** Raw response body, kept verbatim for support/dispute purposes. */
  raw: unknown;
  httpStatus?: number;
}

function authHeader(creds: ZatcaSubmissionCredentials): string {
  return "Basic " + Buffer.from(`${creds.csidToken}:${creds.csidSecret}`).toString("base64");
}

async function post(
  creds: ZatcaSubmissionCredentials,
  path: string,
  body: ZatcaSubmissionRequest,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${BASE_URLS[creds.environment]}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-Language": "en",
      "Accept-Version": "V2",
      Authorization: authHeader(creds),
    },
    body: JSON.stringify({
      invoiceHash: body.invoiceHash,
      uuid: body.documentUuid,
      invoice: body.invoiceBase64,
    }),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/** Simplified/B2C invoices, credit and debit notes: reported to ZATCA, async, within 24h. */
export async function reportInvoice(
  creds: ZatcaSubmissionCredentials,
  request: ZatcaSubmissionRequest,
): Promise<ZatcaSubmissionResult> {
  try {
    const { status, json } = await post(creds, "/invoices/reporting/single", request);
    return { outcome: status >= 200 && status < 300 ? "reported" : "rejected", raw: json, httpStatus: status };
  } catch (error) {
    return { outcome: "error", raw: { message: (error as Error).message } };
  }
}

/** Standard/B2B invoices, credit and debit notes: must be cleared by ZATCA before delivery to the buyer. */
export async function clearInvoice(
  creds: ZatcaSubmissionCredentials,
  request: ZatcaSubmissionRequest,
): Promise<ZatcaSubmissionResult> {
  try {
    const { status, json } = await post(creds, "/invoices/clearance/single", request);
    return { outcome: status >= 200 && status < 300 ? "cleared" : "rejected", raw: json, httpStatus: status };
  } catch (error) {
    return { outcome: "error", raw: { message: (error as Error).message } };
  }
}
