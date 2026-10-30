# pey.sync

[![AI](https://img.shields.io/badge/Built%20with-AI-blueviolet)](#)
[![version](https://img.shields.io/badge/version-1.0.0-blue.svg)](#)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Bonyan Architecture](https://img.shields.io/badge/bonyan-0.11-56c3bf)](https://github.com/barnevis/bonyan)

موتور همگام‌سازی دستی و backend-neutral برای مجموعه‌های `pey.storage.service` به فضای انتخابی کاربر (بک‌اندها: `git` بر فراز GitHub Contents API؛ kindهای تازه با دیسکریپتور ثبت می‌شوند، بی‌نیاز از ویرایش هسته). برای استخراج مستقل، فقط همین پوشه جابه‌جا می‌شود (بدون ارجاع بیرونی به‌جز `pey.*`).

## ساختار

- `manifest.json` — قرارداد معتبر افزونه.
- `index.js` — نقطه‌های ورود `prepare` و `activate` بنیان (فقط سیم‌کشی).
- `lib/` — سرویس لاغر + ماژول‌های متمرکز (scope، paths، collect، remote، round، backend، store، state)، موتور تصمیم خالص، سریالایزرها، خطاها.
- `adapters/` — بک‌اندها (`git`) + قرارداد kind تازه.
- `tests/` — تست هر فایل سورس (از جمله سوئیت قرارداد kind در `sync-target-contract.test.js`).
- `docs/requirements.md` — تنها منبع حقیقت پیاده‌سازی.
- `CHANGELOG.md` — تاریخچه نسخه‌های این افزونه.

## وابستگی‌ها

- **لازم:** `pey.storage.service` — خواندن/نوشتن رکوردها و وضعیت/اعتبار موتور.
- **اختیاری:** هیچ‌کدام.

## همچنین ببینید

- `docs/reference.md` برای API کامل، ایونت‌ها، خطاها، دامنه، ثبت بک‌اند، قواعد و محدودیت‌ها.
