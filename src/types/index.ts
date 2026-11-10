// 定义从 API 获取的电影数据的结构 (对应 API 返回的 list 中的对象)
export interface Movie {
  vod_id: string;
  vod_name: string;
  vod_pic: string;
  vod_remarks?: string;
  vod_year?: string;
  vod_area?: string;
  type_name?: string;
  vod_play_url?: string;
  source?: string;
  source_key?: string;
  source_name?: string;
  vod_score?: string;
  vod_blurb?: string;
  vod_actor?: string;
  vod_time?: string;
}

// 定义通用的 AppleCMS API 响应结构
export interface AppleCMSResponse<T> {
  code: number;      // 状态码，1 表示成功
  msg: string;       // 消息文本
  page: number;      // 当前页码
  pagecount: number; // 总页数
  limit?: string | number; // 每页数量 (API 返回中可能为字符串或数字)
  total?: number;    // 总记录数
  list: T[];         // 数据列表
}

// 定义 searchMovies 函数返回的搜索结果对象结构
export interface MovieSearchResult {
  id: string;
  title: string;
  cover: string;
  year: string;
  type: string;
  rating: number;
  playUrls: string[]; // 提取出的播放 URL 列表
}

// 定义 getMovieDetail 函数返回的电影详情对象结构
export interface MovieDetail {
  id: string;
  title: string;
  cover: string;
  description?: string;
  year: string;
  type: string;
  rating: number;
  playUrls: string[];
  actors: string[];
  area?: string;
  updateTime?: string;
}

export interface PlayHistoryItem {
  vodId: string;
  title: string;
  pic: string;
  episode: string;
  source: string;
  timestamp: number;
}

export interface ApiSite {
  key: string;
  name: string;
  api: string;
  detail?: string;
  filterAdRule?: string;
  isCustom?: boolean;
}

export interface CustomApiSite extends ApiSite {
  isCustom: true;
}