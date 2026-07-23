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
4. Choose **Load unpacked** and select the `release-en` folder (English UI). The `release` folder ships the same build with a Traditional Chinese UI.

## Privacy

- Settings and diagnostics stay in local browser storage and are never uploaded automatically.
- Diagnostics are disabled by default. Once enabled, they record playback page URLs plus performance and CDN data, and can be disabled or cleared at any time.
- Exported diagnostic JSON may contain playback page URLs and media identifiers. Redact it before sharing.

## Development

Node.js 22 or later is required.

```powershell
npm test
npm run build:release
```

The build output is written to `release`.

## License

[MIT](LICENSE)
