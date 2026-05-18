# Invoice Generator — Current Architecture & Next Steps

_Last updated: 2026-05-10_

This is the short handoff guide for resuming work on `invoice-gen`. For exhaustive historical detail, see `docs/plans/invoice-generator-core-app.md`.

## What this app does

`invoice-gen` is an email-first AI invoice assistant. The owner emails an informal invoice request to:

```text
invoice-gen@example.com
```

The app receives the email through Resend, persists the thread/message/job in Neon Postgres, runs an OpenAI-powered agent, uses tools to look up clients and draft invoices, then emails the owner back for clarification or review.

## Providers and deployed resources

- **Production app:** `https://invoice-gen-alpha-neon.vercel.app`
- **Hosting/runtime:** Vercel, Next.js App Router
- **Deploy policy:** manual Vercel CLI deploys only. Git-triggered deploys are disabled in `vercel.json`.
- **Database:** Neon Postgres through the Vercel/Neon integration
- **ORM:** Drizzle
- **Email:** Resend
  - Receiving domain: `example.com`
  - Bot address: `invoice-gen@example.com`
  - Webhook: `email.received` → `/api/inbound-email`
- **LLM:** OpenAI through the Responses API adapter
- **Prompt source of truth:** `settings.invoice_gen_system_prompt` in the database
  - `lib/agent/default-prompts.ts` is only a bootstrap/fallback default.

## Current request flow

1. Owner sends email to `invoice-gen@example.com`.
2. Resend receives it and fires an `email.received` webhook.
3. `POST /api/inbound-email`:
   - verifies the Resend/Svix signature,
   - parses the inbound email,
   - checks the sender against `users.email`,
   - finds or creates a thread,
   - stores the inbound message,
   - enqueues a `process_inbound_email` job,
   - starts `runJob(jobId)` with Vercel `waitUntil`.
4. `lib/jobs/run.ts` dispatches the job to `runAgentLoop(threadId)`.
5. `lib/agent/loop.ts` builds LLM context from both:
   - `threads.subject`, and
   - `messages.content`.
6. The agent calls OpenAI Responses API with registered tools.
7. Tool calls and results are persisted as `messages` rows.
8. Terminal tools stop the current run and send an email back to the owner.

## Important code map

- `app/api/inbound-email/route.ts` — Next.js route export.
- `app/api/inbound-email/handler.ts` — webhook business logic and test seam.
- `lib/email/resend.ts` — Resend send/receive/signature parsing.
- `lib/email/threading.ts` — entry-point detection and email-thread matching.
- `lib/jobs/run.ts` — job dispatcher/status transitions.
- `lib/agent/loop.ts` — agent loop and LLM context construction.
- `lib/agent/personas.ts` — loads model/limits/prompt settings.
- `lib/agent/default-prompts.ts` — bootstrap fallback prompt.
- `lib/llm/openai.ts` — OpenAI Responses API adapter.
- `lib/tools/*` — invoice/client/email tool implementations.
- `lib/invoices/numbering.ts` — invoice number generation.
- `lib/invoices/pdf.ts` — current `@react-pdf/renderer` invoice PDF renderer. Durable Blob/object storage is still deferred.
- `scripts/dev-run-job.ts` — local runner for retrying/debugging DB jobs.
- `scripts/dev-send-email.ts` — local signed webhook simulator.
- `scripts/seed.ts` — owner/settings seed script.

## Database tables in use

- `users` — owner identity/profile.
- `clients` — invoice clients; currently managed manually through Neon or future scripts/UI.
- `threads` — email conversation roots, subject, entry point, status.
- `messages` — user/assistant/tool history. User message content stores the email body.
- `jobs` — background work queue/status.
- `invoices` and `line_items` — draft invoice data.
- `settings` — model/config/prompt settings.

## Tests and validations already completed

- Typecheck passes: `pnpm typecheck`.
- Unit tests pass: `pnpm test`.
- Production build passes: `pnpm build`.
- Real OpenAI Responses API smoke test passed behind env flag.
- Resend DNS/receiving is working for `example.com`.
- Resend webhook delivery to production succeeds with HTTP `200`.
- Unsigned/fake production webhook POST returns HTTP `401`.
- Real inbound emails persist to Neon as `threads`, `messages`, and `jobs`.
- Missing-client real-world test passed:
  - request for non-existent `Fable Co`,
  - local `pnpm dev:run-job` retried the failed job,
  - owner received a clarification email.
