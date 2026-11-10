/**
 * 黄果短剧 Pages Function 适配层（多上游版）。
 *
 * 对外仍然只暴露 MacCMS 形态：
 *   /huangguo/api.php/provide/vod/?ac=list
 *   /huangguo/api.php/provide/vod/?ac=videolist&wd=...
 *   /huangguo/api.php/provide/vod/?ac=detail&ids=...
 *   /huangguo/api.php/provide/vod/?ac=upstreams       (诊断)
 *   /huangguo/api.php/provide/vod/?ac=huangguome      (新站播放诊断)
 *   /huangguo/media?src=...                            (图片代理)
 *   /huangguo/hls?src=...&ref=...                      (播放代理：m3u8 改写 +
 *                                                       key/分片透传，兜住 CORS)
 *   /huangguo/m3u8?src=...                             (同 hls，保留旧链接)
 *   /huangguo/api.php/provide/vod/?ac=playdebug         (播放解析诊断)
 *   /huangguo/api.php/provide/vod/?ac=playprobe         (多种请求姿势探测)
 *   /huangguo/api.php/provide/vod/?ac=playcheck         (批量片源自检)
 *
 * 播放入口 /huangguo/play.m3u8 不再 302 裸地址，而是 302 到 /huangguo/hls，
 * 由 Worker 代理取流；这是修复"一直转圈"的关键。解析失败时会按健康度
 * 自动换下一个上游重试，尽量不让用户看到空播放器。
 *
 * 上游池由三部分组成：
 *   1. 黄果 spider 里的 API / SITE（原生 Worker JSON 接口）；
 *   2. all_sources_config.json 里 type=1 的 MacCMS 站（api.php/provide/vod、
 *      api/json.php 等标准 MacCMS 查询参数）；
 *   3. 环境变量 HUANGGUO_UPSTREAMS（设置后完全覆盖前两项）。
 *
 * 跨站 id 采用 `slug~id` 命名空间；不带 `~` 的 id 仍路由到默认黄果上游，
 * 因此旧链接 /ac=detail&ids=12527 不受影响。
 *
 * 上游故障（超时 / 522 / 非 JSON / 熔断）返回 HTTP 200 + code:0 + 具体 msg，
 * 并附带 error:{upstream,kind,status,ms}，前端才能把原因显示出来。
 *
 * HUANGGUO_UPSTREAMS（覆盖整个候选池）支持：
 *   JSON: [{"key":"huangguo_web","name":"黄果短剧","kind":"huangguo",
 *           "api":"https://...workers.dev","site":"https://huangguoai.com"},
 *          {"key":"ob25","name":"360资源","api":"https://360zy.com/api.php/provide/vod/"}]
 *   文本: key|name|api  或  key=api  或  直接写 https://.../api.php/provide/vod/
 *         原生黄果用 key|name|api|site|huangguo 五段式。
 */

const DEFAULT_API = "https://huangguo-parser.13681235735.workers.dev";
const DEFAULT_SITE = "https://huangguoai.com";
// 黄果新站（iodefog/HuangGuoVideo-Download 使用的路线）：
// /detail/{slug}/ -> /play/{slug}/{chapterId}/ ->
// /api/playlet/chapter/detail?chapterId=&playletSlug= -> data.videoUrl -> /h5/m3u8/{videoUrl}
const HUANGGUO_ME = "https://huangguo.me";
const HUANGGUO_ME_UPSTREAM = {
  key: "huangguo_me",
  slug: "huangguo-me",
  name: "黄果短剧(新)",
  kind: "huangguo-me",
  source: "builtin",
  api: HUANGGUO_ME,
  site: HUANGGUO_ME,
};
const SPIDER_JS_URL =
  "https://cdn.jsdelivr.net/gh/SikROo/huangguo-spider@latest/huangguo_web_spider.js";
const SOURCES_JSON_URL =
  "https://cdn.jsdelivr.net/gh/SikROo/huangguo-spider@latest/all_sources_config.json";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
  "Access-Control-Max-Age": "86400",
};

const HOUR = 60 * 60 * 1000;
const DEFAULT_TTL_MS = 5 * HOUR; // 4~6 小时之间
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_BREAKER_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60 * 1000;
const DEFAULT_SEARCH_CONCURRENCY = 8;
const DEFAULT_SEARCH_TIMEOUT_MS = 5000;
const DEFAULT_SEARCH_DEADLINE_MS = 9000;
const DEFAULT_PROBE_TIMEOUT_MS = 4000;
const DEFAULT_PROBE_DEADLINE_MS = 9000;

const POOL_CACHE_URL = "https://huangguo.internal/__upstreams_v1";
const BOOTSTRAP_TTL_MS = 30 * 1000;

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

// { pool, expiresAt, loading }：单个 isolate 内的热缓存。
const poolState = { pool: null, expiresAt: 0, loading: null };

// 上游健康状态 / 熔断器。只存在当前 isolate，跨 isolate 由请求重新学习。
const healthState = new Map();

