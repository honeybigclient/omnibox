import React, { useEffect, useState } from "react";
import { API_SITES } from "@/config/apiSites";
import { getSelectedApiSites, setSelectedApiSites } from "@/utils/apiSite";
import { ApiSite } from "@/types/apiSite";
import { Trash2, Plus, HeartPulse, AlertCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { fetchWithProxy } from "@/utils/proxy";
import { isAdmin, isAllowedSource } from "@/utils/auth";
import { hideDuplicateManagedSites } from "@/utils/siteVisibility";

interface ApiSiteStatus {
  key: string;
  name: string;
  responseTime?: number;
  isSelected: boolean;
  isCustom?: boolean;
  api: string;
}

const STORAGE_KEY = "customApiSites";

const ApiSitesList: React.FC = () => {
  const [sites, setSites] = useState<ApiSiteStatus[]>([]);
  const [isTesting, setIsTesting] = useState(false);

  const [isAdding, setIsAdding] = useState(false);
  const [newSite, setNewSite] = useState({ name: "", api: "" });
  const [error, setError] = useState<string | null>(null);

  const testApiResponse = async () => {
    setIsTesting(true);
    const selectedKeys = getSelectedApiSites();
    const testResults: ApiSiteStatus[] = [];

    const admin = isAdmin();

    // 测试默认API站点
    await Promise.all(
      API_SITES.filter((site) => admin || isAllowedSource(site.key)).map(async (site) => {
        const targetUrl = `${site.api}/api.php/provide/vod/?ac=detail&wd=${encodeURIComponent("仙逆")}`;
    
        const startTime = performance.now();

        try {
          const response = await fetchWithProxy(targetUrl);
          if (!response.ok) throw new Error("Network response was not ok");
          await response.json();
          const endTime = performance.now();
          const responseTime = endTime - startTime;

          testResults.push({
            key: site.key,
            name: site.name,
            responseTime,
            isSelected: selectedKeys.includes(site.key),
            api: site.api,
          });
        } catch {
          testResults.push({
            key: site.key,
            name: site.name,
            isSelected: selectedKeys.includes(site.key),
            api: site.api,
          });
        }
      })
    );

    // 测试自定义API站点
    try {
      const parsedCustom = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      // 同名 remote_* 与 hg_* 重复时只显示 hg_*（数据仍留在 localStorage）。
      const customSites: ApiSite[] = hideDuplicateManagedSites(
        Array.isArray(parsedCustom) ? parsedCustom : []
      );
      await Promise.all(
        customSites
          .filter((site: ApiSite) => admin || isAllowedSource(site.key))
          .map(async (site: ApiSite) => {
          const targetUrl = `${site.api}/api.php/provide/vod/?ac=detail&wd=${encodeURIComponent("仙逆")}`;
          const startTime = performance.now();
          try {
            const response = await fetchWithProxy(targetUrl);
            if (!response.ok) throw new Error("Network response was not ok");
            await response.json();
            const endTime = performance.now();
            const responseTime = endTime - startTime;

            testResults.push({
              key: site.key,
              name: site.name,
              responseTime,
              isSelected: selectedKeys.includes(site.key),
              isCustom: true,
              api: site.api,
            });
          } catch {
            testResults.push({
              key: site.key,
              name: site.name,
              isSelected: selectedKeys.includes(site.key),
              isCustom: true,
              api: site.api,
            });
          }
        })
      );
    } catch (error) {
      console.error("Error testing custom sites:", error);
    }

    setSites(testResults);
    setIsTesting(false);
  };

  useEffect(() => {
    testApiResponse();
  }, []);

  const getResponseTimeColor = (responseTime?: number) => {
    if (!responseTime) return "bg-gray-500/20 text-gray-400";
    if (responseTime < 1000) return "bg-green-500/20 text-green-400";
    if (responseTime < 3000) return "bg-yellow-500/20 text-yellow-400";
    return "bg-red-500/20 text-red-400";
  };

  const formatResponseTime = (responseTime?: number) => {
    if (!responseTime) return "未知";
    return `${responseTime.toFixed(0)}ms`;
  };

  const toggleSite = (key: string) => {
    const selectedKeys = getSelectedApiSites();
    const newSelectedKeys = selectedKeys.includes(key) ? selectedKeys.filter((k) => k !== key) : [...selectedKeys, key];

    setSelectedApiSites(newSelectedKeys);
    setSites((prev) =>
      prev.map((site) => ({
        ...site,
        isSelected: newSelectedKeys.includes(site.key),
      }))
    );
  };

  const handleSelectAll = () => {
    const allKeys = sites.map((site) => site.key);
    setSelectedApiSites(allKeys);
    setSites((prev) =>
      prev.map((site) => ({
        ...site,
        isSelected: true,
      }))
    );
  };

  const handleDeselectAll = () => {
    setSelectedApiSites([]);
    setSites((prev) =>
      prev.map((site) => ({
        ...site,
        isSelected: false,
      }))
    );
  };

  const testApi = async (api: string): Promise<boolean> => {
    try {
      const targetUrl = `${api}/api.php/provide/vod/?ac=detail&wd=${encodeURIComponent("仙逆")}`;
      const response = await fetchWithProxy(targetUrl);
      if (!response.ok) return false;
      const data = await response.json();
      return data.code === 1;
    } catch {
      return false;
    }
  };

  const handleAddSite = async () => {
    if (!isAdmin()) {
      setError("只有管理员可以添加源");
      return;
    }
    if (!newSite.name.trim() || !newSite.api.trim()) {
      setError("请填写完整的站点信息");
      return;
    }

    setIsTesting(true);
    setError(null);

    try {
      const isValid = await testApi(newSite.api);
      if (!isValid) {
        setError("API 响应异常，请检查地址是否正确");
        return;
      }

      const key = `custom_${Date.now()}`;
      const newCustomSite: ApiSite = {
        key,
        name: newSite.name.trim(),
        api: newSite.api.trim(),
        isCustom: true,
      };

      const customSites = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      const updatedSites = [...customSites, newCustomSite];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updatedSites));

      setNewSite({ name: "", api: "" });
      setIsAdding(false);
      testApiResponse(); // 重新测试所有站点
    } catch {
      setError("添加站点失败，请稍后重试");
    } finally {
      setIsTesting(false);
    }
  };

  const handleDeleteSite = (key: string) => {
    if (!isAdmin()) return;
    const customSites = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    const updatedSites = customSites.filter((site: ApiSite) => site.key !== key);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updatedSites));

    // 从已选择的站点中移除
    const selectedKeys = getSelectedApiSites();
    if (selectedKeys.includes(key)) {
      setSelectedApiSites(selectedKeys.filter((k) => k !== key));
    }

    testApiResponse(); // 重新测试所有站点
  };

  return (
    <>
      <div className="space-y-4">
        {/* 全选/取消全选 */}
        <div className="flex items-center gap-2">
          <div className="flex flex-1 items-center gap-2">
            <Checkbox
              id="selectAll"
              checked={sites.length > 0 && sites.every((site) => site.isSelected)}
              onCheckedChange={(checked) => {
                if (checked) {
                  handleSelectAll();
                } else {
                  handleDeselectAll();
                }
              }}
            />
            <label htmlFor="selectAll" className="text-sm text-gray-400 cursor-pointer">
              全选/取消全选
            </label>
          </div>
          <div className="flex items-center gap-2">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="icon" onClick={testApiResponse} className="h-8 w-8">
                    <HeartPulse className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="z-[70]">
                  <p>检测接口响应速度</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>

            {isAdmin() && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="outline" size="icon" onClick={() => setIsAdding(true)} className="h-8 w-8">
                      <Plus className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="z-[70]">
                    <p>添加站点</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </div>

        {/* 已启用API数量 */}
        <div className="text-sm text-gray-400">已启用 {getSelectedApiSites().length} 个API</div>

        {/* 站点列表 */}
        <div className="space-y-2">
          {isTesting
            ? // 加载状态骨架屏
              Array.from({ length: 5 }).map((_, index) => (
                <div key={index} className="flex items-center gap-4 p-3 rounded-sm">
                  <Skeleton className="h-10 w-10 rounded-full" />
                  <Skeleton className="h-10 flex-1" />
                </div>
              ))
            : sites.map((site) => (
                <div key={site.key} className="flex items-center bg-accent gap-4 p-3 rounded-sm">
                  <div className="flex-1 flex items-center">
                    <Checkbox id={site.key} checked={getSelectedApiSites().includes(site.key)} onCheckedChange={() => toggleSite(site.key)} className="mr-2" />
                    <a href={site.api} target="_blank" rel="noopener noreferrer" className=" hover:text-blue-400 transition-colors" onClick={(e) => e.stopPropagation()}>
                      {site.name}
                    </a>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs px-2 py-1 rounded-full ${getResponseTimeColor(site.responseTime)}`}>{formatResponseTime(site.responseTime)}</span>
                    {site.isCustom && isAdmin() && (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button onClick={() => handleDeleteSite(site.key)} className="text-gray-400 hover:text-red-500 p-1">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent className="z-[70]">
                            <p>删除站点</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                  </div>
                </div>
              ))}
        </div>
      </div>

      {/* 添加站点对话框 */}
      <Dialog open={isAdding} onOpenChange={setIsAdding}>
        <DialogContent className="fixed z-[100]">
          <DialogHeader>
            <DialogTitle>添加API站点</DialogTitle>
            <DialogDescription className="sr-only">请输入站点名称和API地址</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div className="space-y-2">
              <label className="text-sm text-gray-400">站点名称</label>
              <Input value={newSite.name} onChange={(e) => setNewSite({ ...newSite, name: e.target.value })} placeholder="输入站点名称" />
            </div>
            <div className="space-y-2">
              <label className="text-sm text-gray-400">API地址</label>
              <Input value={newSite.api} onChange={(e) => setNewSite({ ...newSite, api: e.target.value })} placeholder="输入API地址" />
            </div>
            {error && (
              <div className="flex items-center gap-2 text-red-500 text-sm">
                <AlertCircle className="w-4 h-4" />
                <span>{error}</span>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsAdding(false)}>
                取消
              </Button>
              <Button onClick={handleAddSite}>添加</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default ApiSitesList;
