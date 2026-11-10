/**
 * 本地验证 /huangguo 适配层。
 *
 * 不依赖 Cloudflare，也不访问真实上游：
 *   - fetch 被替换成小型内存上游（原生黄果 JSON 接口 + 两个 MacCMS 站）；
 *   - 覆盖 ac=list、ac=videolist、ac=detail&ids=12527、?ac=upstreams；
 *   - 覆盖 522、超时、非 JSON、熔断、鉴权、图片代理。
 *
 * 运行：node scripts/verify-huangguo.mjs
 */

import assert from "node:assert/strict";
import { onRequest } from "../functions/huangguo/[[path]].js";

const SPIDER_JS_URL =
  "https://cdn.jsdelivr.net/gh/SikROo/huangguo-spider@latest/huangguo_web_spider.js";
const SOURCES_JSON_URL =
  "https://cdn.jsdelivr.net/gh/SikROo/huangguo-spider@latest/all_sources_config.json";

const SPIDER = `
const API = 'https://native.test';
const SITE = 'https://site.test';
`;

const CONFIG = JSON.stringify({
  sites: [
    { key: "huangguo_web", name: "黄果短剧", type: 3, api: "spider.js" },
    {
      key: "alpha",
      name: "Alpha 资源",
      type: 1,
      api: "https://alpha.test/api.php/provide/vod/",
      searchable: 1,
    },
    {
      key: "beta",
      name: "Beta JSON",
      type: 1,
      api: "https://beta.test/api/json.php",
      searchable: 1,
    },
  ],
});

const nativeList = {
  list: [
    {
      vod_id: 12527,
      vod_name: "测试短剧",
      vod_pic: "https://img.test/cover.jpg",
      vod_remarks: "全2集",
      type_name: "AI短剧",
      vod_year: "2026",
      vod_area: "内地",
      vod_score: "8.8",
    },
  ],
  pagecount: 3,
};

const nativeSearch = {
  list: [
    {
      vod_id: 12527,
      vod_name: "测试短剧",
      vod_pic: "https://img.test/cover.jpg",
      vod_remarks: "全2集",
      type_name: "AI短剧",
    },
  ],
};

const nativeDetail = {
  list: [
    {
      vod_id: 12527,
      vod_name: "测试短剧",
      vod_pic: "https://img.test/cover.jpg",
      vod_remarks: "全2集",
      type_name: "AI短剧",
      episodes: [
        { ep: 1, title: "第1集", url: "https://cdn.test/1.m3u8" },
        { ep: 2, title: "第2集", url: "https://cdn.test/2.m3u8" },
      ],
    },
  ],
};

// 详情里的剧集是网页地址，适配层应生成 /huangguo/play 惰性地址。
const nativeLazyDetail = {
  list: [
    {
      vod_id: 12600,
      vod_name: "惰性解析测试",
      vod_pic: "https://img.test/cover.jpg",
      vod_remarks: "全2集",
      type_name: "AI短剧",
      episodes: [
        { ep: 1, title: "第1集", url: "https://site.test/video/12600/ep-1/" },
        { ep: 2, title: "第2集", url: "https://site.test/video/12600/ep-2/" },
      ],
    },
  ],
};

// Worker /api/play 返回空时，应回退到源站页面里的 videoInitialData。
const nativePageFallbackDetail = {
  list: [
    {
      vod_id: 12700,
      vod_name: "页面兜底测试",
      vod_pic: "https://img.test/cover.jpg",
      vod_remarks: "全2集",
      type_name: "AI短剧",
      episodes: [
        { ep: 1, title: "第1集", url: "https://site.test/video/12700/" },
        { ep: 2, title: "第2集", url: "https://site.test/video/12700/ep-2/" },
      ],
    },
  ],
};

