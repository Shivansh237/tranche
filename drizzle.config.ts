import { loadEnvConfig } from "@next/env";
import { defineConfig } from "drizzle-kit";
import { normalizeDatabaseUrl } from "./src/db/url";

// Read .env.local / .env exactly like Next.js does.
loadEnvConfig(process.cwd());

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: normalizeDatabaseUrl(process.env.DATABASE_URL ?? "postgres://localhost:5432/tranche") },
  strict: true,
});
