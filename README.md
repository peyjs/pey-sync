# pey.sync

[![AI](https://img.shields.io/badge/Built%20with-AI-blueviolet)](#)
[![version](https://img.shields.io/badge/version-2.0.1-blue.svg)](#)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Bonyan Architecture](https://img.shields.io/badge/bonyan-0.11-56c3bf)](https://github.com/barnevis/bonyan)

## هدف

افزونه‌ی زیرساختی (infrastructure) از زیست‌بوم پی برای همگام‌سازی دستی و backend-neutral کالکشن‌های `pey.storage.service` به فضای انتخابی کاربر (بک‌اندهای همراه: `git` بر فراز GitHub Contents API و `gitlab` بر فراز GitLab Repository API؛ kindهای تازه با دیسکریپتور ثبت می‌شوند، بی‌نیاز از ویرایش هسته).

## ساختار

- `adapters/` — بک‌اندها و قرارداد kind تازه.
- `docs/` — سندهای پروژه.
- `lib/` — سرویس، موتور تصمیم خالص، سریالایزرها و خطاها.
- `tests/` — آزمون‌های افزونه و سوئیت قرارداد kind.
- `index.js` — نقطه‌ی ورود.
- `manifest.json` — قرارداد افزونه.

## وابستگی‌ها

- **الزامی:** `pey.storage.service` — خواندن/نوشتن رکوردها و وضعیت/اعتبار موتور.
- **اختیاری:** ندارد.

## نصب و استفاده

افزونه با `manifest.json` و بستهٔ npm به برنامه‌ی میزبان افزوده می‌شود و پس از دو فاز آماده‌سازی و فعال‌سازی، سرویس `pey.sync.service` را عرضه می‌کند. میزبان مقصد را با `configureBackend` تنظیم می‌کند، هر همگام‌سازی با `syncNow` دستی اجرا می‌شود و تعارض‌ها با پرسشِ هر دو سو و `resolveConflict` حل می‌شوند؛ اسکیمای استورها (`sync_backends`، `sync_state`) از پیکربندی `pey.storage` می‌آید.

## مجوز

این پروژه با مجوز MIT منتشر شده است؛ متن کامل در [LICENSE](LICENSE).

## سندهای مرتبط

- [معرفی](docs/introduction.md) — شناخت افزونه به زبان ساده.
- [مرجع](docs/reference.md) — API، رویدادها، خطاها و پیکربندی.
- [نیازمندی‌ها](docs/requirements.md) — سند ساخت افزونه، مکتوب پیش از پیاده‌سازی.
