# Invoice Generator — Core App Plan

> **Status:** Implementation in progress. Phases 0–3 are complete, Phase 4 is partially implemented, Phase 5a/5b have a working first pass, and production email ingestion + agent response has been validated. This document remains the exhaustive original plan, but for a concise current handoff see `docs/current-architecture-and-next-steps.md`.

---

## 1. What we're building

An AI-powered invoice generator that operates primarily over email.

**Happy path:**

1. A small-business owner (the "user" / "owner") emails `invoice-gen@example.com` with an informal request ("Need to invoice Fable Co for last week's wig fitting, $200 + $25 kit fee").
2. An inbound webhook persists the email and kicks off an agent loop.
3. The agent uses tools to look up the client, draft an invoice record in the database, render it to PDF, and email the draft back to the owner for review.
4. The owner replies with "approved" (or a change request). The agent either marks the invoice approved in the DB and optionally forwards to the client, or revises and loops again.

Multiple entry-point addresses (e.g. `invoice-gen@`, `expense-report@`) may exist over time, each binding the same underlying agent to a different system prompt and tool subset.

**Reference sketch (rough concept, not the committed design):**
`/path/to/reference-image.png`

### Scope for this plan
- Single agent, email-only I/O, invoice generation and revision
- Draft → approved status flow, PDF export, email delivery
- Single-user (auth == inbound email identity match)
- Foundation that can grow into multi-user, multi-persona, Stripe payments, web UI

### Current implementation status snapshot

- Production app is deployed manually to Vercel at `invoice-gen-alpha-neon.vercel.app`.
- Git-triggered Vercel auto-deploys are disabled; use `vercel deploy --prod --yes --scope example-team` and verify status after deploy.
- Resend custom receiving domain is `example.com`; active bot address is `invoice-gen@example.com`.
- Resend webhook is configured for `email.received` to `https://invoice-gen-alpha-neon.vercel.app/api/inbound-email`.
- Neon/Drizzle schema and migrations are applied; owner user is seeded from `OWNER_EMAIL`.
- Inbound email signature verification has been proven: unsigned production POSTs return `401`.
- Inbound email ingestion has been proven end-to-end: Resend → Vercel webhook → Neon `threads/messages/jobs`.
- Agent execution has a working first pass: OpenAI Responses API, DB-backed prompt, tool calls, terminal tool behavior, and job dispatch.
- Missing-client clarification has been proven end-to-end: a real request for non-existent "Fable Co" generated an email asking for client details.
- Full invoice draft creation with a seeded client record still needs an end-to-end test and likely troubleshooting/polish.

### Non-goals (for now)
- Web-based chat UI (may add later)
- Authentication beyond email-identity matching (WorkOS planned later)
- Stripe integration (schema reserves fields; no code yet)
- Expense reports (schema/entry-point design must not preclude it; not implemented)
- Multi-tenant hosting as a service

---

## 2. Key design decisions (already made — do not relitigate)

| Decision | Choice | Rationale |
|---|---|---|
| Agent vs. workflow | **Agent** | Free-form email input, the preview→critique→revise loop, and extensibility to future personas all favor an agent over a hand-rolled workflow. |
| Agent framework | **Roll-your-own** on the OpenAI SDK | Loop is ~50 LOC. Avoids framework churn (OpenAI has already deprecated one agent SDK). Zero lock-in. Trivial to swap model providers later. |
| Runtime | **Next.js 15 (App Router) on Vercel** | Matches owner's existing stack. API routes for webhooks + cron. |
| Language | **TypeScript** | Type-safe tools and messages are essential for agent correctness. |
| Database | **Neon Postgres** via the Vercel–Neon integration | Already used, good serverless story. |
| ORM | **Drizzle ORM** | TS-native types, no codegen step, Neon-friendly. |
| LLM | **OpenAI `gpt-5.4`** (configurable via `settings` table) | Current model. Mini is allowed but full-fat is cheap enough at this volume. |
| Email provider | **Resend** on `example.com` | First-class inbound webhooks. Signed Svix payloads. Production receiving and webhook delivery have been validated. |
| PDF generator | Planned: **`@react-pdf/renderer`**. Current first pass: text-buffer stub. | Real PDF rendering/storage remains a finishing task. |
| Auth | **None now.** Inbound `From:` header must match a `users.email` row. | Deferred to WorkOS later; schema reserves `user_id` FKs now. |
| Payments | **None now.** Reserve Stripe columns on `invoices`. | Column order in Postgres is fixed at creation; cheaper to add now than `ALTER` later. |
| License | **MIT** | Owner intends this to be open source for self-hosters. |
| Vercel deploys | **Manual via CLI.** `git.deploymentEnabled: false` in `vercel.json`. | Owner preference. GitHub remains connected for source, not for deploys. |

---

## 3. Architecture overview

