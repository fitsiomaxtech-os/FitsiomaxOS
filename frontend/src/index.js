import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import App from "@/App";
import { ThemeProvider } from "next-themes";
import { applyTheme, effectiveMode, loadCachedSetting, loadUserChoice } from "@/lib/theme";
import { loadSession } from "@/lib/session";

// The last theme heard, painted before React mounts, so a Dark screen never flashes white.
const cachedTheme = loadCachedSetting();
applyTheme(effectiveMode(cachedTheme, loadUserChoice(loadSession()?.user?.id)), cachedTheme.custom);

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <ThemeProvider attribute="class" defaultTheme="light" forcedTheme="light" enableSystem={false}>
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
