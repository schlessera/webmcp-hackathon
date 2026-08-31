import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { registerWebMcpTools } from "./webmcp.ts";
import "./styles.css";

// Register the static tool surface FIRST, at page load — before any
// authentication or rendering (Gate 1). Tools answer not_authenticated until
// the invite exchange completes; they are never absent.
registerWebMcpTools();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
