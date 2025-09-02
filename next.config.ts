/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: {
    // กัน build fail ถ้ามี lint error (ยังเตือนใน dev ได้ปกติ)
    ignoreDuringBuilds: true,
  },
  images: {
    domains: ["localhost", "your-domain.com"], // ถ้ามีใช้ next/image
  },
};

export default nextConfig;
