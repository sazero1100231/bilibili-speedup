# Bilibili Speedup

[English](README.en.md)

非官方的 Chrome／Edge 擴充功能。它會測試 Bilibili 為目前影片提供的 CDN 路線並選擇可用路線；沒有安全候選時，維持原生播放。

> 不提供地區解鎖。實際效果會隨所在地、帳號權限與 CDN 狀態而異。

## 功能

- 自動測試並切換可用 CDN。
- 清除常見追蹤參數，封鎖部分遙測與推廣內容。
- 在瀏覽器本機記錄播放與節點狀態，方便排查卡頓。

## 安裝

需要 Chrome 或 Edge 120 以上版本。

1. 下載並解壓縮本專案。
2. 開啟 `chrome://extensions` 或 `edge://extensions`。
3. 啟用「開發人員模式」。
4. 選擇「載入解壓縮」，並指定 `release` 資料夾。

## 隱私

- 設定與診斷資料只保存在瀏覽器本機，不會自動上傳。
- 診斷預設關閉；開啟後才會記錄播放頁網址及效能／CDN 資料，可隨時關閉或清除。
- 匯出的診斷 JSON 可能包含播放頁網址與影音識別碼，分享前請先遮蔽。

## 開發

需要 Node.js 22 以上版本。

```powershell
npm test
npm run build:release
```

建置結果位於 `release`。

## 授權

[MIT](LICENSE)
