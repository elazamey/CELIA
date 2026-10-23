---
name: celia-orca-orchestrator
description: >-
  تنسيق وتوزيع مهام تطوير منظومة CELIA للأزياء الذكية عبر مسارات git worktree
  متوازية ووكلاء متعددين باستخدام منصة Orca (stablyai/orca)، بما يشمل متجر
  الأزياء، العرض ثلاثي الأبعاد، المساعد الذكي Groq/Gemini، وفحوصات الجودة.
---

# مهارة تنسيق منظومة CELIA عبر Orca

استخدم هذه المهارة عندما يطلب المستخدم بناء ميزة متعددة الطبقات في منظومة **CELIA**، أو تقسيم العمل على عدة وكلاء بالتوازي داخل **Orca**، أو إعداد أتمتة دورية للمستودع.

## 1. تحديد أمر Orca التنفيذي في الجلسة

حدد اسم الملف التنفيذي مرة واحدة واستخدمه في الأوامر اللاحقة:

1. إذا كان المتغير `ORCA_CLI_COMMAND` مضبوطاً في البيئة، استخدم قيمته.
2. إذا كنت داخل نسخة تطوير محلية لـ Orca (`ORCA_DEV_REPO_ROOT`)، استخدم `orca-dev`.
3. على نظام Linux خارج طرفيات Orca المُدارة، استخدم `orca-ide` (لا تشغّل `orca` المجرد خارج طرفيات Orca على Linux لأنه قد يشير إلى قارئ الشاشة GNOME Orca).
4. في باقي الحالات على macOS/Windows وداخل طرفيات Orca، استخدم `orca`.

لتحميل دليل التنسيق المطابق لإصدار Orca المثبّت:

```bash
orca skills get orchestration
orca skills get orca-cli
```

## 2. استطلاع حالة منظومة CELIA قبل التوزيع

شغّل أداة التنسيق المحلية لقراءة خريطة الخدمات والخطط الجاهزة:

```bash
node scripts/celia-orchestrator.mjs status
node scripts/celia-orchestrator.mjs plan seasonal-collection-launch
```

## 3. نمط التقسيم القياسي لميزات CELIA (Fan-Out Worktrees)

لتفادي تعارضات الدمج (Merge Conflicts)، افصل المهام حسب الحدود الوظيفية:

- **`wt/storefront-ui`**: واجهات المتجر، بطاقات الملابس، الفلاتر، وتجربة العربية RTL والتجاوب مع الجوال.
- **`wt/3d-and-media`**: مشاهد Three.js، تحسين الصور والأصول البصرية، وحركات GSAP.
- **`wt/ai-stylist`**: منطق محادثة `Celia Assistant`، هندسة الأوامر لاقتراح المقاسات والتنسيقات، والتبديل التلقائي بين Groq وGemini.
- **`wt/qa-and-security`**: الاختبارات الآلية، التحقق من عدم تسرب أي أسرار، وفحص الأداء قبل الدمج في `main`.

## 4. بوابة القبول والدمج (Evidence Gate)

لا تدمج أي فرع في `main` إلا بعد نجاح الفحص الحتمي:

```bash
npm run validate
npm test
bash scripts/celia-doctor.sh
```
