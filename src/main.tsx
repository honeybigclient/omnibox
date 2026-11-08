import ReactDOM from "react-dom/client";
import { createHashRouter, RouterProvider } from "react-router-dom";
import { ThemeProvider } from "@/components/theme-provider";

import MainLayout from "@/layouts/main-layout";
import App from "@/App";
import SearchResultsPage from "@/pages/search-results-page";
import "./index.css";
import PlayerPage from "./pages/player-page.tsx";
import SimplePlayerPage from "./pages/simple-player-page.tsx";
import HistoryPage from "./pages/history-page.tsx";
import OnlinePlayerPage from "./pages/online-player-page.tsx";
import AISpeedTestPage from "./pages/ai-speed-test-page.tsx";
import AdminPage from "./pages/admin-page.tsx";
import { refreshRemoteApiSites } from "@/config/remoteSources";

const router = createHashRouter([
  {
    path: "/",
    element: <MainLayout />,
    children: [
      {
        index: true,
        element: <App />,
      },
      {
        path: "search",
        element: <SearchResultsPage />,
      },
      {
        path: "play",
        element: <PlayerPage />,
      },
      {
        path: "simple-play",
        element: <SimplePlayerPage />,
      },
      {
        path: "online-play",
        element: <OnlinePlayerPage />,
      },
      {
        path: "history",
        element: <HistoryPage />,
      },
      {
        path: "ai-speed-test",
        element: <AISpeedTestPage />,
      },
      {
        path: "admin",
        element: <AdminPage />,
      },
    ],
  },
]);

// 后台刷新上游远程源，不阻塞首屏渲染
refreshRemoteApiSites().catch((error) => {
  console.warn("刷新远程采集站失败:", error);
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
    <RouterProvider router={router} />
  </ThemeProvider>
);
