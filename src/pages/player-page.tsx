import { useState, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import Artplayer from "artplayer";
import Hls from "hls.js";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ArrowUpDown, ChevronRight } from "lucide-react";
import { Movie, ApiSite } from "@/types";

import { API_SITES } from "@/config/apiSites";
import { getSelectedApiSites } from "@/utils/apiSite";
import { Card, CardContent } from "@/components/ui/card";
import { ListVideo } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Calendar } from "lucide-react";
import { fetchWithProxy } from "@/utils/proxy";
import { hideDuplicateManagedSites } from "@/utils/siteVisibility";
// --- Interfaces ---
interface Episode {
  number: string;
  url: string;
}

interface UpstreamErrorInfo {
  upstream?: string;
  name?: string;
  kind?: string;
  status?: number | null;
  ms?: number | null;
  message?: string;
}

interface DetailApiResponse {
  code: number;
  msg: string;
  list: Movie[];
  error?: UpstreamErrorInfo;
  errors?: UpstreamErrorInfo[];
}

function describeApiError(data: DetailApiResponse): string {
  const error = data?.error;
  const base = data?.msg || error?.message || "无法获取视频详情";
  if (!error) return base;

  const details: string[] = [];
  if (error.upstream) details.push(`上游 ${error.upstream}`);
  if (error.kind) details.push(error.kind);
  if (error.status != null) details.push(`HTTP ${error.status}`);
  if (error.ms != null) details.push(`${error.ms}ms`);
  return details.length ? `${base}（${details.join(" · ")}）` : base;
}

/**
 * 适配层对上游故障也返回 HTTP 200 + code:0，但代理/网关层仍可能返回非 2xx。
 * 这里把响应体里的 msg / error 读出来，避免只剩 `HTTP error! status: xxx`。
 */
async function readResponseError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return "";
    try {
      const body = JSON.parse(text) as {
        msg?: string;
        error?: UpstreamErrorInfo | string;
      };
      if (body?.msg) return String(body.msg);
      if (typeof body?.error === "string") return body.error;
      if (body?.error?.message) return String(body.error.message);
      if (body?.error?.kind) return String(body.error.kind);
    } catch {
      return text.slice(0, 200);
    }
  } catch {
    // 响应体不可读时退回状态码。
  }
  return "";
}

interface PlayHistoryItem {
  vodId: string;
  title: string;
  pic: string;
  episode: string;
  timestamp: number;
  source: string;
  sortOrder: "asc" | "desc";
  skipStart: number;
  skipEnd: number;
}

// --- Main Player Page Component ---
// 黄果族的源：线上同步出来的 "hg_*"，以及原生的 "huangguo"。
// 站内切源（包括播放失败自动切）只在这族里做，避免跳到别的采集站的枪版片源。
function isHuangguoFamilyKey(key: string) {
  return key === "huangguo" || key.startsWith("hg_");
}

function PlayerPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [movieDetails, setMovieDetails] = useState<Movie | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [currentSource, setCurrentSource] = useState<string | null>(null);
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  const [skipStart, setSkipStart] = useState<number>(0);
  const [skipEnd, setSkipEnd] = useState<number>(0);
  const artRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<Artplayer | null>(null);

  const [availableSources, setAvailableSources] = useState<{ key: string; name: string }[]>([]);
  // 播放失败自动切源：tried 记录试过的源，避免两个源之间来回跳。
  const failoverState = useRef({ tried: new Set<string>(), busy: false });
  const failoverRef = useRef<(reason: string) => void>(() => {});
  const switchSourceRef = useRef<(key: string) => Promise<void>>(async () => {});
  // 播放器的 video:ended 回调只注册一次，直接读 state 会永远拿到创建那一刻的旧值，
  // 于是 "播完第四集自动跳回第二集"。统一改成读 ref。
  const currentSourceRef = useRef<string | null>(null);
  const sortedEpisodesRef = useRef<Episode[]>([]);
  const sortOrderRef = useRef<"asc" | "desc">("asc");
  const handleEpisodeSelectRef = useRef<(episode: Episode) => void>(() => {});

  const vodId = searchParams.get("vodId");
  const initialEpNum = searchParams.get("epNum");
  const sourceKey = searchParams.get("source");

  // --- Hooks called unconditionally at the top ---
  const episodes = useMemo(() => {
    if (!movieDetails?.vod_play_url) return [];
    try {
      let playUrlData = movieDetails.vod_play_url;
      // 检查是否包含 $$$，如果包含则取最后一个分段
      if (playUrlData.includes("$$$")) {
        const parts = playUrlData.split("$$$");
        playUrlData = parts[parts.length - 1];
      }

      // 使用 # 分割剧集信息
      const parsed = playUrlData
        .split("#")
        .map((part: string) => {
          const [number, url] = part.split("$");
          if (number && url && url.startsWith("http")) {
            return { number: number.trim(), url: url.trim() };
          }
          return null;
        })
        .filter((ep: Episode | null): ep is Episode => ep !== null);

      // 上游偶尔会把同一集返回两遍（多线路混排），按集号 + 地址去重，避免列表重复。
      const seenNumber = new Set<string>();
      const seenUrl = new Set<string>();
      return parsed.filter((ep) => {
        if (seenNumber.has(ep.number) || seenUrl.has(ep.url)) return false;
        seenNumber.add(ep.number);
        seenUrl.add(ep.url);
        return true;
      });
    } catch (error) {
      console.error("Error parsing episodes string:", error);
      return [];
    }
  }, [movieDetails]);

  const sortedEpisodes = useMemo(() => {
    // 如果是正序，直接返回原始顺序的副本
    if (sortOrder === "asc") {
      return [...episodes];
    }
    // 如果是倒序，返回反转后的副本
    return [...episodes].reverse();
  }, [episodes, sortOrder]);

  // --- Effects ---
  useEffect(() => {
    if (!vodId) {
      setError("无效的视频 ID");
      setIsLoading(false);
      return;
    }
    const fetchDetails = async () => {
      setIsLoading(true);
      setError(null);
      setMovieDetails(null);
      setCurrentSource(null);
      try {
        if (!sourceKey) {
          throw new Error("缺少视频源参数 (source)");
        }

        // 加载默认和自定义站点
        const defaultSites = API_SITES;
        const customSites: ApiSite[] = JSON.parse(localStorage.getItem("customApiSites") || "[]");
        const allSites = [...defaultSites, ...customSites];

        // 查找对应的站点 API。hg_* 是服务端适配层的子源，
        // 即使当前 localStorage 还没同步到，也能按 slug 拼出 /huangguo/<slug>。
        const foundSite =
          allSites.find((site) => site.key === sourceKey) ||
          (sourceKey.startsWith("hg_")
            ? {
                key: sourceKey,
                name: sourceKey,
                api: `${window.location.origin}/huangguo/${sourceKey.slice(3)}`,
                isCustom: true,
              }
            : undefined);

        if (!foundSite) {
          throw new Error(`未找到源: ${sourceKey}`);
        }

        const apiBase = foundSite.api;

        // 使用 ac=detail 获取详情
        const targetUrl = `${apiBase}/api.php/provide/vod/?ac=detail&ids=${vodId}`;
        const response = await fetchWithProxy(targetUrl);
        if (!response.ok) {
          const detail = await readResponseError(response);
          throw new Error(
            detail
              ? `HTTP ${response.status}: ${detail}`
              : `HTTP error! status: ${response.status}`
          );
        }
        const data: DetailApiResponse = await response.json();
        if (data.code === 1 && data.list && data.list.length > 0) {
          setMovieDetails(data.list[0]);
        } else {
          throw new Error(describeApiError(data));
        }
      } catch (e) {
        console.error("Failed to fetch movie details:", e);
        setError(e instanceof Error ? e.message : "加载详情失败");
      } finally {
        setIsLoading(false);
      }
    };
    fetchDetails();
  }, [vodId, sourceKey]);

  useEffect(() => {
    if (episodes.length > 0) {
      // 如果有初始集数，尝试使用它
      if (initialEpNum) {
        const decodedEpNum = decodeURIComponent(initialEpNum);
        const initialEpisode = episodes.find((ep: Episode) => ep.number === decodedEpNum);
        if (initialEpisode) {
          setCurrentSource(initialEpisode.url);
          return;
        }
      }

      // 尝试从历史记录中获取上次播放的集数
      if (vodId && sourceKey) {
        try {
          const raw = localStorage.getItem("playHistory");
          if (raw) {
            const history: PlayHistoryItem[] = JSON.parse(raw);
            const currentItem = history.find((item) => item.vodId === vodId && item.source === sourceKey);
            if (currentItem) {
              const historyEpisode = episodes.find((ep: Episode) => ep.number === currentItem.episode);
              if (historyEpisode) {
                setCurrentSource(historyEpisode.url);
                setSearchParams(
                  {
                    vodId: vodId,
                    epNum: encodeURIComponent(historyEpisode.number),
                    source: sourceKey,
                  },
                  { replace: true }
                );
                return;
              }
            }
          }
        } catch (error) {
          console.error("Error loading play history:", error);
        }
      }

      // 如果以上都没有，默认播放第一集
      setCurrentSource(episodes[0].url);
      setSearchParams(
        {
          vodId: vodId!,
          epNum: encodeURIComponent(episodes[0].number),
          source: sourceKey || "",
        },
        { replace: true }
      );
    } else {
      setCurrentSource(null);
    }
  }, [episodes, initialEpNum, vodId, sourceKey, setSearchParams]);

  // 从本地存储加载播放记录和设置
  useEffect(() => {
    if (vodId && sourceKey) {
      try {
        const raw = localStorage.getItem("playHistory");
        if (raw) {
          const history: PlayHistoryItem[] = JSON.parse(raw);
          const currentItem = history.find((item) => item.vodId === vodId && item.source === sourceKey);
          if (currentItem) {
            setSortOrder(currentItem.sortOrder);
            setSkipStart(currentItem.skipStart);
            setSkipEnd(currentItem.skipEnd);
            if (initialEpNum === null) {
              setSearchParams(
                {
                  vodId: vodId,
                  epNum: encodeURIComponent(currentItem.episode),
                  source: sourceKey,
                },
                { replace: true }
              );
            }
          }
        }
      } catch (error) {
        console.error("Error loading play history:", error);
      }
    }
  }, [vodId, sourceKey, initialEpNum, setSearchParams]);

  // 写入播放记录
  const writePlayHistory = (episode: Episode) => {
    if (!movieDetails) return;
    const item: PlayHistoryItem = {
      vodId: String(movieDetails.vod_id),
      title: movieDetails.vod_name,
      pic: movieDetails.vod_pic,
      episode: String(episode.number),
      timestamp: Date.now(),
      source: sourceKey || "",
      sortOrder: sortOrder,
      skipStart: skipStart,
      skipEnd: skipEnd,
    };
    try {
      const raw = localStorage.getItem("playHistory");
      let arr: PlayHistoryItem[] = raw ? JSON.parse(raw) : [];
      arr = arr.filter((i) => i.vodId !== item.vodId || i.source !== item.source);
      arr.unshift(item);
      if (arr.length > 20) arr = arr.slice(0, 20);
      localStorage.setItem("playHistory", JSON.stringify(arr));
    } catch {
      // ignore
    }
  };

  // 更新跳过设置
  const updateSkipSettings = (newSkipStart: number, newSkipEnd: number) => {
    setSkipStart(newSkipStart);
    setSkipEnd(newSkipEnd);
    if (movieDetails) {
      try {
        const raw = localStorage.getItem("playHistory");
        if (raw) {
          const history: PlayHistoryItem[] = JSON.parse(raw);
          const index = history.findIndex((item) => item.vodId === String(movieDetails.vod_id) && item.source === sourceKey);
          if (index !== -1) {
            history[index].skipStart = newSkipStart;
            history[index].skipEnd = newSkipEnd;
            localStorage.setItem("playHistory", JSON.stringify(history));
          }
        }
      } catch (error) {
        console.error("Error updating skip settings:", error);
      }
    }
  };

  useEffect(() => {
    if (movieDetails && currentSource) {
      const ep = episodes.find((ep: Episode) => ep.url === currentSource);
      if (ep) writePlayHistory(ep);
    }
  }, [currentSource, movieDetails, episodes]);

  // 换集时不该重建播放器（重建会丢全屏和倍速），只有剧/源/集列表/跳过设置变了才重建。
  const playerIdentity = `${vodId}|${sourceKey || ""}|${sortedEpisodes.length}|${skipStart}|${skipEnd}`;
  const playerIdentityRef = useRef(playerIdentity);
  // 切集走 switchUrl 时，Artplayer 会重新执行 customType，但不会帮我们销毁上一次的
  // Hls 实例。旧的实例还挂在同一个 video 上继续吐分片，就会出现"点了第二集却还在
  // 放第一集"。这里统一在挂新实例前把旧的拆干净。
  const hlsCleanupRef = useRef<(() => void) | null>(null);
  const needRecreateRef = useRef(true);
  const fullscreenTimerRef = useRef<number | null>(null);
  if (playerIdentityRef.current !== playerIdentity) {
    playerIdentityRef.current = playerIdentity;
    needRecreateRef.current = true;
  }

  useEffect(() => {
    if (currentSource && artRef.current) {
      const existing = playerRef.current;
      if (existing && !needRecreateRef.current) {
        // 只是换了同一部剧的另一集：就地换源，播放器、全屏状态、倍速全都保留。
        needRecreateRef.current = false;
        if (existing.url !== currentSource) {
          // 先把上一集的 Hls 停掉再换源，否则旧分片会继续喂给同一个 <video>，
          // 表现就是"点了第二集还在放第一集"。
          if (hlsCleanupRef.current) {
            try {
              hlsCleanupRef.current();
            } catch {
              // 已经清理过。
            }
            hlsCleanupRef.current = null;
          }
          void existing.switchUrl(currentSource).catch(() => {
            failoverRef.current("切换剧集失败");
          });
        }
        return;
      }
      needRecreateRef.current = false;
      if (fullscreenTimerRef.current !== null) {
        window.clearInterval(fullscreenTimerRef.current);
        fullscreenTimerRef.current = null;
      }
      if (existing) {
        existing.destroy();
      }

      const currentEpisodeNumber = sortedEpisodes.find((ep) => ep.url === currentSource)?.number;
      const playerId = `morphotv-${vodId}-${sourceKey || "default"}-${currentEpisodeNumber || "1"}`;

      const art = new Artplayer({
        container: artRef.current,
        url: currentSource,
        setting: true,
        autoplay: true,
        pip: true,
        fullscreen: true,
        fullscreenWeb: true,
        miniProgressBar: true,
        hotkey: true,
        playbackRate: true,
        lock: true,
        fastForward: true,
        id: playerId,
        autoPlayback: true,
        autoOrientation: true,
        theme: "#23ade5",
        settings: [
          {
            width: 200,
            html: "跳过设置",
            tooltip: "设置跳过时间",
            selector: [
              {
                html: "片头跳过",
                tooltip: `${skipStart}秒`,
                selector: [
                  {
                    default: skipStart === 0,
                    html: "0秒",
                    value: 0,
                  },
                  {
                    default: skipStart === 30,
                    html: "30秒",
                    value: 30,
                  },
                  {
                    default: skipStart === 60,
                    html: "1分钟",
                    value: 60,
                  },
                  {
                    default: skipStart === 90,
                    html: "1分30秒",
                    value: 90,
                  },
                  {
                    default: skipStart === 120,
                    html: "2分钟",
                    value: 120,
                  },
                  {
                    default: skipStart === 150,
                    html: "2分30秒",
                    value: 150,
                  },
                  {
                    default: skipStart === 180,
                    html: "3分钟",
                    value: 180,
                  },
                  {
                    default: skipStart === 210,
                    html: "3分30秒",
                    value: 210,
                  },
                  {
                    default: skipStart === 240,
                    html: "4分钟",
                    value: 240,
                  },
                  {
                    default: skipStart === 270,
                    html: "4分30秒",
                    value: 270,
                  },
                  {
                    default: skipStart === 300,
                    html: "5分钟",
                    value: 300,
                  },
                ],
                onSelect: function (item) {
                  updateSkipSettings(item.value, skipEnd);
                  return `${item.value}秒`;
                },
              },
              {
                html: "片尾跳过",
                tooltip: `${skipEnd}秒`,
                selector: [
                  {
                    default: skipEnd === 0,
                    html: "0秒",
                    value: 0,
                  },
                  {
                    default: skipEnd === 30,
                    html: "30秒",
                    value: 30,
                  },
                  {
                    default: skipEnd === 60,
                    html: "1分钟",
                    value: 60,
                  },
                  {
                    default: skipEnd === 90,
                    html: "1分30秒",
                    value: 90,
                  },
                  {
                    default: skipEnd === 120,
                    html: "2分钟",
                    value: 120,
                  },
                  {
                    default: skipEnd === 150,
                    html: "2分30秒",
                    value: 150,
                  },
                  {
                    default: skipEnd === 180,
                    html: "3分钟",
                    value: 180,
                  },
                  {
                    default: skipEnd === 210,
                    html: "3分30秒",
                    value: 210,
                  },
                  {
                    default: skipEnd === 240,
                    html: "4分钟",
                    value: 240,
                  },
                  {
                    default: skipEnd === 270,
                    html: "4分30秒",
                    value: 270,
                  },
                  {
                    default: skipEnd === 300,
                    html: "5分钟",
                    value: 300,
                  },
                ],
                onSelect: function (item) {
                  updateSkipSettings(skipStart, item.value);
                  return `${item.value}秒`;
                },
              },
            ],
          },
        ],
        customType: {
          m3u8: function playM3u8(video, url, art) {
            // 换集时先把上一集残留的 Hls/看门狗拆掉，否则会继续播上一集。
            if (hlsCleanupRef.current) {
              try {
                hlsCleanupRef.current();
              } catch {
                // 已经清理过。
              }
              hlsCleanupRef.current = null;
            }

            const userProxy = localStorage.getItem("m3u8ProxySelected");
            const applyUserProxy = (target: string) =>
              userProxy ? `${userProxy}${target}` : target;
            // 浏览器直连 CDN 拿完整片源（CDN 按出口 IP 给不同列表），
            // 直连被拒时给同一个地址加 proxy=1，让适配层改走 Worker 代理。
            const toProxyRetry = (target: string) => {
              const base = target.replace(/([?&])proxy=1(&|$)/g, "$1").replace(/[?&]$/, "");
              return `${base}${base.includes("?") ? "&" : "?"}proxy=1`;
            };

            if (Hls.isSupported()) {
              let current: Hls | null = null;
              let watchdog = 0;
              // 0=初始 1=代理重试 2=浏览器解析 3=浏览器地址走代理
              let stage = 0;

              // 用用户浏览器直接抓剧集页，从 videoInitialData 里取 m3u8。
              // 站点对浏览器是放行的、地址里的 ticket 也绑用户的 IP，直连能拿完整片源。
              const resolveFromBrowser = async (): Promise<string> => {
                let parsed: URL;
                try {
                  parsed = new URL(url, window.location.origin);
                } catch {
                  return "";
                }
                const id = parsed.searchParams.get("id") || "";
                const ep = parsed.searchParams.get("ep") || "1";
                let page = parsed.searchParams.get("page") || "";
                if (!/^https?:\/\//i.test(page)) {
                  const up = parsed.searchParams.get("up") || "";
                  const host = /adihsppe|thu|pku|fdu/.test(up)
                    ? "https://thu.adihsppe.cc"
                    : "https://huangguoai.com";
                  page = `${host}/video/${encodeURIComponent(
                    id
                  )}/ep-${encodeURIComponent(ep)}/`;
                }
                const cacheKey = `hgBrowserPlay:${page}`;
                // 地址里的 auth_key 有有效期，缓存太久会拿着一张过期的票反复失败。
                const CACHE_TTL_MS = 20 * 60 * 1000;
                try {
                  const cached = sessionStorage.getItem(cacheKey);
                  if (cached) {
                    const parsed = JSON.parse(cached) as { url?: string; at?: number };
                    if (
                      parsed &&
                      typeof parsed.url === "string" &&
                      typeof parsed.at === "number" &&
                      Date.now() - parsed.at < CACHE_TTL_MS
                    ) {
                      return parsed.url;
                    }
                    sessionStorage.removeItem(cacheKey);
                  }
                } catch {
                  // 旧格式或隐私模式：当作没缓存，现抓一次。
                }
                try {
                  const response = await fetch(page, {
                    credentials: "omit",
                    cache: "no-store",
                  });
                  if (!response.ok) return "";
                  const html = await response.text();
                  let stream = "";
                  const script = html.match(
                    /id="videoInitialData"[^>]*>([\s\S]*?)<\/script>/
                  );
                  if (script) {
                    try {
                      const data = JSON.parse(script[1]);
                      const srcs = data.epPlaySrcs || {};
                      stream = srcs[String(ep)] || srcs[ep] || data.videoSrc || "";
                    } catch {
                      stream = "";
                    }
                  }
                  if (!stream) {
                    const match = html.match(
                      /https?:\/\/[^"'<>\s]+?\.m3u8[^"'<>\s]*/
                    );
                    if (match) stream = match[0];
                  }
                  stream = String(stream)
                    .replace(/\\u0026/g, "&")
                    .replace(/\\\//g, "/");
                  if (!/^https?:\/\//i.test(stream)) {
                    const match = stream.match(/https?:\/\/[^\s"']+/);
                    stream = match ? match[0] : "";
                  }
                  if (stream) {
                    try {
                      sessionStorage.setItem(
                        cacheKey,
                        JSON.stringify({ url: stream, at: Date.now() })
                      );
                    } catch {
                      // 写不进去也不影响本次播放。
                    }
                  }
                  return stream;
                } catch {
                  return "";
                }
              };

              const stopWatchdog = () => {
                if (watchdog) {
                  window.clearInterval(watchdog);
                  watchdog = 0;
                }
              };

              const readManifestError = async (target: string) => {
                try {
                  const response = await Promise.race([
                    fetch(target, { cache: "no-store" }),
                    new Promise<never>((_, reject) =>
                      setTimeout(() => reject(new Error("timeout")), 3000)
                    ),
                  ]);
                  const text = await response.text();
                  const parsed = JSON.parse(text);
                  if (parsed && typeof parsed.msg === "string" && parsed.msg) {
                    return parsed.msg;
                  }
                } catch {
                  // 不是 JSON 或者取不到，就用兜底文案。
                }
                return "无法加载播放列表";
              };

              const finish = (fallbackReason: string) => {
                stopWatchdog();
                if (current) {
                  try {
                    current.destroy();
                  } catch {
                    // 已经销毁过。
                  }
                }
                const reason = fallbackReason || "播放失败";
                if (String(reason).includes("manifest")) {
                  void readManifestError(applyUserProxy(url)).then((message) =>
                    failoverRef.current(message || reason)
                  );
                } else {
                  failoverRef.current(reason);
                }
              };

              const mount = (target: string) => {
                stopWatchdog();
                if (current) {
                  try {
                    current.destroy();
                  } catch {
                    // 已经销毁过。
                  }
                }

                const hls = new Hls({
                  manifestLoadingTimeOut: 15000,
                  manifestLoadingMaxRetry: 2,
                  levelLoadingTimeOut: 15000,
                  fragLoadingTimeOut: 20000,
                  fragLoadingMaxRetry: 2,
                });
                current = hls;
                art.hls = hls;
                hlsCleanupRef.current = () => {
                  stopWatchdog();
                  try {
                    hls.destroy();
                  } catch {
                    // 已经销毁过。
                  }
                  if (current === hls) current = null;
                };

                let recovered = false;
                let lastTime = 0;
                let lastProgressAt = Date.now();
                // 分片卡住时 hls.js 往往不报错，只是无限转圈；这里自己看进度。
                watchdog = window.setInterval(() => {
                  if (video.paused || video.ended) {
                    lastProgressAt = Date.now();
                    return;
                  }
                  if (video.currentTime !== lastTime) {
                    lastTime = video.currentTime;
                    lastProgressAt = Date.now();
                    return;
                  }
                  if (Date.now() - lastProgressAt > 20000) {
                    stopWatchdog();
                    failoverRef.current("播放卡住");
                  }
                }, 5000);

                hls.on(Hls.Events.MANIFEST_PARSED, () => {
                  lastProgressAt = Date.now();
                });

                hls.on(Hls.Events.ERROR, (_event, data) => {
                  if (!data.fatal) return;
                  // 解码类错误先原地恢复一次，还不行再切源。
                  if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
                    recovered = true;
                    try {
                      hls.recoverMediaError();
                      return;
                    } catch {
                      // 恢复失败，继续往下走。
                    }
                  }

                  const isManifest = String(data.details || "").includes("manifest");

                  if (isManifest && stage === 0) {
                    // 直连拿不到清单（被拒/跨域）→ 同一源改走代理再试一次。
                    stage = 1;
                    art.notice.show = "直连失败，改走代理重试…";
                    mount(toProxyRetry(url));
                    return;
                  }

                  if (isManifest && stage === 1) {
                    // 适配层也拿不到 → 换成"用你的浏览器解析剧集页"。
                    stage = 2;
                    stopWatchdog();
                    art.notice.show = "尝试用浏览器解析剧集页…";
                    void resolveFromBrowser().then((stream) => {
                      if (stream) {
                        mount(stream);
                        return;
                      }
                      finish(`${data.type}/${data.details}`);
                    });
                    return;
                  }

                  if (isManifest && stage === 2) {
                    // 浏览器解析到了地址，但清单本身跨域被拦 → 走代理再试。
                    // 代理地址要签名（防盗用），签名得由适配层出。
                    stage = 3;
                    art.notice.show = "解析到地址，改走代理再试…";
                    void (async () => {
                      try {
                        const res = await fetch(
                          `${window.location.origin}/huangguo/?ac=signproxy&src=${encodeURIComponent(
                            target
                          )}`
                        );
                        const signed = await res.json();
                        if (signed && signed.code === 1 && signed.url) {
                          mount(String(signed.url));
                          return;
                        }
                      } catch {
                        // 签名失败就按失败处理。
                      }
                      finish(`${data.type}/${data.details}`);
                    })();
                    return;
                  }

                  finish(`${data.type}/${data.details}`);
                });

                // 同一个 <video> 复用时，旧的 MediaSource 会残留，先清干净。
                try {
                  video.pause();
                  video.removeAttribute("src");
                  video.load();
                } catch {
                  // 浏览器不支持也无所谓。
                }

                hls.loadSource(applyUserProxy(target));
                hls.attachMedia(video);
              };

              mount(url);
              art.on("destroy", () => {
                if (hlsCleanupRef.current) {
                  hlsCleanupRef.current();
                  hlsCleanupRef.current = null;
                }
                stopWatchdog();
                if (current) {
                  try {
                    current.destroy();
                  } catch {
                    // 已经销毁过。
                  }
                }
              });
            } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
              video.src = applyUserProxy(url);
              video.addEventListener("error", () =>
                failoverRef.current("native-hls")
              );
            } else {
              art.notice.show = "不支持的播放格式: m3u8";
            }
          },
        },
      });

      // 监听视频播放完毕事件
      art.on("video:ended", () => {
        const source = currentSourceRef.current;
        const list = sortedEpisodesRef.current;
        const order = sortOrderRef.current;
        const currentIndex = list.findIndex((ep) => ep.url === source);
        if (currentIndex < 0) {
          art.notice.show = "找不到当前剧集，无法自动播放下一集";
          return;
        }

        const nextEpisode =
          order === "asc" ? list[currentIndex + 1] : list[currentIndex - 1];

        if (nextEpisode) {
          handleEpisodeSelectRef.current(nextEpisode);
        } else {
          art.notice.show = "全部剧集已播放完毕";
        }
      });

      // 监听视频加载完成事件
      art.on("video:loadedmetadata", () => {
        // 设置初始播放位置（跳过片头）
        if (skipStart > 0) {
          art.seek = skipStart;
        }
      });

      // 监听视频播放进度
      art.on("video:timeupdate", () => {
        const duration = art.duration;
        const currentTime = art.currentTime;
        // 如果接近片尾，自动跳过
        if (skipEnd > 0 && duration - currentTime <= skipEnd) {
          art.seek = duration;
        }
      });

      let winnerSaved = false;
      art.on("video:playing", () => {
        if (winnerSaved || !sourceKey) return;
        winnerSaved = true;
        try {
          localStorage.setItem(`hgPlayWinner:${vodId || ""}`, sourceKey);
        } catch {
          // 隐私模式下写不进去，忽略。
        }
      });

      art.on("video:error", () => {
        failoverRef.current("video-error");
      });

      playerRef.current = art;

      // --- 记住用户设定倍速：换集/换片继续沿用 ---
      let holdPrevRate = 0;
      let holding = false;
      try {
        const storedRate = Number(localStorage.getItem("playerRate") || "0");
        if (storedRate >= 0.25 && storedRate <= 3) art.playbackRate = storedRate;
      } catch {
        // 隐私模式忽略
      }

      art.on("video:ratechange", () => {
        if (holding) return; // 按住加速不算"用户设定"
        const rate = art.playbackRate;
        if (rate && rate >= 0.25) {
          try {
            localStorage.setItem("playerRate", String(rate));
          } catch {
            // 忽略写入失败
          }
        }
      });

      // --- 安卓壳（大肥鱼影视 App）用的桥 ---
      type NativeBridge = { setFullscreen?: (fullscreen: boolean) => void };
      const nativeBridge = (window as unknown as { OmniboxNative?: NativeBridge })
        .OmniboxNative;

      const playerBridge = {
        time: () => art.currentTime || 0,
        duration: () => art.duration || 0,
        seekBy: (delta: number) => {
          const duration = art.duration || 0;
          let next = (art.currentTime || 0) + (Number(delta) || 0);
          if (next < 0) next = 0;
          if (duration > 0 && next > duration - 0.3) next = Math.max(0, duration - 0.3);
          art.currentTime = next;
          return next;
        },
        setRate: (rate: number) => {
          const value = Math.min(3, Math.max(0.25, Number(rate) || 1));
          art.playbackRate = value;
          try {
            localStorage.setItem("playerRate", String(value));
          } catch {
            // 忽略
          }
          return value;
        },
        getRate: () => art.playbackRate || 1,
        // 按住屏幕加速：记住原倍速，松开恢复
        hold: (on: boolean) => {
          if (on) {
            if (!holding) {
              holding = true;
              holdPrevRate = art.playbackRate || 1;
            }
            art.playbackRate = 1.5;
          } else if (holding) {
            holding = false;
            art.playbackRate = holdPrevRate || 1;
          }
          return art.playbackRate;
        },
        exitFullscreen: () => {
          if (art.fullscreenWeb) art.fullscreenWeb = false;
          if (art.fullscreen) art.fullscreen = false;
        },
        isFullscreen: () => !!(art.fullscreen || art.fullscreenWeb),
      };
      (
        window as unknown as { OmniboxPlayer?: typeof playerBridge }
      ).OmniboxPlayer = playerBridge;

      // 网页 CSS 全屏时通知安卓壳：这样竖屏全屏也有返回键和手势（且不吞掉网页点击）。
      let lastCssFullscreen = false;
      fullscreenTimerRef.current = window.setInterval(() => {
        const cssFullscreen = !!art.fullscreenWeb;
        if (cssFullscreen === lastCssFullscreen) return;
        lastCssFullscreen = cssFullscreen;
        try {
          nativeBridge?.setFullscreen?.(cssFullscreen);
        } catch {
          // 非 App 环境忽略
        }
      }, 400);


    }
  }, [currentSource, vodId, sortedEpisodes, sourceKey, skipStart, skipEnd]);

  // 只有页面卸载时才销毁播放器；换集走 switchUrl，保留全屏/倍速。
  useEffect(
    () => () => {
      if (fullscreenTimerRef.current !== null) {
        window.clearInterval(fullscreenTimerRef.current);
        fullscreenTimerRef.current = null;
      }
      try {
        (
          window as unknown as { OmniboxNative?: { setFullscreen?: (v: boolean) => void } }
        ).OmniboxNative?.setFullscreen?.(false);
      } catch {
        // 忽略
      }
      const holder = window as unknown as { OmniboxPlayer?: unknown };
      delete holder.OmniboxPlayer;
      if (playerRef.current) {
        try {
          playerRef.current.destroy();
        } catch {
          // 忽略
        }
        playerRef.current = null;
      }
    },
    []
  );

  // --- Event Handlers ---
  const toggleSortOrder = () => {
    setSortOrder((prev) => {
      const newOrder = prev === "asc" ? "desc" : "asc";
      // 更新本地存储中的排序状态
      if (movieDetails) {
        try {
          const raw = localStorage.getItem("playHistory");
          if (raw) {
            const history: PlayHistoryItem[] = JSON.parse(raw);
            const index = history.findIndex((item) => item.vodId === String(movieDetails.vod_id) && item.source === sourceKey);
            if (index !== -1) {
              history[index].sortOrder = newOrder;
              localStorage.setItem("playHistory", JSON.stringify(history));
            }
          }
        } catch (error) {
          console.error("Error updating sort order in history:", error);
        }
      }
      return newOrder;
    });
  };

  const handleEpisodeSelect = (episode: Episode) => {
    setCurrentSource(episode.url);
    setSearchParams({ vodId: vodId!, epNum: encodeURIComponent(episode.number), source: sourceKey || "" }, { replace: true });
    // 切集时也写入历史，带上sourceKey
    if (movieDetails) {
      const item: PlayHistoryItem = {
        vodId: String(movieDetails.vod_id),
        title: movieDetails.vod_name,
        pic: movieDetails.vod_pic,
        episode: String(episode.number),
        timestamp: Date.now(),
        source: sourceKey || "",
        sortOrder: sortOrder,
        skipStart: skipStart,
        skipEnd: skipEnd,
      };
      try {
        const raw = localStorage.getItem("playHistory");
        let arr: PlayHistoryItem[] = raw ? JSON.parse(raw) : [];
        arr = arr.filter((i) => i.vodId !== item.vodId || i.source !== item.source);
        arr.unshift(item);
        if (arr.length > 20) arr = arr.slice(0, 20);
        localStorage.setItem("playHistory", JSON.stringify(arr));
      } catch {
        // ignore
      }
    }
  };

  // 把最新状态同步进 ref，供播放器里只注册一次的回调（video:ended 等）使用。
  currentSourceRef.current = currentSource;
  sortedEpisodesRef.current = sortedEpisodes;
  sortOrderRef.current = sortOrder;
  handleEpisodeSelectRef.current = handleEpisodeSelect;

  // 获取所有启用的资源站
  const getAllEnabledSites = useMemo(() => {
    const selectedKeys = getSelectedApiSites();
    const defaultSites = API_SITES.filter((site) => selectedKeys.includes(site.key));
    const customSites = JSON.parse(localStorage.getItem("customApiSites") || "[]") as ApiSite[];
    const selectedCustomSites = customSites.filter((site) => selectedKeys.includes(site.key));
    return hideDuplicateManagedSites([...defaultSites, ...selectedCustomSites]);
  }, []);

  // 搜索其他资源站的相同视频
  const searchOtherSources = async () => {
    if (!movieDetails?.vod_name) return;

    const sources: { key: string; name: string }[] = [];

    try {
      // 只在黄果这一族里找：别的采集站内容可能是枪版/带水印，
      // 而且一次搜 68 个站既慢又容易被限流。
      await Promise.all(
        getAllEnabledSites.filter((site) => isHuangguoFamilyKey(site.key)).map(async (site) => {
          if (site.key === sourceKey) {
            sources.push({ key: site.key, name: site.name });
            return;
          }

          const targetUrl = `${site.api}/api.php/provide/vod/?ac=videolist&wd=${encodeURIComponent(movieDetails.vod_name)}`;

          try {
            const response = await fetchWithProxy(targetUrl);
            if (!response.ok) return;
            const data = await response.json();

            if (data.code === 1 && data.list) {
              const exactMatch = data.list.find((item: Movie) => item.vod_name === movieDetails.vod_name);

              if (exactMatch) {
                sources.push({ key: site.key, name: site.name });
              }
            }
          } catch (error) {
            console.error(`Error searching in site ${site.name}:`, error);
          }
        })
      );

      setAvailableSources(sources);
    } catch (error) {
      console.error("Error searching other sources:", error);
    }
  };

  // 处理资源站切换
  const handleSourceChange = async (newSourceKey: string) => {
    if (!movieDetails?.vod_name || newSourceKey === sourceKey) return;

    const targetUrl = `${getAllEnabledSites.find((site) => site.key === newSourceKey)?.api}/api.php/provide/vod/?ac=videolist&wd=${encodeURIComponent(movieDetails.vod_name)}`;
    try {
      const response = await fetchWithProxy(targetUrl);
      if (!response.ok) return;
      const data = await response.json();

      if (data.code === 1 && data.list) {
        const matchedVideo = data.list.find((item: Movie) => item.vod_name === movieDetails.vod_name);

        if (matchedVideo) {
          const currentEpNum = sortedEpisodes.find((ep) => ep.url === currentSource)?.number;
          const newVodId = matchedVideo.vod_id;

          // 获取新资源站的剧集列表
          const detailUrl = `${getAllEnabledSites.find((site) => site.key === newSourceKey)?.api}/api.php/provide/vod/?ac=detail&ids=${newVodId}`;
          const detailResponse = await fetchWithProxy(detailUrl);
          const detailData = await detailResponse.json();

          if (detailData.code === 1 && detailData.list && detailData.list.length > 0) {
            const newEpisodes = detailData.list[0].vod_play_url
              .split("#")
              .map((part: string) => {
                const [number, url] = part.split("$");
                if (number && url && url.startsWith("http")) {
                  return { number: number.trim(), url: url.trim() };
                }
                return null;
              })
              .filter((ep: Episode | null): ep is Episode => ep !== null);

            if (!newEpisodes.length) {
              if (playerRef.current) {
                playerRef.current.notice.show = "那个源没有可播的剧集";
              }
              return;
            }

            // 查找匹配的剧集号
            const targetEpisode = newEpisodes.find((ep: Episode) => ep.number === currentEpNum);
            const targetEpNum = targetEpisode ? currentEpNum : newEpisodes[0].number;

            // 更新 URL 参数
            setSearchParams(
              {
                vodId: String(newVodId),
                epNum: encodeURIComponent(targetEpNum),
                source: newSourceKey,
              },
              { replace: true }
            );
          }
        }
      }
    } catch (error) {
      console.error("Error switching source:", error);
    }
  };

  // 播放失败 → 自动切到下一个有同名剧的源。
  // hls.js 的错误回调在 player 初始化时注册，这里留一个稳定的入口给它。
  useEffect(() => {
    switchSourceRef.current = handleSourceChange;
    failoverRef.current = (reason: string) => {
      const state = failoverState.current;
      if (state.busy) return;
      if (!movieDetails?.vod_name) return;

      if (sourceKey) state.tried.add(sourceKey);
      if (state.tried.size > 3) {
        if (playerRef.current) {
          playerRef.current.notice.show = `连续 ${state.tried.size} 个源都播放失败，先停一下`;
        }
        return;
      }
      const next = availableSources.find(
        (site) =>
          !state.tried.has(site.key) &&
          (!sourceKey || isHuangguoFamilyKey(site.key) === isHuangguoFamilyKey(sourceKey))
      );
      if (!next) {
        if (playerRef.current) {
          playerRef.current.notice.show = `播放失败：${String(reason).slice(0, 80)}`;
        }
        return;
      }

      state.busy = true;
      if (playerRef.current) {
        const short = String(reason).slice(0, 60);
        playerRef.current.notice.show = `播放失败（${short}），正在切换到「${next.name}」`;
      }
      void switchSourceRef.current(next.key).finally(() => {
        state.busy = false;
      });
    };
  }, [availableSources, movieDetails?.vod_name, sourceKey]);

  // 换源或换剧时重置切源记录，避免把新剧的源当成"已失败"。
  useEffect(() => {
    failoverState.current = {
      tried: new Set(sourceKey ? [sourceKey] : []),
      busy: false,
    };
  }, [sourceKey, vodId]);

  // 在视频详情加载完成后搜索其他资源站
  useEffect(() => {
    if (movieDetails?.vod_name) {
      searchOtherSources();
    }
  }, [movieDetails?.vod_name]);

  // --- Final Calculations for Render ---
  if (isLoading) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center">
        <p>正在加载视频信息...</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center">
        <p className="text-red-500">错误: {error}</p>
      </div>
    );
  }
  if (!movieDetails) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center">
        <p>未能加载视频信息。</p>
      </div>
    );
  }

  // --- Render ---
  return (
    <>
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-8">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Video Player Section */}
            <div className="lg:col-span-2 space-y-6">
              <div className="h-[250px] xl:h-[600px]">
                {currentSource ? (
                  <div ref={artRef} className="w-full h-full"></div>
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-gray-800">请选择要播放的剧集</div>
                )}
              </div>

              {/* 影片信息 */}
              <Card className="border-border/50 bg-card/50 p-0">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <h2 className="text-xl font-semibold mb-3">{movieDetails.vod_name}</h2>
                      <div className="flex items-center gap-4 text-sm">
                        <div className="flex items-center gap-1">
                          <Calendar className="w-4 h-4" />
                          <span>{movieDetails.vod_year}</span>
                        </div>
                        <Badge variant="outline" className="border-border/50">
                          {movieDetails.type_name}
                        </Badge>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Episode List Section */}
            <div className="space-y-6">
              <Card className="border-border/50 bg-card/50 p-0">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-4 border-b pb-2">
                    <div className="flex items-center gap-2">
                      <ListVideo className="w-5 h-5" />
                      <h3 className="font-semibold text-lg">剧集列表</h3>
                      <Badge variant="outline" className="border-border/50 bg-background/50">
                        {sortedEpisodes.length}集
                      </Badge>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={toggleSortOrder}
                      className="text-muted-foreground hover:text-primary hover:bg-primary/10 px-3 py-1 rounded-md transition-colors">
                      <ArrowUpDown className="w-4 h-4 mr-1" />
                      {sortOrder === "asc" ? "正序" : "倒序"}
                    </Button>
                  </div>
                 
                    <ScrollArea className="h-[300px] md:h-[400px] xl:h-[480px]">
                      <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-5 gap-2">
                        {sortedEpisodes.map((ep) => (
                          <Button
                            key={ep.number + ep.url}
                            variant={currentSource === ep.url ? "default" : "outline"}
                            size="sm"
                            className={`h-10 w-full transition-all duration-200 ${
                              currentSource === ep.url ? "bg-primary text-primary-foreground hover:bg-primary/90" : "border-border/50 hover:border-primary/50 hover:bg-primary/5"
                            }`}
                            onClick={() => handleEpisodeSelect(ep)}>
                            {ep.number}
                          </Button>
                        ))}
                      </div>
                    </ScrollArea>
                
                </CardContent>
              </Card>
              {/* 采集站切换 */}
              <Card className="border-border/50 bg-card/50 p-0">
                <CardContent className="p-4">
                  <h3 className="font-semibold mb-3">采集站切换</h3>
                  <div className="space-y-2">
                    {availableSources.map((source) => (
                      <Button
                        key={source.key}
                        variant={sourceKey === source.key ? "default" : "outline"}
                        className={`w-full justify-between ${sourceKey !== source.key ? "border-border/50" : ""}`}
                        onClick={() => handleSourceChange(source.key)}>
                        {source.name}
                        {sourceKey === source.key && <ChevronRight className="w-4 h-4" />}
                      </Button>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>{" "}
        </div>{" "}
      </div>
    </>
  );
}

export default PlayerPage;
