# نشر SpruVex R مجاناً: Render (الخدمات) + Neon (قاعدة البيانات)

## لماذا Neon بدل قاعدة Render؟

قاعدة Postgres المجانية على Render **تُحذف بعد 30 يوماً** — وهذا ما حدث لـ `spruvex-r-db` (خطأ Prisma `P1001` في سجل `spruvex-r-api`).
**Neon** (https://neon.tech) مجاني بلا بطاقة ائتمان و**لا يحذف القاعدة**: فقط "تنام" عند عدم الاستخدام وتستيقظ تلقائياً خلال ثوانٍ عند أول طلب. الحد المجاني (0.5 GB) يكفي التجربة بسهولة.

## ما الذي يحدث تلقائياً (لا تحتاج تنفيذ SQL)

عند كل تشغيل لـ `spruvex-r-api` (كل خطوة آمنة للتكرار):

1. ينشئ الدور المقيّد `spruvex_app` (NOBYPASSRLS — عزل بيانات كل مطعم) ويعطيه الصلاحيات (`RUN_DB_BOOTSTRAP=true`).
2. يشغّل كل ترحيلات Prisma (`RUN_DB_MIGRATE=true`).
3. يملأ جداول الصلاحيات ووحدات القياس والباقات، وينشئ مدير المنصة الأول إن وُضع `PLATFORM_ADMIN_EMAIL` و`PLATFORM_ADMIN_PASSWORD`.
4. يبني رابط `DATABASE_URL` الخاص بـ `spruvex_app` بنفسه من رابط Neon + كلمة مرور يولّدها Render (`BOOTSTRAP_APP_ROLE_PASSWORD`).

إذن أنت تلصق **رابطاً واحداً فقط**.

## الخطوات

### 1. أنشئ قاعدة Neon
1. ادخل https://neon.tech ← **Sign up** بحساب GitHub.
2. **Create project**: الاسم `spruvex-r`، إصدار Postgres الافتراضي، المنطقة **AWS US West 2 (Oregon)** — نفس منطقة خدمات Render الافتراضية، حتى لا يتأخر كل استعلام.
3. من **Connect** (لوحة المشروع): **أطفئ "Connection pooling"**، ثم انسخ الرابط. يبدأ بـ `postgresql://neondb_owner:...` ولا يحتوي كلمة `-pooler`.

### 2. اربطه بـ Render
1. في Render افتح `spruvex-r-api` ← **Environment**.
2. ضع رابط Neon في `ADMIN_DATABASE_URL`.
3. **احذف** متغيّر `DATABASE_URL` القديم إن وُجد (سيُبنى تلقائياً).
4. تأكد من وجود: `RUN_DB_BOOTSTRAP=true`, `RUN_DB_MIGRATE=true`, `BOOTSTRAP_APP_ROLE_PASSWORD` (أي قيمة طويلة عشوائية), `DASHBOARD_BASE_URL=https://spruvex-r-dashboard.onrender.com`, و `SPRUVEX_SITE_API_KEY` (قيمة عشوائية 32 حرفاً أو أكثر).
   - أسهل طريقة: من Blueprint اضغط **Sync** ليطبّق `render.yaml` الجديد، ثم املأ `ADMIN_DATABASE_URL` فقط.
5. **Save, rebuild, and deploy**. في السجل (Logs) يجب أن ترى:
   `[bootstrap] spruvex_app role + grants done` ← `All migrations have been successfully applied` ← `[reference-data] ... synced`.

### 3. اربط موقع spruvex-site
في خدمة `spruvex-site`، ضع:
- `SPRUVEX_R_API_URL=https://spruvex-r-api.onrender.com`
- `SPRUVEX_SITE_API_KEY` = **نفس القيمة بالضبط** الموجودة في `spruvex-r-api`.

### 4. تأكد أن الخدمات الست تعمل
| الخدمة | الرابط |
|---|---|
| API | `https://spruvex-r-api.onrender.com/api/v1/health` ← يجب أن يعرض `"status":"ok"` |
| لوحة التحكم | `https://spruvex-r-dashboard.onrender.com` |
| نقطة البيع | `https://spruvex-r-pos.onrender.com` |
| شاشة المطبخ | `https://spruvex-r-kds.onrender.com` |
| طلب العميل | `https://spruvex-r-ordering.onrender.com` |
| إدارة المنصة | `https://spruvex-r-platform.onrender.com` |

كل خدمة مجانية تنام بعد 15 دقيقة، وأول فتح يأخذ ~30-60 ثانية. هذا طبيعي.

### 5. جرّب التسجيل المجاني
من موقع spruvex-site سجّل مطعماً تجريبياً ← يصلك رمز التحقق على البريد ← بعد إدخاله تدخل لوحة التحكم مباشرة.

## إذا ظهرت مشكلة
- `P1001` في السجل: رابط Neon خاطئ أو ناقص — انسخه من جديد.
- `lacks BYPASSRLS`: استخدمت دوراً غير المالك؛ استخدم رابط `neondb_owner`.
- التسجيل من الموقع يفشل بـ 401: قيمة `SPRUVEX_SITE_API_KEY` غير متطابقة بين الخدمتين.

## قبل أول عميل يدفع
- رقِّ خدمة الـ API لباقة مدفوعة (لا نوم + قرص دائم للصور المرفوعة).
- Neon المجاني يحفظ سجل تغييرات لفترة قصيرة فقط؛ اضبط نسخاً احتياطياً دورياً (راجع `docs/DATABASE.md`).
