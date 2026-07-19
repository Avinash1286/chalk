/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Allow an isolated build dir (e.g. a second dev server) via env, so two
  // `next dev` instances don't clash on the same .next directory.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
