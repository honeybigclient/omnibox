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
    const data = JSON.parse(atob(normalized));
    return String(data.email || "").trim().toLowerCase();
  } catch {
    return "";
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const email = getEmail(request);

  if (!email) {
    return jsonResponse({ error: "未登录" }, 401);
  }

  const admins = String(env.ADMIN_EMAIL || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const isAdmin = admins.includes(email);

  let approved = isAdmin;
  let sources = [];

  if (!isAdmin && env.USERS_KV) {
    const raw = await env.USERS_KV.get(email);
    if (raw) {
      try {
        const data = JSON.parse(raw);
        approved = data.approved !== false;
        sources = Array.isArray(data.sources) ? data.sources : [];
      } catch {
        approved = false;
      }
    }
  }

  return jsonResponse({
    email,
    isAdmin,
    approved,
    sources: isAdmin ? ["*"] : sources,
  });
}
