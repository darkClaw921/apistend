import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Пакеты воркспейса отдаются как TypeScript-исходники — Next их транспилирует сам.
  transpilePackages: ['@apistend/ui', '@apistend/shared'],
  typedRoutes: true,
}

export default nextConfig
