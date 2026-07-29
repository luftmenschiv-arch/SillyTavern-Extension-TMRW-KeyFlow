# TMRW—KeyFlow

Smart API-key failover for SillyTavern by **tmrw**.

TMRW—KeyFlow keeps the current key until a real API error occurs, then switches to the next available key and retries the interrupted request once. It supports Google AI Studio (`AIza…` and `AQ.…`) and OpenRouter (`sk-or-…`).

## Highlights

- Switches only after configured errors (`401/403`, `429`, `402`, optional `5xx`)
- Retries the interrupted request once without creating an infinite loop
- Optionally follows the active Chat Completion source between Google AI Studio and OpenRouter
- Mobile-friendly key manager with search and pagination
- One-tap bulk cleanup inside the key manager for large key lists
- Detects `allowKeysExposure: true`, provides a ready-to-copy Termux fix command, and rechecks after restart
- Supports bulk key import, manual selection, rename, delete, and cooldowns
- Privacy-safe diagnostics for the latest 10 failed/test requests, including the initial result, rotation result, retry result, final cause, elapsed time, provider, model, and generic device/browser information
- Copyable support reports with API keys, prompts, chat content, request bodies, cookies, and tokens excluded
- Optional minimal connection test using the currently selected model

## Install on Termux

1. Download the ZIP into Android's **Download** folder.
2. Stop SillyTavern with `Ctrl+C`.
3. Run the commands from `INSTALL-TERMUX.txt`.
4. Reload SillyTavern and open **Extensions → TMRW—KeyFlow**.

If ZerxzLib is installed, disable or remove it before using KeyFlow to prevent both extensions from rotating keys at the same time. Removing an extension does not delete API keys stored by SillyTavern.

## Security

Raw API keys are sent only to SillyTavern's own `/api/secrets/write` endpoint. KeyFlow reads masked key metadata from the secret manager and does not place raw keys in extension settings or logs.

Diagnostic records are limited to 10 entries and store only technical metadata needed for troubleshooting. Keys, authorization values, prompts, chat content, request bodies, cookies, tokens, and long quoted content are redacted or excluded before storage.

## License

TMRW—KeyFlow is licensed under the **TMRW Non-Commercial Attribution License v1.0**.

You may use, modify, and redistribute this software for non-commercial
purposes only, provided that attribution to **tmrw** is retained.

Commercial use, sale, monetization, and use in paid products or services
are prohibited.

See the [LICENSE](LICENSE) file for the complete terms.
