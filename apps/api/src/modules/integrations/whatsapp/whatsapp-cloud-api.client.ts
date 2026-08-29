import { BadRequestException } from "@nestjs/common";

const API_VERSION = process.env.WHATSAPP_API_VERSION ?? "v21.0";

export interface WhatsappTemplateParam {
  type: "text";
  text: string;
}

/**
 * Meta WhatsApp Cloud API, called directly (no middleman) — matches
 * .claude/skills/whatsapp-business-api's documented request shape exactly.
 * Sends a pre-approved Message Template with positional {{1}}, {{2}}, ...
 * body parameters. Free-form text only works within a customer-initiated
 * 24h window (error 131047 otherwise) — every send from this system uses a
 * template, since order/receipt notifications are never guaranteed to land
 * inside that window.
 */
export async function sendWhatsappTemplate(params: {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  templateName: string;
  languageCode: string;
  bodyParams: string[];
}): Promise<{ messageId: string }> {
  const digitsOnly = params.to.replace(/[^0-9]/g, "");
  const res = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${params.phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: digitsOnly,
        type: "template",
        template: {
          name: params.templateName,
          language: { code: params.languageCode },
          components: [
            {
              type: "body",
              parameters: params.bodyParams.map(
                (text): WhatsappTemplateParam => ({ type: "text", text }),
              ),
            },
          ],
        },
      }),
    },
  );
  const json = (await res.json().catch(() => null)) as
    | { messages?: Array<{ id: string }>; error?: { message?: string; code?: number } }
    | null;
  const messageId = json?.messages?.[0]?.id;
  if (!res.ok || !messageId) {
    throw new BadRequestException(
      `WhatsApp send failed (${json?.error?.code ?? res.status}): ${json?.error?.message ?? res.statusText}`,
    );
  }
  return { messageId };
}
