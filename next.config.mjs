/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: { serverActions: { bodySizeLimit: '2mb' } },
  images: { remotePatterns: [{ protocol: 'https', hostname: '**.supabase.co' }] },
};
export default nextConfig;
