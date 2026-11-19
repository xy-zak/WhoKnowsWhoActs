import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** In dev, serve /facilitator and /landing (the welcome page) like the production server does. */
const pageRoutes: Plugin = {
  name: "wkwa-page-routes",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      for (const page of ["facilitator", "landing"])
        if (req.url === `/${page}` || req.url?.startsWith(`/${page}?`)) req.url = `/${page}.html`;
      next();
    });
  },
};

const SERVER = `http://localhost:${process.env.PORT ?? 3000}`;

export default defineConfig({
  plugins: [react(), pageRoutes],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rolldownOptions: {
      input: { index: "index.html", facilitator: "facilitator.html", landing: "landing.html" },
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
