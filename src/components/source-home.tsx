import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Play, Star } from "lucide-react";

import { API_SITES } from "@/config/apiSites";
import { fetchWithProxy } from "@/utils/proxy";
import { RouterUtils } from "@/utils/router";
import type { ApiSite } from "@/types/apiSite";
import { filterAllowedSites } from "@/utils/auth";
import { hideDuplicateManagedSites } from "@/utils/siteVisibility";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import noImg from "@/assets/no-img.svg";
import { DoubanMedia } from "./douban-media";

interface SourceCategory {
  type_id: string;
  type_name: string;
}

interface SourceItem {
  vod_id: string;
  vod_name: string;
  vod_pic?: string;
  vod_pic_thumb?: string;
  vod_remarks?: string;
  type_name?: string;
}

interface SourceListResponse {
  code?: number;
  msg?: string;
  list?: SourceItem[];
  pagecount?: number;
  total?: number;
  error?: { kind?: string; message?: string; upstream?: string };
}

const DOUBAN_KEY = "__douban__";
const HOME_SOURCE_KEY = "homeSourceKey";
// 记住每个内容源最后停留的"专区"和滚动位置：从剧集页返回时能回到原处。
const HOME_CATEGORY_PREFIX = "homeSourceCategory:";
const HOME_SCROLL_PREFIX = "homeSourceScroll:";

function readStoredCategory(key: string): string {
  try {
    return localStorage.getItem(HOME_CATEGORY_PREFIX + key) || "";
  } catch {
    return "";
  }
}

function readStoredScroll(key: string, category: string): number {
  try {
    return Number(localStorage.getItem(`${HOME_SCROLL_PREFIX}${key}|${category}`) || "0") || 0;
  } catch {
    return 0;
  }
}

