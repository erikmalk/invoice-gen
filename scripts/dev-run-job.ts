import { desc, eq } from "drizzle-orm";

import { db } from "../lib/db/client.ts";
import { jobs } from "../lib/db/schema.ts";
import { runJob } from "../lib/jobs/run.ts";

function readJobIdArg() {
  const explicit = process.env.JOB_ID ?? process.argv[2];

  if (!explicit) {
    return null;
  }

  const parsed = Number.parseInt(explicit, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid job id: ${explicit}`);
  }

  return parsed;
}

async function findLatestJobId() {
  const [job] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.kind, "process_inbound_email"))
    .orderBy(desc(jobs.id))
    .limit(1);

  if (!job) {
    throw new Error("No process_inbound_email jobs found. Send a local webhook first.");
  }

  return job.id;
}

async function main() {
  const jobId = readJobIdArg() ?? (await findLatestJobId());
  const result = await runJob(jobId);
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);

  console.log(
    JSON.stringify(
      {
        jobId,
        result,
        job,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("Failed to run dev job.");
  console.error(error);
  process.exit(1);
});
