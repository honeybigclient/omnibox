
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * 从 Cloudflare Access 相关请求头中解析用户邮箱
 */
function getEmail(request) {
  const header = request.headers.get("Cf-Access-Authenticated-User-Email");
  if (header) return header.trim().toLowerCase();

  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) return "";

  try {
    const payload = jwt.split(".")[1];
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    return String(JSON.parse(atob(normalized)).email || "")
      .trim()
      .toLowerCase();
  } catch {
    return "";
  }
}

/**
 * 解析管理员邮箱白名单（逗号分隔）
 */
function adminEmails(env) {
  return String(env.ADMIN_EMAIL || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * 用户管理接口：GET 列表 / POST 写入
 */
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
    const list = await env.USERS_KV.list();
    const users = [];

    for (const key of list.keys) {
      if (!key.name.includes("@")) continue;

      const raw = await env.USERS_KV.get(key.name);
      let data = {};
      try {
        data = JSON.parse(raw || "{}");
      } catch {
        data = {};
      }

      users.push({
        email: key.name,
        approved: data.approved !== false,
        sources: Array.isArray(data.sources) ? data.sources : [],
      });
    }

    return jsonResponse({ users });
  }

  if (request.method === "POST") {
    const body = await request.json();
    const target = String(body.email || "").trim().toLowerCase();

    if (!target.includes("@")) {
      return jsonResponse({ error: "邮箱无效" }, 400);
    }

    const sources = Array.isArray(body.sources)
      ? body.sources.filter((item) => typeof item === "string")
      : [];
    const approved = body.approved !== false;

    await env.USERS_KV.put(
      target,
      JSON.stringify({ approved, sources })
    );

    return jsonResponse({ ok: true, email: target });
  }

  return jsonResponse({ error: "不支持的请求方法" }, 405);
}
