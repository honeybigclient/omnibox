import { Outlet, useNavigate } from "react-router-dom";
import { Settings, History } from "lucide-react";
import { useState, useEffect } from "react";

import SettingsDialog from "@/components/settings-dialog";
import InitDialog from "@/components/init-dialog";
import { Button } from "@/components/ui/button";
import { ArrowUp } from "lucide-react";
import { SearchForm } from "@/components/search-form";
import { Link } from "react-router-dom";
import { RouterUtils } from "@/utils/router";
import { Toaster } from "@/components/ui/sonner";
import logo from "@/assets/logo.png";

export default function MainLayout() {
  const navigate = useNavigate();
  const [showBackToTop, setShowBackToTop] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showInitDialog, setShowInitDialog] = useState(false);

  // 注入访问统计代码
  useEffect(() => {
    const analyticsScript = localStorage.getItem("ANALYTICS_SCRIPT");
    if (analyticsScript) {
      try {
        // 创建临时div来解析script标签
        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = analyticsScript;
        const scriptTag = tempDiv.querySelector("script");

        if (scriptTag) {
          // 创建新的script元素
          const script = document.createElement("script");

          // 复制所有属性
          Array.from(scriptTag.attributes).forEach((attr) => {
            script.setAttribute(attr.name, attr.value);
          });

          // 添加到document中
          document.head.appendChild(script);
        }
      } catch (error) {
        console.error("Failed to inject analytics script:", error);
      }
    }
  }, []);

  // 检查系统初始化状态
  useEffect(() => {
    const proxyBaseUrl = localStorage.getItem("PROXY_BASE_URL");
    if (!proxyBaseUrl) {
      setShowInitDialog(true);
    }
  }, []);

  // 初始化路由工具
  useEffect(() => {
    RouterUtils.init(navigate);
  }, [navigate]);

  // 监听滚动事件
  useEffect(() => {
    const handleScroll = () => {
      setShowBackToTop(window.scrollY > 300);
    };

    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  // 处理返回顶部
  const handleBackToTop = () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="fixed top-0 left-0 right-0 z-50 border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto px-4 py-3">
          <div className="flex items-center justify-between md:gap-6">
            <Link to="/" className="flex flex-shrink-0 items-center gap-2">
              <img
                src={logo}
                alt="影视资源站"
                className="h-9 w-9 rounded-full object-cover ring-1 ring-border/50"
              />
              <span className="hidden text-xl font-bold text-primary md:block">
                影视资源站
              </span>
            </Link>

            <div className="flex-1 max-w-2xl mx-2">
              <SearchForm />
            </div>

            <div className="flex items-center gap-2">
              {/* 导航菜单 */}
              <nav className="hidden md:flex items-center gap-1">
                <Link to="/">
                  <Button variant="ghost" size="sm" className="text-sm font-medium hover:bg-muted/80">
                    首页
                  </Button>
                </Link>
                <Link to="/history">
                  <Button variant="ghost" size="sm" className="text-sm font-medium hover:bg-muted/80">
                    观看历史
                  </Button>
                </Link>
                <Button variant="ghost" size="sm" className="text-sm font-medium hover:bg-muted/80" onClick={() => setShowSettings(true)}>
                  设置
                </Button>
              </nav>


              {/* 分隔线 */}
           

              {/* 主题切换按钮 */}
              {/* {mounted && (
                <Button variant="ghost" size="icon" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} className="hover:bg-muted/80 transition-colors">
                  {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                </Button>
              )} */}

              {/* 设置按钮（移动端） */}
             
              <Button variant="ghost" size="icon" className="md:hidden hover:bg-muted/80" onClick={() => navigate('/history')}>
                <History className="w-5 h-5" />
              </Button>
               <Button variant="ghost" size="icon" className="md:hidden hover:bg-muted/80" onClick={() => setShowSettings(true)}>
                <Settings className="w-5 h-5" />
              </Button>
            </div>
          </div>
        </div>
      </header>

      {/* 顶部占位空间 */}
      <div className="h-[56px]" />

      <main>
        <Outlet />
      </main>

      {/* 页脚 */}
      <footer className="hidden md:block  bg-muted/30 mt-16 border-t border-border/30">
        <div className="container mx-auto px-4 py-8">
          <div className=" grid grid-cols-1 md:grid-cols-4 gap-8">
            <div>
              <h3 className="font-semibold mb-4">影视资源站</h3>
              <p className="text-sm text-muted-foreground">基于采集站和网盘资源站的全网影视资源搜索平台</p>
            </div>
            <div>
              <h4 className="font-medium mb-4">功能</h4>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li>影视搜索</li>
                <li>网盘资源</li>
                <li>观看历史</li>
                <li>搜索历史</li>
              </ul>
            </div>
            <div>
              <h4 className="font-medium mb-4">资源类型</h4>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li>电影资源</li>
                <li>电视剧资源</li>
                <li>动漫资源</li>
                <li>综艺资源</li>
              </ul>
            </div>
            <div>
              <h4 className="font-medium mb-4">支持平台</h4>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li>阿里云盘</li>
                <li>115网盘</li>
                <li>百度网盘</li>
                <li>夸克网盘</li>
              </ul>
            </div>
          </div>
          <div className="border-t border-border/30 mt-8 pt-8 text-center text-sm text-muted-foreground">
            <p>&copy; 2024 影视资源站. 所有权利保留.</p>
          </div>
        </div>
      </footer>
      {/* 返回顶部按钮 */}
      {showBackToTop && (
        <Button
          onClick={handleBackToTop}
          size="icon"
          className="fixed bottom-6 right-6 z-50 rounded-full shadow-lg hover:shadow-xl transition-all duration-300 bg-primary hover:bg-primary/90">
          <ArrowUp className="w-5 h-5" />
        </Button>
      )}

      {/* <PlayHistorySidebar open={showHistory} onOpenChange={setShowHistory} /> */}
      <SettingsDialog open={showSettings} onOpenChange={setShowSettings} />
      <InitDialog open={showInitDialog} onOpenChange={setShowInitDialog} />
      <Toaster />
    </div>
  );
}
