import SourceHome from "./components/source-home";

export default function App() {
  return (
    <div className="min-h-screen bg-background">
      {/* Hero Banner区域 */}
      <section className="hidden md:block bg-gradient-to-r from-primary/10 via-primary/5 to-secondary/10 py-16">
        <div className="container mx-auto px-4">
          <div className="max-w-4xl mx-auto text-center">
            <h1 className="text-5xl font-bold mb-6 bg-gradient-to-r from-primary to-primary/80 bg-clip-text text-transparent">
              发现精彩影视内容
            </h1>
            <p className="text-xl text-muted-foreground mb-8">
              基于采集站和网站资源站的全网影视资源搜索平台，为您提供最新最全的影视资源
            </p>
            <div className="flex flex-wrap justify-center gap-4 text-sm">
              <div className="flex items-center gap-2 bg-background/80 backdrop-blur rounded-full px-4 py-2 border border-border/30">
                <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                <span>实时更新</span>
              </div>
              <div className="flex items-center gap-2 bg-background/80 backdrop-blur rounded-full px-4 py-2 border border-border/30">
                <div className="w-2 h-2 bg-blue-500 rounded-full"></div>
                <span>多源聚合</span>
              </div>
              <div className="flex items-center gap-2 bg-background/80 backdrop-blur rounded-full px-4 py-2 border border-border/30">
                <div className="w-2 h-2 bg-purple-500 rounded-full"></div>
                <span>高清资源</span>
              </div>
              <div className="flex items-center gap-2 bg-background/80 backdrop-blur rounded-full px-4 py-2 border border-border/30">
                <div className="w-2 h-2 bg-orange-500 rounded-full"></div>
                <span>免费观看</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 主要内容 */}
      <div className="container mx-auto px-4 py-8">
        {/* <DoubanRecommendation /> */}
        <SourceHome />
      </div>
    </div>
  );
}
