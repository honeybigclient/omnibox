const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
  "Access-Control-Max-Age": "86400",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });

const isDoubanHost = (hostname) =>
  /(^|\.)doubanio\.com$/i.test(hostname) || /(^|\.)douban\.com$/i.test(hostname);

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

function findSource(catalog, targetUrl) {
  let best = null;
  const target = targetUrl.href;

  for (const source of Array.isArray(catalog) ? catalog : []) {
    if (!source?.key || typeof source.api !== "string") continue;
    const base = source.api.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(base)) continue;
    if (
      target === base ||
      target.startsWith(`${base}/`) ||
      target.startsWith(`${base}?`)
    ) {
      if (!best || base.length > best.base.length) {
        best = { key: source.key, base };
      }
    }
  }

  return best;
}

async function checkAccess(request, env, targetUrl) {
  const email = getEmail(request);
  if (!email) return { error: json({ error: "未登录" }, 401) };

  if (adminEmails(env).includes(email)) return { email, admin: true };

  if (!env.USERS_KV) {
    return { error: json({ error: "USERS_KV 未绑定" }, 500) };
  }

  let user = null;
  try {
    user = JSON.parse((await env.USERS_KV.get(email)) || "null");
  } catch {
    user = null;
  }
  if (!user || user.approved === false) {
    return { error: json({ error: "账号未获批准" }, 403) };
  }

  // 豆瓣首页/封面不属于采集站权限范围，登录用户即可看
  if (
    targetUrl.hostname === "movie.douban.com" ||
    isDoubanHost(targetUrl.hostname)
  ) {
    return { email, admin: false };
  }

  let catalog = [];
  try {
    catalog = JSON.parse((await env.USERS_KV.get("catalog")) || "[]");
  } catch {
    catalog = [];
  }

  const matched = findSource(catalog, targetUrl);
  if (!matched) {
    return { error: json({ error: "该源未登记，请联系管理员" }, 403) };
  }

  const allowed = Array.isArray(user.sources) ? user.sources : [];
  if (!allowed.includes(matched.key)) {
    return { error: json({ error: "没有该源权限" }, 403) };
  }

  return { email, admin: false };
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (url.pathname === "/proxy/health") {
    return json({
      status: "healthy",
      platform: "Cloudflare Pages Functions",
      timestamp: new Date().toISOString(),
    });
  }
 
  const target = decodeURIComponent(url.pathname.replace(/^\/proxy\//, ""));
  if (!/^https?:\/\//i.test(target)) {
    return json(
      { error: "Target URL is required", usage: "/proxy/{encoded-target-url}" },
      400
    );
  }

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return json({ error: "Invalid target URL", targetUrl: target }, 400);
  }

  const access = await checkAccess(request, env, targetUrl);
  if (access.error) return access.error;

  try {
    const headers = new Headers();
    for (const [key, value] of request.headers) {
      const lower = key.toLowerCase();
      if (
        ["host", "cf-ray", "cf-connecting-ip", "cf-visitor",
         "x-forwarded-proto", "x-real-ip", "cf-ipcountry"].includes(lower)
      ) continue;
      headers.set(key, value);
    }

    headers.set(
      "User-Agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    headers.set("Accept", "*/*");
    headers.set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
    headers.set("Cache-Control", "no-cache");

    // 豆瓣图床有防盗链：没有 Referer 返回 418，站点 Referer 返回 403。
    if (isDoubanHost(targetUrl.hostname)) {
      headers.set("Referer", "https://movie.douban.com/");
    } else if (!headers.has("Referer")) {
      headers.set("Referer", targetUrl.origin + "/");
    }

    const init = {
      method: request.method,
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
    }

    const upstream = await fetch(target, init);

    // 首页的豆瓣接口直接把封面地址改写成代理地址，<img> 就不用改前端了。
    if (
      targetUrl.hostname === "movie.douban.com" &&
      targetUrl.pathname === "/j/search_subjects"
    ) {
      const data = await upstream.json();
      if (Array.isArray(data.subjects)) {
        data.subjects = data.subjects.map((subject) => ({
          ...subject,
          cover: subject.cover
            ? `${url.origin}/proxy/${encodeURIComponent(subject.cover)}`
            : subject.cover,
        }));
      }
      const outHeaders = new Headers(upstream.headers);
      for (const [key, value] of Object.entries(CORS)) {
        outHeaders.set(key, value);
      }
      outHeaders.set("Content-Type", "application/json; charset=utf-8");
      outHeaders.delete("content-length");
      outHeaders.delete("content-encoding");
      outHeaders.delete("transfer-encoding");
      return new Response(JSON.stringify(data), {
        status: upstream.status,
        headers: outHeaders,
      });
    }

    const responseHeaders = new Headers();
    for (const [key, value] of upstream.headers) {
      if (
        ["content-encoding", "content-length", "transfer-encoding"]
          .includes(key.toLowerCase())
      ) continue;
      responseHeaders.set(key, value);
    }
    for (const [key, value] of Object.entries(CORS)) {
      responseHeaders.set(key, value);
    }
    responseHeaders.set(
      "Cache-Control",
      upstream.headers.get("content-type")?.startsWith("image/")
        ? "public, max-age=86400"
        : "public, max-age=300"
    );

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    return json(
      { error: "Proxy request failed", message: error.message, targetUrl: target },
      502
    );
  }
}
