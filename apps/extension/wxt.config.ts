import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "AI Manager",
    description: "Captures your AI conversations into your unified AI Manager workspace.",
    // Minimal permissions. Host access for AI sites comes from each content script's `matches`;
    // the backend origin is the only other host. No tabs/cookies/webRequest/history.
    permissions: ["storage", "alarms"],
    host_permissions: ["http://localhost:3001/*"],
  },
});
