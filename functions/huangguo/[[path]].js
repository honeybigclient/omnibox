/**
 * 黄果短剧 Pages Function 适配层。
 *
 * MorphoTV 只会请求 MacCMS 风格的：
 *   /huangguo/api.php/provide/vod/?ac=videolist&wd=...
 *   /huangguo/api.php/provide/vod/?ac=detail&ids=...
 * 这里把请求翻译成上游 QuickJS 源使用的 Worker JSON 接口。
 *
 * Worker 地址从上游最新 tag 的 huangguo_web_spider.js 里提取，
 * 所以上游发新版本后这里会跟着更新。
 */

const DEFAULT_API = "https://huangguo-parser.13681235735.workers.dev";
const DEFAULT_SITE = "https://huangguoai.com";
const SPIDER_JS_URL =
  "https://cdn.jsdelivr.net/gh/SikROo/huangguo-spider@latest/huangguo_web_spider.js";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
  "Access-Control-Max-Age": "86400",
};

let configCache = { api: DEFAULT_API, site: DEFAULT_SITE, expires: 0, loading: null };

function refreshConfig() {
  if (configCache.loading) return configCache.loading;

  configCache.loading = (async () => {
    try {
      const response = await fetch(SPIDER_JS_URL, {
        cache: "no-store",
        signal: AbortSignal.timeout(6000),
      });
      if (response.ok) {
        const text = await response.text();
        const api = text.match(/(?:const|let|var)\s+API\s*=\s*['"]([^'"]+)['"]/)?.[1];
        const site = text.match(/(?:const|let|var)\s+SITE\s*=\s*['"]([^'"]+)['"]/)?.[1];
        if (api) configCache.api = api;
        if (site) configCache.site = site;
        configCache.expires = Date.now() + 60 * 60 * 1000;
      }
    } catch (error) {
      console.warn("读取上游 spider 配置失败，使用内置地址:", error);
    } finally {
      configCache.loading = null;
    }
  })();

  return configCache.loading;
}

