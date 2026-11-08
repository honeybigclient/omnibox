const getProxyBaseUrl = () => {
  const baseUrl = localStorage.getItem('PROXY_BASE_URL');
  if (!baseUrl) {
    throw new Error('代理地址未初始化');
  }
  return baseUrl;
};

export const createProxyUrl = (targetUrl: string): string => {
  const baseUrl = getProxyBaseUrl();
  return `${baseUrl}${encodeURIComponent(targetUrl)}`;
};

/**
   * 通过代理地址请求第三方接口。
   * 同域请求（比如 /huangguo 适配层）直接 fetch，少绕一跳代理。
 */
export const fetchWithProxy = async (targetUrl: string, options?: RequestInit) => {
  if (
    typeof window !== "undefined" &&
    targetUrl.startsWith(`${window.location.origin}/`)
  ) {
    return fetch(targetUrl, options);
  }
  const proxyUrl = createProxyUrl(targetUrl);
  return fetch(proxyUrl, options);
};
