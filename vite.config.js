import { defineConfig } from "vite";

export default defineConfig({
  // Cloudflare Pages serves this project from the site root.
  base: "/",
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
