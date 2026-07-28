# TMRW—KeyFlow

Smart API-key failover for SillyTavern by **tmrw**.

TMRW—KeyFlow keeps the current key until a real API error occurs, then switches to the next available key and retries the interrupted request once. It supports Google AI Studio (`AIza…` and `AQ.…`) and OpenRouter (`sk-or-…`).

## Highlights

- Switches only after configured errors (`401/403`, `429`, `402`, optional `5xx`)
- Retries the interrupted request once without creating an infinite loop
- Mobile-friendly key manager with search and pagination
- One-tap cleanup for oversized key lists left by older extensions
- Detects `allowKeysExposure: true` and provides a ready-to-copy Termux fix command
- Supports bulk key import, manual selection, rename, delete, and cooldowns

## Install on Termux

1. Download the ZIP into Android's **Download** folder.
2. Stop SillyTavern with `Ctrl+C`.
3. Run the commands from `INSTALL-TERMUX.txt`.
4. Reload SillyTavern and open **Extensions → TMRW—KeyFlow**.

The installer removes the old local `SillyTavern-Extension-KeyPilot` folder to prevent both versions from loading together. It does not remove your API keys.

## Security

Raw API keys are sent only to SillyTavern's own `/api/secrets/write` endpoint. KeyFlow reads masked key metadata from the secret manager and does not place raw keys in extension settings or logs.

## License

TMRW—KeyFlow is licensed under the **TMRW Non-Commercial Attribution License v1.0**.

You may use, modify, and redistribute this software for non-commercial
purposes only, provided that attribution to **tmrw** is retained.

Commercial use, sale, monetization, and use in paid products or services
are prohibited.

See the [LICENSE](LICENSE) file for the complete terms.
