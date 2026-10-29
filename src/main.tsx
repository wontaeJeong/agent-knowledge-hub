import React from "react";
import ReactDOM from "react-dom/client";
import { lazy, Suspense } from "react";
import OperationalApp from "./operational/App";
import { isDemoRequested } from "./operational/api";
const DemoApp = lazy(() => import("./App"));
import "./ui/tokens.css";
import "./styles.css";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isDemoRequested(window.location.search) ? (
      <Suspense fallback={<p>데모를 불러오는 중…</p>}>
        <DemoApp />
      </Suspense>
    ) : (
      <OperationalApp />
    )}
  </React.StrictMode>,
);