```mermaid
flowchart LR
    subgraph Email["Email (Resend)"]
        IN[Inbound webhook]
        OUT[Outbound send]
    end

    subgraph Vercel["Next.js on Vercel"]
        API[/POST /api/inbound-email/]
        RUN[runAgentLoop<br/>waitUntil background]
        CRON[/GET /api/cron/retry-stuck/]
        TOOLS[Tools:<br/>manage_invoice<br/>search_client_db<br/>send_invoice_for_review<br/>request_clarification]
        PDF[PDF artifact<br/>text stub now, real PDF planned]
    end

    subgraph Postgres["Neon Postgres"]
        T_users[(users)]
        T_clients[(clients)]
        T_invoices[(invoices)]
        T_items[(line_items)]
        T_threads[(threads)]
        T_messages[(messages)]
        T_settings[(settings)]
        T_jobs[(jobs)]
    end

    LLM[OpenAI Responses API<br/>configured model]

    IN --> API
    API -->|persist + 200 OK| Postgres
    API -.waitUntil.-> RUN
    RUN <--> LLM
    RUN --> TOOLS
    TOOLS --> PDF
    TOOLS <--> Postgres
    RUN --> OUT
    CRON --> RUN
```

### The agent loop (conceptual)

```
while step < max_steps:
    response = llm.chat(messages, tools)
    persist(response)                              # append assistant message
    if response.tool_calls:
        for call in response.tool_calls:
            if call.tool.requires_approval and not auto_approved(call):
                send_approval_request_to_owner()
                mark_thread_awaiting_approval()
                return                             # resume on owner's reply
            result = execute(call)
            persist(result)                        # append tool message
        continue
    else:
        if response.indicates_final():             # e.g. called no tools, replied
            send_reply_to_owner(response)
            return
        break
step_budget_exhausted()
```

> **Core convention (see §10 for full rationale):** every unit of agent work — one LLM call, one tool execution, one email send, one status transition — is authored as its own awaitable function and **persisted before the next unit runs**. No function should bundle "LLM call + tool execution + email send" behind a single `await`. This is what makes the whole system resumable, replayable, and migratable to durable-execution platforms with zero changes to business logic.

### Thread = conversation = durable context

- One **thread** per email conversation (identified via `Message-ID` / `In-Reply-To`).
- All LLM turns, tool calls, and tool results for that thread are rows in `messages`.
- The agent is stateless. On each inbound event we load the thread's message history, run the loop, append new rows, and persist.
- This makes the whole thing trivially replayable for debugging.

### Entry-point routing

The inbound email's **To:** address determines the persona:

| Address | Persona | System prompt | Tool subset |
|---|---|---|---|
| `invoice-gen@example.com` | Invoice Generator | `settings.invoice_gen_system_prompt` | manage_invoice, search_client_db, send_invoice_for_review, request_clarification |
| `expense-report@example.com` | *(future)* | — | — |

The current `invoice-gen` persona is configured in code, with runtime settings read from the `settings` table. The system prompt source of truth is `settings.invoice_gen_system_prompt`; `lib/agent/default-prompts.ts` is only a bootstrap/fallback default.

---

## 4. Data model

> Column order is intentional for Postgres (unchangeable once created). All timestamps are `timestamptz default now()`.

### `users`
```
id              bigserial primary key
email           citext unique not null
name            text
company_name    text
company_address text                              -- multi-line ok
company_phone   text
tax_id          text
default_due_days int default 14
created_at      timestamptz default now()
updated_at      timestamptz default now()
```
Seeded with the owner's profile at bootstrap. `email` is the auth key — inbound emails must match.

### `clients`
```
id              bigserial primary key
user_id         bigint not null references users(id) on delete cascade
company_name    text
contact_name    text
email           citext
address         text
phone           text
notes           text
created_at      timestamptz default now()
updated_at      timestamptz default now()
unique (user_id, company_name, email)
```

### `invoices`
```
id                 bigserial primary key
user_id            bigint not null references users(id) on delete cascade
client_id          bigint not null references clients(id) on delete restrict
thread_id          bigint references threads(id) on delete set null
status             text not null default 'draft'
                   -- draft | approved | sent | paid | void
invoice_number     text not null                 -- human-facing (e.g. "2025-0042")
issued_date        date
due_date           date
currency           text not null default 'USD'
subtotal_cents     bigint not null default 0
tax_cents          bigint not null default 0
total_cents        bigint not null default 0
notes              text
pdf_blob_key       text                          -- Vercel Blob or similar
-- Stripe (reserved, not wired yet)
stripe_invoice_id  text
stripe_payment_url text
paid_at            timestamptz
created_at         timestamptz default now()
updated_at         timestamptz default now()
unique (user_id, invoice_number)
```

### `line_items`
```
id              bigserial primary key
invoice_id      bigint not null references invoices(id) on delete cascade
position        int not null
description     text not null
quantity        numeric(12,2) not null default 1
unit_price_cents bigint not null
total_cents     bigint not null
created_at      timestamptz default now()
```

