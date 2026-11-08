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

export async function onRequest(context) {
  const { request } = context;
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
