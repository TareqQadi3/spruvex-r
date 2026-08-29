// Shared transactional-email design for every SpruVex product (this file's
// wrapper/social block is mirrored — same markup — in spruvex-app's
// core/email/templates.ts, so a customer trying two SpruVex products gets
// one consistent brand). Inline styles only: most email clients strip
// <style> tags in <head>. Arabic/RTL by default since that's the product's
// primary market.

const BRAND_GREEN = "#16803c";

// Edit these three constants when a real link is ready — nothing else in
// this file needs to change.
const SOCIAL_LINKS = {
  whatsapp: "", // TODO: add WhatsApp contact link
  tiktok: "https://www.tiktok.com/@spru.vex",
  instagram: "https://www.instagram.com/spruvex",
};

function socialRow(): string {
  const links: Array<{ href: string; label: string }> = [];
  if (SOCIAL_LINKS.whatsapp) links.push({ href: SOCIAL_LINKS.whatsapp, label: "واتساب" });
  if (SOCIAL_LINKS.tiktok) links.push({ href: SOCIAL_LINKS.tiktok, label: "تيك توك" });
  if (SOCIAL_LINKS.instagram) links.push({ href: SOCIAL_LINKS.instagram, label: "إنستغرام" });
  if (links.length === 0) return "";
  return `
    <div style="margin-top:20px;text-align:center;">
      ${links
        .map(
          (l) =>
            `<a href="${l.href}" style="display:inline-block;margin:0 6px;padding:6px 14px;border-radius:20px;background:#f0f9f0;color:${BRAND_GREEN};text-decoration:none;font-size:12px;font-weight:600;">${l.label}</a>`,
        )
        .join("")}
    </div>`;
}

const wrapper = (body: string) => `
<div dir="rtl" style="font-family:'Segoe UI',Tahoma,Arial,sans-serif;background:#f6f7f4;padding:32px 16px;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;">
    <div style="background:${BRAND_GREEN};padding:20px 32px;">
      <div style="font-size:20px;font-weight:700;color:#ffffff;">SpruVex <span style="opacity:.85;font-weight:500;">R</span></div>
    </div>
    <div style="padding:32px;">
      ${body}
      ${socialRow()}
      <div style="margin-top:28px;padding-top:16px;border-top:1px solid #eee;font-size:12px;color:#999;text-align:center;">
        فريق SpruVex — Growth • Vision • Prosperity
      </div>
    </div>
  </div>
</div>`;

function ctaButton(label: string, href: string): string {
  return `<a href="${href}" style="display:inline-block;background:${BRAND_GREEN};color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;margin:16px 0;">${label}</a>`;
}

export function otpEmail(code: string, purpose: "email_verification" | "password_reset" | "login"): { subject: string; html: string } {
  const purposeTitle = purpose === "password_reset" ? "إعادة تعيين كلمة المرور" : "تأكيد البريد الإلكتروني";
  return {
    subject: `${purposeTitle} — رمز التحقق: ${code}`,
    html: wrapper(`
      <p style="font-size:15px;color:#333;">مرحباً،</p>
      <p style="font-size:15px;color:#333;">رمز التحقق الخاص بك لـ${purposeTitle}:</p>
      <div style="font-size:32px;font-weight:700;letter-spacing:8px;text-align:center;background:#f0f9f0;color:${BRAND_GREEN};padding:16px;border-radius:8px;margin:16px 0;">${code}</div>
      <p style="font-size:13px;color:#888;">صالح لمدة 10 دقائق. إذا لم تطلب هذا الرمز، تجاهل هذه الرسالة.</p>
    `),
  };
}

export function welcomeEmail(ownerName: string, tenantName: string, loginUrl: string): { subject: string; html: string } {
  return {
    subject: "مرحباً بك في SpruVex Restaurant",
    html: wrapper(`
      <p style="font-size:15px;color:#333;">مرحباً ${ownerName}،</p>
      <p style="font-size:15px;color:#333;">شكراً لتجربة نظام المطاعم SpruVex R. تم إنشاء حساب مطعم <strong>${tenantName}</strong> التجريبي بنجاح.</p>
      <div style="text-align:center;">${ctaButton("الدخول للوحة التحكم", loginUrl)}</div>
      <p style="font-size:13px;color:#888;">فترتك التجريبية بدأت الآن.</p>
      <div style="margin-top:20px;padding-top:16px;border-top:1px solid #eee;font-size:13px;color:#555;">
        <p style="margin:0 0 8px;font-weight:600;color:#333;">ماذا يمكنك أن تفعل الآن؟</p>
        <ul style="margin:0;padding-inline-start:18px;line-height:1.9;">
          <li>نقطة البيع POS</li>
          <li>إدارة الطاولات</li>
          <li>حسابات الويتر</li>
          <li>شاشة المطبخ KDS</li>
          <li>قائمة QR</li>
          <li>الطلب والدفع الإلكتروني</li>
        </ul>
      </div>
    `),
  };
}

export function staffCredentialsEmail(
  staffName: string,
  tenantName: string,
  email: string,
  password: string,
  loginUrl: string,
): { subject: string; html: string } {
  return {
    subject: `دعوة للانضمام إلى فريق ${tenantName} على SpruVex R`,
    html: wrapper(`
      <p style="font-size:15px;color:#333;">مرحباً ${staffName}،</p>
      <p style="font-size:15px;color:#333;">أُضفت إلى فريق <strong>${tenantName}</strong> على SpruVex R. بيانات الدخول:</p>
      <div style="background:#f6f7f4;border-radius:8px;padding:16px;margin:16px 0;font-size:14px;">
        <div>البريد: <strong dir="ltr">${email}</strong></div>
        <div>كلمة المرور المؤقتة: <strong dir="ltr">${password}</strong></div>
      </div>
      <div style="text-align:center;">${ctaButton("تسجيل الدخول", loginUrl)}</div>
      <p style="font-size:13px;color:#888;margin-top:8px;">يُنصح بتغيير كلمة المرور بعد أول دخول.</p>
    `),
  };
}
