// English locale for the release build.
//
// The `src/` UI is authored in Traditional Chinese. `build-release.js` runs the
// UI files (popup/options/diagnostics HTML + JS) and the telemetry endpoint
// catalogue through the map below so the `release/` bundle ships an
// English-only operator UI, while `src/` stays Chinese for development.
//
// Each entry is a before -> after pair. Keys are the exact maximal runs of
// Chinese characters that appear in the sources (ASCII technical tokens such as
// `URL`, `DNR`, `baseUrl`, `Presentation`, `m4s/flv/mp4` sit between runs and
// are preserved as-is). `build-release.js` applies the longest keys first and
// then asserts that no Chinese characters remain, so an omission fails the
// build rather than shipping mixed-language text.

export const TRANSLATIONS = Object.freeze({
  // Full sentences (options descriptions, endpoint rationale/side-effect).
  "所有設定與量測只保留在這台裝置。功能變更會立即更新規則，已開啟的頁面建議重載。":
    "All settings and measurements stay on this device only. Feature changes update the rules immediately; reload any open pages.",
  "記錄卡頓、緩衝時間、起播、節點、改寫與回退；不會上傳。":
    "Records stalls, buffering time, first-play, nodes, rewrites, and fallbacks; never uploaded.",
  "會影響跨裝置續播、觀看歷史或播放進度；預設關閉。":
    "Affects cross-device resume, watch history, or playback progress; off by default.",
  "自動模式以真實媒體路徑測速；手動模式固定首選。":
    "Auto mode probes using the real media path; manual mode keeps a fixed preferred node.",
  "已停用並移除網路規則；重載頁面後不再注入。":
    "Disabled and network rules removed; no injection after reload.",
  "測速快取已清除，下一支影片會重新測速。":
    "Probe cache cleared; the next video will re-probe.",
  "尚未測速；播放支援的視頻後會自動測量。":
    "Not probed yet; measurement runs automatically after a supported video plays.",
  "注入本地保守選擇器，不使用遠端清單。":
    "Injects local conservative selectors; no remote lists.",
  "已套用；重載頁面可確保全部模組更新。":
    "Applied; reload the page to ensure all modules update.",
  "選配封鎖觀看心跳與進度相關請求。":
    "Optionally blocks watch-heartbeat and progress requests.",
  "不應影響播放、歷史或會員功能。":
    "Should not affect playback, history, or membership features.",
  "可能使部分活動或推廣模組留白。":
    "May leave some campaign or promo modules blank.",
  "封鎖新版網頁行為埋點上報。": "Blocks the new web behavior tracking beacons.",
  "封鎖商業化與廣告投放請求。": "Blocks commercial and ad-delivery requests.",
  "僅在「手動指定」時生效。": "Applies only in Manual mode.",
  "封鎖網頁行為埋點上報。": "Blocks web behavior tracking beacons.",

  // manifest.release.json (name / short_name / description; "海外加速" and
  // "改寫" below are reused).
  "海外播放加速與追蹤淨化": "Overseas Playback Speedup and Tracking Cleaner",
  "改寫與追蹤淨化改善": "rewriting, and tracking cleanup to improve",
  "海外播放體驗。": "overseas playback.",
  "節點評估、": "node probing, ",
  "以本地": "Uses local",

  // Fragments that wrap ASCII technical tokens.
  "。匯出只會在你按下按鈕後產生本地": ". Export produces a local",
  "暫無已驗證加速節點；無候選時保留":
    "No verified speedup node yet; with no candidate it keeps",
  "動態／分頁規則與內容腳本註冊。":
    "dynamic/tab rules and content-script registrations.",
  "只處理普通視頻與番劇的媒體": "Handles only the media",
  "，不解除地區限制。":
    " of regular videos and bangumi; does not bypass regional limits.",
  "、頁面連結與分享剪貼簿。": ", page links, and share clipboard.",
  "已儲存。建議重載已開啟的": "Saved. Reload any open",
  "最近一場：播放器明細": "Latest session: Player details",
  "以每分頁的完整簽名": "Per-tab fully signed",
  "每個節點的結果快取": "Caches each node result for",
  "儲存本地播放量測": "Store local playback measurements",
  "改寫／回退／降權": "Rewrite/Fallback/Degrade",
  "；測速排序首選：": "; probe-ranked pick: ",
  "無法讀取診斷資料": "Unable to read diagnostics",
  "本地量測已清除。": "Local measurements cleared.",
  "關閉後移除全部": "Turning this off removes all",
  "此頁只讀取本機": "This page reads only local",
  "規劃／實際節點": "Planned/Actual node",
  "測速排序首選：": "Probe-ranked pick: ",
  "相容／頻寬不足": "Compatible/low bandwidth",
  "尚無播放器明細": "No player details yet",
  "讀取節點狀態": "Loading node status",
  "啟用播放加速": "Enable playback speedup",
  "主路徑，重排": "primary path; reorders",
  "路由處理劣質": "routes poor",
  "處理網址列、": "Handles the address bar, ",
  "遙測端點封鎖": "Telemetry endpoint blocking",
  "推廣元素隱藏": "Hide promotional elements",
  "清除測速快取": "Clear probe cache",
  "開啟診斷面板": "Open diagnostics panel",
  "清除本地量測": "Clear local measurements",
  "（測速首選）": " (probe pick)",
  "無法讀取設定": "Unable to read settings",
  "實際路由切換": "Actual route switches",
  "規則生效延遲": "Rule apply latency",
  "網路層兜底": "network-layer fallback",
  "雙層處理。": "in two layers.",
  "診斷與量測": "Diagnostics & measurement",
  "最近一場：": "Latest session: ",
  "儲存失敗：": "Save failed: ",
  "清除失敗：": "Clear failed: ",
  "載入失敗：": "Load failed: ",
  "最後測速：": "Last probe: ",
  "已產生本地": "Generated a local",
  "海外加速": "Overseas Speedup",
  "全域啟用": "Global enable",
  "播放加速": "Playback speedup",
  "遙測封鎖": "Telemetry blocking",
  "詳細設定": "Advanced settings",
  "節點策略": "Node strategy",
  "自動測速": "Auto probe",
  "手動指定": "Manual",
  "手動節點": "Manual node",
  "測速快取": "Probe cache",
  "追蹤淨化": "Tracking cleanup",
  "參數淨化": "parameter cleaning",
  "儲存設定": "Save settings",
  "診斷面板": "Diagnostics panel",
  "最近一場": "Latest session",
  "播放秒數": "Play seconds",
  "測速結果": "probe results",
  "重新整理": "Refresh",
  "播放場次": "Play sessions",
  "原生路由": "native routing",
  "讀取失敗": "Load failed",
  "未知錯誤": "unknown error",
  "尚無資料": "No data yet",
  "卡頓事件": "Stall events",
  "起播時間": "First-play time",
  "規劃節點": "Planned node",
  "實際節點": "Actual node",
  "改寫次數": "Rewrite count",
  "回退次數": "Fallback count",
  "主動降權": "Active degrade",
  "分頁規則": "Tab rules",
  "匯出檔。": "export file.",
  "清除失敗": "Clear failed",
  "節點。": "nodes.",
  "分鐘。": "minutes.",
  "播放器": "Player",
  "套用中": "Applying",
  "儲存中": "Saving",
  "頁面。": "pages.",
  "清除中": "Clearing",
  "總緩衝": "Total buffering",
  "淨化": "cleaning",
  "診斷": "Diagnostics",
  "設定": "Settings",
  "改寫": "Rewrite",
  "使用": "Uses",
  "檔。": "file only after you click the button.",
  "明細": "details",
  "類型": "Type",
  "規劃": "Planned",
  "實際": "Actual",
  "切換": "Switches",
  "吞吐": "Throughput",
  "恢復": "Recovery",
  "節點": "Node",
  "狀態": "Status",
  "時間": "Time",
  "頁面": "Page",
  "卡頓": "Stalls",
  "緩衝": "Buffering",
  "起播": "First-play",
  "匯出": "Export",
  "健康": "Healthy",
  "失敗": "Failed",
  "尚無": "No",
  "與": "and",
  "。": ".",
  "／": "/",
  "無": "none"
});

// Matches any Traditional/Simplified Han character plus CJK and fullwidth
// punctuation. Used both to translate and to assert nothing was missed.
export const CJK_PATTERN = /[　-〿㐀-鿿＀-￯]/u;

// HTML documents also declare a Chinese language; the release ships English.
const HTML_LANG_ZH = 'lang="zh-Hant"';
const HTML_LANG_EN = 'lang="en"';

export function translateToEnglish(content) {
  let output = content.split(HTML_LANG_ZH).join(HTML_LANG_EN);
  // Longest keys first so a phrase is replaced before any shorter substring of
  // it (e.g. "實際節點" before "節點").
  const keys = Object.keys(TRANSLATIONS).sort((a, b) => b.length - a.length);
  for (const zh of keys) {
    output = output.split(zh).join(TRANSLATIONS[zh]);
  }
  return output;
}
