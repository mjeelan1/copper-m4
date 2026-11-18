# Architecture

How the Copper State Labs app fits together. Each module adds a section at the
end (see [Adding a module](#adding-a-module)) when it changes how the app
works: new pages, tables or AI calls.

_Fictional — for educational use._

## The starter app (Module 0)

A Next.js app that builds, runs and deploys with **no environment variables**.
A Google AI Studio key is optional until a module needs one.

| Piece | Where | What it does |
|---|---|---|
| Pages | `app/` | `layout.tsx` sets the fonts and theme; `page.tsx` is the placeholder home page |
| Brand components | `components/copper/` | `Logo`, `SiteHeader`, `SiteFooter`, `ModeToggle` |
| UI kit | `components/ui/` (shadcn), `components/ai-elements/` (AI Elements) | The only UI libraries the app uses |
| Setup card | `components/setup-required.tsx` | `<SetupRequired service="ai" />`, shown instead of a page whose service isn't configured |
| Company catalog | `lib/copper/catalog.ts`, `lib/copper/data/catalog.json` | Product, plan and privacy facts from the Product Bible (Sections 3, 4, 8 and 10). Pages read prices and plan details from here instead of typing them (added in the Module 1 starter) |
| AI wrapper | `lib/ai/call.ts` | `callText` and `callObject`: every model call goes through these and is logged to the terminal |
| Models and prices | `lib/ai/models.ts`, `lib/ai/pricing.ts` | The approved Gemini models and their token prices |

## Data flow

1. A user opens a page in `app/`.
2. Server code checks what's configured (`isAiConfigured()`). If the key is
   missing, the page renders `<SetupRequired />` instead of crashing.
3. Data comes from files under `lib/copper/data/`.
4. AI requests go through `callText` / `callObject` in `lib/ai/call.ts`, which
   calls Google and then prints one `[ai_calls]` line: `module`, `feature`,
   `model`, tokens, `cost_usd`, `latency_ms`, `ok`.

```ts
const { text } = await callText(
  { module: 2, feature: "ask-copper" },
  { prompt },
);
```

## Two kinds of "AI tiers"

Don't mix these up:

- **Copper State Labs' product tiers** (On-device, Raw Ore, Refined, the
  Copper Cloud) are part of the fictional company. They are facts in the
  [Product Bible](copper-state-labs/product-bible.md) and rows in the `ai_tiers`
  table.
- **The models this app calls** are real Claude models listed in
  `lib/ai/models.ts`. Their cost is logged in `ai_calls`.

## Decisions

- **No environment variables required.** Every service is optional, so a fresh
  clone builds and deploys before any accounts are set up.
- **One AI wrapper.** Routing every call through `lib/ai/call.ts` gives one
  place to log cost and latency per module and feature.
- **No authentication or row-level security yet.** They arrive in a later
  module.

## Adding a module

When a module changes how the app fits together, add a section here:

```md
## Module N: <feature name>

**Summary:** one or two sentences: what this adds and why.

| Piece | Where | What it does |
|---|---|---|
| Page / route | `app/...` | |
| Components | `components/...` | |
| Data | `lib/copper/data/...` | Data files added |
| AI calls | `lib/ai/call.ts` (module, feature) | Model, prompt purpose, expected cost per call |

**Data flow:** user action → page → server code → database / model → response.

**Decisions and trade-offs:** what you chose, the alternatives, and why.

**Risks and open questions:** cost, privacy, accuracy or safety risks, and how
you handle them.
```

## Module 3 starter: Ask Copper

**Summary:** Ask Copper, the Module 2 shopping chatbot, finished: a floating
chat panel that answers prices, totals and stock with four tools and shows
each step. Module 3 teaches it to answer from the customer documents.

| Piece | Where | What it does |
|---|---|---|
| Component | `components/copper/ask-copper.tsx` | The launcher and chat panel, mounted from `app/page.tsx` and opened by the header's `#ask` link. Draws each answer as stations: the tools on offer, thinking, each tool call, then the reply |
| Server Action | `lib/copper/assistant/ask.ts` | `askCopper()`: streams the conversation with `callStream`, up to 5 steps, and sends each step back as a live `Progress` |
| Tools | `lib/copper/assistant/tools.ts` | `copperTools`: `get_products`, `get_prices`, `calculate_cost`, `check_availability` |
| Instructions | `lib/copper/assistant/instructions.ts` | `COPPER_INSTRUCTIONS`. Copper says it can't help yet with warranty, setup, troubleshooting or privacy |
| Data | `lib/copper/inventory.ts`, `lib/copper/documents.ts` | Stock from `lib/copper/data/inventory.json`; `DOCUMENTS`: the four customer documents and their PDF paths under `public/docs/`. The PDFs are added in class |
| AI calls | `{ module: 2, feature: "ask-copper" }` | One streamed call per question |

## Module 3: Document passages and embeddings

**Summary:** The four customer PDFs in `public/docs/` are split into passages
of a few sentences and embedded with Gemini, so Ask Copper can find the
passages that answer a question and cite their page.

| Piece | Where | What it does |
|---|---|---|
| Build script | `scripts/embed-docs.mjs` (`npm run embed-docs`) | Reads each PDF in `DOCUMENTS` page by page (with `unpdf`), splits pages with `splitPage()`, embeds every passage and writes the JSON. Re-run it when a PDF changes |
| Splitter | `lib/copper/split-passages.ts` | `splitPage()`: drops the footer lines, then groups sentences three at a time (at most ~600 characters) |
| Data | `lib/copper/data/passages.json`, `lib/copper/passages.ts` | `PASSAGES`: `documentId`, `title`, `page`, `text` (starts with the document title) and `embedding`. Importing it loads every passage into memory once per server |
| Tool | `lib/copper/assistant/tools.ts` | `search_docs`: embeds the question, ranks every passage by cosine similarity and returns the 5 closest with title, page, a `/docs/<file>.pdf#page=N` link and a score. The tool card lists them with links; the instructions tell Copper to use it for setup, troubleshooting, warranty and policy questions and to cite the page |
| Citations | `lib/copper/assistant/citations.ts`, `lib/copper/assistant/instructions.ts` | Copper answers document questions only from `search_docs`, ends every sentence with `[Title, p. N]`, and says "I couldn't find that in our support docs" otherwise. `splitCitations()` lets the panel link each citation to that PDF page; unknown titles stay plain text |
| AI calls | `callEmbedMany` in `lib/ai/call.ts`, `{ module: 3, feature: "embed-docs" }` | `gemini-embedding-2` at 768 dimensions. One call per run of the script, plus one `{ module: 3, feature: "search-docs" }` call per search. Google doesn't report embedding tokens, so the log's tokens and cost are null |

**Data flow:** PDF → pages → passages → Gemini embeddings → `passages.json` →
`PASSAGES` in memory. Question → `search_docs` → question embedding → 5
closest passages → Copper answers from them and cites the page.

**Decisions and trade-offs:** A JSON file in memory instead of a vector
database: about 120 passages is under 1 MB, so searching all of them is
instant and needs no new service. 768 dimensions instead of 3072 keeps the
file small with little loss in accuracy. The title goes at the start of each
passage so similar passages from different documents (Copper Home vs. Copper
Notes) embed differently.

**Risks and open questions:** Questions must be embedded with the same model
and dimensions (`EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`) or the search
returns nonsense. Tables lose their columns when turned into text. Embeddings match meaning
better than exact strings, so an error code like C-47 can rank below other
error-code passages (it was third in testing); keyword search alongside would fix that.

## Module 4 starter: Support page

**Summary:** An empty Support page titled "Refund Console", with Ask Copper
(as finished in Module 3) docked on the right. Module 4 builds refunds here: a
second agent, and a person approving the large ones.

| Piece | Where | What it does |
|---|---|---|
| Page | `app/support/page.tsx` | The "Refund Console" title and nothing else yet, linked from the header as Support |
| Chat panel | `components/copper/ask-copper.tsx` | With the `docked` prop it starts open and the page beside it stays clickable. It is the same single agent and tools as on the home page |

## Module 4: Refunds (stage 1)

**Summary:** Customers ask for refunds in Ask Copper on `/support`. Copper
hands the chat to a Refund agent, code decides each request, and a person
approves the ones the code sends for review in the Refund Console. The rule:
**agents talk, code decides, people approve.**

| Piece | Where | What it does |
|---|---|---|
| Decision engine | `lib/copper/refunds/decide.ts` | `decideRefund()`: one pure function. Checks, in order: identity (the order is the signed-in account's), eligibility (not refunded, nothing waiting, 30 days or newer), risk signals (same device or IP on 2+ accounts today, location outside the home country, a claimed approval), limits (order over $50, account over $100 or shop over $200 of automatic refunds today). Returns refund now, refuse by rule or review by a person, with reasons, flags and the limits. Money in cents |
| Refund agent | `lib/copper/refunds/agent.ts` | `REFUND_INSTRUCTIONS` and three tools bound to the chat session: `list_my_orders`, `request_refund` (order ID and an optional `customer_claimed_approval` warning, nothing else) and `check_refund_status`. No tool approves anything. Copper's `transfer_to_refunds` tool is the handoff |
| Handoff | `lib/copper/assistant/ask.ts` | On `/support` the chat sends a session ID. Copper gets `transfer_to_refunds`; once called, the session's `agent` becomes `refunds` and the Refund agent answers from then on. After `request_refund` or `check_refund_status` the reply is the decision log's message, word for word. The code also scans every customer message for claimed approvals ("a supervisor already approved") |
| Service | `lib/copper/refunds/service.ts`, `lib/copper/refunds/actions.ts` | Server code for the tools, the console and the chat. `requestRefund()` reads the facts, lets `decideRefund()` decide and saves through `record_refund_case`; if another request saved first, it decides again with fresh facts |
| Database | `supabase/migrations/2026111700000*_refunds_*.sql`, project "class examples" | `accounts`, `orders`, `chat_sessions` (made-up IP, device, browser, country), `refund_settings`, `refund_cases`, `refund_decisions` (the log). Row level security on with no policies; the SQL functions run for the service role only |
| Console | `components/copper/refunds/refund-console.tsx`, `app/support/page.tsx` | Waiting reviews (Approve / Reject), Customer simulator, Settings (the three limits) and Decision log. Refreshes every 3 seconds |
| Chat | `components/copper/ask-copper.tsx` | "Signed in as" switcher (a new chat per account), the handoff station, and a person's decisions appearing on their own (polled every 3 seconds) |
| AI calls | `{ module: 4, feature: "refund-agent" }` | One streamed call per question once the Refund agent has the chat. Copper's handoff call stays `{ module: 2, feature: "ask-copper" }` |

**Data flow:** customer asks for a refund → Copper calls `transfer_to_refunds`
→ Refund agent calls `request_refund(orderId)` → `refund_facts` (one read) →
`decideRefund()` → `record_refund_case` (one write, under a lock) → the
customer sees the log's message. Review cases wait in the console → a click
calls `review_refund_case` → the chat shows the person's decision.

**Decisions and trade-offs:**
- *Code decides, the database guards.* All the rules live in one TypeScript
  function so they can be tested offline. The SQL function only saves: it
  takes one lock for all refund requests and refuses to save if any case was
  added after the facts were read (the newest case ID is the "version"), so
  two requests at the same time can't both pass the daily totals. A unique
  index allows one refunded, waiting or approved case per order.
- *The handoff is a tool.* The AI SDK has no handoff feature, so
  `transfer_to_refunds` saves the switch on the chat session.
- *Warnings only make it stricter.* The agent can set one warning; the code's
  phrase scan sets the same flag. Both can only send a case to review.
- *The reply after a decision is the code's text,* not the model's, so the
  chat always matches the log.
- *Limits are saved with each case,* so changing them never releases a
  waiting refund.
- *"Today"* is the shop's day in Arizona (America/Phoenix).
- *Polling, not push:* the chat and console check every 3 seconds. Simple,
  and fine for a class demo.

**Risks and open questions:** The console has no sign-in: anyone who can
open `/support` can approve. The "Signed in as" switcher stands in for real
sign-in, and the simulator's signals are made up. The order dates count back
from the day the seed ran, so the recent orders pass 30 days in a few weeks.
