import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { DATABASE_URL } from "../config.js";
import * as schema from "./schema.js";

if (!DATABASE_URL) {
  console.warn("[Database] DATABASE_URL is not set in environment!");
}

const queryClient = postgres(DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  ssl: DATABASE_URL.includes("sslmode=require") ? "require" : undefined,
});

export const db = drizzle(queryClient, { schema });
export { schema };

