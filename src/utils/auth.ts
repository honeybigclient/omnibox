import type { ApiSite } from "@/types/apiSite";

export interface Me {
  email: string;
  isAdmin: boolean;
  approved: boolean;
  sources: string[];
}

let cached: Me | null = null;

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

export function isAllowedSource(key: string): boolean {
  if (!cached) return true;
  if (cached.isAdmin || cached.sources.includes("*")) return true;
  return cached.approved && cached.sources.includes(key);
}

export function filterAllowedSites(sites: ApiSite[]): ApiSite[] {
  return sites.filter((site) => isAllowedSource(site.key));
}
