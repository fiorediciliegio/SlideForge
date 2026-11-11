import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    strictPort: true,
    proxy: {
      "/decks": "http://127.0.0.1:8080",
      "/files": "http://127.0.0.1:8080",
    },
  },
});
