import { eq } from "drizzle-orm";

import { db } from "../db/client.ts";
import { jobs } from "../db/schema.ts";

export async function runJob(jobId: number) {
  await db
    .update(jobs)
    .set({
      status: "running",
      attempts: 1,
      startedAt: new Date(),
      updatedAt: new Date(),
      lastError: null,
    })
    .where(eq(jobs.id, jobId));
}
