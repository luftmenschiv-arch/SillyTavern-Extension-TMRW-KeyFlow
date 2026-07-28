# Changelog

## 1.1.1

- Removed the notification test button.
- Made the **เพิ่มคีย์** button full-width and horizontal on mobile.
- Reworked the key-manager toolbar so **สลับคีย์ถัดไป** no longer collapses into a narrow vertical button.

## 1.1.0

- Renamed the extension to **TMRW—KeyFlow** and changed the author to **tmrw**.
- Added migration from legacy `keypilot` settings.
- Added a migration assistant for oversized key lists and old extensions.
- Added one-tap bulk cleanup: keep the active key only, or delete all keys for the selected provider.
- Added detection of `allowKeysExposure: true` with a copyable Termux fix command.
- Removed the visible activity log and static security/footer blocks.
- Replaced the long key list with a collapsible, searchable, paginated manager.
- Changed automatic and manual rotation to a silent server-side rotation that does not trigger Chat Completion reconnection.
- Improved switch notifications and added a notification test button.
- Shortened the `5xx` setting label.

## 1.0.1

- Fixed Termux installation path for per-user SillyTavern extensions.

## 1.0.0

- Initial KeyPilot prototype.
