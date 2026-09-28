import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // ONE deployment: UI + API routes in a single Next.js process.
  // No separate backend server, by design.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  eslint: { ignoreDuringBuilds: true },
  // There is a stray package-lock.json in a parent directory, which makes Next
  // infer the wrong workspace root. Pin it to this project explicitly.
  outputFileTracingRoot: projectRoot,
};

export default nextConfig;
