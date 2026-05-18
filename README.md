# Invoice Generator

Email-first AI assistant for drafting invoices. The MVP is built around a single-owner workflow: the owner emails an invoice request, the app persists the email thread, runs an OpenAI tool-calling agent, and responds with either a clarification request or a draft invoice for review.

There is intentionally no public product UI right now. The root route returns a 404; the app is operated through email, the inbound webhook, database records, and scripts.

## Stack

- Next.js 15 + TypeScript on Vercel
- Neon Postgres with Drizzle ORM, intended to run through the Vercel integration
- Resend for inbound and outbound email
- OpenAI Responses API for the invoice assistant
- `@react-pdf/renderer` for invoice PDFs

## Current MVP scope

Built:

- Resend inbound webhook at `POST /api/inbound-email`
- Resend webhook signature verification and sender authentication checks
- Owner/user, client, thread, message, job, invoice, line item, and settings tables
- AI agent loop with tools for client lookup, draft invoice management, clarification requests, and owner review emails
- PDF generation and the owner-facing review email attachment path
- Basic tests, type checking, migrations, and seed script

Validated so far:

- Typecheck, unit tests, and production build
- Production Resend webhook signature rejection and real inbound email persistence
- Missing-client flow: the owner receives a clarification email when the requested client is not found

Still to prove or finish:

- No authenticated admin UI yet
- No client-facing invoice sending flow yet
- Client records currently need to be managed directly in Postgres or with future private tooling
- Full seeded-client happy path still needs end-to-end proof: client lookup, invoice and line item creation, totals, review email, and PDF attachment
- Reply/revision/approval semantics are still first-pass/future work
- Job recovery/cron support is not fully wired up yet

## Prerequisites

- Node.js 20+
- pnpm
- Vercel account/project
- Postgres database, preferably via the Vercel Postgres/Neon integration
- Resend account with a verified sending/receiving domain
- OpenAI API key

## Environment variables

Copy `.env.example` to `.env.local` for local development and add the same values to Vercel project environment variables.

```bash
cp .env.example .env.local
```

Required variables:

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Postgres connection URL. Use the Vercel/Neon integration value or create an alias if the integration exposes a different name. |
| `DATABASE_URL_UNPOOLED` | Direct/unpooled Postgres URL for Drizzle migrations and database access. Currently required by env validation. |
| `OPENAI_API_KEY` | OpenAI key used by the assistant. |
| `RESEND_API_KEY` | Resend key for sending email and reading received email payloads. |
| `RESEND_WEBHOOK_SECRET` | Signing secret from the Resend inbound webhook. |
| `EMAIL_FROM_ADDRESS` | Verified sender address on your domain, for example `invoices@example.com`. |
| `EMAIL_FROM_NAME` | Display name for outbound owner emails. |
| `OWNER_EMAIL` | Email address for the owner. The seed script creates/updates this user, and inbound email must come from a known user. |
| `CRON_SECRET` | Required placeholder for planned cron routes. Use a long random value even though cron is not fully wired yet. |

## Resend setup

1. Verify your domain in Resend and configure the required DNS records.
2. Choose the app email address on that domain, such as `invoices@your-domain.com`.
3. Set `EMAIL_FROM_ADDRESS` to that address.
4. Create a Resend API key and set `RESEND_API_KEY`.
5. Configure inbound email in Resend for the domain/address.
6. Add an `email.received` webhook pointing to:

   ```text
   https://<your-vercel-domain>/api/inbound-email
   ```

7. Copy the webhook signing secret into `RESEND_WEBHOOK_SECRET`.

Inbound messages are only accepted when they come through a valid Resend webhook, pass email authentication checks, and match a user in the database.

## Database setup

Install dependencies, run migrations, and seed the initial owner/settings rows:

```bash
pnpm install
pnpm db:migrate
pnpm db:seed
```

After seeding, update the owner profile and add real client records before using the app for actual invoice drafts. The PDF generator uses the owner/client data stored in Postgres. The runtime invoice prompt lives in `settings.invoice_gen_system_prompt`; the source prompt file is only the bootstrap/fallback default.

## Local development

```bash
pnpm dev
```

The app runs at `http://localhost:3000`, but the root page intentionally returns a 404. Most testing happens through the webhook route, database state, and email delivery.

Useful checks:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Useful development scripts:

```bash
pnpm dev:run-job                 # rerun the latest inbound-email job
JOB_ID=<id> pnpm dev:run-job      # rerun a specific job
pnpm dev:export-invoice-pdf       # export the latest invoice PDF to tmp/invoices
pnpm db:update-invoice-gen-prompt # refresh the DB-backed prompt from source
```

## Deployment

This project is configured for Vercel. Git-triggered deployments are disabled in `vercel.json`; use manual Vercel CLI deploys unless you intentionally change that policy.

Preview deploy:

```bash
vercel deploy --yes --scope <your-vercel-scope>
```

Production deploy:

```bash
vercel deploy --prod --yes --scope <your-vercel-scope>
```

Make sure the production Vercel environment has all required environment variables before enabling the Resend webhook.

## License

MIT