function readArray(key: string): ApiSite[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function buildApiUrl(api: string, query: string): string {
  const base = api.trim().replace(/\/+$/, "").replace(/[?&]+$/, "");
  const fullEndpoint =
    /\.php$/i.test(base) ||
    /\/api\/json$/i.test(base) ||
    /\/provide\/vod$/i.test(base);
  if (fullEndpoint) {
    return `${base}${base.includes("?") ? "&" : "?"}${query}`;
  }
  return `${base}/api.php/provide/vod/?${query}`;
}

async function fetchApi(targetUrl: string): Promise<SourceListResponse> {
  const sameOrigin =
    typeof window !== "undefined" &&
    targetUrl.startsWith(`${window.location.origin}/`);
  const response = sameOrigin
    ? await fetch(targetUrl, { cache: "no-store" })
    : await fetchWithProxy(targetUrl);

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data: SourceListResponse = await response.json();
  if (data.code === 0) {
    throw new Error(data.msg || data.error?.message || "加载失败");
  }
  return data;
}

function buildSources(): ApiSite[] {
  const custom = readArray("customApiSites");
  const merged = [...API_SITES, ...custom].filter((site) => site?.key && site?.api);

  const seen = new Set<string>();
  const unique = merged.filter((site) => {
    const normalized = site.api.replace(/\/+$/, "");
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
  return filterAllowedSites(hideDuplicateManagedSites(unique));
}

function posterUrl(raw: string | undefined, site: ApiSite | undefined): string {
  const value = (raw || "").trim();
  if (!value) return "";

  let absolute = value;
  if (value.startsWith("//")) {
    absolute = `https:${value}`;
  } else if (site) {
    try {
      const origin = new URL(site.api).origin;
      if (value.startsWith("/")) absolute = `${origin}${value}`;
      else if (!/^https?:\/\//i.test(value)) absolute = `${origin}/${value}`;
    } catch {
      // ignore
    }
  }

  // 页面是 HTTPS 时，HTTP 封面会被浏览器拦成混合内容，走代理
  if (absolute.startsWith("http://")) {
    const proxyBase = localStorage.getItem("PROXY_BASE_URL") || "/proxy/";
    const normalized = proxyBase.endsWith("/") ? proxyBase : `${proxyBase}/`;
    return `${normalized}${encodeURIComponent(absolute)}`;
  }

  return absolute;
}

export default function SourceHome() {
  const [sources, setSources] = useState<ApiSite[]>([]);
  const [currentKey, setCurrentKey] = useState(DOUBAN_KEY);
  const [categories, setCategories] = useState<SourceCategory[]>([]);
  const [currentCategory, setCurrentCategory] = useState("");
  const [items, setItems] = useState<SourceItem[]>([]);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const requestRef = useRef(0);

  const currentSite = useMemo(
    () => sources.find((site) => site.key === currentKey),
    [sources, currentKey]
  );

  useEffect(() => {
    const chooseInitial = (available: ApiSite[]): string => {
      try {
        const saved = localStorage.getItem(HOME_SOURCE_KEY);
        if (saved === DOUBAN_KEY || available.some((site) => site.key === saved)) {
          return saved!;
        }
        const selected = (() => {
          try {
            const parsed = JSON.parse(localStorage.getItem("selectedApiSites") || "[]");
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })();
        const preferred =
          available.find((site) => site.key === "huangguo") ||
          available.find((site) => selected.includes(site.key));
        return preferred ? preferred.key : DOUBAN_KEY;
      } catch {
        return DOUBAN_KEY;
      }
    };

    const applySources = () => {
      const available = buildSources();
      setSources(available);
      setCurrentKey((previous) =>
        previous !== DOUBAN_KEY && available.some((site) => site.key === previous)
          ? previous
          : chooseInitial(available)
      );
    };

    applySources();
    // index.html 异步同步上游源列表后会发这个事件，已挂载的页面无需刷新。
    window.addEventListener("huangguo-upstreams-updated", applySources);
    return () => {
      window.removeEventListener("huangguo-upstreams-updated", applySources);
    };
  }, []);

  useEffect(() => {
    if (currentKey === DOUBAN_KEY) return;
    const site = sources.find((item) => item.key === currentKey);
    if (!site) return;

    localStorage.setItem(HOME_SOURCE_KEY, currentKey);
    const restored = readStoredCategory(currentKey);
    setCurrentCategory(restored);
    setCategories([]);
    setItems([]);
    setPage(1);
    setPageCount(1);
    setError("");
    loadCategories(site);
    loadList(site, restored, 1, false);
  }, [currentKey, sources]);

  // 记录滚动位置，返回列表时恢复（只记当前源 + 专区）。
  useEffect(() => {
    if (currentKey === DOUBAN_KEY) return;
    const storageKey = `${HOME_SCROLL_PREFIX}${currentKey}|${currentCategory}`;
    const remember = () => {
      try {
        localStorage.setItem(storageKey, String(window.scrollY || 0));
      } catch {
        // 忽略
      }
    };
    window.addEventListener("scroll", remember, { passive: true });
    return () => {
      // 卸载时不要再记一次：跳转前 RouterUtils 会把页面滚到顶部，会把位置记成 0。
      window.removeEventListener("scroll", remember);
    };
  }, [currentKey, currentCategory]);

  // 列表渲染完成后，把上次的滚动位置还原回去。
  useEffect(() => {
    if (currentKey === DOUBAN_KEY || !items.length || page !== 1) return;
    const saved = readStoredScroll(currentKey, currentCategory);
    if (saved <= 0) return;
    const timer = window.setTimeout(() => window.scrollTo(0, saved), 60);
    return () => window.clearTimeout(timer);
  }, [currentKey, currentCategory, items.length, page]);

  async function loadCategories(site: ApiSite) {
    try {
      const data = await fetchApi(buildApiUrl(site.api, "ac=list"));
      const classes = Array.isArray((data as unknown as { class?: SourceCategory[] }).class)
        ? ((data as unknown as { class: SourceCategory[] }).class)
        : [];
      const valid = classes.filter((item) => item?.type_id && item?.type_name);
      setCategories(valid);
      // 恢复的专区如果在这个源里已经不存在（分类改名/换源），回退到"全部"。
      if (currentCategory && !valid.some((item) => item.type_id === currentCategory)) {
        setCurrentCategory("");
        try {
          localStorage.setItem(HOME_CATEGORY_PREFIX + currentKey, "");
        } catch {
          // 忽略
        }
        loadList(site, "", 1, false);
      }
    } catch {
      setCategories([]);
    }
  }

  async function loadList(
    site: ApiSite,
    category: string,
    targetPage: number,
    append: boolean
  ) {
    const requestId = ++requestRef.current;
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError("");

    try {
      const query = `ac=videolist&pg=${targetPage}${
        category ? `&t=${encodeURIComponent(category)}` : ""
      }`;
      let data = await fetchApi(buildApiUrl(site.api, query));

      // 少数 CMS 只接受 ac=detail 的列表查询
      if (
        targetPage === 1 &&
        (!data.list || data.list.length === 0)
      ) {
        const fallback = await fetchApi(
          buildApiUrl(
            site.api,
            `ac=detail&pg=1${category ? `&t=${encodeURIComponent(category)}` : ""}`
          )
        );
        if (fallback.list && fallback.list.length > 0) data = fallback;
      }

      if (requestId !== requestRef.current) return;

      const list = Array.isArray(data.list)
        ? data.list.filter((item) => item?.vod_id && item?.vod_name)
        : [];
      setItems((previous) => (append ? [...previous, ...list] : list));
      setPage(targetPage);
      setPageCount(Math.max(1, Number(data.pagecount) || 1));
    } catch (e) {
      if (requestId === requestRef.current) {
        setError(e instanceof Error ? e.message : "加载失败");
        if (!append) setItems([]);
      }
    } finally {
      if (requestId === requestRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }

  function selectCategory(typeId: string) {
    if (!currentSite) return;
    try {
      localStorage.setItem(HOME_CATEGORY_PREFIX + currentKey, typeId);
    } catch {
      // 忽略
    }
    setCurrentCategory(typeId);
    setItems([]);
    setPage(1);
    setPageCount(1);
    loadList(currentSite, typeId, 1, false);
  }

  function openItem(item: SourceItem) {
    RouterUtils.navigateTo("play", {
      vodId: String(item.vod_id),
      source: currentKey,
    });
  }

  const sourceBar = (
    <div className="flex flex-wrap items-center gap-3 mb-6">
      <span className="text-sm text-muted-foreground">内容源</span>
      <select
        value={currentKey}
        onChange={(event) => setCurrentKey(event.target.value)}
        className="h-9 max-w-[260px] rounded-md border border-border/60 bg-background px-3 text-sm text-foreground outline-none focus:border-primary"
      >
        <option value={DOUBAN_KEY}>豆瓣推荐</option>
        {sources.map((site) => (
          <option key={site.key} value={site.key}>
            {site.name}
          </option>
        ))}
      </select>
      {currentSite?.isCustom ? (
        <Badge variant="outline" className="text-xs">
          采集站
        </Badge>
      ) : null}
    </div>
  );

  if (currentKey === DOUBAN_KEY) {
    return (
      <div>
        {sourceBar}
        <DoubanMedia />
      </div>
    );
  }

  return (
    <div>
      {sourceBar}

      {categories.length > 0 && (
        <div className="mb-5 flex gap-2 overflow-x-auto pb-1">
          <Button
            size="sm"
            variant={currentCategory === "" ? "default" : "outline"}
            onClick={() => selectCategory("")}
          >
            全部
          </Button>
          {categories.map((category) => (
            <Button
              key={category.type_id}
              size="sm"
              variant={currentCategory === category.type_id ? "default" : "outline"}
              onClick={() => selectCategory(category.type_id)}
              className="shrink-0"
            >
              {category.type_name}
            </Button>
          ))}
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          加载失败：{error}
        </div>
      )}

      {loading ? (
        <div className="flex min-h-[240px] items-center justify-center">
          <Loader2 className="mr-2 h-6 w-6 animate-spin" />
          正在加载 {currentSite?.name}...
        </div>
      ) : items.length === 0 ? (
        <div className="py-16 text-center text-sm text-muted-foreground">
          这个源暂时没有返回内容
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-6">
            {items.map((item) => (
              <Card
                key={item.vod_id}
                onClick={() => openItem(item)}
                className="group cursor-pointer gap-0 overflow-hidden border-border/50 bg-card/50 py-0 transition-all duration-300 hover:border-border hover:shadow-lg"
              >
                <div className="relative h-48 w-full overflow-hidden">
                  <img
                    src={posterUrl(item.vod_pic || item.vod_pic_thumb, currentSite) || noImg}
                    alt={item.vod_name}
                    className="absolute inset-0 h-full w-full object-cover"
                    referrerPolicy="no-referrer"
                    onError={(event) => {
                      (event.target as HTMLImageElement).src = noImg;
                    }}
                  />
                  {item.vod_remarks && (
                    <div className="absolute right-2 top-2">
                      <Badge variant="secondary" className="border-0 bg-black/70 text-xs text-white">
                        <Star className="mr-1 h-3 w-3 fill-yellow-400 text-yellow-400" />
                        {item.vod_remarks}
                      </Badge>
                    </div>
                  )}
                  <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition group-hover:bg-black/40 group-hover:opacity-100">
                    <Play className="h-10 w-10 text-white" />
                  </div>
                </div>
                <CardContent className="p-3">
                  <h3 className="line-clamp-2 text-sm font-medium">{item.vod_name}</h3>
                  {item.type_name && (
                    <p className="mt-1 truncate text-xs text-muted-foreground">{item.type_name}</p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>

          {page < pageCount && (
            <div className="mt-6 flex justify-center">
              <Button
                variant="outline"
                disabled={loadingMore}
                onClick={() =>
                  currentSite && loadList(currentSite, currentCategory, page + 1, true)
                }
              >
                {loadingMore ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    加载中
                  </>
                ) : (
                  "加载更多"
                )}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
