# CLAUDE.md

Guidance for future Claude sessions working in this repo.

## What this is

A single Google Apps Script (`Code.gs`) that runs **inside
james@myadventuregroup.com.au's Gmail mailbox** and routes outbound
follow-up threads based on the latest message in each thread. It is deployed by
pasting `Code.gs` into a script.google.com project under James's account — this
repo is the source of truth, not a deploy target. There is no build step, no
package manager, and no test suite.

It routes **multiple channels** driven by the `CHANNELS` config array at the top
of `Code.gs`. Each channel row is `{ name, sourceLabel, threadsTable, bounceRpc }`
— the routing logic is identical; only those three values differ:

| Channel | sourceLabel | threadsTable | bounceRpc |
|---------|-------------|--------------|-----------|
| soc-med | `follow-up-sequence-soc-med` | `follow_up_sequence_threads` | `process_bounced_lead` |
| cold | `follow-up-sequence-cold-leads` | `cold_leads_follow_up_sequence_threads` | `process_bounced_cold_lead` |

The dest/closed labels, `REPLIED_STATUS` (`8A`), the bounce RPC arg
(`_email_add_sent`), and the `process-bounced-leads` Edge Function are shared
across channels. Add a channel by appending a `CHANNELS` row.

## Architecture / flow (read before editing Code.gs)

Every minute, `moveThreads()` -> `processRepliedThreads_()` resolves the shared
dest/closed labels once, then loops `CHANNELS` calling
`processChannel_(channel, dest, closed, windowMinutes)`. Each channel scans its
`sourceLabel` and inspects only threads active within `ACTIVE_WINDOW_MINUTES`
(keeps Gmail reads tiny). One script-wide lock wraps the whole multi-channel
sweep. For each thread it looks at the **last message**:

- **Bounce/block** (postmaster / Mail Delivery Subsystem saying "Delivery has
  failed" / "Message blocked") — handled FIRST. Three ordered side-effects:
  1. `processBouncedLead_(email, channel.bounceRpc)` — POST
     `/rest/v1/rpc/<bounceRpc>` (Postgres RPC, arg `_email_add_sent`) to RECORD
     the bounce into `public.bounced_leads`. The RPC sets `status='10A'` on the
     matched source-lead row and tags `bounced_leads.lead_type` (`'soc med'` or
     `'cold'`).
  2. `invokeProcessBouncedLeadsFunction_()` — POST
     `/functions/v1/process-bounced-leads` (Edge Function, takes NO args, acts
     on all pending bounced_leads rows, lead-type-agnostic) to ACTION them in
     ActiveCampaign. Shared by every channel.
  3. Move the thread to `follow-up-sequence-closed`.
- **Lead reply** (external sender, not ours, not a system sender) —
  `transferThread_()` sets `<channel.threadsTable>.status = '8A'` +
  `status_update_date`, then moves to the to-action label.
- **Our domain last** — stays put.

`process_bounced_lead` / `process_bounced_cold_lead` (RPCs, underscores) and
`process-bounced-leads` (Edge Function, hyphens) are DIFFERENT things and BOTH
fire on a bounce — the RPC records, the function actions in ActiveCampaign.
Don't conflate them. The two RPCs are twins: same shape, differing only in the
source tables they update (soc-med: `ai_scraped_soc_med_leads` +
`manually_found_leads`; cold: `manually_found_cold_leads` +
`ai_verified_cold_leads`) and the `lead_type` constant they insert.

## Critical conventions / gotchas

- **Side-effects before the label move.** Every Supabase call runs before
  `moveLabels_`, and each returns a boolean; on failure the code `continue`s and
  leaves the thread in the source label so the next sweep retries. Preserve this
  ordering when adding steps — all side-effects must be idempotent.
- **Idempotency is assumed.** The RPC and the Edge Function are both called
  potentially more than once for the same bounce; the Edge Function reprocesses
  every pending row each call. Keep any new side-effect safe to repeat.
- **Auth.** All Supabase calls (REST, RPC, Edge Function) use the service_role
  key from the Script Property `SUPABASE_SERVICE_ROLE_KEY` — used as both
  `Authorization: Bearer` and `apikey`. Never hardcode a key in `Code.gs`.
- **Labels are Gmail `label:` search tokens**, not display names. `resolveLabel_`
  matches by normalizing (lowercase, whitespace/slashes -> hyphens), so it works
  whether a label shows as `follow-up-sequence-soc-med` or `Follow Up Sequence
  Soc Med`. `CREATE_DEST_IF_MISSING = true` will CREATE a label on a typo —
  confirm names before first run.
- **`follow_up_sequence_threads` has RLS disabled** in MAGTestProject (documented
  pre-existing condition). service_role bypasses RLS regardless.
- Config is a block of `const`s at the top of `Code.gs`; the README's Config
  table mirrors it — update both together.

## Deploying a change

Edit `Code.gs` here, then paste it over the Apps Script project's `Code.gs` and
save. No new Script Property / OAuth scope is needed for changes that reuse
`SUPABASE_SERVICE_ROLE_KEY` and `UrlFetchApp`. The `process-bounced-leads` Edge
Function lives in Supabase (MAGTestProject, ref `aivitcomiywiysrfwqxt`) and has
its own secrets (`AC_API_URL`, `AC_API_TOKEN`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`) — those are separate from the Apps Script.

## Security

- `creds.txt` holds live secrets (ActiveCampaign token, Supabase access token)
  and is **gitignored** — never stage or commit it.
- Watch pasted cURL / snippets for keys before committing; publishable/anon keys
  are low-risk but service_role / `sbp_` / API tokens are not.
