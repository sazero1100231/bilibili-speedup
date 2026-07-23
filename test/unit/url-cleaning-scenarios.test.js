import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { cleanUrl } from "../../src/lib/url-utils.js";

const tracking = JSON.parse(
  await readFile(
    new URL("../../rules/tracking-params.json", import.meta.url),
    "utf8"
  )
);
const blocked = tracking.params.map((entry) => entry.param);

const scenarios = [
  ["video 分P與時間", "https://www.bilibili.com/video/BV1?p=2&t=31&vd_source=x", ["p", "t"]],
  ["搜尋結果", "https://search.bilibili.com/all?keyword=music&search_source=x", ["keyword"]],
  ["活動頁", "https://www.bilibili.com/blackboard/activity.html?source=x&id=7", ["id"]],
  ["space 頁", "https://space.bilibili.com/123?from=search&tab=video", ["tab"]],
  ["直播跳轉", "https://live.bilibili.com/123?from=search&broadcast_type=0", ["broadcast_type"]],
  ["b23 短鏈", "https://b23.tv/abc?vd_source=x&p=1", ["p"]],
  ["番劇 ep", "https://www.bilibili.com/bangumi/play/ep1?spm_id_from=x&from_spmid=y", []],
  ["opus", "https://www.bilibili.com/opus/1?share_source=copy_link&jump_opus=1", ["jump_opus"]],
  ["read", "https://www.bilibili.com/read/cv1?from=search&mode=read", ["mode"]],
  ["festival", "https://www.bilibili.com/festival/test?sourceFrom=share&bvid=BV1", ["bvid"]],
  ["playlist", "https://www.bilibili.com/list/1?oid=7&type=2&trackid=x", ["oid", "type"]],
  ["收藏", "https://space.bilibili.com/1/favlist?fid=9&mid=1", ["fid"]],
  ["動態", "https://t.bilibili.com/1?tab=2&session_id=x", ["tab"]],
  ["評論定位", "https://www.bilibili.com/video/BV1?comment_root_id=8&visit_id=x", ["comment_root_id"]],
  ["分享平台", "https://www.bilibili.com/video/BV1?share_plat=android&share_tag=s_i", []],
  ["分享工作階段", "https://www.bilibili.com/video/BV1?share_session_id=x&unique_k=y", []],
  ["行動來源", "https://m.bilibili.com/video/BV1?msource=x&bbid=y", []],
  ["Arouter", "https://www.bilibili.com/video/BV1?-Arouter=x&autoplay=1", ["autoplay"]],
  ["aid/bvid", "https://www.bilibili.com/video/av1?aid=1&bvid=BV1&seid=x", ["aid", "bvid"]],
  ["oid/type", "https://www.bilibili.com/video/BV1?oid=1&type=1&refer_from=x", ["oid", "type"]],
  ["timestamp", "https://www.bilibili.com/video/BV1?timestamp=1&quality=80", ["quality"]],
  ["ts", "https://www.bilibili.com/video/BV1?ts=1&qn=80", ["qn"]],
  ["source 通用名", "https://www.bilibili.com/video/BV1?source=feed&season_id=3", ["season_id"]],
  ["from 通用名", "https://www.bilibili.com/video/BV1?from=search&ep_id=4", ["ep_id"]],
  ["mid 通用名", "https://www.bilibili.com/medialist/play/1?mid=2&biz_id=3", ["biz_id"]],
  ["up_id", "https://www.bilibili.com/video/BV1?up_id=2&cid=3", ["cid"]],
  ["buvid query", "https://www.bilibili.com/video/BV1?buvid=x&fnval=4048", ["fnval"]],
  ["story h5", "https://www.bilibili.com/video/BV1?is_story_h5=1&fullscreen=1", ["fullscreen"]],
  ["來源組合", "https://www.bilibili.com/video/BV1?csource=a&bsource=b&sourceFrom=c&part=2", ["part"]],
  ["多值黑名單", "https://www.bilibili.com/video/BV1?vd_source=a&vd_source=b&p=3", ["p"]]
];

test("30 high-risk navigation scenarios remove only listed tracking parameters", () => {
  assert.equal(scenarios.length, 30);
  for (const [name, rawUrl, preserved] of scenarios) {
    const cleaned = new URL(cleanUrl(rawUrl, blocked));
    for (const param of blocked) {
      assert.equal(
        cleaned.searchParams.has(param),
        false,
        `${name} retained blocked parameter ${param}`
      );
    }
    for (const param of preserved) {
      assert.equal(
        cleaned.searchParams.has(param),
        true,
        `${name} removed functional parameter ${param}`
      );
    }
  }
});
