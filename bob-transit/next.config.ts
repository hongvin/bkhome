import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // ONE deployment: UI + API routes in a single Next.js process.
  // No separate backend server, by design.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
