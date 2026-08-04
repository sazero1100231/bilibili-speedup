# Bilibili Speedup

[繁體中文](README.md)

An unofficial extension for Chrome and Edge. It tests the CDN routes Bilibili provides for the current video and selects a working route. If no safe candidate is available, it keeps native playback.

> This extension does not bypass regional restrictions. Results depend on location, account access, and current CDN conditions.

## Features

- Tests and switches between available CDN routes automatically.
- Removes common tracking parameters and blocks selected telemetry and promotional content.
- Stores local playback and CDN diagnostics to help investigate buffering.

## Install

Chrome or Edge 120 or later is required.

1. Download and extract this repository.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select `release-en` for the English UI, or `release` for the Traditional Chinese UI.

## Privacy

- Settings and diagnostics stay in local browser storage and are never uploaded automatically.
- Diagnostics are disabled by default. Once enabled, they retain canonical playback page URLs (query strings and fragments are removed), media/Presentation/route identifiers, performance and CDN data, event details, and exact timestamps so troubleshooting evidence is not lost. They can be disabled or cleared at any time.
- Before reporting a playback issue, choose **Enable diagnostics and start recording** in the diagnostics panel, then reproduce the issue on the playback page. The panel synchronizes active sessions before export and prevents a file with no playback sessions from being mistaken for useful diagnostics.
- Exported diagnostic JSON is a complete technical record and may identify played content or usage context. Review and redact it item by item before sharing; do not upload it publicly as-is.

## Development

Node.js 22 or later is required.

```powershell
npm test
npm run build:release
```

Build outputs are written to `release` (Traditional Chinese) and `release-en` (English).

## License

[MIT](LICENSE)
