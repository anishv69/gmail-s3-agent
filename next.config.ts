import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pdf-parse", "@napi-rs/canvas"],
  output: "standalone",
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
