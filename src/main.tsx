import React from "react";
import ReactDOM from "react-dom/client";
import { lazy, Suspense, useEffect } from "react";
import LandingPage from "./landing/LandingPage";
import { entryMode } from "./entry";
import { watchBrandFavicon } from "./ui/brand-favicon";
const OperationalApp = lazy(() => import("./operational/App"));
const DemoApp = lazy(() => import("./App"));
import "./ui/tokens.css";
import "./styles.css";
// Restore the selected theme for the operational view, which has no toggle yet.
try {
  const savedTheme = localStorage.getItem("agent-knowledge-hub.theme");
  if (savedTheme === "light" || savedTheme === "dark") {
    document.documentElement.dataset.theme = savedTheme;
  }
} catch {
  // Rendering must continue if browser storage is disabled.
}

function BrandFaviconSync() {
  useEffect(watchBrandFavicon, []);
  return null;
}

const mode = entryMode(window.location.search);
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrandFaviconSync />
    <Suspense fallback={<p role="status">지식 공간을 불러오는 중…</p>}>
      {mode === "demo" ? (
        <DemoApp />
      ) : mode === "workspace" ? (
        <OperationalApp />
      ) : (
        <LandingPage />
      )}
    </Suspense>
  </React.StrictMode>,
);
