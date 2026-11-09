/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Loaded with Node's require at runtime instead of being bundled.
  serverExternalPackages: ["pg", "@google/genai", "@ai-sdk/mcp", "@electric-sql/pglite"],
  // Don't write an AGENTS.md (notes for AI coding tools) into the project on every `next dev`.
  agentRules: false,
};
export default nextConfig;