### `threads`
```
id                  bigserial primary key
user_id             bigint not null references users(id) on delete cascade
entry_point         text not null                -- e.g. 'invoice-gen'
subject             text
external_root_id    text unique                  -- first email's Message-ID
status              text not null default 'active'
                    -- active | awaiting_approval | archived | error
last_error          text
created_at          timestamptz default now()
updated_at          timestamptz default now()
```

### `messages`
```
id              bigserial primary key
thread_id       bigint not null references threads(id) on delete cascade
sequence_num    int not null
role            text not null                    -- system | user | assistant | tool
content         text                             -- text content (nullable if tool_calls present)
tool_calls      jsonb                            -- array of {id, name, arguments}
tool_call_id    text                             -- for role='tool'
tool_name       text                             -- for role='tool'
token_usage     jsonb                            -- {prompt, completion, total} when known
model           text                             -- which model produced this
created_at      timestamptz default now()
unique (thread_id, sequence_num)
```

### `settings`
```
key         text primary key
value       jsonb not null
description text
updated_at  timestamptz default now()
```
Seeded keys (initial):
- `invoice_gen_model_name` — `"gpt-5.4"`
- `invoice_gen_max_agent_steps` — `10`
- `invoice_gen_max_wall_clock_seconds` — `600`
- `invoice_gen_system_prompt` — system prompt text for the invoice generator agent
- `invoice_gen_require_approval_for_send_to_client` — `true`
- `invoice_gen_default_currency` — `"USD"`
- `owner_user_id` — `1`

### `jobs`
```
id              bigserial primary key
kind            text not null                    -- 'process_inbound_email' | 'resume_agent_thread'
payload         jsonb not null
status          text not null default 'pending'
                -- pending | running | done | failed
attempts        int not null default 0
max_attempts    int not null default 3
last_error      text
scheduled_for   timestamptz default now()
started_at      timestamptz
finished_at     timestamptz
created_at      timestamptz default now()
updated_at      timestamptz default now()
```

---

## 5. Module layout

```
/app
  /api
    /inbound-email/route.ts        # Resend webhook
    /cron/retry-stuck/route.ts     # planned safety-net cron (not implemented yet)
  /layout.tsx
  /page.tsx                        # minimal landing page

/lib
  /agent
    loop.ts                        # the bounded loop
    step.ts                        # runStep() — the durable-checkpoint seam (see §10.1)
    personas.ts                    # entry-point → config map
    types.ts                       # Message, ToolCall, ToolResult
  /llm
    types.ts                       # provider-agnostic interfaces
    openai.ts                      # OpenAI implementation
    index.ts                       # factory
  /email
    types.ts                       # EmailProvider interface
    resend.ts                      # Resend impl (inbound + outbound)
    threading.ts                   # Message-ID <-> thread mapping
  /tools
    registry.ts                    # id -> Tool definition
    manage-invoice.ts
    search-client-db.ts
    send-invoice-for-review.ts
    request-clarification.ts
  /invoices
    pdf.ts                         # current text-buffer artifact; replace with real PDF renderer later
    numbering.ts                   # invoice_number generator
  /db
    schema.ts                      # Drizzle schema
    client.ts                      # Neon client + drizzle()
    migrations/                    # drizzle-kit output
  /config
    env.ts                         # Zod-validated env
    settings.ts                    # read-through cache for settings table
  /jobs
    enqueue.ts
    run.ts
    kinds.ts

/scripts
  seed.ts                          # seed users + settings
  dev-send-email.ts                # local helper: simulate inbound email
  dev-run-job.ts                   # local helper: run/retry a queued job

/docs
  /plans/invoice-generator-core-app.md   (this file)

.env.example
vercel.json
drizzle.config.ts
README.md
LICENSE                            # MIT
```

---

## 6. Key interfaces

### `LLMClient` (provider-agnostic)
```ts
type Role = 'system' | 'user' | 'assistant' | 'tool';

interface ChatMessage {
  role: Role;
  content?: string;
  toolCalls?: ToolCall[];          // assistant only
  toolCallId?: string;             // tool only
  toolName?: string;               // tool only
}

interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;              // parsed JSON
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;          // Zod → JSON schema
}

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'required' | 'none';
}

interface ChatResponse {
  message: ChatMessage;            // assistant
  usage?: { prompt: number; completion: number; total: number };
  model: string;
}

interface LLMClient {
  chat(req: ChatRequest): Promise<ChatResponse>;
}
```

### `Tool`
```ts
interface Tool<TArgs, TResult> {
  name: string;
  description: string;
  schema: ZodSchema<TArgs>;
  requiresApproval: boolean;       // gate write actions
  run(args: TArgs, ctx: ToolContext): Promise<TResult>;
}

interface ToolContext {
  threadId: number;
  userId: number;
  persona: string;
}
```

### `EmailProvider`
```ts
interface EmailProvider {
  send(msg: OutboundEmail): Promise<{ messageId: string }>;
  verifyInboundSignature(req: Request): Promise<boolean>;
  parseInbound(req: Request): Promise<InboundEmail>;
}
```

