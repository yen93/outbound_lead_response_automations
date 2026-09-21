# Gmail lead-response router — move a thread when the lead replies

A Google Apps Script that runs inside **james@myadventuregroup.com.au**'s mailbox. It watches the
outbound follow-up label and, **only once a lead replies**, moves the whole thread to the
"to-action" label.

- **Source (watched):** `follow-up-sequence-soc-med` — where James's outbound follow-up threads live.
- **Destination:** `@-sales-to-action-outbound-lead-responses` — where a thread goes after a lead responds.

## How it decides to move a thread

Every minute it looks at threads in the source label and moves a thread **only when the last message
in it is from a lead** — i.e. a sender **outside `myadventuregroup.com.au`** (and not a bounce/system
sender). This means:

| Event | Last message is from… | Result |
|-------|-----------------------|--------|
| James sends the first outbound / a follow-up | James (our domain) | **Stays** in `follow-up-sequence-soc-med` |
| **Lead replies** | the lead (external) | **Moves** to `@-sales-to-action-outbound-lead-responses` |
| Auto-reply / out-of-office from the lead | the lead (external) | Moves (counts as a response — see notes) |
| Bounce (mailer-daemon/postmaster) | system sender | **Stays** (ignored) |

- **Cost:** $0. Apps Script time triggers and Gmail usage are free.
- **No OAuth client, refresh tokens, Pub/Sub, or Supabase.** Auth is the standard Apps Script consent
  screen, shown once when James runs the script.
- **Idempotent:** once moved, the source label is removed, so the thread isn't reprocessed. Later
  replies stay on the thread under the destination label and never re-add the source label.
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
3. **Authorize (the auth screen)** — select **`testRunOnce`** → **Run** →
   **Review permissions → choose james@ → Advanced → Allow**. One-time.
4. **Clear any existing replied threads** — select **`processBacklogOnce`** → **Run**. This moves any
   thread already sitting in the source label whose latest message is a lead reply (the scheduled run
   only looks at the last ~10 minutes, so this catches older ones once).
5. **Schedule it** — select **`createEveryMinuteTrigger`** → **Run**. Installs the every-minute
   trigger. (Re-running is safe; it clears any old trigger first.)

## Verify it works
1. Find/create a test thread in `follow-up-sequence-soc-med` where the last message is from James →
   confirm it **stays** put after a minute.
2. Have an external address reply to that thread → within ~1 minute confirm it moves to
   `@-sales-to-action-outbound-lead-responses` and leaves the source label.
3. Check **Executions** (left sidebar) for run logs, e.g. `Inspected 1 thread(s); moved 1 ...`.

## Config (top of `Code.gs`)
| Constant | Default | Meaning |
|----------|---------|---------|
| `SOURCE_LABEL_TOKEN` | `follow-up-sequence-soc-med` | Label to watch (Gmail `label:` search token). |
| `DEST_LABEL_TOKEN` | `@-sales-to-action-outbound-lead-responses` | Label to move replied threads to. |
| `OUR_DOMAIN` | `myadventuregroup.com.au` | A last message from this domain = us, not a lead reply. |
| `OUR_EXTRA_ADDRESSES` | `[]` | Extra addresses to treat as "us" (e.g. an external alias James sends from). |
| `SYSTEM_SENDER_HINTS` | mailer-daemon/postmaster/google no-reply | Senders ignored (bounces/automated). |
| `ACTIVE_WINDOW_MINUTES` | `10` | Scheduled runs only inspect threads active within this window. |
| `BATCH_SIZE` | `150` | Max threads examined per run. |
| `CREATE_DEST_IF_MISSING` | `true` | Create the destination label if not found. |

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
- **Bounces** (mailer-daemon/postmaster) are ignored, so a failed send won't move the thread.
- **If James sends from a different external address** (not @myadventuregroup.com.au), add it to
  `OUR_EXTRA_ADDRESSES` so his messages aren't mistaken for a lead reply.
- **Colleagues at your domain** as the last sender are treated as "us" (no move).

## Turning it off
Run **`deleteTriggers`** (or delete the trigger under the **Triggers** clock icon). The code can stay;
with no trigger it never runs.
