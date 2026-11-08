function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

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

export async function onRequest(context) {
  const { request, env } = context;

  if (!env.USERS_KV) {
    return jsonResponse({ error: "USERS_KV 未绑定" }, 500);
  }

  const email = getEmail(request);
  if (!email || !adminEmails(env).includes(email)) {
    return jsonResponse({ error: "无权限" }, 403);
  }

  if (request.method === "GET") {
    const raw = await env.USERS_KV.get("catalog");
    let sources = [];
    try {
      sources = JSON.parse(raw || "[]");
    } catch {
      sources = [];
    }
    return jsonResponse({ sources: Array.isArray(sources) ? sources : [] });
  }

  if (request.method === "POST") {
    const body = await request.json();
    const input = Array.isArray(body.sources) ? body.sources : [];
    const sources = [];
    const seen = new Set();

    for (const item of input) {
      const key = String(item?.key || "").trim();
      const api = String(item?.api || "").trim();
      if (!key || !/^https?:\/\//i.test(api)) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({ key, name: String(item?.name || key), api });
      if (sources.length >= 200) break;
    }

    await env.USERS_KV.put("catalog", JSON.stringify(sources));
    return jsonResponse({ ok: true, count: sources.length });
  }

  return jsonResponse({ error: "不支持的请求方法" }, 405);
}
