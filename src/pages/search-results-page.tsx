import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Search, ExternalLink, Calendar, Loader2, Copy, Check, Filter, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { API_SITES } from "@/config/apiSites";
import { isAllowedSource } from "@/utils/auth";
import { Movie, ApiSite } from "@/types/index";
import { RouterUtils } from "@/utils/router";
import { fetchWithProxy } from "@/utils/proxy";
import { hideDuplicateManagedSites } from "@/utils/siteVisibility";
import noImg from "@/assets/no-img.svg";
import * as cheerio from "cheerio";

interface MovieResult {
  id: string;
  title: string;
  poster: string;
  source: string;
  vod_remarks:string;
  source_key: string;
  type: string;
  year: string;
  region: string;
  rate?: string;
}

interface CloudResource {
  id: number;
  title: string;
  poster: string;
  sourceChannel: string;
  platform: string;
  publishTime: string;
  shareUrl: string;
  shareCode: string;
  tags: string[];
}

interface AIModel {
  id: string;
  name: string;
}

interface AIResponse {
  channel_name: string;
  resources: Array<{
    title: string;
    resource: string;
    link: string;
    platform?: string;
    share_code?: string;
    publish_time?: string;
    tags?: string[];
    poster?: string;
  }>;
}

interface SearchSite {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  extractionType: string;
}

// 格式化时间为相对时间
const formatRelativeTime = (dateString: string): string => {
  const date = new Date(dateString);
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diffInSeconds < 60) {
    return "刚刚";
  }

  const diffInMinutes = Math.floor(diffInSeconds / 60);
  if (diffInMinutes < 60) {
    return `${diffInMinutes}分钟前`;
  }

  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) {
    return `${diffInHours}小时前`;
  }

  const diffInDays = Math.floor(diffInHours / 24);
  if (diffInDays < 30) {
    return `${diffInDays}天前`;
  }

  const diffInMonths = Math.floor(diffInDays / 30);
  if (diffInMonths < 12) {
    return `${diffInMonths}个月前`;
  }

  const diffInYears = Math.floor(diffInMonths / 12);
  return `${diffInYears}年前`;
};

// 根据链接判断网盘平台
const getPlatformByUrl = (url: string): string => {
  try {
    const u = new URL(url);
    const host = u.hostname;
    if (/alipan\.com|aliyundrive\.com/.test(host)) return "阿里云网盘";
    if (/quark\.cn/.test(host)) return "夸克网盘";
    if (/baidu\.com/.test(host)) return "百度网盘";
    if (/189\.cn/.test(host)) return "天翼云网盘";
    if (/xunlei\.com/.test(host)) return "迅雷云盘";
    if (/123865\.com|123684\.com|123912\.com/.test(host)) return "123云盘";
    if (/139\.com/.test(host)) return "移动云盘";
    if (/uc\.cn/.test(host)) return "UC网盘";
    return host;
  } catch {
    return "未知平台";
  }
};

