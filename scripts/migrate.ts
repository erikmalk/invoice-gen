import { migrate } from "drizzle-orm/neon-serverless/migrator";

import { db } from "../lib/db/client.ts";

async function main() {
  await migrate(db, {
    migrationsFolder: "./lib/db/migrations",
  });

  console.log("Database migrations applied successfully.");
}

main().catch((error) => {
  console.error("Failed to apply database migrations.");
  console.error(error);
  process.exit(1);
});
