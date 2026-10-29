import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // StreetScan reads SQLite and streams SSE on every route - there is nothing
  // here to prerender, and cacheComponents rejects the route-level `runtime`
  // and `dynamic` opt-outs this app needs.
  cacheComponents: false,
  // exiftool-vendored locates its bundled binary from its own __dirname.
  // Bundling it into .next rewrites that path to .next/server, so
  // exiftoolPath() throws "Failed to find ExifTool installation" at runtime -
  // which surfaced as a silent "no GPS in file".
  serverExternalPackages: ['exiftool-vendored'],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
