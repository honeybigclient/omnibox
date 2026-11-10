import type { ApiSite } from "@/types/apiSite";

const MANAGED_PREFIX = "hg_";
const LEGACY_PREFIX = "remote_";

function normalizeName(value: string | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

/**
 * hg_* 和旧版自动生成的 remote_* 指向同一个上游时，只显示 hg_*（走适配层）。
 *
 * 数据本身不删：remote_* 仍留在 localStorage 里，等对应的 hg_* 消失后
 * 会自动重新出现，避免同步调整把用户手工加过的源弄丢。
 */
export function hideDuplicateManagedSites(sites: ApiSite[]): ApiSite[] {
  const managedNames = new Set(
    sites
      .filter(
        (site) => site?.key && String(site.key).startsWith(MANAGED_PREFIX)
      )
      .map((site) => normalizeName(site.name))
      .filter(Boolean)
  );

  if (!managedNames.size) return sites;

  return sites.filter((site) => {
    if (!site?.key) return false;
    if (!String(site.key).startsWith(LEGACY_PREFIX)) return true;
    return !managedNames.has(normalizeName(site.name));
  });
}
