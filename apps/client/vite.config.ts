import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** In dev, serve /facilitator like the production server does. */
const facilitatorRoute: Plugin = {
  name: "wkwa-facilitator-route",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === "/facilitator" || req.url?.startsWith("/facilitator?")) req.url = "/facilitator.html";
      next();
    });
  },
};

const SERVER = `http://localhost:${process.env.PORT ?? 3000}`;

export default defineConfig({
  plugins: [react(), facilitatorRoute],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rolldownOptions: {
      input: { index: "index.html", facilitator: "facilitator.html" },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // dev server stays on localhost: through the proxy every client would look like "localhost"
    host: "127.0.0.1",
    proxy: {
      "/socket.io": { target: SERVER, ws: true },
      "/api": SERVER,
    },
  },
});
