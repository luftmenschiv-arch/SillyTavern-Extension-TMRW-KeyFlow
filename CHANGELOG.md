# Changelog

## 1.3.4
- Redesigned the diagnostic modal using a mobile-first header/content/footer layout.
- Added clear visual hierarchy: product label, report title, and provider badge.
- Made only the report content scroll while the header and copy actions stay visible.
- Changed the close control to a compact 44px circular button in the top-right corner.
- Made copy buttons fill the footer width; the current report is the primary action.
- Hide **Copy all** when only one diagnostic report exists.
- Added safe-area spacing for iPhone and improved small-screen behavior.

## 1.3.3
- Moved the report close button to the top-right corner for easier mobile use.
- Removed the extra bottom close button from the diagnostic dialog.
- Kept the copy buttons in a horizontal two-button layout for a cleaner mobile UI.

## 1.3.2
- Changed diagnostics UI so users read the report before copying it.
- Replaced the top copy buttons with **ดูรายละเอียดล่าสุด** and an in-dialog copy action.
- Added a readable diagnostic dialog window with the full `TMRW—KeyFlow Diagnostic Report`.
- Simplified each saved diagnostic card to a short summary plus a **ดูรายละเอียด** button.

## 1.3.1

- จัดรูปแบบ Diagnostic Report ใหม่เป็น Quick Summary, Request Flow, Suggested Checks และ Technical Details
- เพิ่มคำแนะนำเบื้องต้นตามสาเหตุที่ตรวจพบ เพื่อให้ส่งขอความช่วยเหลือได้ง่ายขึ้น
- ตัดบันทึกคำขอทดสอบที่สำเร็จออก และเก็บเฉพาะ 2 ปัญหาล่าสุด
- แสดงเวลาท้องถิ่นพร้อมเขตเวลา และตัดบรรทัดรายละเอียด Error ที่ยาวเกินไปให้อ่านง่ายขึ้น

## 1.3.0

- Added a privacy-safe **ตรวจสอบคำขอล่าสุด** diagnostic panel with up to 10 recent problem/test records.
- Records the first HTTP/network result, key-rotation outcome, retry result, final cause, elapsed time, provider, model, generic device/browser information, and request ID.
- Added one-tap copy buttons for the latest report, each individual report, or all reports.
- Added an optional minimal connection test using the currently selected model.
- Added detailed classification for quota, authentication, credits, context length, safety, model/endpoint, timeout, gateway, provider outage, overloaded provider, network failure, closed streams, and maximum retries.
- Monitors streaming responses for connection failures or provider error frames that occur after HTTP 200.
- Diagnostic reports redact API keys, tokens, cookies, authorization values, prompt-like fields, request bodies, and long quoted content.
- Existing key management, migration cleanup, cooldown, provider selection, and silent failover behavior remain unchanged.

## 1.2.2

- Put destructive bulk key cleanup actions inside a nested section that is collapsed by default.
- Added a visible safety note and kept the existing confirmation prompt before any bulk deletion.
- Automatically closes the cleanup section when the selected provider no longer has a large key list.

## 1.2.1

- Hide the old-extension migration panel completely after ZerxzLib is no longer active and `allowKeysExposure` is `false`.
- Move large key-list cleanup controls into the regular key manager so having 30+ keys no longer keeps the migration warning panel visible.
- Remove the ZerxzLib-specific duplicate warning from ordinary bulk key management.

## 1.2.0

- Fixed stale ZerxzLib and `allowKeysExposure` warnings remaining visible after cleanup.
- Detects ZerxzLib from SillyTavern's enabled-extension registry instead of leftover page elements.
- Added an optional setting to follow the current Chat Completion source automatically between Google AI Studio and OpenRouter.
- Fixed key-switch notifications with a dedicated mobile-safe notification layer that remains visible above SillyTavern panels.
- Renamed the migration panel when only the large-key cleanup tool is needed.

## 1.1.4

- Fixed the legacy key-cleanup buttons collapsing into narrow vertical columns on mobile.
- Made both bulk-cleanup actions full-width and readable on small screens.

## 1.1.3

- Fixed a JavaScript module parsing error that prevented the extension settings panel from loading.
- Corrected escaping in the copied `allowKeysExposure` Termux command.

## 1.1.2

- Removed references to the unreleased prototype name.
- Made the Termux configuration button full-width and horizontal on mobile.
- Rechecks `allowKeysExposure` after returning to the browser, so the warning clears after SillyTavern restarts.
- Shortened the Termux button label and made the copied command easier to read.

## 1.1.1

- Removed the notification test button.
- Made the **เพิ่มคีย์** button full-width and horizontal on mobile.
- Reworked the key-manager toolbar so **สลับคีย์ถัดไป** no longer collapses into a narrow vertical button.

## 1.1.0

- Released the extension as **TMRW—KeyFlow** by **tmrw**.
- Added a migration assistant for oversized key lists and ZerxzLib installations.
- Added one-tap bulk cleanup: keep the active key only, or delete all keys for the selected provider.
- Added detection of `allowKeysExposure: true` with a copyable Termux fix command.
- Removed the visible activity log and static security/footer blocks.
- Replaced the long key list with a collapsible, searchable, paginated manager.
- Changed automatic and manual rotation to a silent server-side rotation that does not trigger Chat Completion reconnection.
- Improved switch notifications.
- Shortened the `5xx` setting label.