---

## 7. Runtime concerns

### Vercel function timeouts
- Webhook route must return quickly. It persists the email and enqueues work; it does **not** run the agent loop inline.
- Agent loop runs via `waitUntil(...)` (from `@vercel/functions`) so the HTTP response returns immediately and the loop continues in the background.
- Fluid Compute (Vercel Pro) supports background execution up to 800s, which is plenty for a bounded 10-step loop even on slow OpenAI days.
- A **safety-net cron** is planned but not implemented yet. It should run regularly, pick up `jobs` rows in `status='pending'` older than 2 minutes (or `status='running'` older than 10 minutes with `started_at` stale), and retry them. This will cover cases where `waitUntil` didn't execute, the function was killed, or OpenAI timed out.

### Webhook security
- Resend signs inbound webhooks with an HMAC header. Verify using the signing secret from `RESEND_WEBHOOK_SECRET`. Reject on mismatch.
- Planned cron routes should use Vercel cron auth / a bearer secret (`Authorization: Bearer $CRON_SECRET`).

### Idempotency
- Inbound emails have a `Message-ID`. Persist a `messages`-style row only if that ID isn't already in the thread. Resend retries become no-ops.
- `manage_invoice` with `action='create'` is **not** naturally idempotent — the agent could double-create. Mitigate via `requiresApproval` gating plus a `(thread_id, role='tool', tool_name='manage_invoice', args digest)` uniqueness check if needed in practice.

---

## 8. Tools (v1)

### `search_client_db`
Read-only. Lookup by company name, contact name, and/or address. Returns up to N matches with full client rows. Used first to identify the invoice recipient.

### `manage_invoice`
Write. Current implementation supports draft `create` and `update` only. Future approval actions may add `approve`, `void`, and `delete`.
```
{
  action: 'create' | 'update',
  invoiceId?: number,              // required for update
  clientId?: number,               // required for create
  lineItems?: Array<{description, quantity, unitPriceCents}>,
  issuedDate?: string,             // YYYY-MM-DD
  dueDate?: string,                // YYYY-MM-DD
  currency?: string,
  taxCents?: number,
  notes?: string
}
```
Returns the invoice plus the current PDF artifact reference. The artifact is a text-buffer placeholder until real PDF/storage work lands.

### `send_invoice_for_review`
Write. `requiresApproval = false` (the review itself is the human-in-the-loop gate).
```
{ invoiceId: number, messageToOwner: string }
```
Emails the owner the PDF + a summary. Sets thread status to `awaiting_approval`.

### `request_clarification`
Terminal. Sends a reply to the owner asking for missing info, marks the thread `awaiting_approval` in the current first pass, and ends the current agent turn. A more precise future status may be `awaiting_clarification`.
```
{ messageToOwner: string }
```

---

## 9. Phased implementation

Each phase is sized to be completable by a sub-agent in a single session. Phases are sequential; later ones assume earlier ones are merged.

---

### Phase 0 — Project bootstrap

**Current status:** ✅ Complete.

Production is manually deployed on Vercel. Git-triggered auto-deploys are disabled in `vercel.json` and manual CLI deploys are the expected workflow.

**Goal:** empty-but-wired Next.js app on Vercel with Neon, GitHub, and CI conventions in place.