/* -------------------------------------------------------------------------- */
/* 基础工具                                                                    */
/* -------------------------------------------------------------------------- */

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function envNumber(env, key, fallback) {
  const raw = Number(env && env[key]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function poolTtl(env) {
  return clamp(envNumber(env, "HUANGGUO_POOL_TTL_MS", DEFAULT_TTL_MS), 4 * HOUR, 6 * HOUR);
}

function upstreamTimeout(env) {
  return clamp(envNumber(env, "HUANGGUO_TIMEOUT_MS", DEFAULT_TIMEOUT_MS), 3000, 25000);
}

function breakerThreshold(env) {
  return clamp(envNumber(env, "HUANGGUO_BREAKER_THRESHOLD", DEFAULT_BREAKER_THRESHOLD), 1, 10);
}

function breakerCooldown(env) {
  return clamp(envNumber(env, "HUANGGUO_BREAKER_COOLDOWN_MS", DEFAULT_COOLDOWN_MS), 15000, 600000);
}

function searchConcurrency(env) {
  return clamp(envNumber(env, "HUANGGUO_SEARCH_CONCURRENCY", DEFAULT_SEARCH_CONCURRENCY), 1, 16);
}

function searchTimeout(env) {
  return clamp(
    envNumber(env, "HUANGGUO_SEARCH_TIMEOUT_MS", DEFAULT_SEARCH_TIMEOUT_MS),
    2000,
    8000
  );
}

function searchDeadlineMs(env) {
  return clamp(
    envNumber(env, "HUANGGUO_SEARCH_DEADLINE_MS", DEFAULT_SEARCH_DEADLINE_MS),
    3000,
    15000
  );
}

function slugify(value) {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "upstream";
}

function uniqueSlug(base, used) {
  let slug = base;
  let suffix = 2;
  while (used.has(slug)) {
    slug = `${base}-${suffix++}`;
  }
  used.add(slug);
  return slug;
}

function namespaceId(upstream, id) {
  const raw = String(id == null ? "" : id);
  if (!raw) return "";
  const prefix = `${upstream.slug}~`;
  return raw.startsWith(prefix) ? raw : `${prefix}${raw}`;
}

/**
 * 前端拿到的 vod_id 是 `slug~id` 形式（跨站防冲突）。正常链路上我们会先剥离，
 * 但只要这个值从别处漏进播放参数（手动拼 URL、历史记录、第三方调用），
 * 上游就会回"无效的 ID"。这里做一次兜底剥离，id 和 page 都过一遍。
 */
function stripNamespace(pool, value) {
  let out = String(value == null ? "" : value);
  if (!out || !pool || !Array.isArray(pool.upstreams)) return out;
  for (const upstream of pool.upstreams) {
    const prefix = `${upstream.slug}~`;
    if (out.includes(prefix)) out = out.split(prefix).join("");
  }
  return out;
}

function lazyPlayUrl(origin, upstream, id, ep, pageUrl, title) {
  // 结尾必须是 .m3u8，Artplayer 靠扩展名选择 customType.m3u8 / Hls.js。
  // page 是详情里这一集的真实页面地址；Worker 的页面兜底需要它。
  // title 用于旧站播放失败后按剧名去 huangguo.me 找新站片源。
  const params = new URLSearchParams({
    up: upstream.slug,
    id: String(id),
    ep: String(ep),
  });
  if (isHttpUrl(pageUrl)) params.set("page", pageUrl);
  if (title) params.set("title", String(title));
  return `${origin}/huangguo/play.m3u8?${params.toString()}`;
}

function searchSourceKey(upstream) {
  return upstream.kind === "huangguo" ? "huangguo" : `hg_${upstream.slug}`;
}

function decorateSearchItem(item, upstream) {
  return {
    ...item,
    source: upstream.name,
    source_key: searchSourceKey(upstream),
    source_name: upstream.name,
  };
}

function normalizeBase(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function normalizeMaccmsEndpoint(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return "";
  }
  if (!/^https?:$/.test(url.protocol)) return "";
  if (!url.pathname || url.pathname === "/") {
    url.pathname = "/api.php/provide/vod/";
  }
  url.hash = "";
  let out = url.toString().replace(/\/+$/, "");
  if (out.endsWith("?")) out = out.slice(0, -1);
  return out;
}

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function hostOf(value) {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

function isoTime(ms) {
  if (!ms) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* 错误                                                                        */
/* -------------------------------------------------------------------------- */

class UpstreamError extends Error {
  constructor(upstream, kind, message, options = {}) {
    super(message || kind || "upstream error");
    this.name = "UpstreamError";
    this.upstream = upstream && upstream.slug ? upstream.slug : String(upstream || "");
    this.upstreamName =
      (upstream && upstream.name) || this.upstream || "上游";
    this.kind = kind || "upstream";
    this.status =
      options.status === null || options.status === undefined || options.status === ""
        ? null
        : Number.isFinite(Number(options.status))
          ? Number(options.status)
          : null;
    this.ms = Math.max(0, Math.round(Number(options.ms) || 0));
    // 聚合错误需要覆盖默认的“上游 X 超时”文案。
    this.summary = options.summary || "";
    this.details = options.details || null;
    if (options.cause) this.cause = options.cause;
  }

  toJSON() {
    return {
      upstream: this.upstream,
      name: this.upstreamName,
      kind: this.kind,
      status: this.status,
      ms: this.ms,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

function kindLabel(kind) {
  const labels = {
    timeout: "超时",
    http: "HTTP错误",
    parse: "解析失败",
    network: "网络错误",
    circuit_open: "熔断冷却",
    upstream: "上游错误",
    no_playable: "无播放地址",
    unknown_upstream: "未知上游",
    search: "搜索失败",
  };
  return labels[kind] || kind || "未知错误";
}

function errorMessage(error) {
  if (error.summary) return error.summary;
  const name = error.upstreamName || error.upstream || "上游";
  switch (error.kind) {
    case "timeout":
      return `上游「${name}」请求超时（${error.ms}ms）`;
    case "http":
      return `上游「${name}」返回 HTTP ${error.status}${error.ms ? `（${error.ms}ms）` : ""}`;
    case "parse":
      return `上游「${name}」响应解析失败（不是有效 JSON）`;
    case "network":
      return `上游「${name}」网络连接失败${error.ms ? `（${error.ms}ms）` : ""}`;
    case "circuit_open":
      return `上游「${name}」处于失败冷却中，请稍后再试`;
    case "no_playable":
      return `上游「${name}」返回了详情，但没有解析到可播放地址`;
    case "unknown_upstream":
      return error.message || "未知的上游";
    case "upstream":
    case "search":
      return `上游「${name}」返回错误：${error.message}`;
    default:
      return `上游「${name}」请求失败：${error.message}`;
  }
}

function errorResponse(error, extra = {}) {
  return jsonResponse({
    code: 0,
    msg: errorMessage(error),
    page: 1,
    pagecount: 0,
    limit: 0,
    total: 0,
    list: [],
    error: error.toJSON(),
    ...extra,
  });
}

function summarizeKinds(errors) {
  const counts = new Map();
  for (const error of errors) {
    const kind = error && error.kind ? error.kind : "upstream";
    counts.set(kind, (counts.get(kind) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([kind, count]) => `${kindLabel(kind)} ${count}`)
    .join("、");
}

/* -------------------------------------------------------------------------- */
/* 鉴权（保持原有行为）                                                        */
/* -------------------------------------------------------------------------- */

function getEmail(request) {
  const header = request.headers.get("Cf-Access-Authenticated-User-Email");
  if (header) return header.trim().toLowerCase();

  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) return "";
  try {
    const payload = jwt.split(".")[1];
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    return String(JSON.parse(atob(normalized)).email || "").trim().toLowerCase();
  } catch {
    return "";
  }
}

function adminEmails(env) {
  return String(env.ADMIN_EMAIL || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

async function checkAccess(request, env) {
  const email = getEmail(request);
  if (!email) return { ok: false, status: 401, error: "未登录" };
  if (adminEmails(env).includes(email)) return { ok: true };

  if (!env.USERS_KV) {
    return { ok: false, status: 500, error: "USERS_KV 未绑定" };
  }

  let user = null;
  try {
    user = JSON.parse((await env.USERS_KV.get(email)) || "null");
  } catch {
    user = null;
  }

  if (!user || user.approved === false) {
    return { ok: false, status: 403, error: "账号未获批准" };
  }

  const allowed = Array.isArray(user.sources) ? user.sources : [];
  if (!allowed.includes("huangguo")) {
    return { ok: false, status: 403, error: "没有黄果短剧权限" };
  }

  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* 上游池                                                                      */
/* -------------------------------------------------------------------------- */

function nativeUpstream(api, site, source = "spider") {
  const key = "huangguo_web";
  return {
    key,
    slug: slugify(key),
    name: "黄果短剧",
    kind: "huangguo",
    source,
    api: normalizeBase(api || DEFAULT_API),
    site: normalizeBase(site || DEFAULT_SITE),
  };
}

function maccmsUpstream(site, source = "config") {
  const endpoint = normalizeMaccmsEndpoint(site && site.api);
  if (!endpoint) return null;
  const key = String((site && site.key) || hostOf(endpoint) || "maccms");
  return {
    key,
    slug: slugify(key),
    name: String((site && site.name) || key),
    kind: "maccms",
    source,
    endpoint,
    site: originOf(endpoint),
    searchable: site && Number(site.searchable) === 0 ? false : true,
  };
}

function bootstrapPool() {
  return hydratePool({
    source: "bootstrap",
    updatedAt: 0,
    upstreams: [nativeUpstream(DEFAULT_API, DEFAULT_SITE, "builtin")],
    expiresAt: Date.now() + BOOTSTRAP_TTL_MS,
  });
}

function hydratePool(raw) {
  const list = Array.isArray(raw && raw.upstreams) ? raw.upstreams : [];
  const used = new Set();
  const upstreams = [];
  for (const item of list) {
    if (!item || !item.slug || !item.kind) continue;
    const slug = uniqueSlug(slugify(item.slug), used);
    if (item.kind === "huangguo") {
      if (!item.api || !item.site) continue;
      upstreams.push({
        key: String(item.key || slug),
        slug,
        name: String(item.name || "黄果短剧"),
        kind: "huangguo",
        source: String(item.source || "cache"),
        api: normalizeBase(item.api),
        site: normalizeBase(item.site),
        searchable: item.searchable !== false,
      });
    } else {
      if (!item.endpoint) continue;
      const endpoint = normalizeMaccmsEndpoint(item.endpoint);
      if (!endpoint) continue;
      upstreams.push({
        key: String(item.key || slug),
        slug,
        name: String(item.name || item.key || slug),
        kind: "maccms",
        source: String(item.source || "cache"),
        endpoint,
        site: String(item.site || originOf(endpoint)),
        searchable: item.searchable !== false,
      });
    }
  }

  return {
    source: String((raw && raw.source) || "cache"),
    updatedAt: Number((raw && raw.updatedAt) || 0),
    expiresAt: Number((raw && raw.expiresAt) || 0),
    upstreams,
    bySlug: new Map(upstreams.map((item) => [item.slug, item])),
  };
}

function parseSpiderConfig(text) {
  const api = String(text || "").match(
    /(?:const|let|var)\s+API\s*=\s*['"]([^'"]+)['"]/
  )?.[1];
  const site = String(text || "").match(
    /(?:const|let|var)\s+SITE\s*=\s*['"]([^'"]+)['"]/
  )?.[1];
  return {
    api: normalizeBase(api || DEFAULT_API),
    site: normalizeBase(site || DEFAULT_SITE),
  };
}

function parseConfigUpstreams(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const sites = Array.isArray(data && data.sites) ? data.sites : [];
  const out = [];
  for (const site of sites) {
    if (!site || Number(site.type) !== 1) continue;
    const upstream = maccmsUpstream(site, "config");
    if (upstream) out.push(upstream);
  }
  return out;
}

function envOverrideText(env) {
  return String((env && env.HUANGGUO_UPSTREAMS) || "").trim();
}

function buildUpstreamFromEnvItem(item, index) {
  if (typeof item === "string") {
    const raw = item.trim();
    if (!raw) return null;

    const parts = raw.split("|").map((part) => part.trim());
    if (parts.length >= 3) {
      const kind = parts[4] === "huangguo" ? "huangguo" : "maccms";
      if (kind === "huangguo") {
        const native = nativeUpstream(parts[2], parts[3] || originOf(parts[2]), "env");
        native.key = parts[0] || native.key;
        native.slug = slugify(parts[0] || native.key);
        native.name = parts[1] || native.name;
        return native;
      }
      return maccmsUpstream({ key: parts[0], name: parts[1], api: parts[2] }, "env");
    }

    const eq = raw.indexOf("=");
    if (eq > 0 && eq < raw.indexOf("://")) {
      return maccmsUpstream(
        { key: raw.slice(0, eq).trim(), name: raw.slice(0, eq).trim(), api: raw.slice(eq + 1).trim() },
        "env"
      );
    }

    if (raw.includes("://")) {
      return maccmsUpstream(
        { key: `${hostOf(raw) || `env-${index + 1}`}`, name: hostOf(raw) || raw, api: raw },
        "env"
      );
    }
    return null;
  }

  if (!item || typeof item !== "object") return null;
  const kind = item.kind === "huangguo" ? "huangguo" : "maccms";
  if (kind === "huangguo") {
    const native = nativeUpstream(
      item.api,
      item.site || originOf(item.api),
      "env"
    );
    native.key = String(item.key || native.key);
    native.slug = slugify(item.key || native.key);
    native.name = String(item.name || native.name);
    return native;
  }
  return maccmsUpstream(
    {
      key: item.key,
      name: item.name,
      api: item.api || item.endpoint,
      searchable: item.searchable,
    },
    "env"
  );
}

function poolFromEnv(env) {
  const raw = envOverrideText(env);
  if (!raw) return null;

  let items = [];
  try {
    if (raw.startsWith("[") || raw.startsWith("{")) {
      const parsed = JSON.parse(raw);
      items = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed && parsed.upstreams)
          ? parsed.upstreams
          : [];
    }
  } catch {
    return null;
  }

  if (!items.length) {
    items = raw
      .split(/[\n;,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  const upstreams = [];
  items.forEach((item, index) => {
    const upstream = buildUpstreamFromEnvItem(item, index);
    if (upstream) upstreams.push(upstream);
  });
  if (!upstreams.length) return null;

  return hydratePool({
    source: "env",
    updatedAt: Date.now(),
    expiresAt: Date.now() + poolTtl(env),
    upstreams,
  });
}

async function cacheGetPool() {
  if (typeof caches === "undefined" || !caches.default) return null;
  try {
    const response = await caches.default.match(POOL_CACHE_URL);
    if (!response) return null;
    const data = await response.json();
    if (!data || !Array.isArray(data.upstreams) || !data.upstreams.length) return null;
    return hydratePool(data);
  } catch {
    return null;
  }
}

async function cachePutPool(pool) {
  if (typeof caches === "undefined" || !caches.default) return;
  try {
    const ttlMs = Math.max(60000, pool.expiresAt - Date.now());
    const body = JSON.stringify({
      version: 1,
      source: pool.source,
      updatedAt: pool.updatedAt,
      expiresAt: pool.expiresAt,
      upstreams: pool.upstreams.map((item) => ({
        key: item.key,
        slug: item.slug,
        name: item.name,
        kind: item.kind,
        source: item.source,
        api: item.api,
        site: item.site,
        endpoint: item.endpoint,
        searchable: item.searchable,
      })),
    });
    await caches.default.put(
      POOL_CACHE_URL,
      new Response(body, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": `public, max-age=${Math.floor(ttlMs / 1000)}`,
        },
      })
    );
  } catch {
    // Cache API 不可用时继续用内存池。
  }
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json, text/plain, */*",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function refreshPool(env) {
  if (poolState.loading) return poolState.loading;

  poolState.loading = (async () => {
    const previous = poolState.pool || (await cacheGetPool());
    const [spiderResult, sourcesResult] = await Promise.allSettled([
      fetchText(SPIDER_JS_URL, 8000),
      fetchText(SOURCES_JSON_URL, 10000),
    ]);

    let native = nativeUpstream(DEFAULT_API, DEFAULT_SITE, "builtin");
    if (spiderResult.status === "fulfilled") {
      const parsedSpider = parseSpiderConfig(spiderResult.value);
      native = nativeUpstream(parsedSpider.api, parsedSpider.site, "spider");
    } else {
      console.warn("读取黄果 spider 配置失败，沿用内置地址");
    }

    let configUpstreams = [];
    const parsedConfig =
      sourcesResult.status === "fulfilled"
        ? parseConfigUpstreams(sourcesResult.value)
        : null;

    if (parsedConfig) {
      configUpstreams = parsedConfig;
    } else {
      // 配置源临时失败/返回坏 JSON 时保留上一次的 MacCMS 上游，避免池子瞬间缩水。
      const stale = previous && previous.upstreams ? previous.upstreams : [];
      configUpstreams = stale
        .filter((item) => item.kind === "maccms")
        .map((item) => ({ ...item, source: item.source || "cache" }));
      console.warn("读取 all_sources_config.json 失败，沿用缓存中的 MacCMS 上游");
    }

    const pool = hydratePool({
      source: "auto",
      updatedAt: Date.now(),
      expiresAt: Date.now() + poolTtl(env),
      upstreams: [native, ...configUpstreams],
    });

    // 保证至少有一个可用上游。
    if (!pool.upstreams.length) {
      pool.upstreams = [native];
      pool.bySlug = new Map([[native.slug, native]]);
    }

    poolState.pool = pool;
    poolState.expiresAt = pool.expiresAt;
    await cachePutPool(pool);
    return pool;
  })()
    .catch((error) => {
      console.warn("刷新上游池失败:", error && error.message);
      return null;
    })
    .finally(() => {
      poolState.loading = null;
    });

  return poolState.loading;
}

function scheduleRefresh(env, context) {
  const task = refreshPool(env);
  if (context && typeof context.waitUntil === "function") {
    context.waitUntil(task.catch(() => {}));
  }
  return task;
}

async function getPool(env, context, options = {}) {
  const envPool = poolFromEnv(env);
  if (envPool) return envPool;

  const now = Date.now();
  const awaitRefresh = options.awaitRefresh === true;

  if (poolState.pool) {
    if (poolState.expiresAt > now) {
      // 诊断端点遇到只有内置黄果的 bootstrap 池时，强制刷新一次，
      // 否则第一次打开 ?ac=upstreams 可能只看到一个上游。
      if (awaitRefresh && poolState.pool.source === "bootstrap") {
        const fresh = await refreshPool(env);
        if (fresh) return fresh;
      }
      return poolState.pool;
    }
    if (awaitRefresh) {
      const fresh = await refreshPool(env);
      if (fresh) return fresh;
    } else {
      scheduleRefresh(env, context);
    }
    return poolState.pool;
  }

  const cached = await cacheGetPool();
  if (cached && cached.expiresAt > now) {
    poolState.pool = cached;
    poolState.expiresAt = cached.expiresAt;
    return cached;
  }

  if (awaitRefresh) {
    const fresh = await refreshPool(env);
    if (fresh) return fresh;
  } else {
    scheduleRefresh(env, context);
  }

  if (cached && cached.upstreams.length) {
    poolState.pool = cached;
    poolState.expiresAt = Math.min(cached.expiresAt || 0, now + BOOTSTRAP_TTL_MS);
    return cached;
  }

  const bootstrap = bootstrapPool();
  poolState.pool = bootstrap;
  poolState.expiresAt = bootstrap.expiresAt;
  return bootstrap;
}

function defaultUpstream(pool) {
  if (!pool || !pool.upstreams.length) return null;
  const native = pool.upstreams.find((item) => item.kind === "huangguo");
  return native || pool.upstreams[0];
}

function upstreamBySlug(pool, slug) {
  if (!pool) return null;
  if (!slug) return defaultUpstream(pool);
  const direct = pool.bySlug.get(slug);
  if (direct) return direct;
  // 兼容可能出现的旧别名。
  if (slug === "huangguo" || slug === "huangguo_web") {
    return pool.upstreams.find((item) => item.kind === "huangguo") || null;
  }
  return null;
}

function requestedSlug(url) {
  const querySlug =
    url.searchParams.get("slug") ||
    url.searchParams.get("upstream") ||
    url.searchParams.get("source") ||
    "";
  if (querySlug.trim()) return querySlug.trim();

  const segments = url.pathname.split("/").filter(Boolean);
  const index = segments.lastIndexOf("huangguo");
  if (index >= 0) {
    const next = segments[index + 1];
    if (
      next &&
      next !== "api.php" &&
      next !== "api" &&
      next !== "media" &&
      next !== "play" &&
      next !== "play.m3u8"
    ) {
      return decodeURIComponent(next);
    }
  }
  return "";
}

/* -------------------------------------------------------------------------- */
/* 健康检查 / 熔断                                                             */
/* -------------------------------------------------------------------------- */

function healthOf(upstream) {
  let state = healthState.get(upstream.slug);
  if (!state) {
    state = {
      failures: 0,
      successes: 0,
      consecutiveFailures: 0,
      circuitOpenUntil: 0,
      latencyMs: null,
      lastCheckedAt: 0,
      lastSuccessAt: 0,
      lastError: null,
    };
    healthState.set(upstream.slug, state);
  }
  return state;
}

function isCircuitOpen(upstream) {
  const state = healthState.get(upstream.slug);
  return !!state && state.circuitOpenUntil > Date.now();
}

function markSuccess(upstream, ms) {
  const state = healthOf(upstream);
  state.successes += 1;
  state.failures = 0;
  state.consecutiveFailures = 0;
  state.circuitOpenUntil = 0;
  state.latencyMs = Math.round(ms);
  state.lastCheckedAt = Date.now();
  state.lastSuccessAt = Date.now();
}

function markFailure(upstream, error, env) {
  const state = healthOf(upstream);
  state.failures += 1;
  state.consecutiveFailures += 1;
  state.lastCheckedAt = Date.now();
  state.latencyMs = error.ms || state.latencyMs;
  state.lastError = error.toJSON();
  if (state.consecutiveFailures >= breakerThreshold(env)) {
    const extra = Math.min(state.consecutiveFailures - breakerThreshold(env), 4);
    state.circuitOpenUntil = Date.now() + breakerCooldown(env) * (1 + extra);
  }
}

function statusOf(upstream) {
  const state = healthState.get(upstream.slug);
  if (state && state.circuitOpenUntil > Date.now()) return "circuit_open";
  if (state && state.consecutiveFailures > 0) return "degraded";
  if (state && state.lastSuccessAt) return "ok";
  return "unknown";
}

/* -------------------------------------------------------------------------- */
/* 上游请求                                                                    */
/* -------------------------------------------------------------------------- */

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function refererOf(upstream) {
  return `${(upstream && (upstream.site || originOf(upstream.api))) || DEFAULT_SITE}/`;
}

async function requestUpstreamJson(upstream, url, env, options = {}) {
  const timeoutMs = clamp(
    Number(options.timeoutMs) || upstreamTimeout(env),
    1000,
    30000
  );

  if (!options.bypassBreaker && isCircuitOpen(upstream)) {
    const state = healthState.get(upstream.slug);
    const remain = Math.max(0, (state.circuitOpenUntil || 0) - Date.now());
    throw new UpstreamError(
      upstream,
      "circuit_open",
      `失败冷却中，剩余 ${Math.ceil(remain / 1000)} 秒`,
      { ms: 0 }
    );
  }

  const start = Date.now();
  let status = null;

  try {
    const response = await fetchWithTimeout(
      url,
      {
        headers: {
          "User-Agent": UA,
          Referer: refererOf(upstream),
          Accept: "application/json, text/plain, */*",
        },
      },
      timeoutMs
    );
    status = response.status;
    const text = await response.text();
    const ms = Date.now() - start;

    if (!response.ok) {
      throw new UpstreamError(upstream, "http", `HTTP ${response.status}`, {
        status,
        ms,
      });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new UpstreamError(upstream, "parse", "响应不是有效 JSON", {
        status,
        ms,
      });
    }
    if (!data || typeof data !== "object") {
      throw new UpstreamError(upstream, "parse", "响应 JSON 不是对象", {
        status,
        ms,
      });
    }
    if (Number(data.code) === 0) {
      const message = String(data.msg || data.message || "上游返回 code=0").trim();
      throw new UpstreamError(upstream, "upstream", message, { status, ms });
    }

    markSuccess(upstream, ms);
    return { data, ms, status };
  } catch (error) {
    const ms = Date.now() - start;
    let err = error;
    if (!(err instanceof UpstreamError)) {
      const name = String((error && error.name) || "");
      const message = String((error && error.message) || "");
      const timeout =
        name === "AbortError" ||
        name === "TimeoutError" ||
        /abort|timed? ?out/i.test(message);
      const kind = timeout ? "timeout" : "network";
      err = new UpstreamError(
        upstream,
        kind,
        timeout ? `请求超过 ${timeoutMs}ms` : message || "网络请求失败",
        { status, ms }
      );
    } else if (!err.ms) {
      err.ms = ms;
    }
    markFailure(upstream, err, env);
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* 数据归一化                                                                  */
/* -------------------------------------------------------------------------- */

function proxyPicture(origin, upstream, value) {
  let pic = String(value || "").trim();
  if (!pic) return "";
  if (pic.startsWith("//")) pic = `https:${pic}`;
  if (!/^https?:\/\//i.test(pic)) {
    const base = upstream.site || originOf(upstream.api) || DEFAULT_SITE;
    pic = `${base}${pic.startsWith("/") ? "" : "/"}${pic}`;
  }
  if (!origin) return pic;
  return `${origin}/huangguo/media?src=${encodeURIComponent(pic)}&up=${encodeURIComponent(upstream.slug)}`;
}

function nativePicture(upstream, value, wrapPic) {
  const raw = String(value || "");
  if (!raw) return "";
  if (raw.startsWith("//")) {
    const absolute = `https:${raw}`;
    return wrapPic ? `${upstream.api}/media?url=${encodeURIComponent(absolute)}` : absolute;
  }
  if (/^https?:\/\//i.test(raw)) {
    return wrapPic ? `${upstream.api}/media?url=${encodeURIComponent(raw)}` : raw;
  }
  // Worker 列表偶尔返回 /media?url=... 这种相对路径，必须先补上 Worker 地址。
  return `${upstream.api}${raw.startsWith("/") ? "" : "/"}${raw}`;
}

function toNativeVod(item, upstream, origin, wrapPic = false) {
  const rawPic = nativePicture(
    upstream,
    item.vod_pic || item.cover || "",
    wrapPic
  );
  return {
    vod_id: String(item.vod_id || item.id || ""),
    vod_name: String(item.vod_name || item.title || ""),
    vod_pic: proxyPicture(origin, upstream, rawPic),
    vod_remarks: String(item.vod_remarks || ""),
    type_name: String(item.type_name || ""),
    vod_year: String(item.vod_year || ""),
    vod_area: String(item.vod_area || ""),
    vod_score: String(item.vod_score || item.score || ""),
  };
}

function toMaccmsVod(item, upstream, origin) {
  return {
    vod_id: String(item.vod_id != null ? item.vod_id : item.id != null ? item.id : ""),
    vod_name: String(item.vod_name || item.name || item.title || ""),
    vod_pic: proxyPicture(
      origin,
      upstream,
      item.vod_pic || item.vod_pic_thumb || item.pic || ""
    ),
    vod_remarks: String(item.vod_remarks || item.vod_note || ""),
    type_name: String(item.type_name || item.vod_class || ""),
    vod_year: String(item.vod_year || ""),
    vod_area: String(item.vod_area || ""),
    vod_score: String(item.vod_score || ""),
  };
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function isDirectMediaUrl(value) {
  return (
    isHttpUrl(value) &&
    /\.(m3u8|mp4|flv|mkv|webm)(\?|#|$)/i.test(String(value || ""))
  );
}

/**
 * 上游接口字段名一直在变（url / play_url / video_url / data.url / 甚至塞在
 * JSON 字符串里），这里做一次有界的深度搜索，避免"明明有地址却解析不到"。
 */
function deepFindMediaUrl(value, depth = 0) {
  if (depth > 4 || value == null) return "";
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return "";
    if (isDirectMediaUrl(text)) return text;
    if (/^[[{]/.test(text)) {
      try {
        return deepFindMediaUrl(JSON.parse(text), depth + 1);
      } catch {
        return "";
      }
    }
    return "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFindMediaUrl(item, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (typeof value === "object") {
    const preferred = [
      "url",
      "proxy",
      "play_url",
      "playUrl",
      "video_url",
      "videoUrl",
      "m3u8",
      "m3u8_url",
      "src",
      "file",
      "link",
      "data",
      "result",
    ];
    for (const key of preferred) {
      if (key in value) {
        const found = deepFindMediaUrl(value[key], depth + 1);
        if (found) return found;
      }
    }
    for (const item of Object.values(value)) {
      const found = deepFindMediaUrl(item, depth + 1);
      if (found) return found;
    }
  }
  return "";
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
    Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, () => worker())
  );
  return results;
}

/* -------------------------------------------------------------------------- */
/* 原生黄果上游                                                                */
/* -------------------------------------------------------------------------- */

async function nativeList(upstream, typeId, page, origin, env) {
  const type = typeId || "ai-duanju";
  let url = `${upstream.api}/api/category/${encodeURIComponent(type)}?page=${page}&size=50&sort=latest`;

  if (type.startsWith("rank:")) {
    const kind = type.slice("rank:".length) || "hot";
    url = `${upstream.api}/api/ranks/${encodeURIComponent(kind)}?page=${page}&size=50`;
  } else if (type.startsWith("chigua")) {
    const cate = type.split(":")[1] || "all";
    url = `${upstream.api}/api/chigua?cate=${encodeURIComponent(cate)}&page=${page}&size=50`;
  }

  const { data } = await requestUpstreamJson(upstream, url, env);
  const list = (Array.isArray(data.list) ? data.list : [])
    .map((item) => toNativeVod(item, upstream, origin, false))
    .filter((item) => item.vod_id && item.vod_name)
    .map((item) => ({ ...item, vod_id: namespaceId(upstream, item.vod_id) }));
  const pageCount = Number(data.pagecount) || page;
  return { list, pageCount };
}

async function nativeSearch(upstream, keyword, origin, env) {
  const warnings = [];
  let list = [];

  try {
    const { data } = await requestUpstreamJson(
      upstream,
      `${upstream.api}/api/search/${encodeURIComponent(keyword)}?page=1&size=50`,
      env,
      { timeoutMs: searchTimeout(env) }
    );
    if (Array.isArray(data.list)) {
      list = data.list
        .map((item) => toNativeVod(item, upstream, origin, false))
        .filter((item) => item.vod_id && item.vod_name);
    }
  } catch (error) {
    warnings.push(error.toJSON ? error.toJSON() : null);
  }

  if (!list.length) {
    try {
      const { data } = await requestUpstreamJson(
        upstream,
        `${upstream.site}/api/search?q=${encodeURIComponent(keyword)}&page=1&size=50`,
        env,
        { timeoutMs: searchTimeout(env) }
      );
      const items = data && data.data && data.data.items;
      if (Array.isArray(items)) {
        list = items
          .map((item) => toNativeVod(item, upstream, origin, true))
          .filter((item) => item.vod_id && item.vod_name);
      }
    } catch (error) {
      warnings.push(error.toJSON ? error.toJSON() : null);
    }
  }

  if (!list.length && warnings.length === 2) {
    const first = warnings[0] || {};
    const second = warnings[1] || {};
    const summary = `Worker 搜索失败（${first.message || "未知"}）；站点搜索失败（${second.message || "未知"}）`;
    throw new UpstreamError(upstream, first.kind || "search", summary, {
      status: first.status,
      ms: (first.ms || 0) + (second.ms || 0),
      summary,
    });
  }

  return {
    list: list
      .filter((item) => item.vod_id && item.vod_name)
      .map((item) => ({ ...item, vod_id: namespaceId(upstream, item.vod_id) })),
    warnings: warnings.filter(Boolean),
  };
}

async function fetchPageStream(upstream, pageUrl, ep, timeoutMs) {
  if (!isHttpUrl(pageUrl)) return "";
  try {
    const response = await fetchWithTimeout(
      pageUrl,
      {
        headers: {
          "User-Agent": UA,
          Referer: `${upstream.site}/`,
        },
      },
      timeoutMs
    );
    if (!response.ok) return "";
    const html = await response.text();
    const normalized = html.replace(/\\\//g, "/").replace(/\\u0026/g, "&");

    const dataMatch = normalized.match(
      /id=["']videoInitialData["'][^>]*>([\s\S]*?)<\/script>/i
    );
    if (dataMatch) {
      try {
        const data = JSON.parse(dataMatch[1]);
        let stream = "";
        if (Array.isArray(data.epPlaySrcs)) {
          stream = data.epPlaySrcs[Number(ep) - 1] || data.epPlaySrcs[0] || "";
        } else if (data.epPlaySrcs && typeof data.epPlaySrcs === "object") {
          stream = data.epPlaySrcs[String(ep)] || data.epPlaySrcs[ep] || "";
        }
        if (!stream) stream = data.videoSrc || "";
        stream = String(stream).trim();
        if (isHttpUrl(stream)) return stream;
      } catch {
        // 继续用正则兜底。
      }
    }

    const matched = normalized.match(
      /https?:\/\/[^"'<>\s]+?\.(?:m3u8|mp4)(?:\?[^"'<>\s]*)?/i
    );
    if (matched) return matched[0].replace(/&amp;/g, "&");

    // 再宽一点：player_aaaa / player_data 之类的配置块、<source src>、data-src。
    const configMatch = normalized.match(
      /(?:player_[a-z0-9]*|playerData|videoInfo)\s*=\s*(\{[\s\S]{0,4000}?\})\s*[;<]/i
    );
    if (configMatch) {
      const fromConfig = deepFindMediaUrl(configMatch[1]);
      if (fromConfig) return fromConfig;
    }

    const attrMatch = normalized.match(
      /<(?:source|video)[^>]+(?:src|data-src|data-video-src)=["']([^"']+)["']/i
    );
    if (attrMatch) {
      const candidate = attrMatch[1].replace(/&amp;/g, "&");
      if (isDirectMediaUrl(candidate)) return candidate;
    }
  } catch {
    // 页面抓取失败就返回空，由调用方决定下一个兜底。
  }
  return "";
}

/**
 * 把单集解析推迟到用户真正点播时。
 *
 * 旧实现会在详情阶段对最多 50 集并发调用 /api/play；Worker 现在每次 play
 * 还会探测 m3u8 时长，50 个请求很容易超时，最后一集都拿不到，只能报
 * no_playable。详情阶段改为生成 /huangguo/play.m3u8?... 的惰性地址，
 * 点哪集解析哪集；解析顺序：Worker /api/play → 源站官方接口 → 页面兜底。
 */
function playAttemptError(error) {
  if (error instanceof UpstreamError) {
    return {
      kind: error.kind,
      status: error.status,
      ms: error.ms,
      message: String(error.message || "").slice(0, 180),
    };
  }
  return {
    kind: "error",
    message: String((error && error.message) || error || "").slice(0, 180),
  };
}

/**
 * 把单集解析推迟到用户真正点播时。
 *
 * 关键点：Worker 的 /api/play 虽然也接受数字 id，但它的页面兜底是
 * getHtml(page)；传数字 id 时这一步会失败。所以优先把详情里的
 * episodes[].url（真实剧集页地址）作为 url 参数传给 Worker。
 *
 * 解析顺序：详情直链/剧集页 → 吃瓜帖子 → Worker /api/play（页面地址）
 * → 源站官方接口 → 剧集页 videoInitialData/m3u8。
 * 每次失败都记录 attempts，最终 502 JSON 会带上，方便定位。
 */
async function resolveNativePlay(upstream, id, ep, env, pageHint, budgetMs) {
  const budget = clamp(Number(budgetMs) || 25000, 2500, 30000);
  const deadline = Date.now() + budget;
  const remaining = (max) =>
    Math.max(1000, Math.min(max || 25000, deadline - Date.now()));
  const attempts = [];
  const archives = String(id).startsWith("archives_");
  const pid = archives ? String(id).slice("archives_".length) : "";
  let detailPageUrl = isHttpUrl(pageHint) ? String(pageHint).trim() : "";

  // 没有页面地址时才回详情里找；有 pageHint 时直接进入播放解析，少一次请求。
  if (!detailPageUrl) {
    try {
      const started = Date.now();
      const { data, status } = await requestUpstreamJson(
        upstream,
        `${upstream.api}/api/detail/${encodeURIComponent(id)}`,
        env,
        { timeoutMs: remaining(6000) }
      );
      const item = (Array.isArray(data.list) && data.list[0]) || null;
      const episodes = item && Array.isArray(item.episodes) ? item.episodes : [];
      const match =
        episodes.find((entry) => String(entry.ep) === String(ep)) ||
        episodes[Number(ep) - 1] ||
        episodes[0] ||
        null;
      const url = match ? String(match.url || "").trim() : "";

      if (isDirectMediaUrl(url)) {
        attempts.push({
          step: "detail",
          ok: true,
          via: "direct",
          status,
          ms: Date.now() - started,
        });
        // 原生站 CDN 对分片和清单都带 CORS，浏览器直连才能拿到完整片源。
        return { url, attempts, preferDirect: true };
      }
      if (isHttpUrl(url)) detailPageUrl = url;
      attempts.push({
        step: "detail",
        ok: !!detailPageUrl,
        status,
        ms: Date.now() - started,
        hasEpisodePage: !!detailPageUrl,
      });
    } catch (error) {
      attempts.push({ step: "detail", ok: false, ...playAttemptError(error) });
    }
  }

  // 吃瓜图文帖：帖子接口里的 video_url / 正文 m3u8，再退到吃瓜页面。
  if (archives) {
    try {
      const started = Date.now();
      const { data, status } = await requestUpstreamJson(
        upstream,
        `${upstream.site}/api/posts/${encodeURIComponent(pid)}`,
        env,
        { timeoutMs: remaining(5000) }
      );
      let url = String((data.data && data.data.video_url) || "");
      if (!url) {
        const matched = String((data.data && data.data.content) || "").match(
          /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i
        );
        if (matched) url = matched[0].replace(/&amp;/g, "&");
      }
      if (isHttpUrl(url)) {
        attempts.push({
          step: "archives-post",
          ok: true,
          status,
          ms: Date.now() - started,
        });
        return { url, attempts, preferDirect: true };
      }
      attempts.push({
        step: "archives-post",
        ok: false,
        status,
        ms: Date.now() - started,
        reason: "empty video_url",
      });
    } catch (error) {
      attempts.push({ step: "archives-post", ok: false, ...playAttemptError(error) });
    }

    const started = Date.now();
    const archivePage = await fetchPageStream(
      upstream,
      `${upstream.site}/archives/${encodeURIComponent(pid)}/`,
      "1",
      remaining(5000)
    );
    attempts.push({
      step: "archives-page",
      ok: !!archivePage,
      ms: Date.now() - started,
      ...(archivePage ? {} : { reason: "no media" }),
    });
    if (archivePage) return { url: archivePage, attempts, preferDirect: true };
  }

  // Worker /api/play：优先传真实剧集页地址，让 Worker 的页面兜底可用。
  try {
    const started = Date.now();
    const target = detailPageUrl || id;
    const { data, status } = await requestUpstreamJson(
      upstream,
      `${upstream.api}/api/play?url=${encodeURIComponent(target)}&ep=${encodeURIComponent(ep)}`,
      env,
      { timeoutMs: remaining(archives ? 6000 : 12000) }
    );
    const direct = typeof data.url === "string" ? data.url.trim() : "";
    const proxy = typeof data.proxy === "string" ? data.proxy.trim() : "";
    const ms = Date.now() - started;

    if (
      isHttpUrl(direct) &&
      !(direct.startsWith("http://") && proxy.startsWith("https://"))
    ) {
      attempts.push({ step: "worker-play", ok: true, via: "direct", status, ms });
      return {
        url: direct,
        attempts,
        // preferDirect=true 表示浏览器直连能拿到完整片源（Worker 出口只有预览片段）
        preferDirect: data.preferDirect !== false,
      };
    }
    if (isHttpUrl(proxy)) {
      attempts.push({ step: "worker-play", ok: true, via: "proxy", status, ms });
      return { url: proxy, attempts, preferDirect: true };
    }
    // 字段名变了也要认出来（data.url / play_url / 嵌套 JSON 字符串等）。
    const deepWorker = deepFindMediaUrl(data);
    if (deepWorker) {
      attempts.push({ step: "worker-play", ok: true, via: "deep", status, ms });
      return {
        url: deepWorker,
        attempts,
        preferDirect: data.preferDirect !== false,
      };
    }
    const declared = Number((data && data.declaredDuration) || 0);
    attempts.push({
      step: "worker-play",
      ok: false,
      status,
      ms,
      // Worker 声明了时长却没给地址：一般是刚更新、还没转码出播放地址。
      ...(declared > 0
        ? {
            kind: "media_pending",
            reason: "Worker 声明了时长但没有播放地址（可能刚更新）",
            declaredDuration: declared,
          }
        : { reason: "empty url/proxy" }),
      ...(data && typeof data === "object"
        ? { keys: Object.keys(data).slice(0, 8) }
        : {}),
    });
  } catch (error) {
    attempts.push({ step: "worker-play", ok: false, ...playAttemptError(error) });
  }

  // 源站官方播放接口。
  try {
    const started = Date.now();
    const { data, status } = await requestUpstreamJson(
      upstream,
      `${upstream.site}/api/videos/${encodeURIComponent(id)}/play?ep=${encodeURIComponent(ep)}`,
      env,
      { timeoutMs: remaining(5000) }
    );
    const siteUrl = String(
      (data.data && data.data.video_url) || data.video_url || ""
    ).trim();
    const deepSite = siteUrl ? "" : deepFindMediaUrl(data);
    const ms = Date.now() - started;
    if (isHttpUrl(siteUrl) || deepSite) {
      attempts.push({
        step: "site-play",
        ok: true,
        status,
        ms,
        ...(deepSite ? { via: "deep" } : {}),
      });
      return { url: siteUrl || deepSite, attempts, preferDirect: true };
    }
    const detailData = (data && data.data) || null;
    const duration = Number((detailData && detailData.duration) || 0);
    attempts.push({
      step: "site-play",
      ok: false,
      status,
      ms,
      // 有 duration、没有 video_url：上游更新了剧集但片源还没生成好。
      ...(duration > 0
        ? {
            kind: "media_pending",
            reason: "上游返回了时长但没有播放地址（可能刚更新）",
            duration,
          }
        : { reason: "empty video_url" }),
      ...(data && typeof data === "object"
        ? { keys: Object.keys(data).slice(0, 8) }
        : {}),
    });
  } catch (error) {
    attempts.push({ step: "site-play", ok: false, ...playAttemptError(error) });
  }

  // 最后一层：抓剧集页。优先用详情里的精确 ep.url，再退回拼 URL。
  const pageUrl =
    detailPageUrl ||
    (ep === "1"
      ? `${upstream.site}/video/${encodeURIComponent(id)}/`
      : `${upstream.site}/video/${encodeURIComponent(id)}/ep-${encodeURIComponent(ep)}/`);
  const started = Date.now();
  const pageStream = await fetchPageStream(upstream, pageUrl, ep, remaining(5000));
  attempts.push({
    step: "page",
    ok: !!pageStream,
    ms: Date.now() - started,
    ...(pageStream ? {} : { reason: "no media" }),
  });

  return {
    url: pageStream || "",
    attempts,
    preferDirect: true,
  };
}

async function nativeDetail(upstream, id, origin, env) {
  const started = Date.now();
  const { data } = await requestUpstreamJson(
    upstream,
    `${upstream.api}/api/detail/${encodeURIComponent(id)}`,
    env
  );
  const item = (Array.isArray(data.list) && data.list[0]) || null;
  if (!item) return { status: "not_found" };

  let episodes = Array.isArray(item.episodes) ? item.episodes.slice(0, 100) : [];
  if (!episodes.length && String(id).startsWith("archives_")) {
    // 吃瓜详情可能没有 episodes，点播时再去 posts/detail 里找直链。
    episodes = [{ ep: "1", title: "第1集", url: "" }];
  }

  if (!episodes.length) {
    const summary = `上游「${upstream.name}」返回了详情，但 episodes 为空（可能已下架或详情接口异常）`;
    throw new UpstreamError(upstream, "no_playable", summary, {
      status: 200,
      ms: Date.now() - started,
      summary,
      details: { id: String(id), episodes: 0 },
    });
  }

  const playUrls = episodes.map((ep, index) => {
    const epNumber = String(ep.ep || index + 1);
    const title = String(ep.title || `第${epNumber}集`).replace(/\$/g, " ");
    let url = String(ep.url || "").trim();
    if (url.startsWith("//")) url = `https:${url}`;
    const pageUrl = isHttpUrl(url) ? url : "";
    if (!isDirectMediaUrl(url)) {
      url = lazyPlayUrl(
        origin,
        upstream,
        id,
        epNumber,
        pageUrl,
        item.vod_name || ""
      );
    }
    return `${title}$${url}`;
  });

  return {
    status: "ok",
    vod: {
      ...toNativeVod(item, upstream, origin, false),
      vod_id: String(item.vod_id || id),
      vod_play_from: "黄果",
      vod_play_url: playUrls.join("#"),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* MacCMS 上游                                                                 */
/* -------------------------------------------------------------------------- */

function maccmsUrl(upstream, params) {
  const url = new URL(upstream.endpoint);
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function maccmsClasses(upstream, env) {
  const { data } = await requestUpstreamJson(
    upstream,
    maccmsUrl(upstream, { ac: "list" }),
    env
  );

  if (Array.isArray(data.class)) {
    return data.class
      .filter((item) => item && item.type_id != null && item.type_name)
      .map((item) => ({
        type_id: String(item.type_id),
        type_name: String(item.type_name),
      }));
  }

  // 部分 api/json.php 实现把 ac=list 当成列表接口，用列表里的类型反推分类。
  const seen = new Set();
  const classes = [];
  for (const item of Array.isArray(data.list) ? data.list : []) {
    const typeId = item && item.type_id != null ? String(item.type_id) : "";
    const typeName = item && item.type_name ? String(item.type_name) : "";
    if (!typeId || !typeName || seen.has(typeId)) continue;
    seen.add(typeId);
    classes.push({ type_id: typeId, type_name: typeName });
  }
  return classes;
}

async function maccmsList(upstream, typeId, page, origin, env) {
  let { data } = await requestUpstreamJson(
    upstream,
    maccmsUrl(upstream, {
      ac: "videolist",
      pg: page,
      t: typeId,
    }),
    env
  );

  // 少数 CMS 只接受 ac=detail 做列表查询。
  if (
    page === 1 &&
    (!Array.isArray(data.list) || data.list.length === 0) &&
    typeId
  ) {
    const fallback = await requestUpstreamJson(
      upstream,
      maccmsUrl(upstream, { ac: "detail", pg: 1, t: typeId }),
      env
    );
    if (Array.isArray(fallback.data.list) && fallback.data.list.length > 0) {
      data = fallback.data;
    }
  }

  const list = (Array.isArray(data.list) ? data.list : [])
    .map((item) => toMaccmsVod(item, upstream, origin))
    .filter((item) => item.vod_id && item.vod_name)
    .map((item) => ({ ...item, vod_id: namespaceId(upstream, item.vod_id) }));

  return {
    list,
    pageCount: Number(data.pagecount) || page,
  };
}

async function maccmsSearch(upstream, keyword, origin, env) {
  const { data } = await requestUpstreamJson(
    upstream,
    maccmsUrl(upstream, { ac: "videolist", wd: keyword, pg: 1 }),
    env,
    { timeoutMs: searchTimeout(env) }
  );

  const list = (Array.isArray(data.list) ? data.list : [])
    .map((item) => toMaccmsVod(item, upstream, origin))
    .filter((item) => item.vod_id && item.vod_name)
    .map((item) => ({ ...item, vod_id: namespaceId(upstream, item.vod_id) }));

  return { list, warnings: [] };
}

async function maccmsDetail(upstream, ids, origin, env) {
  const { data } = await requestUpstreamJson(
    upstream,
    maccmsUrl(upstream, { ac: "detail", ids }),
    env
  );
  const item = (Array.isArray(data.list) && data.list[0]) || null;
  if (!item) return { status: "not_found" };

  const playUrl = String(item.vod_play_url || "");
  if (!playUrl || !/https?:\/\//i.test(playUrl)) {
    throw new UpstreamError(
      upstream,
      "no_playable",
      "详情存在，但 vod_play_url 为空或不是 HTTP 地址",
      { status: 200 }
    );
  }

  const vod = toMaccmsVod(item, upstream, origin);
  return {
    status: "ok",
    vod: {
      ...vod,
      vod_play_from: String(item.vod_play_from || upstream.name || "MacCMS"),
      vod_play_url: playUrl,
      vod_content: String(item.vod_content || item.vod_blurb || ""),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 聚合搜索                                                                    */
/* -------------------------------------------------------------------------- */

function searchErrorFor(errors, skipped) {
  if (errors.length) {
    const first = errors[0];
    const summary = `搜索失败：${errors.length} 个上游不可用${
      skipped ? `，${skipped} 个跳过` : ""
    }（${summarizeKinds(errors)}）`;
    return new UpstreamError(
      { slug: first.upstream || "all", name: first.upstreamName || first.upstream || "all" },
      first.kind || "search",
      summary,
      {
        status: first.status,
        ms: errors.reduce((sum, item) => sum + (item.ms || 0), 0),
        summary,
      }
    );
  }
  return new UpstreamError(
    "all",
    "circuit_open",
    `搜索失败：所有可搜索上游都在失败冷却中${skipped ? `（${skipped} 个）` : ""}`,
    { ms: 0 }
  );
}

async function searchAll(pool, keyword, origin, env) {
  const candidates = pool.upstreams.filter(
    (item) => item.searchable !== false && !isCircuitOpen(item)
  );
  let skipped = pool.upstreams.length - candidates.length;
  const deadline = Date.now() + searchDeadlineMs(env);
  const errors = [];
  const warnings = [];

  const results = await mapLimit(
    candidates,
    searchConcurrency(env),
    async (upstream) => {
      if (Date.now() >= deadline) {
        skipped += 1;
        return null;
      }
      try {
        const result =
          upstream.kind === "huangguo"
            ? await nativeSearch(upstream, keyword, origin, env)
            : await maccmsSearch(upstream, keyword, origin, env);
        for (const warning of result.warnings || []) {
          warnings.push({
            ...warning,
            upstream: warning.upstream || upstream.slug,
          });
        }
        return { list: result.list || [], upstream };
      } catch (error) {
        const err =
          error instanceof UpstreamError
            ? error
            : new UpstreamError(upstream, "upstream", String(error && error.message));
        errors.push(err);
        return null;
      }
    }
  );

  const successes = results.filter(Boolean);
  const seen = new Set();
  const list = [];
  for (const result of successes) {
    for (const item of result.list) {
      if (!item.vod_id || seen.has(item.vod_id)) continue;
      seen.add(item.vod_id);
      // 搜索页用 source_key 找到对应源的 API 基址，用 source_name 展示来源。
      list.push(decorateSearchItem(item, result.upstream));
    }
  }

  errors.sort((a, b) => String(a.upstream).localeCompare(String(b.upstream)));
  warnings.sort((a, b) =>
    String(a.upstream).localeCompare(String(b.upstream))
  );

  return {
    list: list.slice(0, 300),
    errors,
    warnings,
    skipped,
    attempted: candidates.length,
    succeeded: successes.length,
  };
}

/* -------------------------------------------------------------------------- */
/* 诊断                                                                        */
/* -------------------------------------------------------------------------- */

function upstreamReport(upstream) {
  const state = healthState.get(upstream.slug);
  const now = Date.now();
  const open = !!state && state.circuitOpenUntil > now;
  const status = statusOf(upstream);
  return {
    slug: upstream.slug,
    key: upstream.key,
    name: upstream.name,
    kind: upstream.kind,
    source: upstream.source,
    host:
      upstream.kind === "huangguo"
        ? hostOf(upstream.api)
        : hostOf(upstream.endpoint),
    status,
    latencyMs: state ? state.latencyMs : null,
    lastCheckedAt: state ? isoTime(state.lastCheckedAt) : null,
    lastSuccessAt: state ? isoTime(state.lastSuccessAt) : null,
    lastError: state ? state.lastError : null,
    consecutiveFailures: state ? state.consecutiveFailures : 0,
    successes: state ? state.successes : 0,
    circuitOpenUntil: open ? isoTime(state.circuitOpenUntil) : null,
    cooldownRemainingMs: open
      ? Math.max(0, state.circuitOpenUntil - now)
      : 0,
  };
}

async function probeUpstreams(pool, env) {
  const deadline = Date.now() + DEFAULT_PROBE_DEADLINE_MS;
  let skipped = 0;
  const results = await mapLimit(pool.upstreams, 8, async (upstream) => {
    if (Date.now() >= deadline) {
      skipped += 1;
      return false;
    }
    try {
      if (upstream.kind === "huangguo") {
        await requestUpstreamJson(
          upstream,
          `${upstream.api}/api/category/ai-duanju?page=1&size=1`,
          env,
          { timeoutMs: DEFAULT_PROBE_TIMEOUT_MS, bypassBreaker: true }
        );
      } else {
        await requestUpstreamJson(
          upstream,
          maccmsUrl(upstream, { ac: "list" }),
          env,
          { timeoutMs: DEFAULT_PROBE_TIMEOUT_MS, bypassBreaker: true }
        );
      }
      return true;
    } catch {
      return false;
    }
  });

  const ok = results.filter(Boolean).length;
  return {
    enabled: true,
    attempted: pool.upstreams.length - skipped,
    ok,
    failed: results.length - ok - skipped,
    skipped,
  };
}

/* -------------------------------------------------------------------------- */
/* 路由                                                                        */
/* -------------------------------------------------------------------------- */

function parseDetailIds(raw, pool, fallbackSlug) {
  const pieces = String(raw || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!pieces.length) return null;

  const parsed = pieces.map((piece) => {
    const index = piece.indexOf("~");
    if (index > 0) {
      return {
        slug: piece.slice(0, index),
        id: piece.slice(index + 1),
        namespaced: true,
      };
    }
    return { slug: "", id: piece, namespaced: false };
  });

  const namespaced = parsed.find((item) => item.namespaced);
  const slug = namespaced ? namespaced.slug : fallbackSlug || "";
  const upstream = upstreamBySlug(pool, slug);
  if (!upstream) {
    return {
      error: new UpstreamError(
        slug || "unknown",
        "unknown_upstream",
        `未知上游: ${slug || "(空)"}`
      ),
    };
  }

  if (
    namespaced &&
    parsed.some((item) => item.namespaced && item.slug !== namespaced.slug)
  ) {
    return {
      error: new UpstreamError(
        upstream,
        "upstream",
        "一次只能查询同一个上游的详情"
      ),
    };
  }

  const first = parsed[0];
  const routedByPath = !first.namespaced && !!fallbackSlug;
  return {
    upstream,
    ids: parsed.map((item) => item.id).join(","),
    firstId: first.id,
    displayId:
      first.namespaced || routedByPath
        ? `${upstream.slug}~${first.id}`
        : String(raw).trim(),
    count: parsed.length,
  };
}

async function handleList(url, pool, env) {
  const slug = requestedSlug(url);
  const upstream = upstreamBySlug(pool, slug);
  if (!upstream) {
    return errorResponse(
      new UpstreamError(slug, "unknown_upstream", `未知上游: ${slug}`)
    );
  }

  if (upstream.kind === "huangguo") {
    return jsonResponse({
      code: 1,
      msg: "数据列表",
      class: HUANGGUO_CLASSES,
      list: [],
    });
  }

  try {
    const classes = await maccmsClasses(upstream, env);
    return jsonResponse({ code: 1, msg: "数据列表", class: classes, list: [] });
  } catch (error) {
    const err =
      error instanceof UpstreamError
        ? error
        : new UpstreamError(upstream, "upstream", String(error && error.message));
    return errorResponse(err);
  }
}

async function handleDetailList(url, pool, env) {
  const keyword = String(url.searchParams.get("wd") || "").trim();
  const origin = url.origin;

  if (keyword) {
    const slug = requestedSlug(url);
    const upstream = upstreamBySlug(pool, slug);
    if (!upstream) {
      return errorResponse(
        new UpstreamError(slug, "unknown_upstream", `未知上游: ${slug}`)
      );
    }

    if (slug) {
      try {
        const result =
          upstream.kind === "huangguo"
            ? await nativeSearch(upstream, keyword, origin, env)
            : await maccmsSearch(upstream, keyword, origin, env);
        const list = result.list.map((item) => decorateSearchItem(item, upstream));
        return jsonResponse({
          code: 1,
          msg: "数据列表",
          page: 1,
          pagecount: 1,
          limit: list.length,
          total: list.length,
          list,
          ...(result.warnings && result.warnings.length
            ? { warnings: result.warnings }
            : {}),
        });
      } catch (error) {
        const err =
          error instanceof UpstreamError
            ? error
            : new UpstreamError(upstream, "upstream", String(error && error.message));
        return errorResponse(err);
      }
    }

    const result = await searchAll(pool, keyword, origin, env);
    if (!result.succeeded && (result.errors.length || result.skipped)) {
      const err = searchErrorFor(result.errors, result.skipped);
      return errorResponse(err, {
        errors: result.errors.map((item) => item.toJSON()),
        skipped: result.skipped,
      });
    }

    const partial = result.errors.length > 0;
    return jsonResponse({
      code: 1,
      msg: partial
        ? `数据列表（${result.errors.length} 个上游失败）`
        : "数据列表",
      page: 1,
      pagecount: 1,
      limit: result.list.length,
      total: result.list.length,
      list: result.list,
      ...(partial ? { partial: true, errors: result.errors.map((item) => item.toJSON()) } : {}),
      ...(result.warnings.length ? { warnings: result.warnings } : {}),
      ...(result.skipped ? { skipped: result.skipped } : {}),
    });
  }

  const slug = requestedSlug(url);
  const upstream = upstreamBySlug(pool, slug);
  if (!upstream) {
    return errorResponse(
      new UpstreamError(slug, "unknown_upstream", `未知上游: ${slug}`)
    );
  }

  const page = Math.max(1, Number(url.searchParams.get("pg")) || 1);
  const typeId = url.searchParams.get("t") || (upstream.kind === "huangguo" ? "ai-duanju" : "");

  try {
    const result =
      upstream.kind === "huangguo"
        ? await nativeList(upstream, typeId, page, origin, env)
        : await maccmsList(upstream, typeId, page, origin, env);
    return jsonResponse({
      code: 1,
      msg: "数据列表",
      page,
      pagecount: result.pageCount,
      limit: result.list.length,
      total: result.list.length,
      list: result.list,
    });
  } catch (error) {
    const err =
      error instanceof UpstreamError
        ? error
        : new UpstreamError(upstream, "upstream", String(error && error.message));
    return errorResponse(err);
  }
}

async function handleDetail(url, pool, env) {
  const parsed = parseDetailIds(
    url.searchParams.get("ids"),
    pool,
    requestedSlug(url)
  );
  if (!parsed) {
    return jsonResponse({ code: 1, msg: "缺少 ids", list: [] });
  }
  if (parsed.error) return errorResponse(parsed.error);

  const { upstream } = parsed;
  try {
    const result =
      upstream.kind === "huangguo"
        ? await nativeDetail(upstream, parsed.firstId, url.origin, env)
        : await maccmsDetail(upstream, parsed.ids, url.origin, env);

    if (result.status === "not_found") {
      return jsonResponse({
        code: 1,
        msg: "没有找到内容",
        page: 1,
        pagecount: 0,
        limit: 0,
        total: 0,
        list: [],
      });
    }

    // 附带一份候选上游（按健康度/延迟排序），前端切源时可以直接用。
    const candidates = playCandidates(pool, upstream, false).map((item) => ({
      slug: item.slug,
      name: item.name,
      kind: item.kind,
      status: statusOf(item),
    }));
    const vod = {
      ...result.vod,
      vod_id: parsed.displayId,
      upstream_candidates: candidates,
    };
    return jsonResponse({
      code: 1,
      msg: "数据列表",
      page: 1,
      pagecount: 1,
      limit: 1,
      total: 1,
      list: [vod],
    });
  } catch (error) {
    const err =
      error instanceof UpstreamError
        ? error
        : new UpstreamError(upstream, "upstream", String(error && error.message));
    return errorResponse(err);
  }
}

async function handleUpstreams(url, pool, env) {
  const probe =
    /^(1|true|all|yes)$/i.test(String(url.searchParams.get("probe") || ""));
  const probeResult = probe
    ? await probeUpstreams(pool, env)
    : { enabled: false, attempted: 0, ok: 0, failed: 0, skipped: 0 };

  const reports = pool.upstreams.map(upstreamReport);
  const counts = { ok: 0, degraded: 0, circuit_open: 0, unknown: 0 };
  for (const report of reports) {
    counts[report.status] = (counts[report.status] || 0) + 1;
  }

  return jsonResponse({
    code: 1,
    msg: "上游状态",
    defaultSlug: defaultUpstream(pool) && defaultUpstream(pool).slug,
    source: pool.source,
    updatedAt: isoTime(pool.updatedAt),
    expiresAt: isoTime(pool.expiresAt),
    ttlMs: pool.expiresAt ? Math.max(0, pool.expiresAt - Date.now()) : null,
    count: reports.length,
    counts,
    probe: probeResult,
    upstreams: reports,
  });
}

/* -------------------------------------------------------------------------- */
/* 图片代理                                                                    */
/* -------------------------------------------------------------------------- */

function looksLikeImage(bytes) {
  if (!bytes || bytes.length < 12) return false;
  const b = bytes;
  const jpeg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const png = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const gif = b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46;
  const webp =
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50;
  return jpeg || png || gif || webp;
}

function imageResponse(bytes, contentType) {
  return new Response(bytes, {
    headers: {
      ...CORS,
      "Content-Type": contentType || "image/jpeg",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

async function handleMedia(url, pool) {
  const src = url.searchParams.get("src") || "";
  if (!isHttpUrl(src)) {
    return jsonResponse({ error: "缺少有效的图片地址" }, 400);
  }

  const slug = url.searchParams.get("up") || requestedSlug(url);
  const upstream = upstreamBySlug(pool, slug) || defaultUpstream(pool);
  const referer = upstream ? `${upstream.site || originOf(upstream.api)}/` : `${DEFAULT_SITE}/`;

  try {
    const response = await fetchWithTimeout(
      src,
      { headers: { "User-Agent": UA, Referer: referer } },
      15000
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (looksLikeImage(bytes)) {
      return imageResponse(bytes, response.headers.get("content-type"));
    }

    // 黄果的封面在被 CDN 上可能是 AES-CBC 加密的原始二进制（不是 base64），
    // 自己解密没必要——上游 Worker 的 /media 已经做好解密和魔数校验，借用它。
    const workerApi = (upstream && upstream.api) || DEFAULT_API;
    if (workerApi && !src.startsWith(workerApi)) {
      try {
        const proxied = await fetchWithTimeout(
          `${workerApi}/media?url=${encodeURIComponent(src)}`,
          { headers: { "User-Agent": UA, Referer: referer } },
          15000
        );
        if (proxied.ok) {
          const decrypted = new Uint8Array(await proxied.arrayBuffer());
          if (looksLikeImage(decrypted)) {
            return imageResponse(decrypted, proxied.headers.get("content-type"));
          }
        }
      } catch {
        // 兜不住就把原始内容返回，至少前端能拿到东西。
      }
    }

    return imageResponse(bytes, response.headers.get("content-type"));
  } catch (error) {
    return jsonResponse(
      { error: "图片代理失败", message: error && error.message },
      502
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 按需播放解析                                                                */
/* -------------------------------------------------------------------------- */

function stripHtmlText(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTitleKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

function titleScore(wanted, candidate) {
  const a = normalizeTitleKey(wanted);
  const b = normalizeTitleKey(candidate);
  if (!a || !b) return -1;
  if (a === b) return 100;
  if (b.includes(a) || a.includes(b)) return 80;
  const chars = new Set(Array.from(a));
  let hit = 0;
  for (const ch of chars) {
    if (b.includes(ch)) hit += 1;
  }
  return Math.round((hit / chars.size) * 60);
}

async function fetchHuangguoMeText(url, referer, timeoutMs) {
  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        "User-Agent": UA,
        Referer: referer || `${HUANGGUO_ME}/`,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
    },
    timeoutMs
  );
  if (!response.ok) {
    throw new UpstreamError(
      HUANGGUO_ME_UPSTREAM,
      "http",
      `HTTP ${response.status}`,
      { status: response.status, ms: 0 }
    );
  }
  return { text: await response.text(), status: response.status };
}

/**
 * 旧站播放失败后的新站兜底（路线来自 iodefog/HuangGuoVideo-Download）：
 * 按剧名搜索 huangguo.me -> 详情页取 /play/{slug}/{chapterId}/ ->
 * /api/playlet/chapter/detail -> data.videoUrl -> /h5/m3u8/{videoUrl}
 */
async function resolveHuangguoMeByTitle(title, ep, env) {
  const attempts = [];
  const startedAll = Date.now();
  const timeout = Math.min(upstreamTimeout(env), 8000);

  if (!title) {
    attempts.push({ step: "huangguo-me", ok: false, reason: "缺少剧名" });
    return { stream: "", playPage: "", title: "", attempts };
  }

  let searchText = "";
  try {
    const started = Date.now();
    const search = await fetchHuangguoMeText(
      `${HUANGGUO_ME}/search/?q=${encodeURIComponent(title)}`,
      `${HUANGGUO_ME}/`,
      timeout
    );
    searchText = search.text;
    attempts.push({
      step: "huangguo-me-search",
      ok: true,
      status: search.status,
      ms: Date.now() - started,
    });
  } catch (error) {
    attempts.push({
      step: "huangguo-me-search",
      ok: false,
      ...playAttemptError(error),
    });
    return { stream: "", playPage: "", title: "", attempts };
  }

  const detailLinks = Array.from(
    new Set(
      Array.from(
        searchText.matchAll(
          /href=["'](?:https?:\/\/huangguo\.me)?(\/detail\/[^"']+)["']/g
        )
      ).map((match) => match[1])
    )
  ).slice(0, 6);

  if (!detailLinks.length) {
    attempts.push({ step: "huangguo-me-search", ok: false, reason: "没有搜索结果" });
    return { stream: "", playPage: "", title: "", attempts };
  }

  const candidates = await mapLimit(detailLinks, 4, async (link) => {
    try {
      const page = await fetchHuangguoMeText(
        `${HUANGGUO_ME}${link}`,
        `${HUANGGUO_ME}/`,
        timeout
      );
      const titleHtml =
        (page.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] ||
        (page.text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] ||
        "";
      const rawTitle = stripHtmlText(titleHtml)
        .replace(/\s*[-–—|]\s*黄果短剧[\s\S]*$/i, "")
        .trim();
      const plays = Array.from(
        new Set(
          Array.from(page.text.matchAll(/href="(\/play\/[^"]+)"/g)).map(
            (match) => match[1]
          )
        )
      ).filter((path) => /\/play\/[^/]+\/\d+\/?$/.test(path));
      return {
        link,
        rawTitle,
        plays,
        score: titleScore(title, rawTitle),
      };
    } catch (error) {
      return {
        link,
        rawTitle: "",
        plays: [],
        score: -1,
        error: playAttemptError(error),
      };
    }
  });

  // 先排除详情页没有分集链接的条目（有些是预告/空壳），再按标题相似度排。
  candidates.sort(
    (a, b) =>
      (b.plays.length > 0 ? 1 : 0) - (a.plays.length > 0 ? 1 : 0) ||
      b.score - a.score ||
      b.plays.length - a.plays.length
  );
  const usable = candidates.filter(
    (item) => item.score >= 50 && item.plays.length > 0
  );
  attempts.push({
    step: "huangguo-me-detail",
    ok: usable.length > 0,
    candidates: candidates.slice(0, 6).map((item) => ({
      title: item.rawTitle,
      score: item.score,
      plays: item.plays.length,
      error: item.error,
    })),
  });

  const best = usable[0];
  if (!best) {
    return {
      stream: "",
      playPage: "",
      title: candidates[0] ? candidates[0].rawTitle : "",
      attempts,
    };
  }

  const epIndex = Math.min(
    Math.max(0, (Number(ep) || 1) - 1),
    best.plays.length - 1
  );
  const playPath = best.plays[epIndex] || best.plays[0];
  const chapterId = playPath.split("/").filter(Boolean).pop();
  const slug = best.link.split("/").filter(Boolean).pop();
  const playPage = `${HUANGGUO_ME}${playPath}`;

  try {
    const started = Date.now();
    const { data, status } = await requestUpstreamJson(
      HUANGGUO_ME_UPSTREAM,
      `${HUANGGUO_ME}/api/playlet/chapter/detail?chapterId=${encodeURIComponent(
        chapterId
      )}&playletSlug=${encodeURIComponent(slug)}`,
      env,
      { timeoutMs: timeout }
    );
    const detail = (data && data.data) || {};
    const raw = String(detail.videoUrl || "").trim();

    if (detail.needUnlock && !detail.canWatch) {
      attempts.push({
        step: "huangguo-me-api",
        ok: false,
        status,
        ms: Date.now() - started,
        reason: "locked",
      });
      return { stream: "", playPage, title: best.rawTitle, attempts };
    }

    if (!raw) {
      attempts.push({
        step: "huangguo-me-api",
        ok: false,
        status,
        ms: Date.now() - started,
        reason: "empty videoUrl",
      });
      return { stream: "", playPage, title: best.rawTitle, attempts };
    }

    const stream = /^https?:\/\//i.test(raw)
      ? raw
      : `${HUANGGUO_ME}/h5/m3u8/${raw.replace(/^\/+/, "")}`;
    attempts.push({
      step: "huangguo-me-api",
      ok: true,
      status,
      ms: Date.now() - started,
      title: detail.title || best.rawTitle,
      episode: detail.currentEpisode,
      totalMs: Date.now() - startedAll,
    });
    return { stream, playPage, title: best.rawTitle, attempts };
  } catch (error) {
    attempts.push({
      step: "huangguo-me-api",
      ok: false,
      ...playAttemptError(error),
    });
    return { stream: "", playPage, title: best.rawTitle, attempts };
  }
}

function isAllowedHuangguoMeHost(hostname) {
  return (
    hostname === "huangguo.me" ||
    hostname.endsWith(".huangguo.me") ||
    hostname === "rlkfus.cn" ||
    hostname.endsWith(".rlkfus.cn")
  );
}

function streamProxyUrl(origin, src, referer) {
  const params = new URLSearchParams({ src: String(src) });
  if (referer) params.set("ref", String(referer));
  return `${origin}/huangguo/hls?${params.toString()}`;
}

function isPlaylistResponse(response, sourceUrl) {
  const type = String(response.headers.get("content-type") || "").toLowerCase();
  if (type.includes("mpegurl")) return true;
  // 有些 CDN 用 text/plain / octet-stream 发 m3u8，这时按扩展名兜底。
  if (!type || type.includes("text/plain") || type.includes("octet-stream")) {
    return /\.m3u8(\?|#|$)/i.test(String(sourceUrl));
  }
  return false;
}

/**
 * 播放代理（解决"一直转圈"的核心）。
 *
 * 背景：原生黄果站的 m3u8 / 分片 / AES key 都没有 CORS 头，302 直跳裸地址后
 * hls.js 的 manifest 或 key 请求会被浏览器拦下来，表现就是无限转圈；而
 * huangguo.me 新站同样没有 CORS。所以播放地址一律先跳回本域 /huangguo/hls，
 * 由 Worker 拉取后再返回给浏览器：
 *
 *   - 播放列表（m3u8）：改写所有 URI 为同域代理，包括子播放列表、key、分片。
 *     不能"能直连就直连"——key 的 ticket 绑定取清单时的出口 IP，浏览器换 IP
 *     去取会被 CDN 返回 200 + 空 body（hls.js 解不了密 → 无限转圈）。
 *   - 分片 / key / mp4：原样透传，保留 Range 与 206 状态码，并补上 CORS 头。
 *
 * 代理地址只接受 http(s) src，且不携带任何用户凭据，避免被当成开放代理滥用。
 */

async function rewritePlaylist(text, sourceUrl, origin, referer) {
  // 关键：ticket 是按"取清单的那个出口 IP"绑定的。清单既然是我们 Worker 取的，
  // 那 key / 分片也必须由我们 Worker 去取，否则浏览器拿着 Worker 的 ticket 会被
  // CDN 回一个 200 + 空 body（表现就是 hls.js 解不了密、无限转圈）。
  // 所以这里不做"能直连就直连"的优化，统一改写成本域代理。
  const base = String(sourceUrl);
  const absolutize = (value) => {
    try {
      return new URL(value, base).toString();
    } catch {
      return value;
    }
  };

  const render = (raw) => {
    const absUrl = absolutize(raw);
    if (!isHttpUrl(absUrl)) return absUrl;
    try {
      if (new URL(absUrl).origin === origin) return absUrl;
    } catch {
      return absUrl;
    }
    return streamProxyUrl(origin, absUrl, referer);
  };

  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) {
        return line.replace(
          /URI="([^"]+)"/g,
          (match, uri) => `URI="${render(uri)}"`
        );
      }
      return render(trimmed);
    })
    .join("\n");
}

async function handleStream(url, request, env) {
  const src = String(url.searchParams.get("src") || "").trim();
  const ref = String(url.searchParams.get("ref") || "").trim();

  if (!isHttpUrl(src)) {
    return jsonResponse({ error: "缺少有效的播放地址" }, 400);
  }
  let srcUrl;
  try {
    srcUrl = new URL(src);
  } catch {
    return jsonResponse({ error: "播放地址无效" }, 400);
  }
  if (!/^https?:$/.test(srcUrl.protocol)) {
    return jsonResponse({ error: "不支持的播放地址协议" }, 400);
  }

  const referer = isHttpUrl(ref) ? ref : `${srcUrl.origin}/`;
  const headers = {
    "User-Agent": UA,
    Referer: referer,
    Accept: "*/*",
  };
  const range = request && request.headers ? request.headers.get("range") : null;
  if (range) headers.Range = range;

  let response;
  try {
    response = await fetchWithTimeout(src, { headers }, 15000);
  } catch (error) {
    return jsonResponse(
      { error: "拉取播放地址失败", message: error && error.message, src },
      502
    );
  }

  if (!response.ok && response.status !== 206) {
    return jsonResponse({ error: `上游返回 HTTP ${response.status}`, src }, 502);
  }

  // key / 分片返回 200 但内容是空的（剧集刚更新或 ticket 失效），
  // 直接给出明确错误，别让 hls.js 拿着空 key 无限转圈。
  if (
    response.status === 200 &&
    Number(response.headers.get("content-length") || -1) === 0
  ) {
    return jsonResponse(
      { error: "上游返回了空内容（key/分片可能还没生成）", src },
      502
    );
  }

  if (isPlaylistResponse(response, src)) {
    const text = await response.text();
    if (!text.trimStart().startsWith("#EXTM3U")) {
      return jsonResponse({ error: "上游返回的不是 m3u8", src }, 502);
    }
    const rewritten = await rewritePlaylist(text, src, url.origin, referer);
    return new Response(rewritten, {
      headers: {
        ...CORS,
        "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  // 分片 / key / mp4：透传，保留 Range 语义，补 CORS。
  // 用 private 而不是 public：这个路径挂在鉴权后面，不要被边缘缓存成公共资源。
  const out = new Headers(CORS);
  for (const name of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
  ]) {
    const value = response.headers.get(name);
    if (value) out.set(name, value);
  }
  out.set("Cache-Control", "private, max-age=300");
  const body =
    request && request.method === "HEAD" ? null : response.body;
  return new Response(body, { status: response.status, headers: out });
}

async function handleHuangguoMe(url, env) {
  const title = String(
    url.searchParams.get("wd") ||
      url.searchParams.get("title") ||
      ""
  ).trim();
  const ep = String(url.searchParams.get("ep") || "1").trim() || "1";

  if (!title) {
    return jsonResponse({ code: 0, msg: "缺少 wd/title", list: [] }, 400);
  }

  const result = await resolveHuangguoMeByTitle(title, ep, env);
  if (!result.stream) {
    return jsonResponse({
      code: 0,
      msg: "新站没有找到可播放地址",
      title: result.title || title,
      attempts: result.attempts,
      list: [],
    });
  }

  return jsonResponse({
    code: 1,
    msg: "ok",
    title: result.title || title,
    stream: result.stream,
    playPage: result.playPage,
    proxy: `${url.origin}/huangguo/m3u8?src=${encodeURIComponent(
      result.stream
    )}&ref=${encodeURIComponent(result.playPage || `${HUANGGUO_ME}/`)}`,
    attempts: result.attempts,
    list: [],
  });
}

/* -------------------------------------------------------------------------- */
/* 选源（健康度 + 延迟加权）与跨上游兜底                                        */
/* -------------------------------------------------------------------------- */

/**
 * 上游健康分：越高的越先试。
 * 成功次数、延迟加分；失败次数、连续失败扣分；熔断中的直接排到最后。
 */
function healthScore(upstream) {
  const state = healthState.get(upstream.slug);
  if (!state) return 50;
  if (state.circuitOpenUntil > Date.now()) return -100;

  let score = 60;
  score += Math.min(state.successes, 10) * 2;
  score -= Math.min(state.failures, 10) * 3;
  score -= Math.min(state.consecutiveFailures, 5) * 15;
  if (state.latencyMs) score += Math.max(0, 40 - state.latencyMs / 250);
  return Math.round(score);
}

function rankedUpstreams(pool, preferred) {
  if (!pool || !pool.upstreams.length) return [];
  const ordered = pool.upstreams
    .map((upstream) => ({ upstream, score: healthScore(upstream) }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.upstream);

  if (!preferred) return ordered.slice(0, 4);
  const rest = ordered.filter((item) => item.slug !== preferred.slug);
  // 用户点名的上游先试，其余按分数最多再带 3 个做兜底。
  return [preferred, ...rest.slice(0, 3)];
}

/**
 * 同一个"源"的边界：黄果原生站和黄果新站算一家，可以互相兜底；
 * 其他 MacCMS 站各算各的，绝不跨站顶替——否则黄果源里会播出别家的片子。
 */
function familyOf(upstream) {
  return upstream.kind === "huangguo" || upstream.kind === "huangguo-me"
    ? "huangguo"
    : upstream.slug;
}

function playCandidates(pool, preferred, allowCross) {
  if (!pool || !pool.upstreams.length) return preferred ? [preferred] : [];
  if (!preferred) return pool.upstreams.slice(0, 1);
  // 显式 ?cross=1 时才允许跨站兜底（默认关闭）。
  if (allowCross) return rankedUpstreams(pool, preferred);

  const family = familyOf(preferred);
  const siblings = pool.upstreams
    .filter(
      (item) => item.slug !== preferred.slug && familyOf(item) === family
    )
    .map((upstream) => ({ upstream, score: healthScore(upstream) }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.upstream);

  return [preferred, ...siblings.slice(0, 2)];
}

function pickTitleMatch(items, title) {
  let best = null;
  let bestScore = -1;
  for (const item of items) {
    const score = titleScore(
      title,
      item.vod_name || item.name || item.title || ""
    );
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return bestScore >= 60 ? best : null;
}

/** 按剧名在 MacCMS 上游里找同一部剧，并取第 ep 集的播放地址。 */
async function maccmsPlayByTitle(upstream, title, ep, env) {
  const attempts = [];
  const search = await requestUpstreamJson(
    upstream,
    maccmsUrl(upstream, { ac: "videolist", wd: title, pg: 1 }),
    env,
    { timeoutMs: 6000 }
  );
  const items = Array.isArray(search.data.list) ? search.data.list : [];
  const match = pickTitleMatch(items, title);
  attempts.push({
    step: `${upstream.slug}-search`,
    ok: !!match,
    status: search.status,
    matched: match ? String(match.vod_name || "") : "",
  });
  if (!match) {
    throw new UpstreamError(upstream, "not_found", "该上游没有同名资源", {
      status: search.status,
    });
  }

  const detail = await requestUpstreamJson(
    upstream,
    maccmsUrl(upstream, { ac: "detail", ids: match.vod_id }),
    env,
    { timeoutMs: 6000 }
  );
  const item = (Array.isArray(detail.data.list) && detail.data.list[0]) || null;
  const parts = String((item && item.vod_play_url) || "")
    .split("#")
    .filter(Boolean);
  const index = Math.max(0, (Number(ep) || 1) - 1);
  const selected = parts[index] || parts[0] || "";
  const url = String(
    selected.includes("$") ? selected.split("$").slice(1).join("$") : selected
  ).trim();
  attempts.push({
    step: `${upstream.slug}-detail`,
    ok: isHttpUrl(url),
    status: detail.status,
    episodes: parts.length,
  });

  return {
    url,
    referer: refererOf(upstream),
    // 其他 MacCMS 站的 CORS 情况未知，默认走代理更稳。
    preferDirect: false,
    attempts,
  };
}

async function resolveCandidatePlay(candidate, ctx) {
  const { id, ep, pageHint, title, env } = ctx;

  if (candidate.kind === "huangguo") {
    const native = await resolveNativePlay(
      candidate,
      id,
      ep,
      env,
      pageHint,
      ctx.budgetMs
    );
    if (isHttpUrl(native.url)) {
      return {
        url: native.url,
        referer: refererOf(candidate),
        preferDirect: native.preferDirect !== false,
        attempts: native.attempts,
      };
    }

    // 旧站失败 → 按剧名去新站兜底。
    if (title) {
      const me = await resolveHuangguoMeByTitle(title, ep, env);
      const attempts = [...native.attempts, ...me.attempts];
      if (isHttpUrl(me.stream)) {
        attempts.push({
          step: "huangguo-me-proxy",
          ok: true,
          playPage: me.playPage,
        });
        return {
          url: me.stream,
          referer: me.playPage || `${HUANGGUO_ME}/`,
          // 新站 m3u8 没有 CORS 头，必须走代理。
          preferDirect: false,
          attempts,
        };
      }
      return { url: "", referer: "", attempts };
    }
    return { url: "", referer: "", attempts: native.attempts };
  }

  if (candidate.kind === "huangguo-me") {
    if (!title) {
      return {
        url: "",
        referer: "",
        attempts: [{ step: "huangguo-me", ok: false, reason: "缺少剧名" }],
      };
    }
    const me = await resolveHuangguoMeByTitle(title, ep, env);
    return {
      url: me.stream,
      referer: me.playPage || `${HUANGGUO_ME}/`,
      preferDirect: false,
      attempts: me.attempts,
    };
  }

  if (!title) {
    return {
      url: "",
      referer: "",
      attempts: [
        {
          step: candidate.slug,
          ok: false,
          reason: "缺少剧名，无法跨站匹配",
        },
      ],
    };
  }

  return maccmsPlayByTitle(candidate, title, ep, env);
}

async function handlePlay(url, pool, env) {
  const id = stripNamespace(pool, String(url.searchParams.get("id") || "").trim());
  const ep = String(url.searchParams.get("ep") || "1").trim() || "1";
  const slug = String(url.searchParams.get("up") || "").trim();
  const pageHint = stripNamespace(
    pool,
    String(url.searchParams.get("page") || "").trim()
  );
  const title = String(url.searchParams.get("title") || "").trim();

  if (!id) return jsonResponse({ code: 0, msg: "缺少 id", list: [] }, 400);

  const upstream = upstreamBySlug(pool, slug);
  if (!upstream) {
    return jsonResponse(
      { code: 0, msg: `未知上游: ${slug || "(空)"}`, list: [] },
      404
    );
  }

  const allowCross = /^(1|true|yes)$/i.test(
    String(url.searchParams.get("cross") || "")
  );
  const candidates = playCandidates(pool, upstream, allowCross);
  const deadline = Date.now() + 18000;
  const attempts = [];
  let lastError = null;

  for (const candidate of candidates) {
    const remaining = deadline - Date.now();
    if (remaining <= 800) {
      attempts.push({
        step: candidate.slug,
        ok: false,
        reason: "解析总耗时超时，未尝试",
      });
      continue;
    }
    if (candidate !== upstream && isCircuitOpen(candidate)) {
      attempts.push({
        step: candidate.slug,
        ok: false,
        reason: "熔断冷却中",
      });
      continue;
    }

    const started = Date.now();
    try {
      const result = await resolveCandidatePlay(candidate, {
        id,
        ep,
        pageHint,
        title,
        env,
        budgetMs: Math.max(3000, Math.min(12000, remaining)),
      });
      attempts.push(...result.attempts);

      if (isHttpUrl(result.url)) {
        // 黄果 CDN 按出口 IP 给不同版本：浏览器（住宅 IP）能拿到完整片源，
        // Worker（机房 IP）只给 54s 预览。所以默认让浏览器直连，代理只做兜底：
        //   - 直连失败 → 前端带 proxy=1 重试，走 /huangguo/hls
        //   - 新站（huangguo.me）清单没有 CORS → preferDirect=false，直接代理
        const wantProxy =
          /^(1|true|yes)$/i.test(String(url.searchParams.get("proxy") || "")) ||
          result.preferDirect === false;
        const location = wantProxy
          ? streamProxyUrl(url.origin, result.url, result.referer)
          : result.url;
        attempts.push({
          step: `${candidate.slug}-route`,
          ok: true,
          upstream: candidate.slug,
          route: wantProxy ? "proxy" : "direct",
          ms: Date.now() - started,
        });
        return new Response(null, {
          status: 302,
          headers: {
            ...CORS,
            Location: location,
            "Cache-Control": "no-store",
          },
        });
      }

      attempts.push({
        step: `${candidate.slug}-resolve`,
        ok: false,
        upstream: candidate.slug,
        ms: Date.now() - started,
        reason: "没有拿到可播放地址",
      });
    } catch (error) {
      lastError = error;
      const err =
        error instanceof UpstreamError
          ? error
          : new UpstreamError(
              candidate,
              "upstream",
              String(error && error.message)
            );
      attempts.push({
        step: candidate.slug,
        ok: false,
        upstream: candidate.slug,
        ...playAttemptError(err),
      });
    }
  }

  // 区分两类失败：上游整体不可用（熔断/超时/HTTP）报具体原因；
  // 上游都能访问、只是没有片源时报 no_playable，并说清试过几个源。
  const systemicKinds = new Set([
    "circuit_open",
    "http",
    "timeout",
    "upstream",
    "parse",
    "abort",
  ]);
  const systemic = attempts.find((item) => {
    if (item.ok !== false) return false;
    const kind = String(item.kind || "");
    if (!systemicKinds.has(kind)) return false;
    // 404 只说明那家没有这条资源，不算上游故障。
    if (kind === "http" && Number(item.status) === 404) return false;
    return true;
  });
  const pending = attempts.find(
    (item) => item.ok === false && item.kind === "media_pending"
  );
  const tried = candidates.map((item) => item.slug);

  return jsonResponse(
    {
      code: 0,
      msg: pending
        ? `该剧刚更新，上游还没生成播放地址，过几小时再试（已尝试 ${tried.length} 个上游）`
        : systemic
          ? errorMessage(lastError)
          : `上游没有返回可播放地址（已尝试 ${tried.length} 个上游）`,
      kind: pending ? "media_pending" : systemic ? systemic.kind : "no_playable",
      upstream: upstream.slug,
      tried,
      attempts,
      list: [],
    },
    502
  );
}

/**
 * 批量自检：给一批 id（或用分类拉最近 N 部），逐个问站点接口"这集有没有片源"。
 * 用来快速判断"到底哪些剧能播、哪些没源"，比一部部点快得多。
 *
 *   /huangguo/api.php/provide/vod/?ac=playcheck&t=ai-duanju&limit=10
 *   /huangguo/api.php/provide/vod/?ac=playcheck&ids=12612,7628&ep=2
 */
async function handlePlayCheck(url, pool, env) {
  const slug = String(url.searchParams.get("up") || "").trim();
  const upstream = upstreamBySlug(pool, slug);
  if (!upstream || upstream.kind !== "huangguo") {
    return jsonResponse(
      { code: 0, msg: "只支持黄果原生上游（up=huangguo-web）" },
      400
    );
  }
  const ep = String(url.searchParams.get("ep") || "1").trim() || "1";
  const idsParam = String(url.searchParams.get("ids") || "").trim();

  let items = [];
  if (idsParam) {
    items = idsParam
      .split(",")
      .map((value) => stripNamespace(pool, value.trim()))
      .filter(Boolean)
      .slice(0, 30)
      .map((id) => ({ id, name: "" }));
  } else {
    const typeId = String(url.searchParams.get("t") || "ai-duanju").trim();
    const limit = clamp(Number(url.searchParams.get("limit")) || 10, 1, 20);
    const listUrl = typeId.startsWith("rank:")
      ? `${upstream.api}/api/ranks/${encodeURIComponent(
          typeId.slice("rank:".length)
        )}?page=1&size=${limit}`
      : `${upstream.api}/api/category/${encodeURIComponent(
          typeId
        )}?page=1&size=${limit}&sort=latest`;
    try {
      const { data } = await requestUpstreamJson(upstream, listUrl, env, {
        timeoutMs: 8000,
      });
      items = (Array.isArray(data.list) ? data.list : [])
        .slice(0, limit)
        .map((item) => ({
          id: String(item.vod_id != null ? item.vod_id : item.id || ""),
          name: String(item.vod_name || item.name || ""),
        }));
    } catch (error) {
      return jsonResponse(
        { code: 0, msg: "拉取列表失败", detail: playAttemptError(error) },
        502
      );
    }
  }

  const rows = await mapLimit(items, 3, async (item) => {
    if (!item.id) return { ...item, ok: false, reason: "缺少 id" };
    const target = `${upstream.site}/api/videos/${encodeURIComponent(
      item.id
    )}/play?ep=${encodeURIComponent(ep)}`;
    const started = Date.now();
    try {
      const response = await fetchWithTimeout(
        target,
        {
          headers: {
            "User-Agent": UA,
            Referer: `${upstream.site}/video/${encodeURIComponent(item.id)}/`,
            Accept: "application/json, text/plain, */*",
          },
        },
        7000
      );
      const text = await response.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      const data = (parsed && parsed.data) || {};
      const hasVideo = !!(data.video_url || data.video_url_hevc);
      return {
        id: item.id,
        name: item.name,
        status: response.status,
        ms: Date.now() - started,
        msg: (parsed && parsed.msg) || "",
        duration: data.duration == null ? null : Number(data.duration),
        hasVideoUrl: !!data.video_url,
        hasHevc: !!data.video_url_hevc,
        mediaId: data.media_id || "",
        ok: hasVideo,
        ...(hasVideo ? {} : { reason: "没有 video_url" }),
      };
    } catch (error) {
      return {
        id: item.id,
        name: item.name,
        ms: Date.now() - started,
        ok: false,
        error: String((error && error.message) || error).slice(0, 140),
      };
    }
  });

  const okCount = rows.filter((row) => row.ok).length;
  return jsonResponse({
    code: 1,
    msg: `可播 ${okCount}/${rows.length}`,
    upstream: upstream.slug,
    site: upstream.site,
    ep,
    rows,
  });
}

/**
 * 播放探测：一次性试多种请求姿势（浏览器头、Origin、ep=0、带 cookie 等），
 * 用来确认上游到底是"字段改名"还是"把机房 IP 当爬虫挡了"。
 *
 *   /huangguo/api.php/provide/vod/?ac=playprobe&up=huangguo-web&id=12612&ep=1
 */
const BROWSER_HEADERS = {
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  "sec-ch-ua": '"Chromium";v="120", "Not(A:Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Upgrade-Insecure-Requests": "1",
};

async function handlePlayProbe(url, pool, env) {
  const id = stripNamespace(pool, String(url.searchParams.get("id") || "").trim());
  const ep = String(url.searchParams.get("ep") || "1").trim() || "1";
  const slug = String(url.searchParams.get("up") || "").trim();
  const title = String(url.searchParams.get("title") || "").trim();

  const upstream = upstreamBySlug(pool, slug);
  if (!upstream) {
    return jsonResponse({ code: 0, msg: `未知上游: ${slug || "(空)"}` }, 404);
  }
  if (!id) return jsonResponse({ code: 0, msg: "缺少 id" }, 400);

  const pageUrl = `${upstream.site}/video/${encodeURIComponent(id)}/ep-${encodeURIComponent(
    ep
  )}/`;
  const homeUrl = `${upstream.site}/`;
  const steps = [];

  const attempt = async (label, target, headers) => {
    const started = Date.now();
    try {
      const response = await fetchWithTimeout(
        target,
        { headers: { "User-Agent": UA, ...headers } },
        9000
      );
      const text = await response.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      steps.push({
        label,
        target,
        status: response.status,
        ms: Date.now() - started,
        contentType: response.headers.get("content-type") || "",
        setCookie: (response.headers.get("set-cookie") || "").slice(0, 160) || null,
        keys: parsed && typeof parsed === "object" ? Object.keys(parsed).slice(0, 10) : null,
        mediaFields: parsed && parsed.data
          ? Object.fromEntries(
              Object.entries(parsed.data).filter(([key, value]) =>
                /url|key|iv|api|media/i.test(key) && typeof value === "string"
              )
            )
          : null,
        foundMedia: deepFindMediaUrl(parsed || text),
        playLinks: (String(text).match(/\/(?:detail|play)\/[A-Za-z0-9_-]+/g) || []).length,
        body: (parsed ? JSON.stringify(parsed) : text).slice(0, 400),
      });
      return { response, text, parsed };
    } catch (error) {
      steps.push({
        label,
        target,
        ms: Date.now() - started,
        error: String((error && error.message) || error).slice(0, 160),
      });
      return null;
    }
  };

  const apiBase = `${upstream.site}/api/videos/${encodeURIComponent(id)}`;

  // 1) 基线：和现在线上一样的请求
  await attempt("baseline", `${apiBase}/play?ep=${encodeURIComponent(ep)}`, {
    Referer: `${upstream.site}/`,
    Accept: "application/json, text/plain, */*",
  });

  // 2) 浏览器全套头 + Origin + XHR 标记
  await attempt("browser-headers", `${apiBase}/play?ep=${encodeURIComponent(ep)}`, {
    ...BROWSER_HEADERS,
    Accept: "application/json, text/plain, */*",
    Referer: pageUrl,
    Origin: upstream.site,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "X-Requested-With": "XMLHttpRequest",
  });

  // 3) ep 从 0 开始
  await attempt("ep-zero", `${apiBase}/play?ep=0`, {
    ...BROWSER_HEADERS,
    Referer: pageUrl,
    Origin: upstream.site,
  });

  // 4) 带时间戳破缓存
  await attempt(
    "cache-bust",
    `${apiBase}/play?ep=${encodeURIComponent(ep)}&_t=${Date.now()}`,
    { ...BROWSER_HEADERS, Referer: pageUrl, Origin: upstream.site }
  );

  // 5) 详情接口（看有没有别的媒体字段）
  await attempt("video-detail", apiBase, {
    "User-Agent": UA,
    Referer: pageUrl,
    Accept: "application/json, text/plain, */*",
  });

  // 6) 用浏览器头抓剧集页，看真实播放器 HTML 里有没有 m3u8
  const pageAttempt = await attempt("page-browser", pageUrl, {
    ...BROWSER_HEADERS,
    Referer: homeUrl,
  });

  // 7) 如果页面给了 cookie，带 cookie 再问一次接口
  const cookie = pageAttempt && pageAttempt.response
    ? (pageAttempt.response.headers.get("set-cookie") || "").split(",")[0].slice(0, 200)
    : "";
  if (cookie) {
    await attempt(
      "api-with-cookie",
      `${apiBase}/play?ep=${encodeURIComponent(ep)}`,
      {
        ...BROWSER_HEADERS,
        Referer: pageUrl,
        Origin: upstream.site,
        Cookie: cookie,
        Accept: "application/json, text/plain, */*",
      }
    );
  }

  // 8) 新站按剧名搜，看有没有这部
  if (title) {
    await attempt(
      "me-search-browser",
      `${HUANGGUO_ME}/search/?q=${encodeURIComponent(title)}`,
      { ...BROWSER_HEADERS, Referer: `${HUANGGUO_ME}/` }
    );
  }

  return jsonResponse({
    code: 1,
    msg: "播放探测",
    upstream: { slug: upstream.slug, api: upstream.api, site: upstream.site },
    id,
    ep,
    title,
    pageUrl,
    cookie: cookie || null,
    steps,
  });
}

/**
 * 播放诊断：把解析每一步的上游原始返回打出来（含 HTTP 状态、耗时、JSON 键名、
 * 抓到的媒体地址、正文前 1200 字符）。排查"上游有片却解析不到"时用它。
 *
 *   /huangguo/api.php/provide/vod/?ac=playdebug&up=huangguo-web&id=12527&ep=1
 *   &page=https%3A%2F%2Fhuangguoai.com%2Fvideo%2F12527%2Fep-1%2F&title=剧名
 */
async function handlePlayDebug(url, pool, env) {
  const id = stripNamespace(pool, String(url.searchParams.get("id") || "").trim());
  const ep = String(url.searchParams.get("ep") || "1").trim() || "1";
  const slug = String(url.searchParams.get("up") || "").trim();
  const pageHint = stripNamespace(
    pool,
    String(url.searchParams.get("page") || "").trim()
  );
  const title = String(url.searchParams.get("title") || "").trim();

  const upstream = upstreamBySlug(pool, slug);
  if (!upstream) {
    return jsonResponse(
      { code: 0, msg: `未知上游: ${slug || "(空)"}` },
      404
    );
  }
  if (!id) {
    return jsonResponse({ code: 0, msg: "缺少 id" }, 400);
  }

  const steps = [];
  const baseHeaders = {
    "User-Agent": UA,
    Referer: refererOf(upstream),
    Accept: "application/json, text/plain, */*",
  };

  const probe = async (label, target, init = {}) => {
    const started = Date.now();
    try {
      const response = await fetchWithTimeout(
        target,
        { ...init, headers: { ...baseHeaders, ...(init.headers || {}) } },
        12000
      );
      const text = await response.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      const snippet =
        parsed && typeof parsed === "object"
          ? JSON.stringify(parsed).slice(0, 1200)
          : text.slice(0, 1200);
      steps.push({
        step: label,
        target,
        status: response.status,
        ms: Date.now() - started,
        contentType: response.headers.get("content-type") || "",
        keys:
          parsed && typeof parsed === "object"
            ? Object.keys(parsed).slice(0, 12)
            : null,
        foundMedia: deepFindMediaUrl(parsed || text),
        body: snippet,
      });
    } catch (error) {
      steps.push({
        step: label,
        target,
        ms: Date.now() - started,
        error: String((error && error.message) || error).slice(0, 200),
      });
    }
  };

  const pageUrl = isHttpUrl(pageHint)
    ? pageHint
    : `${upstream.site}/video/${encodeURIComponent(id)}/ep-${encodeURIComponent(ep)}/`;

  if (upstream.kind === "huangguo") {
    await probe(
      "worker-play-page",
      `${upstream.api}/api/play?url=${encodeURIComponent(pageUrl)}&ep=${encodeURIComponent(ep)}`
    );
    await probe(
      "worker-play-id",
      `${upstream.api}/api/play?url=${encodeURIComponent(id)}&ep=${encodeURIComponent(ep)}`
    );
    await probe(
      "site-play",
      `${upstream.site}/api/videos/${encodeURIComponent(id)}/play?ep=${encodeURIComponent(ep)}`
    );
    await probe("page", pageUrl);
    await probe(
      "worker-detail",
      `${upstream.api}/api/detail/${encodeURIComponent(id)}`
    );
  }

  if (title) {
    await probe(
      "huangguo-me-search",
      `${HUANGGUO_ME}/search/?q=${encodeURIComponent(title)}`
    );
  }

  let resolved = { url: "", attempts: [] };
  try {
    resolved =
      upstream.kind === "huangguo"
        ? await resolveNativePlay(upstream, id, ep, env, pageHint, 12000)
        : { url: "", attempts: [] };
  } catch (error) {
    resolved = { url: "", attempts: [playAttemptError(error)] };
  }

  return jsonResponse({
    code: 1,
    msg: "播放诊断",
    upstream: {
      slug: upstream.slug,
      kind: upstream.kind,
      api: upstream.api,
      site: upstream.site,
    },
    id,
    ep,
    title,
    pageUrl,
    resolved,
    steps,
  });
}

/* -------------------------------------------------------------------------- */
/* 入口                                                                        */
/* -------------------------------------------------------------------------- */

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const access = await checkAccess(request, env);
  if (!access.ok) {
    return jsonResponse({ error: access.error }, access.status);
  }

  const ac = url.searchParams.get("ac");
  const mediaPath = url.pathname.replace(/\/+$/, "");
  const isMedia =
    mediaPath === "/huangguo/media" || mediaPath.endsWith("/huangguo/media");
  const isPlay =
    mediaPath === "/huangguo/play" ||
    mediaPath === "/huangguo/play.m3u8" ||
    mediaPath.endsWith("/huangguo/play") ||
    mediaPath.endsWith("/huangguo/play.m3u8");
  const isM3u8 =
    mediaPath === "/huangguo/m3u8" ||
    mediaPath.endsWith("/huangguo/m3u8") ||
    mediaPath === "/huangguo/hls" ||
    mediaPath.endsWith("/huangguo/hls");

  // 播放代理和诊断不需要上游池。
  if (isM3u8) {
    return handleStream(url, request, env);
  }

  if (ac === "huangguome") {
    return handleHuangguoMe(url, env);
  }

  // 诊断端点首次访问时等待一次池刷新，保证能立即看到全部候选上游。
  const pool = await getPool(env, context, {
    awaitRefresh: ac === "upstreams" && !isMedia && !isPlay && !isM3u8,
  });

  if (ac === "playdebug") {
    return handlePlayDebug(url, pool, env);
  }

  if (ac === "playprobe") {
    return handlePlayProbe(url, pool, env);
  }

  if (ac === "playcheck") {
    return handlePlayCheck(url, pool, env);
  }

  if (isPlay) {
    return handlePlay(url, pool, env);
  }

  if (isMedia) {
    return handleMedia(url, pool);
  }

  if (ac === "list") {
    return handleList(url, pool, env);
  }

  if (ac === "upstreams") {
    return handleUpstreams(url, pool, env);
  }

  if (ac === "videolist" || (ac === "detail" && !url.searchParams.get("ids"))) {
    return handleDetailList(url, pool, env);
  }

  if (ac === "detail") {
    return handleDetail(url, pool, env);
  }

  return jsonResponse({ code: 0, msg: "不支持的 ac 参数", list: [] });
}
