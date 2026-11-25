import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  // Order matters: "/sapi/v1/meme" is also a prefix of "/sapi/v1/meme-account".
  const proxy = {
    "/sapi/v1/meme-account": { target: env.MEME_ACCOUNT_UPSTREAM ?? "http://127.0.0.1:3016" },
    "/sapi/v1/meme": { target: env.MEME_API_UPSTREAM ?? "http://127.0.0.1:3000", ws: true },
    // AZ web3 login for treasury mode; the AZ JWT it returns is what quotes and trades require.
    "/uaapi": { target: env.AZ_API_UPSTREAM ?? "https://app.az-qa.xyz", changeOrigin: true },
  };
  return {
    plugins: [react()],
    server: { port: 5173, strictPort: true, proxy },
    preview: {
      port: 4173,
      strictPort: true,
      proxy,
    },
    test: {
      environment: "jsdom",
      setupFiles: "./src/test-setup.ts",
      css: true,
      env: {
        VITE_MEME_API_BASE_URL: "http://127.0.0.1:3000",
        VITE_MEME_WS_URL: "ws://127.0.0.1:3000/sapi/v1/meme/stream",
      },
    },
  };
});
