# Gmail lead-response router — move a thread when the lead replies

A Google Apps Script that runs inside **james@myadventuregroup.com.au**'s mailbox. It watches the
outbound follow-up labels and, **only once a lead replies**, moves the whole thread to the
"to-action" label **and updates the thread's row in Supabase**.

It routes **two channels** (see the `CHANNELS` config in `Code.gs`) with identical logic — each has
its own source label, Supabase threads table, and bounce RPC:

| Channel | Source label (watched) | Threads table | Bounce RPC |
|---------|------------------------|---------------|------------|
| **soc-med** | `follow-up-sequence-soc-med` | `public.follow_up_sequence_threads` | `process_bounced_lead` |
| **cold** | `follow-up-sequence-cold-leads` | `public.cold_leads_follow_up_sequence_threads` | `process_bounced_cold_lead` |

Both channels share the same **destination** and **closed** labels and the same bounce Edge Function:

- **Destination (lead replied):** `@-sales-to-action-outbound-lead-responses`.
- **Closed (delivery failed/blocked):** `follow-up-sequence-closed`.
- **Lead reply sync:** on a lead-reply move, sets the matching row's `status = '8A'` and
  `status_update_date` (Sydney local time) in the channel's threads table (MAGTestProject), matched
  on `thread_id`.
- **Bounce handling:** bounced leads are **not** in the threads table. On a bounce, the script
  (1) calls the channel's `<bounce RPC>(_email_add_sent)` with the bounced recipient's email to
  **record** the bounce (it sets `status = '10A'` on the matched source-lead row and inserts into
  `public.bounced_leads`, tagging `lead_type` — `'soc med'` or `'cold'`), (2) invokes the
  **`process-bounced-leads` Edge Function** to push the recorded bounces to ActiveCampaign (adds a
  deal note, then marks the deal Lost), then (3) moves the thread to `follow-up-sequence-closed`. The
  Edge Function is lead-type-agnostic, so both channels' bounces flow through the same invocation.

## How it decides to move a thread

Every minute, **for each channel**, it looks at the **latest message** of each thread in that channel's
source label and routes based on who sent it:

