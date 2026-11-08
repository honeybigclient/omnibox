import React, { useState } from "react";
import { Settings, Server, Database, Bot, Archive, Link, Menu, Palette } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider } from "@/components/ui/sidebar";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import ApiSitesList from "@/components/api-sites-list";
import ProxySettings from "@/components/proxy-settings";
import AIModelSettings from "@/components/ai-model-settings";
import CloudDriveSettings from "@/components/cloud-drive-settings";
import DataManagement from "@/components/data-management";
import OnlineParserSettings from "@/components/online-parser-settings";
import AppearanceSettings from "@/components/appearance-settings";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const menuItems = [
  { key: "appearance", icon: <Palette className="w-4 h-4" />, label: "外观设置" },
  { key: "proxy", icon: <Settings className="w-4 h-4" />, label: "代理设置" },
  { key: "site", icon: <Server className="w-4 h-4" />, label: "采集站点" },
  { key: "parser", icon: <Link className="w-4 h-4" />, label: "在线解析" },
  { key: "ai", icon: <Bot className="w-4 h-4" />, label: "模型服务" },
  { key: "drive", icon: <Archive className="w-4 h-4" />, label: "网盘资源" },
  { key: "data", icon: <Database className="w-4 h-4" />, label: "数据管理" },
];

const SettingsDialog: React.FC<SettingsDialogProps> = ({ open, onOpenChange }) => {
  const [activeKey, setActiveKey] = useState("appearance");
  const [sheetOpen, setSheetOpen] = useState(false);

  const handleMenuClick = (key: string) => {
    setActiveKey(key);
    setSheetOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] overflow-hidden p-0 md:max-h-[650px] md:max-w-[700px] lg:max-w-[1000px] z-70">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">Customize your settings here.</DialogDescription>
        <SidebarProvider className="min-h-0 w-full items-start">
          {/* 桌面端侧边栏 */}
          <Sidebar collapsible="none" className="hidden md:flex border">
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {menuItems.map((item) => (
                      <SidebarMenuItem key={item.key}>
                        <SidebarMenuButton size="lg" asChild isActive={activeKey === item.key}>
                          <a className="cursor-pointer" onClick={() => setActiveKey(item.key)}>
                            {item.icon}
                            <span>{item.label}</span>
                          </a>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>

          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 transition-[width,height] ease-linear group-has-[[data-collapsible=icon]]/sidebar-wrapper:h-12 md:h-16 md:px-4">
              <div className="flex items-center gap-2">
                {/* 移动端汉堡包菜单 */}
                <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
                  <SheetTrigger asChild>
                    <Button variant="ghost" size="icon" className="md:hidden">
                      <Menu className="h-5 w-5" />
                    </Button>
                  </SheetTrigger>
                  <SheetContent side="left" className="w-[240px] p-0 z-100">
                    <div className="flex flex-col h-full">
                      <div className="p-4 border-b">
                        <h2 className="text-lg font-semibold">设置菜单</h2>
                      </div>
                      <ScrollArea className="flex-1">
                        <div className="p-2">
                          {menuItems.map((item) => (
                            <button
                              key={item.key}
                              className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm ${
                                activeKey === item.key
                                  ? "bg-primary/10 text-primary"
                                  : "hover:bg-accent hover:text-accent-foreground"
                              }`}
                              onClick={() => handleMenuClick(item.key)}
                            >
                              {item.icon}
                              <span>{item.label}</span>
                            </button>
                          ))}
                        </div>
                      </ScrollArea>
                    </div>
                  </SheetContent>
                </Sheet>
                <span>系统设置</span>
              </div>
            </header>

            <ScrollArea className="h-[calc(100dvh-5.5rem)] w-full min-w-0 p-3 md:h-[580px] md:p-4">
             {activeKey === "appearance" && <AppearanceSettings />} 
              {activeKey === "proxy" && <ProxySettings />}
              {activeKey === "site" && <ApiSitesList />}
              {activeKey === "parser" && <OnlineParserSettings />}
              {activeKey === "data" && <DataManagement />}
              {activeKey === "ai" && <AIModelSettings />}
              {activeKey === "drive" && <CloudDriveSettings />}
         
            </ScrollArea>
          </main>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  );
};

export default SettingsDialog;
