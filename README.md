# invoice-gen

AI-powered invoice generator scaffold built with Next.js 15, TypeScript, App Router, Tailwind, Drizzle, Neon, OpenAI, Resend, and Vercel.

## Phase 0 status

This repository currently contains only Phase 0 bootstrap work: project scaffolding, configuration, environment validation, deployment wiring, and a placeholder landing page.

## Stack

- Next.js 15 (App Router)
- TypeScript
- Tailwind CSS
- ESLint
- Drizzle ORM + drizzle-kit
- Neon Postgres (intended via Vercel integration)
- OpenAI SDK
- Resend
- `@react-pdf/renderer`
- Vercel Functions helpers

## Local development

1. Copy `.env.example` to `.env.local` and fill in values.
2. Install dependencies:
   ```bash
   pnpm install
   ```
3. Start the app:
   ```bash
   pnpm dev
   ```
4. Open http://localhost:3000.

## Scripts

- `pnpm dev` — start the Next.js dev server
- `pnpm build` — production build
- `pnpm start` — start the production server
- `pnpm lint` — run ESLint
- `pnpm typecheck` — run TypeScript checks
- `pnpm db:generate` — generate Drizzle migrations
- `pnpm db:check` — validate Drizzle configuration / migrations state

## Environment variables

See `.env.example` for the full list required by the current scaffold.

## Self-host setup checklist

### Phase 0 — Project bootstrap
- [x] Next.js app scaffolded
- [x] Tailwind and ESLint configured
- [x] Drizzle config added
- [x] Env validation added
- [x] Placeholder landing page added
- [ ] Neon integration values populated
- [ ] Production env vars fully configured

### Phase 1 — Database schema & migrations
- [ ] Planned

### Phase 2 — Email provider abstraction
- [ ] Planned

### Phase 3 — Inbound email webhook + job enqueue
- [ ] Planned

### Phase 4 — Tools & PDF generation
- [ ] Planned

### Phase 5a — Agent loop (synchronous, no email glue yet)
- [ ] Planned

### Phase 5b — Approval/revision loop over email
- [ ] Planned

### Phase 6 — Reliability, cron retries, observability
- [ ] Planned

### Phase 7 — Minimal admin UI
- [ ] Planned

## Deployment notes

- Vercel project name: `invoice-gen`
- Repo name: `invoice-gen`
- Git-triggered deploys are currently enabled per user-approved Phase 0 override.
- A manual `vercel deploy --yes` preview deploy should still be used to confirm the bootstrap works.

## License

MIT