function normalizeTitle(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

function buildSearchUrl(api: string, keyword: string): string {
  const base = api.trim().replace(/\/+$/, "").replace(/[?&]+$/, "");
  const fullEndpoint =
    /\.php$/i.test(base) ||
    /\/api\/json$/i.test(base) ||
    /\/provide\/vod$/i.test(base);
  const query = `ac=videolist&wd=${encodeURIComponent(keyword)}`;
  return fullEndpoint
    ? `${base}${base.includes("?") ? "&" : "?"}${query}`
    : `${base}/api.php/provide/vod/?${query}`;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;

  async function worker() {
    while (true) {
      const current = index++;
      if (current >= items.length) return;
      results[current] = await task(items[current]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return results;
}

export default function SearchResultsPage() {
  const [searchParams] = useSearchParams();
  const [movieResults, setMovieResults] = useState<MovieResult[]>([]);
  const [cloudResults, setCloudResults] = useState<CloudResource[]>([]);
  const [filteredCloudResults, setFilteredCloudResults] = useState<CloudResource[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("movies");
  const [searchQuery, setSearchQuery] = useState("");
  const [copiedItems, setCopiedItems] = useState<Set<number>>(new Set());
  const [isCloudLoading, setIsCloudLoading] = useState(false);
  const [selectedPlatform, setSelectedPlatform] = useState<string>("all");
  const [platformCounts, setPlatformCounts] = useState<Record<string, number>>({});

  const normalizedSearchQuery = normalizeTitle(searchQuery);
  const exactMovies = movieResults.filter(
    (movie) => normalizeTitle(movie.title) === normalizedSearchQuery
  );
  const fuzzyMovies = movieResults.filter(
    (movie) => normalizeTitle(movie.title) !== normalizedSearchQuery
  );

  // 获取选中的AI模型配置
  const getSelectedAIModel = () => {
    const selectedModelId = localStorage.getItem("tg_selected_model");
    const savedModels = localStorage.getItem("ai_models");
    if (!selectedModelId || !savedModels) return null;

    const models = JSON.parse(savedModels);
    return models.find((model: AIModel) => model.id === selectedModelId);
  };

  // 获取AI模型API配置
  const getAIModelConfig = () => {
    const apiUrl = localStorage.getItem("ai_api_url");
    const apiKey = localStorage.getItem("ai_api_key");
    return { apiUrl, apiKey };
  };
  const extractJson = (text: string) => {
    const jsonRegex = /```(?:json)?\n?([\s\S]*?)\n?```/i; // 匹配 ```json ... ``` 或 ``` ... ```
    const match = text.match(jsonRegex);
    if (match && match[1]) {
      try {
        const jsonString = match[1].trim();
        return JSON.parse(jsonString);
      } catch (error) {
        console.error("JSON 解析失败:", error);
        return null;
      }
    } else {
      try {
        // 尝试直接解析整个字符串，以防没有 ```json 标签
        return JSON.parse(text);
      } catch (error) {
        console.error("JSON 解析失败:", error);
        return null;
      }
    }
  };
  // 使用AI模型提取网盘信息
  const extractCloudInfo = async (htmlContent: string, channelName: string): Promise<CloudResource[]> => {
    const model = getSelectedAIModel();
    const config = getAIModelConfig();

    if (!model || !config.apiUrl || !config.apiKey) {
      console.error("AI模型配置不完整");
      return [];
    }

    try {
      // 获取用户自定义的提示词
      const customPrompt = localStorage.getItem("tg_prompt") || "";
      
      const basePrompt = `请从以下网盘资源站内容中提取包含关键词"${searchParams.get("q")}"的网盘资源信息，并以JSON格式返回。要求：
1. 返回格式必须为JSON，包含channel_name和resources数组
2. resources数组中的每个资源必须包含以下字段：
   - title: 资源标题
   - poster：海报封面图片
   - link: 分享链接
   - platform: 网盘平台名称（根据分享链接域名判断：
     * alipan.com 或 aliyundrive.com 为阿里云网盘
     * quark.cn 为夸克网盘
     * baidu.com 为百度网盘
     * 189.cn 为天翼云网盘
     * xunlei.com 为迅雷云盘
     * 123865.com 或 123684.com 或 123912.com 为123云盘
     * 139.com 为移动云盘
     * uc.cn 为UC网盘
     * 其他域名保持原样）
   - share_code: 提取码（如果有）
   - publish_time: 发布时间（如果有）
   - tags: 标签数组（如果有）
3. 如果某些字段信息不存在，可以省略该字段
4. 如果存在相同的网盘链接，则只提取发布时间最新的那个资源
5. 请确保JSON格式正确，便于程序解析`;

      // 合并基础提示词和自定义提示词
      const prompt = customPrompt 
        ? `${basePrompt}\n\n额外要求：\n${customPrompt}`
        : basePrompt;

      const response = await fetch(config.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: model.name,
          messages: [
            {
              role: "system",
              content: "你是一个专门用于提取网盘资源信息的AI助手。请严格按照要求的JSON格式返回数据。",
            },
            {
              role: "user",
              content: `${prompt}\n\n频道名称：${channelName}\n内容：${htmlContent}`,
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error("AI模型请求失败");
      }

      const data = await response.json();
      const content = extractJson(data.choices[0].message.content);
      console.log(content);
      const aiResponse = content as AIResponse;
      console.log(aiResponse);
      // 转换AI返回的数据为CloudResource格式
      const resources = aiResponse.resources.map((resource) => ({
        id: Date.now() + Math.random(),
        title: resource.title,
        poster: resource.poster || "/placeholder.svg?height=400&width=300", // 默认海报
        sourceChannel: aiResponse.channel_name,
        platform: resource.platform || "未知平台",
        publishTime: resource.publish_time || new Date().toISOString().split("T")[0],
        shareUrl: resource.link,
        shareCode: resource.share_code || "",
        tags: resource.tags || [],
      }));
      // 按发布时间倒序排序
      const sortedResources = resources.sort((a, b) => {
        const t1 = new Date(a.publishTime).getTime();
        const t2 = new Date(b.publishTime).getTime();
        return t2 - t1;
      });
      return sortedResources;
    } catch (error) {
      console.error("AI模型提取失败:", error);
      return [];
    }
  };

  // TG频道规则提取网盘信息
  const extractCloudInfoByTG = (htmlContent: string, channelName: string): CloudResource[] => {
    const $ = cheerio.load(htmlContent);
    const items: CloudResource[] = [];
    // 获取频道名（如有）
    let sourceChannel = channelName;
    const channelHeader = $(".tgme_header_link").find("img").attr("src");
    if (channelHeader) {
      sourceChannel = channelName;
    }

    // 遍历每个消息容器
    $(".tgme_widget_message_wrap").each((_: unknown, element: unknown) => {
   
      const messageEl = $(
        element as Parameters<ReturnType<typeof cheerio.load>>[0]
      );

      // 发布时间
      const pubDate = messageEl.find("time").attr("datetime") || new Date().toISOString();
      // 标题（第一个<br>前的内容）
      const html = messageEl.find(".js-message_text").html() || "";
      const title = html.split("<br>")[0]?.replace(/<[^>]+>/g, "").replace(/\n/g, "").trim() || "";

      // 云盘链接
      const links = messageEl
        .find(".tgme_widget_message_text a")
        .map((_: unknown, el: unknown) => {
          const node = el as { href?: string; attribs?: { href?: string } };
          return node.href || node.attribs?.href || "";
        })
        .get();
      
      // 只保留平台能识别的云盘链接
      const validLinks = (links as string[]).filter((link: string) => {
     
        const platform = getPlatformByUrl(link);
     
        // 只要不是"未知平台"且不是原始 host
        return platform && platform !== "未知平台" && !/^([\w.-]+)$/.test(platform);
      });
  
      if (validLinks.length === 0) return;
 
      validLinks.forEach((link: string) => {
        items.push({
          id: Date.now() + Math.random(),
          title,
          poster: '', // TG规则不提取封面
          sourceChannel,
          platform: getPlatformByUrl(link),
          publishTime: pubDate,
          shareUrl: link,
          shareCode: '',
          tags: [],
        });
      });
    });
    // 按发布时间倒序排序
    const sortedItems = items.sort((a, b) => {
      const t1 = new Date(a.publishTime).getTime();
      const t2 = new Date(b.publishTime).getTime();
      return t2 - t1;
    });
    return sortedItems;
  };

  // 获取启用的搜索站点列表
  const getEnabledSites = (): SearchSite[] => {
    const savedSites = localStorage.getItem("search_sites");
    if (!savedSites) return [];
    const sites = JSON.parse(savedSites) as SearchSite[];
    return sites.filter((site) => site.enabled);
  };

  // 替换URL中的关键词
  const replaceKeywordInUrl = (url: string, keyword: string): string => {
    return url.replace(/{keyword}/g, encodeURIComponent(keyword));
  };

  // 搜索网盘资源
  const searchCloudResources = async (query: string) => {
    const sites = getEnabledSites();
    if (sites.length === 0) {
      setCloudResults([]);
      return;
    }
    setIsCloudLoading(true);
    const results: CloudResource[] = [];
    try {
      // 并行搜索所有启用的站点
      const searchPromises = sites.map(async (site) => {
        try {
          const searchUrl = replaceKeywordInUrl(site.url, query);
          const response = await fetchWithProxy(searchUrl);
          if (!response.ok) throw new Error(`站点 ${site.name} 请求失败`);
          const html = await response.text();
          let cloudInfos: CloudResource[] = [];
          if (site.extractionType === 'ai') {
            const aiResult = await extractCloudInfo(html, site.name);
            if (aiResult) cloudInfos = aiResult;
          } else {
            cloudInfos = extractCloudInfoByTG(html, site.name);
          }
          return cloudInfos;
        } catch (error) {
          console.error(`搜索站点 ${site.name} 失败:`, error);
          return [];
        }
      });
      const siteResults = await Promise.all(searchPromises);
      const allResults = siteResults.flat();
      // 过滤重复链接，保留最新的资源
      const uniqueResults = allResults.reduce((acc: CloudResource[], current) => {
        const existingIndex = acc.findIndex(item => item.shareUrl === current.shareUrl);
        if (existingIndex === -1) {
          acc.push(current);
        } else {
          const existing = acc[existingIndex];
          const existingTime = new Date(existing.publishTime).getTime();
          const currentTime = new Date(current.publishTime).getTime();
          if (currentTime > existingTime) {
            acc[existingIndex] = current;
          }
        }
        return acc;
      }, []);
      results.push(...uniqueResults);
    } catch (error) {
      console.error("搜索网盘资源失败:", error);
      toast("搜索失败", {
        description: "获取网盘资源时出错，请稍后重试",
      });
    } finally {
      setIsCloudLoading(false);
      setCloudResults(results);
    }
  };

  useEffect(() => {
    const query = searchParams.get("q");
    if (query) {
      setSearchQuery(query);
      performSearch(query);
      searchCloudResources(query);
    }
  }, [searchParams.get("q"), searchParams.get("t")]);

  const performSearch = async (query: string) => {
    setIsLoading(true);
    setMovieResults([]);

    try {
      // 搜索所有有权限的源，而不只是当前勾选的源
      const defaultSites = API_SITES.filter((site) => isAllowedSource(site.key));
      // 同名 remote_* 与 hg_* 重复时只保留 hg_*，避免重复请求/重复结果。
      const customSites = hideDuplicateManagedSites(
        JSON.parse(localStorage.getItem("customApiSites") || "[]") as ApiSite[]
      );
      // hg_* 是 /huangguo 下的子源，默认 huangguo 源一次请求就会合并搜索，
      // 不要再让浏览器为每个子源单独发一次请求。
      const allowedCustomSites = customSites.filter(
        (site) =>
          site?.key &&
          site?.api &&
          isAllowedSource(site.key) &&
          !String(site.key).startsWith("hg_")
      );

      const seen = new Set<string>();
      const allSites = [...defaultSites, ...allowedCustomSites].filter((site) => {
        const key = site.api.replace(/\/+$/, "");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // 控制并发，避免几十个源同时请求
      const searchResults = await mapLimit(allSites, 8, async (site) => {
        try {
          const targetUrl = buildSearchUrl(site.api, query);
          const response = await Promise.race([
            fetchWithProxy(targetUrl),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("搜索超时")), 10000)
            ),
          ]);
          if (!response.ok) return [];
          const data = await response.json();
          if (data.code === 1 && Array.isArray(data.list)) {
            return data.list.map((item: Movie) => ({
              id: item.vod_id,
              title: item.vod_name,
              poster: item.vod_pic,
              source: item.source_name || item.source || site.name,
              source_key: item.source_key || site.key,
              vod_remarks: item.vod_remarks,
              type: item.type_name || "未知",
              year: item.vod_year || "未知",
              region: item.vod_area || "未知",
              rate: item.vod_score,
            }));
          }
          return [];
        } catch (error) {
          console.error(`Error searching in site ${site.name}:`, error);
          return [];
        }
      });

      const allResults = searchResults.flat();
      const normalizedQuery = normalizeTitle(query);
      allResults.sort((a, b) => {
        const aExact = normalizeTitle(a.title) === normalizedQuery ? 0 : 1;
        const bExact = normalizeTitle(b.title) === normalizedQuery ? 0 : 1;
        return aExact - bExact;
      });
      setMovieResults(allResults);
    } catch (error) {
      console.error("Error fetching search results:", error);
      toast("搜索失败", {
        description: "获取搜索结果时出错，请稍后重试",
      });
    } finally {
      setIsLoading(false);
    }
  };
  // 处理卡片点击事件：直接跳转到播放页面
  const handleCardClick = (movie: MovieResult) => {
    if (!movie.id) {
      console.error("Missing movie ID");
      return;
    }
    const vodId = movie.id;
    console.log(movie);
    const source = movie.source_key || "";
    // window.location.hash=`play?vodId=${vodId}&source=${source}`;
    RouterUtils.navigateTo("play", { vodId: vodId, source: source });
  };

  const handleCopyLink = async (resource: CloudResource) => {
    try {
      await navigator.clipboard.writeText(resource.shareUrl);
      setCopiedItems((prev) => new Set(prev).add(resource.id));
      toast("复制成功", {
        description: `已复制 ${resource.platform} 分享链接`,
      });
      setTimeout(() => {
        setCopiedItems((prev) => {
          const newSet = new Set(prev);
          newSet.delete(resource.id);
          return newSet;
        });
      }, 3000);
    } catch {
      const textArea = document.createElement("textarea");
      textArea.value = resource.shareUrl;
      document.body.appendChild(textArea);
      textArea.select();

      try {
        document.execCommand("copy");
        toast("复制成功", {
          description: `已复制 ${resource.platform} 分享链接`,
        });
        setCopiedItems((prev) => new Set(prev).add(resource.id));
        setTimeout(() => {
          setCopiedItems((prev) => {
            const newSet = new Set(prev);
            newSet.delete(resource.id);
            return newSet;
          });
        }, 3000);
      } catch {
        toast("复制失败", {
          description: "请手动复制链接",
        });
      } finally {
        document.body.removeChild(textArea);
      }
    }
  };

  // 计算各平台资源数量
  useEffect(() => {
    if (cloudResults.length > 0) {
      const counts: Record<string, number> = { all: cloudResults.length };
      cloudResults.forEach((resource) => {
        if (counts[resource.platform]) {
          counts[resource.platform]++;
        } else {
          counts[resource.platform] = 1;
        }
      });
      setPlatformCounts(counts);
    }
  }, [cloudResults]);

  // 根据选择的平台筛选结果
  useEffect(() => {
    if (selectedPlatform === "all") {
      setFilteredCloudResults(cloudResults);
    } else {
      setFilteredCloudResults(cloudResults.filter((resource) => resource.platform === selectedPlatform));
    }
  }, [selectedPlatform, cloudResults]);

  // 获取所有可用的平台类型
  const getPlatforms = () => {
    const platforms = new Set<string>();
    cloudResults.forEach((resource) => platforms.add(resource.platform));
    return Array.from(platforms);
  };

  // 处理访问网盘
  const handleVisitCloud = (resource: CloudResource) => {
    window.open(resource.shareUrl, "_blank");
  };

  // 处理图片加载错误
  const handleImageError = (e: React.SyntheticEvent<HTMLImageElement, Event>) => {
    e.currentTarget.src = noImg;
  };

  const renderMovieCard = (movie: MovieResult) => (
    <Card
      key={`${movie.source_key}-${movie.id}`}
      onClick={() => handleCardClick(movie)}
      className="gap-0 py-0 overflow-hidden hover:shadow-lg transition-all duration-300 border-border/50 hover:border-border bg-card/50 hover:bg-card">
      <div className="relative w-full h-48">
        <img
          src={movie.poster || noImg}
          alt={movie.title}
          className="absolute inset-0 w-full h-full object-cover"
          referrerPolicy="no-referrer"
          onError={handleImageError}
        />
        {movie.rate && (
          <div className="absolute top-2 right-2">
            <Badge variant="secondary" className="bg-black/70 text-white text-xs border-0">
              <Star className="w-3 h-3 mr-1 fill-yellow-400 text-yellow-400" />
              {movie.rate}
            </Badge>
          </div>
        )}
        <div className="absolute bottom-2 left-2">
          <Badge variant="outline" className="bg-black/70 text-white border-white/30 text-xs">
            {movie.vod_remarks}
          </Badge>
        </div>
        <div className="absolute bottom-2 right-2">
          <Badge variant="outline" className="bg-black/70 text-white border-white/30 text-xs">
            {movie.source}
          </Badge>
        </div>
      </div>
      <CardContent className="p-3">
        <h3 className="font-medium text-sm line-clamp-2 mb-2">{movie.title}</h3>
        <div className="flex items-center gap-1 mb-2 text-xs text-muted-foreground">
          <Badge variant="outline" className="text-xs border-border/50">
            {movie.type}
          </Badge>
          <span>{movie.year}</span>
          <span>{movie.region}</span>
        </div>
      </CardContent>
    </Card>
  );

  const renderMovieGrid = (movies: MovieResult[]) => (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
      {movies.map(renderMovieCard)}
    </div>
  );

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-8">
        {/* 搜索结果标题 */}
        {searchQuery && (
          <div className="mb-6">
            <h1 className="text-2xl font-bold mb-2">搜索结果</h1>
            <p className="text-muted-foreground">关键词："{searchQuery}"</p>
          </div>
        )}

        {isLoading && (
          <div className="flex flex-col items-center justify-center py-24 text-muted-foreground">
            <Loader2 className="mb-4 h-9 w-9 animate-spin text-primary" />
            <p className="text-sm font-medium">正在搜索所有资源站...</p>
            <p className="mt-1 text-xs">源比较多时可能需要几秒，请稍候</p>
          </div>
        )}

        {/* 搜索结果 */}
        {!isLoading && (movieResults.length > 0 || cloudResults.length > 0) && (
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="grid w-full grid-cols-2 bg-muted/50 border border-border/30">
              <TabsTrigger value="movies" className="data-[state=active]:bg-background data-[state=active]:border-border/50">
                影视作品 ({movieResults.length})
              </TabsTrigger>
              <TabsTrigger value="cloud" className="data-[state=active]:bg-background data-[state=active]:border-border/50">
                网盘资源 ({cloudResults.length})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="movies" className="mt-6">
              {isLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-8 h-8 animate-spin mr-2" />
                  <span>正在搜索影视作品...</span>
                </div>
              ) : (
                <div className="space-y-8">
                  {exactMovies.length > 0 && (
                    <section>
                      <h2 className="mb-3 text-lg font-semibold">
                        精确匹配 ({exactMovies.length})
                      </h2>
                      {renderMovieGrid(exactMovies)}
                    </section>
                  )}
                  {fuzzyMovies.length > 0 && (
                    <section>
                      <h2 className="mb-3 text-lg font-semibold">
                        {exactMovies.length > 0 ? "相关结果" : "搜索结果"} ({fuzzyMovies.length})
                      </h2>
                      {renderMovieGrid(fuzzyMovies)}
                    </section>
                  )}
                </div>
              )}
            </TabsContent>

            <TabsContent value="cloud" className="mt-6">
              {isCloudLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-8 h-8 animate-spin mr-2" />
                  <span>正在搜索网盘资源...</span>
                </div>
              ) : (
                <>
                  {/* 网盘类型筛选 */}
                  {cloudResults.length > 0 && (
                    <div className="mb-4">
                      <div className="flex items-center gap-2 mb-3">
                        <Filter className="w-4 h-4" />
                        <h3 className="font-medium">按网盘类型筛选</h3>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant={selectedPlatform === "all" ? "default" : "outline"}
                          size="sm"
                          onClick={() => setSelectedPlatform("all")}
                          className={selectedPlatform !== "all" ? "border-border/50" : ""}>
                          全部
                          <Badge variant="secondary" className="ml-2 bg-background/80">
                            {platformCounts["all"] || 0}
                          </Badge>
                        </Button>

                        {getPlatforms().map((platform) => (
                          <Button
                            key={platform}
                            variant={selectedPlatform === platform ? "default" : "outline"}
                            size="sm"
                            onClick={() => setSelectedPlatform(platform)}
                            className={selectedPlatform !== platform ? "border-border/50" : ""}>
                            {platform}
                            <Badge variant="secondary" className="ml-2 bg-background/80">
                              {platformCounts[platform] || 0}
                            </Badge>
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 筛选结果 */}
                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                    {filteredCloudResults.length > 0 ? (
                      filteredCloudResults.map((resource) => (
                        <Card key={resource.id} className="overflow-hidden border-border/50 bg-card/50 hover:bg-card hover:border-border transition-all duration-300">
                          <CardContent className="p-4">
                            <div className="space-y-3">
                              {/* 标题和平台 */}
                              <div className="flex items-start justify-between">
                                <div className="flex-1 min-w-0">
                                  <h3 className="font-semibold text-base line-clamp-2 mb-2 leading-tight">{resource.title}</h3>
                                </div>
                                <Badge variant="outline" className="ml-3 flex-shrink-0 border-border/50 bg-primary/10 text-primary">
                                  {resource.platform}
                                </Badge>
                              </div>

                              {/* 信息行 */}
                              <div className="flex items-center justify-between text-sm text-muted-foreground">
                                <div className="flex items-center gap-4">
                                  <div className="flex items-center gap-1">
                                    <Calendar className="w-3 h-3" />
                                    <span>{formatRelativeTime(resource.publishTime)}</span>
                                  </div>
                                  <div className="flex items-center gap-1">
                                    <span>来源：{resource.sourceChannel}</span>
                                  </div>
                                </div>
                              </div>

                              {/* 操作按钮 */}
                              <div className="flex items-center gap-2 pt-2 border-t border-border/30">
                                <Button variant="outline" size="sm" className="h-8 px-3 text-xs flex-1" onClick={() => handleCopyLink(resource)}>
                                  {copiedItems.has(resource.id) ? (
                                    <>
                                      <Check className="w-3 h-3 mr-1 text-green-500" />
                                      已复制链接
                                    </>
                                  ) : (
                                    <>
                                      <Copy className="w-3 h-3 mr-1" />
                                      复制链接
                                    </>
                                  )}
                                </Button>
                                <Button size="sm" className="h-8 px-4 text-xs flex-1" onClick={() => handleVisitCloud(resource)}>
                                  <ExternalLink className="w-3 h-3 mr-1" />
                                  访问{resource.platform}
                                </Button>
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      ))
                    ) : (
                      <div className="col-span-full text-center py-8">
                        <p className="text-muted-foreground">没有找到符合条件的{selectedPlatform}资源</p>
                      </div>
                    )}
                  </div>
                </>
              )}
            </TabsContent>
          </Tabs>
        )}

        {/* 无搜索结果 */}
        {!isLoading && movieResults.length === 0 && cloudResults.length === 0 && searchQuery && (
          <div className="text-center py-12">
            <Search className="w-16 h-16 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">未找到相关资源</h3>
            <p className="text-muted-foreground mb-4">没有找到与 "{searchQuery}" 相关的影视作品或网盘资源</p>
            <p className="text-sm text-muted-foreground">请检查采集站和网盘资源站配置，或尝试其他关键词</p>
          </div>
        )}
      </div>
    </div>
  );
}