- DB-backed prompt setting is seeded and verified.
- Recent production deployments have been manually inspected as Ready after manual Vercel CLI deploys.

## Not yet fully tested

- Full happy path with a real seeded client:
  - client lookup,
  - invoice creation,
  - line item creation,
  - totals,
  - owner review email.
- Reply/revision flow after a draft has been sent for review.
- Approval flow beyond the current first-pass design.
- Non-review-email attachments / inbound attachment handling.
- Durable PDF storage/linking beyond the current generated attachment buffer.
- Cron recovery for stuck/pending jobs.
- Admin/client management UI and auth.

## Recommended next phases

### Phase A — Prove seeded-client invoice generation

1. Add a real test client record, probably `Fable Co`, for `user_id = 1`.
2. Send a real email:
   ```text
   To: invoice-gen@example.com
   Subject: test invoice
   Body: Please generate a $100 invoice for Fable Co for services rendered. Due in 20 days.
   ```
3. Verify Neon rows:
   - `threads` has the new subject,
   - `messages` has body plus assistant/tool history,
   - `jobs.status = done`,
   - `invoices` has a draft invoice,
   - `line_items` has correct amount/description.
4. Verify owner receives the review email.
5. If it fails, inspect `jobs.last_error`, fix locally, and rerun with:
   ```bash
   pnpm dev:run-job
   # or
   JOB_ID=<id> pnpm dev:run-job
   ```

### Phase B — Button up the core agent behavior

- Tune `settings.invoice_gen_system_prompt` based on the seeded-client test.
- Ensure subject and body are always both included in agent context.
- Harden tool schemas/descriptions so the model reliably:
  - searches clients first,
  - asks clarification when ambiguous,
  - converts dollar amounts to cents,
  - creates sensible line items,
  - sends review after draft creation.
- Add tests for happy path, ambiguity, and tool errors.

### Phase C — Add job recovery

- Implement `app/api/cron/retry-stuck/route.ts`.
- Protect it with `CRON_SECRET`.
- Add Vercel cron config.
- Reclaim pending and stale running jobs.
- Add tests for retry/stale-job behavior.

### Phase D — Durable invoice PDF storage

- Decide storage, likely Vercel Blob for v1.
- Store a durable `pdf_blob_key`/URL instead of regenerating/attaching directly from a buffer.
- Attach or link the stored PDF in the owner review email.

### Phase E — Reply, revision, and approval flow

- Decide exact v1 approval semantics.
- Add/extend tool actions if needed, e.g. `approve` or `void`.
- Test owner replies like:
  - `approved`,
  - `change the description`,
  - `make it $125 instead`.
- Keep the important convention: do not call the LLM again after sending a terminal review/clarification email until the owner replies.

### Phase F — Admin/client management with auth

Do not build a public production admin panel without auth.

Recommended path:

1. Use WorkOS because it is already used in other projects.
2. Add protected admin routes only after the auth/session story is settled.
3. Admin UI should eventually support:
   - managing clients,
   - viewing invoices/line items,
   - inspecting threads/messages/jobs,
   - editing `settings.invoice_gen_system_prompt`,
   - replaying/debugging failed jobs.

Short-term, use Neon Console or a private script to seed clients for testing.

## Useful commands

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm db:seed
pnpm dev:run-job
JOB_ID=<id> pnpm dev:run-job
pnpm dev:send-email
```

Manual deployment:

```bash
vercel deploy --prod --yes --scope <your-vercel-scope>
vercel inspect invoice-gen-alpha-neon.vercel.app --scope <your-vercel-scope>
```

Real OpenAI smoke test:

```bash
RUN_OPENAI_SMOKE_TEST=1 node --env-file-if-exists=.env --env-file-if-exists=.env.local --test lib/llm/openai.smoke.test.ts
```

## Things not to forget

- Manual Vercel deploys only; do not rely on Git auto-deploy.
- The DB setting is the real prompt; do not reintroduce a second runtime prompt file.
- Local job runs may mutate whichever DB `.env.local` points at.
- The seeded-client invoice path is the next critical proof point.
- WorkOS/auth should come before any production admin UI.