**Tasks:**
1. `create-next-app` with TypeScript, App Router, Tailwind (yes — we'll want a tiny admin UI later), ESLint.
2. Initialize new GitHub repo `invoice-gen` (owner: Erik). Push main.
3. Create new Vercel project, link to GitHub repo, **disable Git-triggered deploys**:
   ```json
   // vercel.json
   {
     "$schema": "https://openapi.vercel.sh/vercel.json",
     "git": { "deploymentEnabled": false }
   }
   ```
4. Add Neon via the Vercel–Neon integration. Capture `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED`.
5. Install deps: `drizzle-orm`, `drizzle-kit`, `@neondatabase/serverless`, `zod`, `openai`, `resend`, `@react-pdf/renderer`, `@vercel/functions`.
6. `drizzle.config.ts` pointing at `lib/db/schema.ts` and `lib/db/migrations/`.
7. `lib/config/env.ts` with Zod validation for all env vars. `.env.example` mirroring it.
8. `LICENSE` (MIT), `README.md` with self-host setup checklist (placeholder sections for each phase), `.gitignore`.
9. Root page: minimal "Invoice Generator — running" placeholder.
10. First manual deploy to Vercel preview: `vercel deploy --yes`. Verify page loads.

**Env vars to define (empty values OK in .env.example):**
```
DATABASE_URL=
DATABASE_URL_UNPOOLED=
OPENAI_API_KEY=
RESEND_API_KEY=
RESEND_WEBHOOK_SECRET=
EMAIL_FROM_ADDRESS=
EMAIL_FROM_NAME=
CRON_SECRET=
OWNER_EMAIL=
```

**Acceptance:**
- `pnpm dev` loads the placeholder page locally.
- `vercel deploy --yes` succeeds and returns a preview URL.
- `drizzle-kit check` runs cleanly (even with empty schema).

---

### Phase 1 — Data model & migrations

**Current status:** ✅ Complete.

The Drizzle schema, migrations, seed script, Neon database, owner user, and settings rows are in place. The prompt setting is now `invoice_gen_system_prompt` and is the runtime source of truth.

**Goal:** all tables from §4 exist; a seed script populates the owner user and initial `settings`.

**Tasks:**
1. Implement `lib/db/schema.ts` with every table from §4. Use Drizzle's `pgTable`, proper FKs, indexes on `threads.external_root_id`, `clients.user_id`, `invoices.user_id`, `messages.thread_id`, `jobs.status + scheduled_for`.
2. Generate initial migration: `drizzle-kit generate`.
3. `scripts/seed.ts`:
   - Upserts owner user from `OWNER_EMAIL` env (and some sensible `company_*` defaults; can be updated later).
   - Upserts the seeded `settings` keys listed in §4.
4. Add `pnpm db:push`, `pnpm db:migrate`, `pnpm db:seed`, `pnpm db:studio` scripts to `package.json`.
5. Run against local Neon branch; verify via `drizzle-kit studio`.

**Acceptance:**
- All tables exist in the dev branch.
- `pnpm db:seed` is idempotent (running twice leaves the DB unchanged).
- `settings` has every key from §4.

---

### Phase 2 — LLM client abstraction

**Current status:** ✅ Complete, with the implementation using the OpenAI Responses API rather than Chat Completions.

The app-level `LLMClient.chat()` interface remains provider-agnostic. Unit tests and the real OpenAI smoke test passed.

**Goal:** a provider-agnostic chat interface with an OpenAI implementation and a fake for tests.

**Tasks:**
1. `lib/llm/types.ts` — the interfaces from §6.
2. `lib/llm/openai.ts` — implements `LLMClient` using the OpenAI Responses API through the `openai` SDK:
   - Converts our `ChatMessage[]` to Responses API input items (including tool calls and tool outputs).
   - Converts `ToolDefinition[]` to Responses API tools.
   - Returns normalized `ChatResponse`.
3. `lib/llm/fake.ts` — a scripted fake for tests: given a queue of responses, return them in order.
4. `lib/llm/index.ts` — factory reading `invoice_gen_model_name` from settings and returning the right client.
5. Unit tests covering: roundtripping a tool call, handling a response with no tool calls, handling multiple tool calls in one turn.

**Acceptance:**
- A smoke test (behind an env flag) calls the real OpenAI Responses API with the configured model and round-trips a hello-world tool call.
- Unit tests pass with the fake.

---

### Phase 3 — Email layer (Resend)

**Current status:** ✅ Complete and validated in production.

Resend receiving is configured on `example.com`, with inbound messages sent to `invoice-gen@example.com`. The webhook listens for `email.received` at `/api/inbound-email`. Valid inbound emails are persisted and unsigned/fake production requests return `401`.

**Goal:** send and receive email, with threading and signature verification.

**Tasks:**
1. `lib/email/types.ts` — the `EmailProvider` interface.
2. `lib/email/resend.ts`:
   - `send()` — outbound via Resend SDK. Sets `References`/`In-Reply-To` when replying to an existing thread.
   - `verifyInboundSignature()` — HMAC check against `RESEND_WEBHOOK_SECRET`.
   - `parseInbound()` — normalize Resend's webhook payload into `InboundEmail { from, to, subject, text, html, messageId, inReplyTo, references[], attachments[] }`.
3. `lib/email/threading.ts`:
   - Given an inbound email's `In-Reply-To` / `References`, find the owning `threads` row or create a new one.
   - Determine `entry_point` from the `To:` address (strip domain, match against personas map).
4. `app/api/inbound-email/route.ts`:
   - Verify signature, else 401.
   - Parse payload.
   - Match `from` to a `users` row; reject unknown senders with a polite bounce.
   - Find-or-create thread. Persist a `messages` row for the inbound email (role=`user`).
   - Enqueue a `jobs` row kind=`process_inbound_email` with `{threadId}`.
   - Call `waitUntil(runJob(jobId))` and return `200` immediately.
5. `scripts/dev-send-email.ts` — posts a fake Resend payload to the local inbound endpoint for testing without real email.

**Acceptance:**
- Invalid signature → 401.
- Valid inbound from owner → creates thread, persists message, enqueues job, returns 200 in <500ms.
- Same `Message-ID` received twice → second call is a no-op on messages.

---

### Phase 4 — Tools & PDF generation

**Current status:** 🟡 Partially complete.

Implemented: `search_client_db`, `manage_invoice`, `send_invoice_for_review`, `request_clarification`, invoice numbering, line-item/totals persistence, and fake email support for tests. Not yet production-quality: real `@react-pdf/renderer` PDF generation, real Blob/storage integration, and full seeded-client invoice E2E validation.

**Goal:** the four v1 tools implemented and individually testable, plus a clean PDF template.

**Tasks:**
1. `lib/invoices/numbering.ts` — generate next `invoice_number` per user (format: `YYYY-NNNN`).
2. `lib/invoices/pdf.ts` — currently a text-buffer placeholder. Replace with an `@react-pdf/renderer` template that takes a full invoice + user + client and emits a Buffer, then store to Vercel Blob or the chosen storage provider (`pdf_blob_key`).
3. `lib/tools/*.ts` — each tool implemented with Zod schema, `requiresApproval` flag, and a pure `run(args, ctx)`.
4. `lib/tools/registry.ts` — maps tool name → Tool. Provides a `toolsForPersona(persona)` helper.
5. Unit tests for each tool against a seeded test DB.

**Acceptance:**
- `search_client_db` returns correct fuzzy matches.
- `manage_invoice({action:'create', ...})` creates invoice + line_items + PDF, returns structured result.
- `send_invoice_for_review` sends a real-looking email via a fake `EmailProvider`.
- PDF renders with correct totals, line items, user and client details.

---

### Phase 5a — Agent loop (synchronous, no email glue yet)

**Current status:** 🟡 Working first pass.

`runAgentLoop(threadId)` loads thread/user/message context, includes both thread subject and message body in the LLM context, uses the DB-backed prompt, calls OpenAI through the Responses API adapter, persists assistant/tool messages, executes tools, and stops after terminal tools without an unnecessary extra LLM call. Missing-client clarification has been proven with a real inbound email. The happy path with a real seeded client still needs E2E validation.

**Goal:** a function `runAgentLoop(threadId)` that, given a thread with queued messages, runs the bounded loop and persists everything.

**Tasks:**
1. `lib/agent/types.ts` — re-exports from llm types plus `PersonaConfig { name, systemPrompt, toolNames[], model, maxSteps, maxWallClockSeconds }`.
2. `lib/agent/personas.ts` — registry for `invoice-gen` that loads the runtime prompt from `settings.invoice_gen_system_prompt` and falls back to the bundled default only if the setting is missing.
3. `lib/agent/default-prompts.ts` — bundled bootstrap/fallback prompt used by seeding and missing-setting recovery. Runtime prompt iteration should happen in the settings table.
4. `lib/agent/step.ts` — the `runStep(name, fn)` wrapper. In v1 it simply awaits `fn()`, records duration, and on error writes to the active `jobs` row. **This is the migration seam to Inngest/Temporal/etc. (see §10.1) — keep its surface minimal and provider-agnostic.**
5. `lib/agent/loop.ts`:
   - Load thread, user, persona, message history — **via `runStep`**.
   - Compose system prompt (with user profile filled in) — one `runStep`.
   - Loop up to `maxSteps`, also respecting `maxWallClockSeconds`:
     - `runStep("llm-call", ...)` → call `LLMClient.chat(...)`.
     - `runStep("persist-assistant", ...)` → persist assistant message.
     - If tool calls: for each, check `requiresApproval`; if gated, `runStep("request-approval", ...)` sends approval email + marks thread `awaiting_approval` + exits. Else `runStep("tool-<name>", ...)` executes, then `runStep("persist-tool", ...)` persists the result, continue.
     - If no tool calls: `runStep("send-reply", ...)` sends email, `runStep("mark-active", ...)` sets thread `active`, exit.
   - On step or wall-clock exhaustion: `runStep("mark-error", ...)` sets thread `error` with `last_error`, notify owner.
   - **Every step must persist before the next begins.** No multi-step batching inside a single `runStep`.
6. Unit tests using the fake LLM and fake email provider, covering:
   - Happy path: client found → draft invoice → send for review → exit
   - Missing client: request_clarification → exit awaiting_approval
   - Step budget exhausted
   - Tool error recovery

**Acceptance:**
- Given a seeded thread with an inbound email, `runAgentLoop(threadId)` produces the expected tool calls and final state deterministically (with the fake LLM).
- Real end-to-end test against OpenAI Responses API generates a plausible invoice for a seeded client. **Still pending as of the current status update.**

---

### Phase 5b — Background execution & inbound routing

**Current status:** 🟡 Partially complete.

Implemented: `lib/jobs/run.ts`, job status transitions, `waitUntil(runJob(jobId))` from inbound webhook, and local retry/debugging via `pnpm dev:run-job`. Not yet implemented: cron route for pending/stuck jobs, cron config, and automatic recovery of stale jobs.

**Goal:** inbound email → agent run happens asynchronously, reliably.

**Tasks:**
1. `lib/jobs/run.ts` — dispatcher switching on `jobs.kind`:
   - `process_inbound_email` → `runAgentLoop(threadId)`
   - `resume_agent_thread` → same
   Handles attempts, backoff, `status` transitions, error capture.
2. Wire `waitUntil(runJob(jobId))` into the inbound webhook route (Phase 3 stubbed this).
3. `app/api/cron/retry-stuck/route.ts` — reads pending/stuck jobs, runs them. Protected by `CRON_SECRET`.
4. `vercel.json` cron entry: `* * * * *` → `/api/cron/retry-stuck`.
5. Integration test: POST a fake inbound → observe DB state transitions through completion.

**Acceptance:**
- Posting a fake inbound email to the local webhook results in a generated invoice + review email (stubbed provider) within seconds.
- Killing the process mid-run and then triggering the cron causes the job to complete.

---

### Phase 6 — Minimal admin UI (optional but recommended)

**Current status:** 🔴 Not started / deferred.

Do not expose a production admin UI until the authentication story is settled. Because the owner already uses WorkOS in other projects, WorkOS is the recommended auth path before building real client/invoice management screens. For short-term testing, use Neon Console or a private script to seed client records.

**Goal:** eventually provide a protected admin/debug UI for client records, invoices, threads, jobs, and prompt/settings management.

**Tasks:**
1. `/app/admin/invoices` — list invoices with status.
2. `/app/admin/invoices/[id]` — detail view, PDF link, status actions (approve, void).
3. `/app/admin/threads/[id]` — message timeline for debugging agent runs.
4. Protect with WorkOS auth for production use. A simple `ADMIN_PASSWORD` or localhost-only guard is acceptable only for temporary debugging tools.

**Acceptance:**
- Can view every invoice, open its PDF, and manually approve/void.
- Can replay a thread's messages visually.

---

## 10. Forward-looking runtime & durable execution

**Design goal:** the agent's logical runtime is bounded only by *our policy* ("stop after 12 hours" or "stop after 50 steps"), never by the *platform's* execution limits. A 5-step run and a 5,000-step run must be expressible in this codebase without architectural changes — only the ceiling configured in `settings` changes.

Vercel's ~800s Fluid Compute window is comfortable for the v1 scope (bounded loops of ~10 steps). It is **not** the upper bound of the system we're designing for. As models and tool ecosystems mature and agents are expected to run for hours on complex work, this codebase should migrate cleanly — not be rewritten.

### 10.1 Core convention: one step = one durable checkpoint

Every unit of agent work must be authored as a **single awaitable function whose result is persisted before the next unit runs.** The agent loop is a sequence of such units.

Concretely, each of these is a "step":

- One `LLMClient.chat(...)` call → persist the resulting assistant message
- One tool execution → persist the tool result message
- One outbound email send → persist a record of the send
- One status transition (e.g. thread → `awaiting_approval`) → persisted by itself

**Anti-pattern — do not write code shaped like this:**
```ts
// ❌ One function doing four logical steps with no intermediate persistence
async function doTurn(thread) {
  const response = await llm.chat(...);
  const toolResults = await Promise.all(response.toolCalls.map(execute));
  await sendEmail(summarize(response, toolResults));
  await updateThreadStatus(thread, "active");
}
```

**Correct pattern:**
```ts
// ✅ Each step persists before the next runs
async function runAgentLoop(threadId: number) {
  const thread = await runStep("load-thread", () => loadThread(threadId));

  for (let step = 0; step < maxSteps; step++) {
    const response = await runStep("llm-call", () => llm.chat(thread.messages));
    await runStep("persist-assistant", () => persistMessage(threadId, response));

    if (response.toolCalls?.length) {
      for (const call of response.toolCalls) {
        const result = await runStep(`tool-${call.name}`, () => execute(call));
        await runStep("persist-tool-result", () => persistMessage(threadId, result));
      }
      continue;
    }

    await runStep("send-reply", () => sendEmail(threadId, response));
    await runStep("mark-thread-active", () => setThreadStatus(threadId, "active"));
    return;
  }

  await runStep("step-budget-exhausted", () => setThreadStatus(threadId, "error"));
}
```

In v1, `runStep(name, fn)` is a thin wrapper in `lib/agent/step.ts` that:

1. Calls `fn()`.
2. Catches errors and records them against the current `jobs` row.
3. Optionally logs step name + duration for observability.

That's it — no external dependencies. Once we migrate to a durable execution platform, the *only* change is that `runStep` becomes `step.run(...)` from that platform's SDK, and every step becomes a durable checkpoint for free, with **zero changes to the business logic inside each step**.

**Code review rule:** if a PR introduces a function that does two or more of { LLM call, tool execution, email send, DB status transition } without intermediate persistence, it is rejected.

### 10.2 State lives in the database, never in a process

- The agent is stateless. Given a `thread_id` and a `job_id`, any process, at any time, should be able to resume the work from where it left off.
- "Currently executing" is a property of the `jobs` row (`status`, `started_at`, `attempts`), not of any running process.
- A crashed, killed, or redeployed process must never cause a job to be lost — the safety-net cron reclaims any `running` job whose `started_at` is older than a threshold and resets it to `pending`.

### 10.3 Migration paths we're designed to support

Ranked by expected migration cost from v1's `waitUntil` + cron model (lower = easier):

1. **Standalone Node worker on Fly.io / Railway / Render / Hetzner.** Extract `lib/jobs/run.ts` into its own long-lived process; poll the `jobs` table or use Postgres `LISTEN/NOTIFY`; run indefinitely with no timeout. Webhook stops calling `waitUntil` and just writes the job row. *Migration surface: one new process entrypoint. Agent loop code unchanged.* This is the "it just runs" model — closest in spirit to a FastAPI backend.

2. **Inngest or Trigger.dev (durable execution as a service).** Replace `lib/jobs/run.ts` dispatcher with a platform-registered function. Swap the body of `runStep` to call `step.run(...)`. Platform handles checkpointing, retries, replay, observability, and fan-out. *Migration surface: the dispatcher file and `step.ts`. Agent business logic unchanged.* Recommended if operational simplicity > infra ownership.

3. **Temporal.** Heavier, self-hostable cleanly, gold standard for serious workflow orchestration. Use if scale or compliance demands it.

4. **Cloudflare Workflows / Durable Objects.** Same shape, different ecosystem. Viable if we ever leave Vercel.

We do **not** plan to support migrating *away* from the "each step is durable" convention. That convention is the load-bearing idea; everything downstream is swappable infrastructure.

### 10.4 Runtime caps are policy, not platform

Termination conditions are configured in `settings`, not imposed by infrastructure:

- `invoice_gen_max_agent_steps` — hard step ceiling (v1 default: `10`)
- `invoice_gen_max_wall_clock_seconds` — hard time ceiling (v1 default: `600`; raise freely after migration)
- `invoice_gen_max_total_tokens` — cost ceiling (add when cost becomes a concern)

A job hitting any configured cap transitions to `status = 'error'` with a descriptive `last_error` — it is **never** silently killed by a platform timeout. If we ever observe a job ending because of a Vercel timeout rather than one of our own caps, that is a bug and a signal it's time to migrate to option (1) or (2) above.

### 10.5 When to migrate

Stay on v1 (`waitUntil` + safety-net cron) while all of the following hold:

- p95 agent run time is comfortably under 600s
- Volume is < ~500 agent runs / day
- No user-facing need for live progress streaming

Migrate to option (1) or (2) when any of:

- Agent runs regularly approach or exceed 600s, or a new persona is introduced that plausibly will (e.g. multi-hour research agents, large codebase analysis, long tool chains)
- A web UI is added that wants live thread streaming or interactive interrupts
- Concurrency or throughput exceeds what Vercel's per-function limits give comfortably
- Cost analysis shows FaaS execution pricing is worse than a small always-on box

The migration itself should be a one-afternoon task because of the conventions in §10.1–10.2.

---

## 11. Open questions / deferred decisions

- **Seeded-client invoice E2E:** not yet complete. The next core milestone is adding a real client record, sending an invoice request, and confirming `invoices` + `line_items` + review email are generated correctly.
- **PDF rendering/storage:** currently a text-buffer stub. Need real `@react-pdf/renderer` output and a storage decision, with Vercel Blob still the default leaning.
- **Prompt storage:** DB-backed via `settings.invoice_gen_system_prompt`, with a bundled code fallback only for bootstrap/missing-setting recovery so local and production use the same runtime prompt source.
- **Cron/retry safety net:** job dispatcher exists, but `/api/cron/retry-stuck` and Vercel cron config are not implemented yet.
- **Client data management:** currently manual via Neon Console or future script. Production admin/client CRUD should wait for WorkOS auth.
- **Approval policy granularity:** currently a boolean per tool. May need per-action inside `manage_invoice` (already designed that way — `create` and `update` on draft don't require; `approve`/`void`/`delete` do).
- **Client-facing send:** sending the final approved invoice *to the client* is intentionally NOT in v1. The owner forwards manually. Added later as a new tool with `requiresApproval=true`.
- **Stripe:** schema only. Code lands in a future plan.
- **Auth:** none now. WorkOS is recommended before any production admin panel; add an `auth_provider_id` column and login/session routes when that phase starts.
- **Multi-tenancy:** every query is already scoped by `user_id`. Turning on multi-tenant is "allow more users" + auth.

---

## 12. What the next agent should do

Start by reading `docs/current-architecture-and-next-steps.md`, then use this document for exhaustive detail as needed.

The next highest-value work is:

1. Create or manually insert a real test client record, e.g. `Fable Co` for owner user `1`.
2. Run a full invoice-generation E2E test from inbound email through `invoices`, `line_items`, job completion, and owner review email.
3. Fix any prompt/tool/schema issues found during that seeded-client happy-path test.
4. Implement the cron/retry safety net once the core happy path is stable.
5. Replace the text-buffer PDF stub with real PDF rendering/storage.
6. Defer the admin UI until WorkOS/protected auth is designed.