| Event | Latest message | Result |
|-------|----------------|--------|
| James sends the first outbound / a follow-up | James (our domain) | **Stays** in the channel's source label |
| **Delivery failed / blocked** | postmaster or Mail Delivery Subsystem, saying *"Delivery has failed"* or *"Message blocked"* | Calls the channel's bounce RPC `<rpc>(<bounced email>)`, invokes the `process-bounced-leads` Edge Function, then **moves** to `follow-up-sequence-closed` |
| **Lead replies** | the lead (external, not a bounce/system sender) | **Moves** to `@-sales-to-action-outbound-lead-responses`, status → `8A` (in the channel's threads table) |
| Auto-reply / out-of-office from the lead | the lead (external) | Moves as a reply (counts as a response — see notes) |

The bounce/block check runs first, so a delivery-failure notice closes the thread rather than being
mistaken for anything else.

- **Cost:** $0. Apps Script time triggers and Gmail usage are free.
- **No OAuth client, refresh tokens, or Pub/Sub.** Auth is the standard Apps Script consent screen,
  shown once when James runs the script. The Supabase REST/RPC calls and the `process-bounced-leads`
  Edge Function invocation all use a service_role key stored in Script Properties (see setup).
- **Consistency:** the Supabase update runs **before** the label move, so a transient Supabase error
  leaves the thread in the source label to retry next sweep rather than moving it out of sync.
- **Idempotent:** once moved, the source label is removed, so the thread isn't reprocessed. Later
  replies stay on the thread under the destination label and never re-add the source label. Re-running
  the status update (`status='8A'`) is harmless.
- **Efficient:** each minute it only fetches message details for threads with activity in the last
  ~10 minutes, so Gmail read usage stays tiny even if the source label holds hundreds of open threads.

## Files
| File | What it is |
|------|------------|
| `Code.gs` | The automation (`moveThreads`) plus backlog + setup helpers. |
| `appsscript.json` | Project manifest — timezone + minimal OAuth scopes. |

## Setup (must be done while signed in as james@)

The script has to live under **James's** Google account (the mailbox being watched). If you are not
James, have James do these steps or do them while signed in to his account.

1. **New project** — go to <https://script.google.com> signed in as
   **james@myadventuregroup.com.au** → **New project**.
2. **Paste the code:**
   - Replace the default `Code.gs` with this repo's `Code.gs`.
   - Open **Project Settings** (gear) → tick **"Show 'appsscript.json' manifest file in editor"**.
   - Open `appsscript.json` in the editor and replace it with this repo's version. Save.
3. **Add the Supabase key** — still in **Project Settings** → **Script Properties** →
   **Add script property**: name `SUPABASE_SERVICE_ROLE_KEY`, value = the **service_role** key from
   Supabase → **Project Settings → API keys** (MAGTestProject, `aivitcomiywiysrfwqxt`). This key is
   secret; it lives only here, never in the code.
4. **Authorize (the auth screen)** — select **`testRunOnce`** → **Run** →
   **Review permissions → choose james@ → Advanced → Allow**. One-time. (The script now also requests
   permission to make external requests, for the Supabase call — if you had authorized an earlier
   version, you'll be re-prompted once to approve the new scope.)
5. **Clear any existing replied threads** — select **`processBacklogOnce`** → **Run**. This moves any
   thread already sitting in the source label whose latest message is a lead reply (and updates its
   Supabase row). The scheduled run only looks at the last ~10 minutes, so this catches older ones once.
6. **Schedule it** — select **`createEveryMinuteTrigger`** → **Run**. Installs the every-minute
   trigger. (Re-running is safe; it clears any old trigger first.)

## Verify it works
1. Find/create a test thread in `follow-up-sequence-soc-med` where the last message is from James →
   confirm it **stays** put after a minute.
2. Have an external address reply to that thread → within ~1 minute confirm it moves to
   `@-sales-to-action-outbound-lead-responses` and leaves the source label.
3. Confirm the Supabase row updated: in `public.follow_up_sequence_threads`, the row whose `thread_id`
   equals that thread's id now has `status = '8A'` and a fresh `status_update_date`
   (`select thread_id, status, status_update_date from public.follow_up_sequence_threads where thread_id = '<id>';`).
   Also confirm the reply was **recorded**: `process_lead_responses` was called with the lead's email
   (Executions log line `Called process_lead_responses for lead reply <email>`) and a matching row now
   exists in `public.lead_responses` (`select * from public.lead_responses where email = '<email>';`),
   with its `source_table`/`lead_type` and the ActiveCampaign ids looked up from the AC mirror tables.
4. **Bounce path:** send to an address that hard-fails (or forward a real postmaster/Mail Delivery
   Subsystem failure into a source-labelled thread as its latest message) → within ~1 minute confirm
   the thread moves to `follow-up-sequence-closed` and that `process_bounced_lead` was called with the
   bounced address (check the Executions log line `Called process_bounced_lead for bounced lead <email>`
   and/or the effect of that function in your data). The next log line, `Invoked process-bounced-leads
   Edge Function: ...`, confirms the ActiveCampaign push ran (deal note added + deal marked Lost).
5. Check **Executions** (left sidebar) for run logs, e.g. `... moved 1 ... bounced 1 ...`, plus any
   `Supabase: no row found ...` warnings (a lead-reply thread wasn't tracked — it's still moved).

## Config (top of `Code.gs`)
| Constant | Default | Meaning |
|----------|---------|---------|
| `CHANNELS` | soc-med + cold (see below) | List of channels to route. Each row = `{ name, sourceLabel, threadsTable, bounceRpc }`. |
| `DEST_LABEL_TOKEN` | `@-sales-to-action-outbound-lead-responses` | Label to move replied threads to (shared by all channels). |
| `CLOSED_LABEL_TOKEN` | `follow-up-sequence-closed` | Label to move bounced/blocked threads to (shared). |
| `OUR_DOMAIN` | `myadventuregroup.com.au` | A last message from this domain = us, not a lead reply. |
| `OUR_EXTRA_ADDRESSES` | `[]` | Extra addresses to treat as "us" (e.g. an external alias James sends from). |
| `SYSTEM_SENDER_HINTS` | mailer-daemon/postmaster/google no-reply | Senders ignored (bounces/automated). |
| `ACTIVE_WINDOW_MINUTES` | `10` | Scheduled runs only inspect threads active within this window. |
| `BATCH_SIZE` | `150` | Max threads examined per channel per run. |
| `CREATE_DEST_IF_MISSING` | `true` | Create the destination label if not found. |
| `SUPABASE_URL` | `https://aivitcomiywiysrfwqxt.supabase.co` | MAGTestProject REST endpoint. |
| `REPLIED_STATUS` | `8A` | Status set on the thread's row when the lead replies. |
| `LEAD_RESPONSE_RPC` | `process_lead_responses` | RPC that records a lead reply into `public.lead_responses` (single cross-channel function; takes `_email_add_sent`). |
| `BOUNCE_RPC_ARG` | `_email_add_sent` | Argument name shared by every channel's bounce RPC. |
| `BOUNCE_EDGE_FUNCTION` | `process-bounced-leads` | Edge Function invoked after the RPC to push recorded bounces to ActiveCampaign. |
| `STATUS_DATE_TIMEZONE` | `Australia/Sydney` | Timezone used to stamp `status_update_date`. |
| `SUPABASE_KEY_PROPERTY` | `SUPABASE_SERVICE_ROLE_KEY` | Script Property name holding the service_role key. |

**`CHANNELS` rows:**

| `name` | `sourceLabel` | `threadsTable` | `bounceRpc` |
|--------|---------------|----------------|-------------|
| `soc-med` | `follow-up-sequence-soc-med` | `follow_up_sequence_threads` | `process_bounced_lead` |
| `cold` | `follow-up-sequence-cold-leads` | `cold_leads_follow_up_sequence_threads` | `process_bounced_cold_lead` |

To add another channel, append a row — no other code changes needed.

**Label names vs. tokens:** the label values are Gmail `label:` **search tokens** (spaces become
hyphens). The script matches them against your real labels by normalizing names, so it works whether a
label displays as `follow-up-sequence-soc-med` or `Follow Up Sequence Soc Med`.

> ⚠️ Confirm the destination label already exists with the expected name before first run. With
> `CREATE_DEST_IF_MISSING = true`, a typo or differently-formatted name would create a *new* label.

## Notes & edge cases
- **James's own follow-ups never move the thread** — the last message is from your domain, so it waits
  for a genuine lead reply.
- **Does James sending a follow-up trigger a move?** No. Only a message from an external (lead) sender
  does. Sending a reply doesn't add/remove labels either.
- **Auto-replies / out-of-office** from the lead's address count as a response and will move the
  thread. If you want to exclude these, add sender hints to `SYSTEM_SENDER_HINTS`.
- **Bounces / blocks** are detected on the latest message from postmaster or Mail Delivery Subsystem
  whose subject/body contains *"Delivery has failed"* or *"Message blocked"*. The bounced recipient's
  email is taken from the address our outbound message(s) in that thread were sent to, then the
  channel's bounce RPC (`process_bounced_lead` for soc-med, `process_bounced_cold_lead` for cold) is
  called with `<email>` to record it, the `process-bounced-leads` Edge Function is invoked to push it
  to ActiveCampaign, and finally the thread is moved to `follow-up-sequence-closed`.
  Other automated notices (e.g. "delayed") are ignored and the thread stays. If your provider phrases
  failures differently, add the phrase to `isBounceOrBlocked_`.
- **Edge Function step:** `process-bounced-leads` takes no arguments — it processes **every** pending
  row in `public.bounced_leads` (adds a deal note, marks the deal Lost) and is idempotent, so invoking
  it once per bounce is safe. It's called **after** the RPC and **before** the label move, so a failure
  (e.g. ActiveCampaign or the function being down) leaves the thread in the source label and both steps
  retry on the next sweep. It authenticates with the same service_role key from Script Properties
  (`SUPABASE_SERVICE_ROLE_KEY`), which also serves as the `apikey` the Functions gateway requires.
- **Bounce = RPC only, no table row:** the bounce path never touches the channel's threads table. If
  the bounced recipient can't be determined from the thread, the thread is left in place and a warning
  is logged. The RPC is called **before** the label move, so a transient failure retries next sweep —
  both `process_bounced_lead` and `process_bounced_cold_lead` are safe to call more than once for the
  same email (they de-dup on `email` against `bounced_leads`).
- **Closed label:** if `follow-up-sequence-closed` doesn't exist it's auto-created (same
  `CREATE_DEST_IF_MISSING` flag); confirm the intended label exists to avoid a differently-named
  duplicate.
- **If James sends from a different external address** (not @myadventuregroup.com.au), add it to
  `OUR_EXTRA_ADDRESSES` so his messages aren't mistaken for a lead reply.
- **Colleagues at your domain** as the last sender are treated as "us" (no move).
- **Untracked threads:** if a transferred thread has no matching `thread_id` row, the update logs a
  `Supabase: no row found` warning and the thread is still moved (the DB write isn't a gate).

## Supabase / security note
- The status update calls the Supabase REST API directly from `Code.gs` with the **service_role** key
  from Script Properties. Keep that key secret — anyone who can edit this Apps Script can read it.
- ⚠️ **Row Level Security is currently disabled** on `follow_up_sequence_threads` (and several other
  tables in MAGTestProject). That means the project's anon key can already read/modify every row —
  a pre-existing condition, not introduced by this automation. Using the service_role key here means
  the update keeps working if/when RLS is enabled. If you enable RLS, add a policy (or keep using
  service_role, which bypasses RLS) so this update isn't blocked.

## Turning it off
Run **`deleteTriggers`** (or delete the trigger under the **Triggers** clock icon). The code can stay;
with no trigger it never runs.