async function getConfig() {
  // 不阻塞当前请求：先用内置地址，后台刷新上游最新 Worker 地址
  if (Date.now() >= configCache.expires && !configCache.loading) {
    refreshConfig().catch(() => {});
  }
  return configCache;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

async function fetchJson(url, referer, timeout = 15000) {
  const response = await fetch(url, {
    headers: { "User-Agent": UA, "Referer": referer },
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function picOf(config, value) {
  const raw = String(value || "");
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) {
    return `${config.api}/media?url=${encodeURIComponent(raw)}`;
  }
  return `${config.api}${raw}`;
}

function toVod(item, config, wrapPic = false, origin = "") {
  let pic = wrapPic
    ? picOf(config, item.vod_pic || item.cover)
    : String(item.vod_pic || item.cover || "");

  // Worker 的列表接口有时返回 /media?url=... 这种相对路径，
  // 先补成 Worker 绝对地址，再统一走本站图片代理。
  if (pic && !/^https?:\/\//i.test(pic)) {
    pic = `${config.api}${pic.startsWith("/") ? "" : "/"}${pic}`;
  }
  if (pic && origin) {
    pic = `${origin}/huangguo/media?src=${encodeURIComponent(pic)}`;
  }

  return {
    vod_id: String(item.vod_id || item.id || ""),
    vod_name: String(item.vod_name || item.title || ""),
    vod_pic: pic,
    vod_remarks: String(item.vod_remarks || ""),
    type_name: String(item.type_name || ""),
    vod_year: String(item.vod_year || ""),
    vod_area: String(item.vod_area || ""),
    vod_score: String(item.vod_score || item.score || ""),
  };
}

async function search(keyword, config, origin) {
  let list = [];

  try {
    const data = await fetchJson(
      `${config.api}/api/search/${encodeURIComponent(keyword)}?page=1&size=50`,
      `${config.site}/`
    );
    if (Array.isArray(data?.list)) {
      list = data.list.map((item) => toVod(item, config, false, origin));
    }
  } catch (error) {
    console.warn("Worker 搜索失败:", error);
  }

  if (!list.length) {
    try {
      const data = await fetchJson(
        `${config.site}/api/search?q=${encodeURIComponent(keyword)}&page=1&size=50`,
        `${config.site}/`
      );
      const items = data?.data?.items;
      if (Array.isArray(items)) {
        list = items.map((item) => toVod(item, config, true, origin));
      }
    } catch (error) {
      console.warn("站点搜索兜底失败:", error);
    }
  }

  return list.filter((item) => item.vod_id && item.vod_name);
}

async function resolvePlay(id, ep, config) {
  try {
    const data = await fetchJson(
      `${config.api}/api/play?url=${encodeURIComponent(id)}&ep=${encodeURIComponent(ep)}`,
      `${config.site}/`
    );
    return typeof data?.url === "string" ? data.url : "";
  } catch {
    return "";
  }
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return results;
}

async function buildDetail(id, config, origin) {
  let item = null;
  try {
    const data = await fetchJson(
      `${config.api}/api/detail/${encodeURIComponent(id)}`,
      `${config.site}/`
    );
    item = data?.list?.[0] || null;
  } catch (error) {
    console.warn("Worker 详情失败:", error);
  }

  if (!item) return null;

  const episodes = Array.isArray(item.episodes) ? item.episodes.slice(0, 50) : [];

  // 并行解析播放地址，避免 30 集串行请求导致详情页很慢
  const resolved = await mapLimit(episodes, 8, async (ep, index) => {
    const epNumber = String(ep.ep || index + 1);
    let url = String(ep.url || "");
    // 详情里的 ep.url 经常是 /video/xxx/ep-2/ 这种网页地址，
    // 只有 m3u8/mp4 这类直链才直接使用，否则必须走 /api/play 解析。
    if (!/\.(m3u8|mp4|flv|mkv|webm)(\?|#|$)/i.test(url)) {
      url = await resolvePlay(id, epNumber, config);
    }
    if (!url || !/^https?:\/\//i.test(url)) return "";

    const title = String(ep.title || `第${epNumber}集`).replace(/\$/g, " ");
    return `${title}$${url}`;
  });
  const playUrls = resolved.filter(Boolean);

  // 吃瓜图文帖：正文/帖子接口里才有 video_url
  if (!playUrls.length && id.startsWith("archives_")) {
    const pid = id.slice("archives_".length);
    try {
      const data = await fetchJson(
        `${config.site}/api/posts/${encodeURIComponent(pid)}`,
        `${config.site}/`
      );
      let url = String(data?.data?.video_url || "");
      if (!url) {
        const matched = String(data?.data?.content || "").match(
          /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i
        );
        if (matched) url = matched[0].replace(/&amp;/g, "&");
      }
      if (/^https?:\/\//i.test(url)) playUrls.push(`第1集$${url}`);
    } catch (error) {
      console.warn("吃瓜帖子解析失败:", error);
    }
  }

  if (!playUrls.length) return null;

  return {
    ...toVod(item, config, false, origin),
    vod_id: String(item.vod_id || id),
    vod_play_from: "黄果",
    vod_play_url: playUrls.join("#"),
  };
}

const HUANGGUO_CLASSES = [
  { type_id: "ai-duanju", type_name: "AI短剧" },
  { type_id: "ai-manju", type_name: "AI漫剧" },
  { type_id: "ai-huanlian", type_name: "换脸专区" },
  { type_id: "ai-mogai", type_name: "魔改专区" },
  { type_id: "chigua", type_name: "吃瓜·全部" },
  { type_id: "rank:hot", type_name: "热播榜" },
  { type_id: "rank:recommend", type_name: "推荐榜" },
  { type_id: "rank:potential", type_name: "潜力榜" },
];

async function homeList(typeId, page, config, origin) {
  const type = typeId || "ai-duanju";
  let url = `${config.api}/api/category/${encodeURIComponent(type)}?page=${page}&size=50&sort=latest`;

  if (type.startsWith("rank:")) {
    const kind = type.slice("rank:".length) || "hot";
    url = `${config.api}/api/ranks/${encodeURIComponent(kind)}?page=${page}&size=50`;
  } else if (type.startsWith("chigua")) {
    const cate = type.split(":")[1] || "all";
    url = `${config.api}/api/chigua?cate=${encodeURIComponent(cate)}&page=${page}&size=50`;
  }

  try {
    const data = await fetchJson(url, `${config.site}/`);
    const list = Array.isArray(data?.list) ? data.list.map((item) => toVod(item, config, false, origin)) : [];
    const pageCount = Number(data?.pagecount) || page;
    return { list, pageCount };
  } catch (error) {
    console.warn("Worker 首页列表失败:", error);
    return { list: [], pageCount: page };
  }
}

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (typeof context.waitUntil === "function") {
    context.waitUntil(refreshConfig().catch(() => {}));
  }

  // 封面/图片同域代理，浏览器不直接访问 Worker 域名
  if (url.pathname.endsWith("/huangguo/media")) {
    const src = url.searchParams.get("src") || "";
    if (!/^https?:\/\//i.test(src)) {
      return jsonResponse({ error: "缺少有效的图片地址" }, 400);
    }
    try {
      const config = await getConfig();
      const response = await fetch(src, {
        headers: { "User-Agent": UA, "Referer": `${config.site}/` },
        signal: AbortSignal.timeout(15000),
      });
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(CORS)) headers.set(key, value);
      headers.delete("content-length");
      headers.delete("content-encoding");
      headers.delete("transfer-encoding");
      headers.set("Cache-Control", "public, max-age=86400");
      return new Response(response.body, {
        status: response.status,
        headers,
      });
    } catch (error) {
      return jsonResponse({ error: "图片代理失败", message: error.message }, 502);
    }
  }

  const ac = url.searchParams.get("ac");
  const config = await getConfig();

  if (ac === "list") {
    return jsonResponse({ code: 1, msg: "数据列表", class: HUANGGUO_CLASSES, list: [] });
  }

  if (ac === "videolist" || (ac === "detail" && !url.searchParams.get("ids"))) {
    const keyword = url.searchParams.get("wd") || "";
    if (keyword.trim()) {
      const list = await search(keyword.trim(), config, url.origin);
      return jsonResponse({
        code: 1,
        msg: "数据列表",
        page: 1,
        pagecount: 1,
        limit: list.length,
        total: list.length,
        list,
      });
    }

    const page = Math.max(1, Number(url.searchParams.get("pg")) || 1);
    const typeId = url.searchParams.get("t") || "ai-duanju";
    const home = await homeList(typeId, page, config, url.origin);
    return jsonResponse({
      code: 1,
      msg: "数据列表",
      page,
      pagecount: home.pageCount,
      limit: home.list.length,
      total: home.list.length,
      list: home.list,
    });
  }

  if (ac === "detail") {
    const ids = url.searchParams.get("ids") || "";
    if (!ids.trim()) return jsonResponse({ code: 1, msg: "缺少 ids", list: [] });

    const detail = await buildDetail(ids.trim(), config, url.origin);
    return jsonResponse({
      code: 1,
      msg: detail ? "数据列表" : "没有找到内容",
      page: 1,
      pagecount: 1,
      limit: detail ? 1 : 0,
      total: detail ? 1 : 0,
      list: detail ? [detail] : [],
    });
  }

  return jsonResponse({ code: 0, msg: "不支持的 ac 参数", list: [] });
}
