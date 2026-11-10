/**
 * 真实网络冒烟测试：直接调用适配层 onRequest，打真实上游（需要能访问外网）。
 *
 *   node scripts/smoke-huangguo-live.mjs
 *
 * 覆盖：上游池 → 原生搜索/详情/惰性播放 → 播放列表代理 → key/分片可达性，
 * 以及 huangguo.me 新站兜底。注意：huangguo-parser Worker 与 huangguoai.com
 * 在部分网络环境不可达，脚本会跳过原生那一段而不是报错。
 */
import { onRequest } from "./functions/huangguo/[[path]].js";

const BASE = "https://app.test";
const ENV = { ADMIN_EMAIL: "live@test" };

async function call(path, init = {}) {
  const request = new Request(BASE + path, {
    ...init,
    headers: {
      "Cf-Access-Authenticated-User-Email": "live@test",
      ...(init.headers || {}),
    },
  });
  const response = await onRequest({ request, env: ENV, waitUntil() {} });
  return response;
}

function log(...args) {
  console.log(...args);
}

/** 拿一个黄果原生（huangguo kind）的资源 id。 */
async function findNativeId() {
  for (const keyword of ["总裁", "重生", "战神", "闪婚"]) {
    const res = await call(
      `/huangguo/api.php/provide/vod/?ac=videolist&slug=huangguo-web&wd=${encodeURIComponent(keyword)}`
    );
    const data = await res.json().catch(() => null);
    const item = (data && data.list || [])[0];
    if (item) return item;
  }
  return null;
}

async function testPlaylist(label, src, ref) {
  const path = `/huangguo/hls?src=${encodeURIComponent(src)}&ref=${encodeURIComponent(ref)}`;
  const res = await call(path);
  const type = res.headers.get("content-type") || "";
  const acao = res.headers.get("access-control-allow-origin") || "(无)";
  const text = await res.text();
  log(`\n### ${label} 播放列表`, res.status, type, "ACAO=", acao);
  log("  头部:", text.split("\n").slice(0, 4).join(" | ").slice(0, 320));
  if (res.status !== 200) {
    log("  失败:", text.slice(0, 300));
    return null;
  }

  const segments = text
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"))
    .slice(0, 1);
  const keys = [...text.matchAll(/URI="([^"]+)"/g)].map((m) => m[1]).slice(0, 1);
  log("  首个分片:", (segments[0] || "").slice(0, 200));
  log("  首个 key:", (keys[0] || "").slice(0, 200));

  for (const [name, target] of [
    ["分片", segments[0]],
    ["key", keys[0]],
  ]) {
    if (!target) continue;
    if (!target.startsWith(`${BASE}/huangguo/hls`)) {
      log(`  ${name}：直连（说明该域名带 CORS）`, target.slice(0, 120));
      continue;
    }
    const url = new URL(target);
    const one = await call(url.pathname + url.search, {
      headers: { Range: "bytes=0-2047" },
    });
    const bytes = (await one.arrayBuffer()).byteLength;
    log(
      `  ${name}：经代理`,
      one.status,
      one.headers.get("content-type"),
      `${bytes}B`,
      "ACAO=",
      one.headers.get("access-control-allow-origin") || "(无)"
    );
  }
  return text;
}

async function main() {
  const poolRes = await call("/huangguo/?ac=upstreams");
  const pool = await poolRes.json().catch(() => null);
  log("### 上游池", poolRes.status, "count=", pool && pool.count);
  if (!pool || !Array.isArray(pool.upstreams)) throw new Error("上游池不可用");

  // ---- 1. 原生黄果：详情惰性地址 → play.m3u8 → 代理 → 分片 ----
  const nativeItem = await findNativeId();
  log("\n### 原生黄果条目", nativeItem && nativeItem.vod_id, nativeItem && nativeItem.vod_name);
  if (nativeItem) {
    const detailRes = await call(
      `/huangguo/api.php/provide/vod/?ac=detail&ids=${encodeURIComponent(nativeItem.vod_id)}`
    );
    const detail = await detailRes.json().catch(() => null);
    log("  详情", detailRes.status, "code=", detail && detail.code, "msg=", detail && detail.msg);
    if (detail && detail.list && detail.list[0]) {
      log("  候选上游:", JSON.stringify(detail.list[0].upstream_candidates || []));
      const eps = String(detail.list[0].vod_play_url || "").split("#");
      log("  剧集数:", eps.length);
      const first = eps[0] || "";
      const lazy = first.includes("$") ? first.split("$").slice(1).join("$") : first;
      log("  惰性地址:", lazy.slice(0, 180));

      if (lazy.includes("/huangguo/play.m3u8")) {
        const u = new URL(lazy);
        const playRes = await call(u.pathname + u.search);
        const location = playRes.headers.get("location") || "";
        log("\n### 播放解析", playRes.status, "->", location.slice(0, 220));
        if (playRes.status === 302 && location) {
          const p = new URL(location);
          await testPlaylist("原生黄果", p.searchParams.get("src"), p.searchParams.get("ref") || "");
        } else {
          log("  失败响应:", (await playRes.text()).slice(0, 600));
        }
      }
    }
  }

  // ---- 2. 新站兜底：按剧名解析 huangguo.me ----
  const meRes = await call(
    `/huangguo/api.php/provide/vod/?ac=huangguome&wd=${encodeURIComponent("琼明神女录")}&ep=1`
  );
  const me = await meRes.json().catch(() => null);
  log("\n### 新站解析", meRes.status, "code=", me && me.code, "msg=", me && me.msg);
  if (me && me.stream) {
    log("  stream:", String(me.stream).slice(0, 160));
    await testPlaylist("新站 huangguo.me", me.stream, me.playPage || "");
  }
}

main().catch((error) => {
  console.error("LIVE TEST FAILED:", error);
  process.exitCode = 1;
});
