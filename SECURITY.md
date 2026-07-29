# Security

TMRW—KeyFlow does not require `allowKeysExposure: true`.

- New keys are written through SillyTavern's `/api/secrets/write` endpoint.
- The extension reads only the masked state returned by `/api/secrets/read`.
- Raw keys are not stored in extension settings, browser storage, or logs.
- Key rotation and deletion use SillyTavern's local secret endpoints.
- The migration cleanup is irreversible; the UI asks for confirmation before deleting keys.
- Diagnostic history is limited to 10 records and does not store prompts, chat content, request bodies, raw API keys, cookies, or tokens.
- Technical error details are extracted only from known error fields and are redacted before being saved or copied.

Do not publish screenshots containing raw API keys, and revoke any key that may have been exposed.
