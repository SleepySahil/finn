/** @type {import('next').NextConfig} */
const nextConfig = {
  // API routes read the committed snapshot from disk; make sure it ships with the functions.
  outputFileTracingIncludes: { '/api/**': ['./public/snapshot/**/*'] },
  serverExternalPackages: ['unpdf'],
};
export default nextConfig;
