import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

/**
 * Mirrors proxy-alpha/webui so the two front ends stay one codebase in two
 * places rather than two dialects. Two things differ, and both follow from this
 * being a microservice rather than the platform itself.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The Node server serves this bundle from /admin/, not from the document
  // root. Without this every emitted asset URL is /assets/… — absolute from a
  // root that serves nothing — and the page loads a blank body with two 404s.
  base: "/admin/",
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    // 5173 and 5174 both belong to the platform (webui and web); this dev server
    // has to sit beside them, not on top of one.
    port: 5175,
    strictPort: true,
    // The admin API is same-origin in production — the Node server serves this
    // bundle itself. In `vite dev` it is not, so proxy rather than widen CORS:
    // the server never has to know a browser reached it from another port.
    proxy: {
      "/admin/api": {
        target: "https://127.0.0.1:9443",
        changeOrigin: true,
        secure: false, // the dev certificate is self-signed by design.
      },
    },
  },
  build: {
    // A directory of this build's own, NOT public/admin.
    //
    // public/admin holds the previous UI, which still ships at /admin/legacy.html because it
    // is the only screen that has been ported everywhere. Building into it with emptyOutDir
    // deleted app.js, api.js, login.js, login.html and styles.css — an ordinary `npm run
    // build` destroying five tracked files, recoverable only from a previously built image.
    //
    // The Dockerfile merges the two, moving the previous UI aside and copying it back around
    // this output, which is why the image was never wrong and only the working tree suffered.
    outDir: "../public/.admin-build",
    emptyOutDir: true,
    sourcemap: true,
  },
});
