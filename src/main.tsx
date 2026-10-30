import React from "react";
import ReactDOM from "react-dom/client";
import { lazy, Suspense } from "react";
import LandingPage from "./landing/LandingPage";
import { entryMode } from "./entry";
const OperationalApp = lazy(() => import("./operational/App"));
const DemoApp = lazy(() => import("./App"));
import "./ui/tokens.css";
import "./styles.css";
const mode = entryMode(window.location.search);
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Suspense fallback={<p role="status">지식 공간을 불러오는 중…</p>}>
      {mode === "demo" ? (
        <DemoApp />
      ) : mode === "workspace" || mode === "preview" ? (
        <OperationalApp preview={mode === "preview"} />
      ) : (
        <LandingPage />
      )}
    </Suspense>
  </React.StrictMode>,
);
