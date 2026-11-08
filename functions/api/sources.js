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
  if (!email) return jsonResponse({ error: "未登录" }, 401);

  const isAdmin = adminEmails(env).includes(email);
  let allowed = [];

  if (!isAdmin) {
    let user = null;
    try {
      user = JSON.parse((await env.USERS_KV.get(email)) || "null");
    } catch {
      user = null;
    }
    if (!user || user.approved === false) {
      return jsonResponse({ error: "账号未获批准" }, 403);
    }
    allowed = Array.isArray(user.sources) ? user.sources : [];
  }

  let catalog = [];
  try {
    catalog = JSON.parse((await env.USERS_KV.get("catalog")) || "[]");
  } catch {
    catalog = [];
  }

  const sources = (Array.isArray(catalog) ? catalog : []).filter(
    (source) =>
      source?.key &&
      source?.api &&
      (isAdmin || allowed.includes(source.key))
  );

  return jsonResponse({ sources });
}
