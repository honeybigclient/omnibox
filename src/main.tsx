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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
    <RouterProvider router={router} />
  </ThemeProvider>
);
