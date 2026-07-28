# Security

TMRW—KeyFlow does not require `allowKeysExposure: true`.

- New keys are written through SillyTavern's `/api/secrets/write` endpoint.
- The extension reads only the masked state returned by `/api/secrets/read`.
- Raw keys are not stored in extension settings, browser storage, or logs.
- Key rotation and deletion use SillyTavern's local secret endpoints.
- The migration cleanup is irreversible; the UI asks for confirmation before deleting keys.

Do not publish screenshots containing raw API keys, and revoke any key that may have been exposed.
