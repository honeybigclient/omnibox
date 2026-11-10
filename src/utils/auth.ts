import { API_SITES } from "@/config/apiSites";
import type { ApiSite } from "@/types/apiSite";

export interface Me {
  email: string;
  isAdmin: boolean;
  approved: boolean;
  sources: string[];
}

let cached: Me | null = null;
const BUILTIN_KEYS = new Set(API_SITES.map((site) => site.key));

async function syncAllowedSources() {
  try {
    const response = await fetch("/api/sources", { cache: "no-store" });
    if (!response.ok) return;

    const data = await response.json();
    const extras = (Array.isArray(data.sources) ? data.sources : [])
      .filter(
        (site: ApiSite) =>
          site?.key &&
          site?.api &&
          !BUILTIN_KEYS.has(site.key)
      )
      .map((site: ApiSite) => ({
        key: site.key,
        name: String(site.name || site.key),
        api: site.api,
        isCustom: true,
      }));

    let existing: ApiSite[] = [];
    try {
      const parsed = JSON.parse(localStorage.getItem("customApiSites") || "[]");
      if (Array.isArray(parsed)) existing = parsed;
    } catch {
      existing = [];
    }

    const extraKeys = new Set<string>(extras.map((site: ApiSite) => site.key));
    // 只去掉 /api/sources 已经重新下发的 key；其余本地源（含 remote_*）
    // 一律保留，避免服务端同步把用户自己的源冲掉。
    const kept = existing.filter(
      (site) => site?.key && !extraKeys.has(site.key)
    );

    // 保留本地 huangguo / hg_* 源，并按 key 去重，避免 /api/sources 同步时把它们冲掉。
    const merged = new Map<string, ApiSite>();
    for (const site of [...kept, ...extras]) {
      if (site?.key) merged.set(site.key, site);
    }
    localStorage.setItem(
      "customApiSites",
      JSON.stringify([...merged.values()])
    );
  } catch {
    // 保留浏览器里已有的源
  }
}

export async function loadMe(): Promise<Me | null> {
  try {
    const response = await fetch("/api/me", { cache: "no-store" });
    if (!response.ok) return null;
    const data = await response.json();
    cached = {
      email: String(data.email || ""),
      isAdmin: data.isAdmin === true,
      approved: data.approved === true,
      sources: Array.isArray(data.sources) ? data.sources : [],
    };
    await syncAllowedSources();
    return cached;
  } catch {
    return null;
  }
}

export function getMe(): Me | null {
  return cached;
}

export function isAdmin(): boolean {
  return cached?.isAdmin === true;
}

function isHuangguoChild(key: string): boolean {
  return String(key).startsWith("hg_");
}

function hasHuangguoAccess(): boolean {
  return !!cached?.approved && cached.sources.includes("huangguo");
}

export function isAllowedSource(key: string): boolean {
  if (!cached) return true;
  if (cached.isAdmin || cached.sources.includes("*")) return true;
  // 拥有 huangguo 权限即自动拥有所有 hg_* 子源；子源实际还是走 /huangguo 适配层。
  if (hasHuangguoAccess() && isHuangguoChild(key)) return true;
  return cached.approved && cached.sources.includes(key);
}

export function filterAllowedSites(sites: ApiSite[]): ApiSite[] {
  return sites.filter((site) => isAllowedSource(site.key));
}
