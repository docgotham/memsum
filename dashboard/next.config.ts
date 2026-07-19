import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The monorepo keeps a second lockfile at the repo root (the kernel's), so
  // Turbopack must be pinned to this directory. Without it, the workspace root
  // is inferred as the repo root and the Vercel build emits its output relative
  // to the wrong directory — a "Ready" deployment that 404s on every route.
  turbopack: {
    root: path.join(__dirname),
  },
  // /pricing became /beta (2026-07-19): the page describes the beta and its
  // limits, and deliberately says nothing about money. Permanent, so old
  // links keep landing somewhere true.
  async redirects() {
    return [{ source: "/pricing", destination: "/beta", permanent: true }];
  },
};

export default nextConfig;