// 详情存在但 episodes 为空：应明确报 no_playable，而不是“没有找到内容”。
const nativeEmptyDetail = {
  list: [
    {
      vod_id: 99999,
      vod_name: "空剧集测试",
      vod_pic: "https://img.test/cover.jpg",
      episodes: [],
    },
  ],
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function slowResponse(init) {
  return new Promise((resolve, reject) => {
    const signal = init && init.signal;
    if (!signal) return;
    signal.addEventListener(
      "abort",
      () => {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        reject(error);
      },
      { once: true }
    );
  });
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const parsed = new URL(url);

  if (url === SPIDER_JS_URL) return new Response(SPIDER, { status: 200 });
  if (url === SOURCES_JSON_URL) return new Response(CONFIG, { status: 200 });

  if (parsed.hostname === "img.test") {
    return new Response(new Uint8Array([137, 80, 78, 71]), {
      status: 200,
      headers: { "Content-Type": "image/png" },
    });
  }

  if (parsed.hostname === "slow.test") {
    return slowResponse(init);
  }

  if (parsed.hostname === "parsebad.test") {
    return new Response("<html><body>not json</body></html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  }

  if (parsed.hostname === "broken.test") {
    return new Response("upstream unavailable", { status: 522 });
  }

  if (parsed.hostname === "failnative.test") {
    return new Response("origin down", { status: 522 });
  }

  if (parsed.hostname === "site.test") {
    if (parsed.pathname === "/video/12700/ep-2/") {
      return new Response(
        '<script id="videoInitialData">{"epPlaySrcs":{"2":"https:\\/\\/cdn.test\\/from-page.m3u8"}}</script>',
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }
    if (parsed.pathname.startsWith("/api/videos/")) {
      return json({ data: { video_url: "" } });
    }
    return new Response("not found", { status: 404 });
  }

  if (parsed.hostname === "native.test") {
    if (parsed.pathname.startsWith("/api/category/")) return json(nativeList);
    if (parsed.pathname.startsWith("/api/search/")) return json(nativeSearch);
    if (parsed.pathname === "/api/detail/12527") return json(nativeDetail);
    if (parsed.pathname === "/api/detail/12600") return json(nativeLazyDetail);
    if (parsed.pathname === "/api/detail/12700") return json(nativePageFallbackDetail);
    if (parsed.pathname === "/api/detail/99999") return json(nativeEmptyDetail);
    if (parsed.pathname === "/api/play") {
      if (parsed.searchParams.get("url") === "12700") {
        return json({ url: "", proxy: "" });
      }
      return json({ url: "https://cdn.test/play.m3u8" });
    }
    return new Response("not found", { status: 404 });
  }

  if (parsed.hostname === "alpha.test") {
    if (parsed.searchParams.get("ac") === "list") {
      return json({
        code: 1,
        msg: "数据列表",
        class: [{ type_id: "1", type_name: "电影" }],
        list: [],
      });
    }
    if (parsed.searchParams.get("ac") === "videolist") {
      const keyword = parsed.searchParams.get("wd");
      if (keyword) {
        return json({
          code: 1,
          msg: "数据列表",
          list: [
            {
              vod_id: 9001,
              vod_name: "测试短剧 Alpha",
              vod_pic: "https://img.test/alpha.jpg",
              type_name: "电影",
            },
          ],
        });
      }
      return json({
        code: 1,
        msg: "数据列表",
        page: 1,
        pagecount: 2,
        list: [
          {
            vod_id: 9001,
            vod_name: "测试短剧 Alpha",
            vod_pic: "https://img.test/alpha.jpg",
            type_name: "电影",
          },
        ],
      });
    }
    if (parsed.searchParams.get("ac") === "detail") {
      if (parsed.searchParams.get("ids") === "9001") {
        return json({
          code: 1,
          msg: "数据列表",
          list: [
            {
              vod_id: 9001,
              vod_name: "测试短剧 Alpha",
              vod_pic: "https://img.test/alpha.jpg",
              type_name: "电影",
              vod_play_from: "alpha",
              vod_play_url: "第1集$https://alpha.test/1.m3u8#第2集$https://alpha.test/2.m3u8",
            },
          ],
        });
      }
      return json({ code: 1, msg: "数据列表", list: [] });
    }
    return json({ code: 1, msg: "数据列表", list: [] });
  }

  if (parsed.hostname === "beta.test") {
    if (parsed.searchParams.get("ac") === "list") {
      return json({
        code: 1,
        msg: "数据列表",
        list: [{ vod_id: 8001, vod_name: "测试短剧 Beta", type_id: 2, type_name: "剧集" }],
        pagecount: 1,
      });
    }
    if (parsed.searchParams.get("ac") === "videolist") {
      return json({
        code: 1,
        msg: "数据列表",
        page: 1,
        pagecount: 1,
        list: [
          {
            vod_id: 8001,
            vod_name: "测试短剧 Beta",
            vod_pic: "/upload/beta.jpg",
            type_name: "剧集",
          },
        ],
      });
    }
    if (parsed.searchParams.get("ac") === "detail") {
      return json({
        code: 1,
        msg: "数据列表",
        list: [
          {
            vod_id: 8001,
            vod_name: "测试短剧 Beta",
            vod_pic: "/upload/beta.jpg",
            type_name: "剧集",
            vod_play_from: "beta",
            vod_play_url: "第1集$https://beta.test/1.m3u8",
          },
        ],
      });
    }
    return json({ code: 1, msg: "数据列表", list: [] });
  }

  throw new Error(`unexpected fetch: ${url}`);
};

const baseEnv = {
  USERS_KV: {
    async get(key) {
      if (key === "user@test") {
        return JSON.stringify({ approved: true, sources: ["huangguo"] });
      }
      if (key === "other@test") {
        return JSON.stringify({ approved: true, sources: ["heimuer"] });
      }
      return null;
    },
  },
};

async function call(path, options = {}) {
  const env = options.env ? { ...baseEnv, ...options.env } : baseEnv;
  const headers = {};
  const email = options.email === undefined ? "user@test" : options.email;
  if (email) headers["Cf-Access-Authenticated-User-Email"] = email;

  const request = new Request(`https://app.test${path}`, { headers });
  const waitUntil = [];
  const response = await onRequest({
    request,
    env,
    waitUntil(task) {
      waitUntil.push(task);
    },
  });
  await Promise.allSettled(waitUntil);

  const raw = response.clone();
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // 图片等非 JSON 响应保留原文。
  }
  return { response, raw, status: response.status, body, text };
}

async function show(label, path, result) {
  console.log(`\n### ${label}`);
  console.log(`GET ${path}`);
  console.log(`HTTP ${result.status}`);
  if (result.response.headers.get("content-type")?.startsWith("image/")) {
    const bytes = await result.raw.arrayBuffer();
    console.log(`Content-Type: ${result.response.headers.get("content-type")}`);
    console.log(`Bytes: ${bytes.byteLength}`);
  } else {
    console.log(JSON.stringify(result.body, null, 2));
  }
}

function expect(condition, message) {
  assert.ok(condition, message);
}

async function main() {
  console.log("== /huangguo 适配层验证（内存上游，不访问真实网络）==");

  // 1. 首次访问诊断端点：等待一次后台池同步，应看到 spider + type=1 候选。
  let path = "/huangguo/api.php/provide/vod/?ac=upstreams";
  let result = await call(path);
  await show("1. ac=upstreams（自动同步候选池）", path, result);
  expect(result.status === 200, "upstreams HTTP 200");
  expect(result.body.code === 1, "upstreams code 1");
  expect(result.body.count === 3, "should discover native + 2 MacCMS");
  expect(result.body.defaultSlug === "huangguo-web", "default slug");
  expect(result.body.upstreams.every((item) => item.status === "unknown"), "initial status");

  // 2. ac=upstreams&probe=1：主动健康检查。
  path = "/huangguo/api.php/provide/vod/?ac=upstreams&probe=1";
  result = await call(path);
  await show("2. ac=upstreams&probe=1（主动健康检查）", path, result);
  expect(result.body.probe.ok === 3, "all 3 probes ok");
  expect(result.body.upstreams.every((item) => item.status === "ok"), "probe marks ok");

  // 3. ac=list：保持原有黄果分类。
  path = "/huangguo/api.php/provide/vod/?ac=list";
  result = await call(path);
  await show("3. ac=list（默认黄果分类）", path, result);
  expect(result.body.code === 1, "list code 1");
  expect(result.body.class.some((item) => item.type_id === "ai-duanju"), "has ai-duanju");

  // 4. ac=videolist：默认黄果首页，id 自动带 slug 命名空间。
  path = "/huangguo/api.php/provide/vod/?ac=videolist&pg=1";
  result = await call(path);
  await show("4. ac=videolist（默认黄果列表）", path, result);
  expect(result.body.code === 1, "videolist code 1");
  expect(result.body.list.length === 1, "one native item");
  expect(result.body.list[0].vod_id === "huangguo-web~12527", "namespaced id");

  // 5. ac=detail&ids=12527：旧链接必须照旧可用。
  path = "/huangguo/api.php/provide/vod/?ac=detail&ids=12527";
  result = await call(path);
  await show("5. ac=detail&ids=12527（旧链接兼容）", path, result);
  expect(result.body.code === 1, "detail code 1");
  expect(result.body.list.length === 1, "one detail");
  expect(result.body.list[0].vod_id === "12527", "legacy id preserved");
  expect(result.body.list[0].vod_play_url.includes("#"), "two episodes");

  // 6. ac=detail&ids=huangguo-web~12527：命名空间 id。
  path = "/huangguo/api.php/provide/vod/?ac=detail&ids=huangguo-web~12527";
  result = await call(path);
  await show("6. ac=detail&ids=huangguo-web~12527（命名空间）", path, result);
  expect(result.body.list[0].vod_id === "huangguo-web~12527", "namespaced detail id");

  // 6b. 详情里的网页剧集地址应转成 /huangguo/play 惰性地址，不在详情阶段解析。
  path = "/huangguo/api.php/provide/vod/?ac=detail&ids=12600";
  result = await call(path);
  await show("6b. 网页剧集地址转惰性播放地址", path, result);
  const lazyUrl = result.body.list[0].vod_play_url.split("#")[0].split("$")[1];
  expect(lazyUrl.includes("/huangguo/play.m3u8?"), "lazy play url");
  expect(result.body.list[0].vod_play_url.split("#").length === 2, "two lazy episodes");

  // 6c. 点播时才请求上游 /api/play，并 302 到真实流。
  const lazyPath = new URL(lazyUrl).pathname + new URL(lazyUrl).search;
  result = await call(lazyPath);
  await show("6c. /huangguo/play 302 到真实流", lazyPath, result);
  console.log(`Location: ${result.response.headers.get("location")}`);
  expect(result.status === 302, "play 302");
  expect(
    result.response.headers.get("location") === "https://cdn.test/play.m3u8",
    "play location"
  );

  // 6d. Worker /api/play 返回空时，回退到详情页 videoInitialData。
  path = "/huangguo/api.php/provide/vod/?ac=detail&ids=12700";
  result = await call(path);
  await show("6d. Worker play 为空时回退页面", path, result);
  const fallbackLazy = result.body.list[0].vod_play_url.split("#")[1].split("$")[1];
  const fallbackPath = new URL(fallbackLazy).pathname + new URL(fallbackLazy).search;
  result = await call(fallbackPath);
  await show("6e. 页面兜底 302 到真实流", fallbackPath, result);
  console.log(`Location: ${result.response.headers.get("location")}`);
  expect(result.status === 302, "page fallback 302");
  expect(
    result.response.headers.get("location") === "https://cdn.test/from-page.m3u8",
    "page fallback location"
  );

  // 7. MacCMS 上游按 slug 路由 + ac=list。
  path = "/huangguo/api.php/provide/vod/?ac=list&slug=alpha";
  result = await call(path);
  await show("7. ac=list&slug=alpha（MacCMS 分类）", path, result);
  expect(result.body.class[0].type_name === "电影", "alpha class");

  // 8. MacCMS 列表按 slug 路由。
  path = "/huangguo/api.php/provide/vod/?ac=videolist&slug=alpha&pg=1";
  result = await call(path);
  await show("8. ac=videolist&slug=alpha（MacCMS 列表）", path, result);
  expect(result.body.list[0].vod_id === "alpha~9001", "alpha namespaced id");

  // 9. MacCMS 详情按 slug 路由。
  path = "/huangguo/api.php/provide/vod/?ac=detail&ids=alpha~9001";
  result = await call(path);
  await show("9. ac=detail&ids=alpha~9001（MacCMS 详情）", path, result);
  expect(result.body.list[0].vod_play_url.includes("alpha.test"), "alpha play url");

  // 9b. 裸 id + slug 参数：按 slug 路由详情，并回填命名空间。
  path = "/huangguo/api.php/provide/vod/?ac=detail&ids=9001&slug=alpha";
  result = await call(path);
  await show("9b. ac=detail&ids=9001&slug=alpha（按 slug 路由裸 id）", path, result);
  expect(result.body.list[0].vod_id === "alpha~9001", "slug-routed detail id");

  // 10. 跨上游并发搜索合并。
  path = "/huangguo/api.php/provide/vod/?ac=videolist&wd=%E6%B5%8B%E8%AF%95%E7%9F%AD%E5%89%A7";
  result = await call(path);
  await show("10. ac=videolist&wd=测试短剧（跨上游合并）", path, result);
  expect(result.body.code === 1, "search code 1");
  expect(result.body.list.length === 3, "merged 3 upstream results");
  expect(
    result.body.list.every((item) => item.vod_id.includes("~")),
    "all search ids namespaced"
  );
  expect(result.body.list[0].source_key === "huangguo", "native source key");
  expect(result.body.list[1].source_key === "hg_alpha", "alpha source key");
  expect(result.body.list[1].source_name === "Alpha 资源", "alpha source name");

  // 11. 确实没有内容：code 1 + 没有找到内容。
  path = "/huangguo/api.php/provide/vod/?ac=detail&ids=alpha~9999";
  result = await call(path);
  await show("11. ac=detail&ids=alpha~9999（真实未找到）", path, result);
  expect(result.body.code === 1, "not found code 1");
  expect(result.body.msg === "没有找到内容", "not found msg");

  // 11b. 详情存在但 episodes 为空：明确 no_playable，并带诊断信息。
  path = "/huangguo/api.php/provide/vod/?ac=detail&ids=99999";
  result = await call(path);
  await show("11b. 详情存在但 episodes 为空", path, result);
  expect(result.body.code === 0, "empty episodes code 0");
  expect(result.body.error.kind === "no_playable", "empty episodes kind");
  expect(result.body.error.details.episodes === 0, "empty episodes details");
  expect(result.body.msg.includes("episodes 为空"), "empty episodes concrete msg");

  // 12. 图片代理保持可用。
  path = "/huangguo/media?src=https%3A%2F%2Fimg.test%2Fcover.jpg&up=huangguo-web";
  result = await call(path);
  await show("12. /huangguo/media（图片代理）", path, result);
  expect(result.status === 200, "media 200");
  expect(result.response.headers.get("content-type") === "image/png", "media type");

  // 13. Cf-Access 鉴权保持。
  path = "/huangguo/api.php/provide/vod/?ac=list";
  result = await call(path, { email: "" });
  await show("13a. 无 Cf-Access 用户（401）", path, result);
  expect(result.status === 401, "unauth 401");

  result = await call(path, { email: "other@test" });
  await show("13b. 无 huangguo 权限（403）", path, result);
  expect(result.status === 403, "forbidden 403");

  // 14. 上游 522：HTTP 200 + code 0 + 具体 msg，而不是“没有找到内容”。
  const brokenEnv = {
    HUANGGUO_UPSTREAMS: JSON.stringify([
      {
        key: "broken",
        name: "Broken 资源",
        api: "https://broken.test/api.php/provide/vod/",
      },
    ]),
  };
  path = "/huangguo/api.php/provide/vod/?ac=videolist&slug=broken&pg=1";
  result = await call(path, { env: brokenEnv });
  await show("14. 上游 522（code 0 + error）", path, result);
  expect(result.status === 200, "522 envelope HTTP 200");
  expect(result.body.code === 0, "522 code 0");
  expect(result.body.msg.includes("HTTP 522"), "522 concrete msg");
  expect(result.body.msg.includes("没有找到内容") === false, "not disguised as not-found");
  expect(result.body.error.kind === "http", "522 error kind");
  expect(result.body.error.status === 522, "522 error status");
  expect(typeof result.body.error.ms === "number", "522 error ms");

  // 15. 连续失败触发熔断。
  await call(path, { env: brokenEnv });
  await call(path, { env: brokenEnv });
  result = await call(path, { env: brokenEnv });
  await show("15. 连续失败后的熔断（circuit_open）", path, result);
  expect(result.body.code === 0, "circuit code 0");
  expect(result.body.error.kind === "circuit_open", "circuit kind");
  expect(result.body.msg.includes("冷却"), "circuit msg");

  path = "/huangguo/api.php/provide/vod/?ac=upstreams";
  result = await call(path, { env: brokenEnv });
  await show("16. ac=upstreams&slug 状态（熔断可见）", path, result);
  expect(result.body.upstreams[0].status === "circuit_open", "upstream reports circuit");
  expect(result.body.upstreams[0].lastError.kind === "http", "last error visible");

  // 17. 超时。
  const slowEnv = {
    HUANGGUO_UPSTREAMS: JSON.stringify([
      {
        key: "slow",
        name: "Slow 资源",
        api: "https://slow.test/api.php/provide/vod/",
      },
    ]),
    HUANGGUO_TIMEOUT_MS: "3000",
  };
  path = "/huangguo/api.php/provide/vod/?ac=videolist&slug=slow&pg=1";
  result = await call(path, { env: slowEnv });
  await show("17. 上游超时（code 0 + timeout）", path, result);
  expect(result.body.code === 0, "timeout code 0");
  expect(result.body.error.kind === "timeout", "timeout kind");
  expect(result.body.msg.includes("超时"), "timeout msg");

  // 18. 非 JSON。
  const parseEnv = {
    HUANGGUO_UPSTREAMS: JSON.stringify([
      {
        key: "parsebad",
        name: "ParseBad 资源",
        api: "https://parsebad.test/api.php/provide/vod/",
      },
    ]),
  };
  path = "/huangguo/api.php/provide/vod/?ac=videolist&slug=parsebad&pg=1";
  result = await call(path, { env: parseEnv });
  await show("18. 上游返回非 JSON（code 0 + parse）", path, result);
  expect(result.body.code === 0, "parse code 0");
  expect(result.body.error.kind === "parse", "parse kind");

  // 19. 详情上游 522，不能退化成“没有找到内容”。
  const failNativeEnv = {
    HUANGGUO_UPSTREAMS: JSON.stringify([
      {
        key: "huangguo_web",
        name: "黄果短剧",
        kind: "huangguo",
        api: "https://failnative.test",
        site: "https://site.test",
      },
    ]),
  };
  path = "/huangguo/api.php/provide/vod/?ac=detail&ids=12527";
  result = await call(path, { env: failNativeEnv });
  await show("19. 详情上游 522（保留真实原因）", path, result);
  expect(result.body.code === 0, "detail 522 code 0");
  expect(result.body.msg.includes("HTTP 522"), "detail 522 msg");
  expect(result.body.msg.includes("没有找到内容") === false, "detail not disguised");

  console.log("\n== 全部断言通过 ==");
}

main().catch((error) => {
  console.error("\n验证失败:", error);
  process.exitCode = 1;
});
