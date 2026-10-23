# CELIA × Orca — منظومة سيليا للأزياء الذكية بتنسيق الوكلاء المتوازي

<p align="right">
  <strong>FASHION WEAR • 3D COMMERCE • BILINGUAL AI STYLIST • PARALLEL MULTI-AGENT ORCHESTRATION</strong>
</p>

مستودع **`elazamey/CELIA`** هو المظلة المركزية ومركز القيادة لمنظومة **CELIA** للأزياء الذكية، وقد تم تزويده وتهيئته بالكامل للعمل مع منصة **[stablyai/orca](https://github.com/stablyai/orca)** لتشغيل وتنسيق أسطول من وكلاء الذكاء الاصطناعي (Claude Code، Codex، Grok، OpenCode، Cursor) بالتوازي داخل مسارات `git worktree` معزولة.

---

## كيف يفيد `stablyai/orca` منظومة CELIA؟

بدل الاكتفاء بنسخ جامد للملفات، تم توظيف **Orca** داخل المستودع عبر **5 طبقات عملية متكاملة**:

1. **ربط رسمي خفيف وقابل للتحديث (`./orca` Git Submodule)**:
   - ربط مستودع [`stablyai/orca`](https://github.com/stablyai/orca.git) كموديول فرعي رسمي في `.gitmodules` بدون تضخيم مستودع `CELIA` بـ 39 ألف ملف، مع إمكانية جلب مصدر Orca أو تحديثه بأمر واحد (`npm run init:orca`).
2. **تهيئة أصلية لمسارات العمل المتوازية (`orca.yaml` + `.worktreeinclude`)**:
   - عند فتح مشروع `CELIA` داخل تطبيق **Orca** وإنشاء أي `Worktree` جديد، يقوم Orca تلقائياً بتجهيز البيئة، مشاركة مجلدي `.cache` و`.workspaces` بين الوكلاء، نقل ملفات `.env` المحلية بأمان دون رفعها إلى Git، وفتح تبويبات جاهزة للوكيل ولوحة القيادة والفحص الصحي.
3. **إضافة Orca مخصصة لمنظومة سيليا (`plugins/celia-ops` — `elazamey.celia-ops`)**:
   - إضافة أصلية متوافقة مع **Orca Plugin API v1** تضيف لوحة جانبية عربية (`CELIA Studio`) داخل Orca لإرسال أوامر الفحص والتشغيل وتوليد الخطط مباشرة للطرفيات، مع عامل خلفي (Worker) يرصد اكتمال مهام الوكلاء وإنشاء المسارات.
4. **مهارة ودليل تنسيق الوكلاء (`AGENTS.md` + `.agents/skills/celia-orca-orchestrator`)**:
   - يزوّد الوكلاء بخريطة مستودعات منظومة CELIA الستة وقوالب تقسيم المهام المتوازية (تطوير الواجهة RTL، العرض ثلاثي الأبعاد، المساعد الذكي Groq/Gemini، وبوابة الاختبارات والأمان).
5. **لوحة قيادة تفاعلية وأداة CLI (`hub/` + `scripts/celia-orchestrator.mjs`)**:
   - واجهة ويب عربية فاخرة مع محاكي حي لإضافة `CELIA Studio` ومولّد خطط `git worktree` وأوامر جدولة `orca automations` بتوقيت القاهرة (`Africa/Cairo`).

---

## خريطة منظومة CELIA المرتبطة

| المكوّن | المستودع | الدور في المنظومة |
|---|---|---|
| **CELIA Hub** | `elazamey/CELIA` | المستودع المركزي، إعدادات `orca.yaml`، إضافة `elazamey.celia-ops`، ولوحة القيادة |
| **CELIA Storefront** | `elazamey/ELAZAMEY` | متجر الأزياء الإلكتروني (Next.js 14، TypeScript، Tailwind، MongoDB) |
| **CELIA 3D & AI** | `elazamey/celia-fashion-live` | عرض ثلاثي الأبعاد للملابس (Three.js + GSAP) وتوصيات ذكية (Flask + scikit-learn) |
| **Celia Assistant** | `elazamey/celia.assestent` | المساعد الذكي ومستشار الأزياء (`/chat` مع التبديل التلقائي بين Groq وGemini) |
| **Celia Dreams** | `elazamey/celia_dreams` | النواة المعمارية النظيفة (`core`, `agents`, `api`, `data`, ADRs) |
| **NEXA Protocol** | `elazamey/nexa` | حوكمة صلاحيات الوكلاء وسلسلة الأدلة الموقعة قبل اعتماد المخرجات |

---

## التشغيل السريع

يتطلب المشروع **Node.js 18+** و**Git** (بدون أي حزم خارجية معقدة):

```bash
# 1. فحص صحة التكامل ومطابقة مخططات Orca
npm run doctor

# 2. تشغيل الاختبارات الآلية
npm test

# 3. تشغيل لوحة قيادة CELIA × Orca التفاعلية (على المنفذ 4173)
npm run hub
```

### أوامر التنسيق ومزامنة Orca

```bash
# عرض حالة المنظومة والخدمات المسجلة
npm run status

# توليد خطة عمل متوازية عبر 4 وكلاء لإطلاق تشكيلة أزياء موسمية
npm run plan -- seasonal-collection-launch

# عرض أوامر الأتمتة المجدولة الجاهزة لمنصة Orca
npm run automations

# جلب الكود المصدري الكامل لـ stablyai/orca داخل ./orca (نسخة سطحية سريعة --depth 1)
npm run init:orca

# تثبيت مهارات Orca الرسمية للوكلاء (orca-cli, orchestration, computer-use, orca-linear)
npm run skills:orca

# جلب مستودعات منظومة CELIA الشقيقة داخل .workspaces/ المشترك بين الـ worktrees
bash scripts/orca-sync.sh sync-services
```

---

## استخدام الإضافة `elazamey.celia-ops` داخل تطبيق Orca

1. حمّل تطبيق **Orca** من [onorca.dev/download](https://onorca.dev/download) وافتح مستودع `CELIA` (سيقرأ ملف `orca.yaml` تلقائياً).
2. من إعدادات الإضافات في Orca، ثبّت الإضافة المحلية من المسار:
   `plugins/celia-ops`
3. ستظهر أيقونة **CELIA Studio** في الشريط الجانبي الأيمن مع أوامر `CELIA: ملخص نشاط المسارات والوكلاء` وإشعارات اكتمال مهام الوكلاء.

---

## هيكل المستودع

```text
CELIA/
├── .gitmodules                                # ربط stablyai/orca كموديول فرعي رسمي
├── .worktreeinclude                           # نقل ملفات .env المحلية تلقائياً للمسارات الجديدة
├── orca/                                      # نقطة ربط مستودع stablyai/orca
├── orca.yaml                                  # إعدادات مسارات العمل والتبويبات الافتراضية في Orca
├── .orca/issue-command                        # قالب توجيه التذاكر للوكلاء
├── AGENTS.md / CLAUDE.md                      # القواعد الهندسية وسياق منظومة CELIA للوكلاء
├── .agents/skills/celia-orca-orchestrator/    # مهارة تنسيق الوكلاء المتوازيين لميزات الأزياء
├── config/celia-ecosystem.json                # سجل خدمات CELIA وخطط الوكلاء والأتمتة
├── plugins/celia-ops/                         # إضافة Orca الرسمية (orca-plugin.json + main.mjs + panel.html)
├── scripts/                                   # أدوات الفحص، المزامنة، وتوليد خطط التنسيق
├── hub/                                       # خادم وواجهة مركز قيادة CELIA × Orca التفاعلية
├── tests/orca-integration.test.mjs            # اختبارات التحقق الآلية الشاملة
└── .github/workflows/ci.yml                   # فحص مستمر عبر GitHub Actions
```
