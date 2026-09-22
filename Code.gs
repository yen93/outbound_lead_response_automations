/**
 * Gmail lead-response router for james@myadventuregroup.com.au
 * ------------------------------------------------------------
 * Each source label (see CHANNELS: soc-med + cold) holds OUTBOUND follow-up
 * threads James started. They should STAY there while James keeps following up,
 * and only move to the destination label once a LEAD REPLIES.
 *
 * Trigger rule: a thread is moved only when the LAST message in the thread is
 * from a lead — i.e. a sender outside our own domain (and not a bounce/system
 * sender). James's own follow-ups leave the last message as "ours", so the
 * thread stays put until a lead actually responds.
 *
 * Two Supabase side effects, each run BEFORE the label move so a transient error
 * leaves the thread in place to retry next sweep (no silent desync). Each channel
 * uses its own threads table + bounce RPC (see CHANNELS); the dest/closed labels
 * and the bounce Edge Function are shared:
 *   - Lead reply  → set <channel.threadsTable>.status = REPLIED_STATUS on the
 *                   row matched by thread_id, and stamp status_update_date.
 *   - Bounce/block → call the channel's bounce RPC (process_bounced_lead for
 *                    soc-med, process_bounced_cold_lead for cold), taking
 *                    _email_add_sent, with the bounced recipient's email (bounced
 *                    leads are NOT in the threads table) to record it, then invoke
 *                    the process-bounced-leads Edge Function to push those bounced
 *                    leads to ActiveCampaign (deal note + mark Lost), then move the
 *                    thread to CLOSED_LABEL_TOKEN.
 *   Bounce detection: latest message from postmaster / Mail Delivery Subsystem
 *   saying "Delivery has failed" or "Message blocked".
 *
 * Runs on a 1-minute time trigger. Idempotent: once moved, the source label is
 * removed, so the thread is never reprocessed (further replies land in the
 * destination label's thread and don't re-add the source label).
 *
 * Setup: see README.md. Add the SUPABASE_SERVICE_ROLE_KEY Script Property, run
 * testRunOnce() once to authorize, run processBacklogOnce() once to clear any
 * already-replied threads, then run createEveryMinuteTrigger() to schedule it.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Channels processed each sweep. The routing logic is identical for every
 * channel — only three things differ, so each channel is one config row:
 *   - sourceLabel  : Gmail "label:" search token to watch (outbound follow-ups).
 *   - threadsTable : Supabase table whose row (matched on thread_id) gets
 *                    status = REPLIED_STATUS on a lead reply.
 *   - bounceRpc    : Postgres function (PostgREST RPC) called on a bounce to
 *                    record it into public.bounced_leads.
 * Everything else (dest/closed labels, REPLIED_STATUS, the RPC arg name, the
 * Edge Function, domain, windows, timezone, key property) is shared below.
 * The bounce Edge Function (process-bounced-leads) is lead-type-agnostic, so
 * both channels' bounces flow through the same invocation.
 */
const CHANNELS = [
  {
    name: 'soc-med',
    sourceLabel: 'follow-up-sequence-soc-med',
    threadsTable: 'follow_up_sequence_threads',
    bounceRpc: 'process_bounced_lead'
  },
  {
    name: 'cold',
    sourceLabel: 'follow-up-sequence-cold-leads',
    threadsTable: 'cold_leads_follow_up_sequence_threads',
    bounceRpc: 'process_bounced_cold_lead'
  }
];

/** Gmail "label:" search token for the label to move replied-to threads into. */
const DEST_LABEL_TOKEN = '@-sales-to-action-outbound-lead-responses';

/** Gmail "label:" search token for the label to move bounced/blocked threads into. */
const CLOSED_LABEL_TOKEN = 'follow-up-sequence-closed';

/** Our own domain. A last message from this domain = James/us, NOT a lead reply. */
const OUR_DOMAIN = 'myadventuregroup.com.au';

/** Any extra addresses that should also count as "us" (lowercase, optional). */
const OUR_EXTRA_ADDRESSES = [];

/** Bounce / system senders that must NOT be treated as a lead reply. */
const SYSTEM_SENDER_HINTS = ['mailer-daemon', 'postmaster', 'no-reply@google', 'noreply@google'];

/**
 * On each scheduled run, only inspect threads whose most recent message arrived
 * within this many minutes. Keeps Gmail read usage tiny (we only fetch messages
 * for threads with fresh activity) while giving several sweeps of retry room.
 */
const ACTIVE_WINDOW_MINUTES = 10;

/** Max threads to look at per run. */
const BATCH_SIZE = 150;

/** If the destination label can't be found, create it (with the literal token as its name). */
const CREATE_DEST_IF_MISSING = true;

// --- Supabase --------------------------------------------------------------
// Lead reply  → set follow_up_sequence_threads.status = REPLIED_STATUS (matched on thread_id).
// Bounce/block → call the process_bounced_lead RPC with the bounced recipient's email.
//               (Bounced leads are NOT tracked in follow_up_sequence_threads.)

/** Supabase project URL (MAGTestProject). */
const SUPABASE_URL = 'https://aivitcomiywiysrfwqxt.supabase.co';

/** Status set on a thread's row once the lead has replied and it's been actioned. */
const REPLIED_STATUS = '8A';

/**
 * Argument name shared by every channel's bounce RPC (each channel's function
 * name lives in CHANNELS[].bounceRpc). Both process_bounced_lead and
 * process_bounced_cold_lead take a single `_email_add_sent` text arg.
 */
const BOUNCE_RPC_ARG = '_email_add_sent';

/**
 * Supabase Edge Function (Functions endpoint) that processes the recorded bounced
 * leads against ActiveCampaign (adds a deal note, then marks the deal Lost). Called
 * after the RPC records a bounce. Takes no arguments — it acts on every pending row
 * in public.bounced_leads and is idempotent — so it's safe to invoke per bounce.
 */
const BOUNCE_EDGE_FUNCTION = 'process-bounced-leads';

/** Name of the Script Property that holds the Supabase service_role key (never hardcode the key). */
const SUPABASE_KEY_PROPERTY = 'SUPABASE_SERVICE_ROLE_KEY';

/**
 * Timezone used to stamp status_update_date (a `timestamp without time zone`
 * column). Sydney local wall-clock time, matching the project timezone.
 */
const STATUS_DATE_TIMEZONE = 'Australia/Sydney';

// ---------------------------------------------------------------------------
// Main (scheduled)
// ---------------------------------------------------------------------------

/**
 * Scheduled entry point. Routes threads whose latest message is a lead reply
 * (→ to-action) or a delivery failure/block (→ closed), limited to threads with
 * activity in the last ACTIVE_WINDOW_MINUTES.
 */
function moveThreads() {
  processRepliedThreads_(ACTIVE_WINDOW_MINUTES);
}

/**
 * One-time cleanup: scan the whole source label (up to BATCH_SIZE) with no time
 * window, and route every thread whose latest message is already a lead reply or a
 * bounce/block. Run this once after deploying to clear any pre-existing threads.
 */
function processBacklogOnce() {
  processRepliedThreads_(null);
}

/**
 * Core routine. Resolves the shared destination/closed labels once, then routes
 * every channel in CHANNELS (soc-med + cold) under a single script-wide lock.
 * @param {number|null} windowMinutes  Only inspect threads active within this many
 *                                     minutes; null = no time filter (backlog mode).
 */
function processRepliedThreads_(windowMinutes) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    console.log('Another run is in progress; skipping this tick.');
    return;
  }

  try {
    const dest = resolveLabel_(DEST_LABEL_TOKEN, CREATE_DEST_IF_MISSING);
    if (!dest) {
      console.log('Destination label not found and CREATE_DEST_IF_MISSING is false: "' +
                  DEST_LABEL_TOKEN + '". Aborting.');
      return;
    }

    // Closed label is optional: if missing we still handle lead replies, just skip bounces.
    const closed = resolveLabel_(CLOSED_LABEL_TOKEN, CREATE_DEST_IF_MISSING);
    if (!closed) {
      console.warn('Closed label not found: "' + CLOSED_LABEL_TOKEN +
                   '". Bounced/blocked threads will be left in place this run.');
    }

    for (let c = 0; c < CHANNELS.length; c++) {
      processChannel_(CHANNELS[c], dest, closed, windowMinutes);
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Route one channel's source label. Threads whose latest message is a lead reply
 * move to `dest` (status → REPLIED_STATUS on the channel's threads table); threads
 * whose latest message is a bounce/block call the channel's bounce RPC, invoke the
 * shared Edge Function, then move to `closed`. Every Supabase side-effect runs
 * BEFORE the label move, so a transient failure leaves the thread in the source
 * label to retry next sweep.
 * @param {{name:string, sourceLabel:string, threadsTable:string, bounceRpc:string}} channel
 * @param {GmailLabel} dest
 * @param {GmailLabel|null} closed
 * @param {number|null} windowMinutes
 */
function processChannel_(channel, dest, closed, windowMinutes) {
  const source = resolveLabel_(channel.sourceLabel, false);
  if (!source) {
    console.log('[' + channel.name + '] Source label not found: "' +
                channel.sourceLabel + '". Skipping this channel.');
    return;
  }

  // Newest-activity-first: fresh activity (a reply or a bounce) bumps its thread to the top.
  const threads = GmailApp.search('label:' + channel.sourceLabel, 0, BATCH_SIZE);
  if (threads.length === 0) {
    return;
  }

  const cutoffMs = windowMinutes == null ? null : (Date.now() - windowMinutes * 60 * 1000);

  let inspected = 0;
  let moved = 0;
  let closedCount = 0;
  for (let i = 0; i < threads.length; i++) {
    const thread = threads[i];

    // Cheap metadata check: skip threads with no recent activity (no message fetch).
    if (cutoffMs != null && thread.getLastMessageDate().getTime() < cutoffMs) {
      continue;
    }

    inspected++;
    const msgs = thread.getMessages();
    const last = msgs[msgs.length - 1];

    if (isBounceOrBlocked_(last)) {
      // Delivery failed / blocked → call the channel's bounce RPC(email), then close the thread.
      if (!closed) {
        continue;
      }
      const bouncedEmail = getBouncedEmail_(thread);
      if (!bouncedEmail) {
        console.warn('[' + channel.name + '] Bounce detected on thread ' + thread.getId() +
                     ' but could not determine the bounced recipient; leaving in place.');
        continue;
      }
      // RPC first (records the bounce): if it fails, leave the thread in source
      // to retry next sweep.
      if (!processBouncedLead_(bouncedEmail, channel.bounceRpc)) {
        continue;
      }
      // Then push the recorded bounce(s) to ActiveCampaign via the shared Edge
      // Function. Same retry philosophy: on failure, leave the thread in place so
      // the next sweep re-runs both steps (both are idempotent).
      if (!invokeProcessBouncedLeadsFunction_()) {
        continue;
      }
      if (moveLabels_(thread, closed, source)) {
        closedCount++;
      }
    } else if (isLeadReply_(last.getFrom())) {
      // Lead replied → move to the to-action label.
      if (transferThread_(thread, dest, source, REPLIED_STATUS, channel.threadsTable)) {
        moved++;
      }
    }
  }

  if (moved > 0 || closedCount > 0 || windowMinutes == null) {
    console.log('[' + channel.name + '] Inspected ' + inspected + ' thread(s); moved ' +
                moved + ' (lead reply → "' + DEST_LABEL_TOKEN + '"), bounced ' + closedCount +
                ' (' + channel.bounceRpc + ' → "' + CLOSED_LABEL_TOKEN + '").');
  }
}

/**
 * Update Supabase status (DB first) then relabel a thread. If the Supabase update
 * fails, the thread is left in place so it retries next sweep.
 * @param {string} table  The channel's threads table to update (matched on thread_id).
 * @return {boolean} true if the thread was moved.
 */
function transferThread_(thread, destLabel, sourceLabel, status, table) {
  if (!updateThreadStatus_(thread.getId(), status, table)) {
    return false;
  }
  return moveLabels_(thread, destLabel, sourceLabel);
}

/**
 * Relabel a thread: add destLabel, remove sourceLabel.
 * @return {boolean} true on success.
 */
function moveLabels_(thread, destLabel, sourceLabel) {
  try {
    thread.addLabel(destLabel);
    thread.removeLabel(sourceLabel);
    return true;
  } catch (err) {
    console.error('Failed to move thread ' + thread.getId() + ': ' + err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Decide whether a message is a delivery failure / block notification:
 * from postmaster or the Mail Delivery Subsystem (mailer-daemon), whose subject
 * or body says "Delivery has failed" or "Message blocked".
 * @param {GmailMessage} message
 * @return {boolean}
 */
function isBounceOrBlocked_(message) {
  const from = String(message.getFrom() || '').toLowerCase();
  const fromSystemSender = from.indexOf('postmaster') !== -1 ||
                           from.indexOf('mailer-daemon') !== -1 ||
                           from.indexOf('mail delivery subsystem') !== -1;
  if (!fromSystemSender) {
    return false;
  }

  let body = '';
  try {
    body = message.getPlainBody() || '';
  } catch (e) {
    body = '';
  }
  const text = (String(message.getSubject() || '') + ' ' + body).toLowerCase();

  return text.indexOf('delivery has failed') !== -1 ||
         text.indexOf('message blocked') !== -1;
}

/**
 * Decide whether a message's "From" header represents a lead reply, i.e. an
 * external sender that is not one of our addresses and not a bounce/system sender.
 * @param {string} fromHeader  e.g. "Jane Doe <jane@leadco.com>" or "jane@leadco.com".
 * @return {boolean}
 */
function isLeadReply_(fromHeader) {
  return isExternalLeadAddress_(extractEmail_(fromHeader));
}

/** True if the email is an external lead (not ours, not a system/bounce sender). */
function isExternalLeadAddress_(email) {
  return !!email && !isOurAddress_(email) && !isSystemSender_(email);
}

/** True if the email is one of ours (James / colleagues / configured aliases). */
function isOurAddress_(email) {
  if (email.indexOf('@' + OUR_DOMAIN.toLowerCase()) !== -1) {
    return true;
  }
  return OUR_EXTRA_ADDRESSES.map(function (a) { return a.toLowerCase(); }).indexOf(email) !== -1;
}

/** True if the email looks like an automated / bounce system sender. */
function isSystemSender_(email) {
  for (let i = 0; i < SYSTEM_SENDER_HINTS.length; i++) {
    if (email.indexOf(SYSTEM_SENDER_HINTS[i].toLowerCase()) !== -1) {
      return true;
    }
  }
  return false;
}

/**
 * Find the bounced recipient's email for a thread: the external (lead) address
 * that our outbound message(s) in the thread were sent to. Scans newest-first so
 * the most recent send (the one that most likely bounced) wins.
 * @param {GmailThread} thread
 * @return {string} lowercase email, or '' if none found.
 */
function getBouncedEmail_(thread) {
  const msgs = thread.getMessages();
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    const from = extractEmail_(m.getFrom());
    if (!from || !isOurAddress_(from)) {
      continue; // only look at messages WE sent
    }
    let recips = extractEmails_(m.getTo());
    recips = recips.concat(extractEmails_(m.getCc()));
    for (let j = 0; j < recips.length; j++) {
      if (isExternalLeadAddress_(recips[j])) {
        return recips[j];
      }
    }
  }
  return '';
}

/**
 * Extract a lowercase email address from a single "From"-style header value.
 * @param {string} headerValue
 * @return {string} lowercase email, or '' if none found.
 */
function extractEmail_(headerValue) {
  const all = extractEmails_(headerValue);
  return all.length ? all[0] : '';
}

/**
 * Extract all lowercase email addresses from a header value that may list several
 * recipients (e.g. a "To"/"Cc" header).
 * @param {string} headerValue
 * @return {string[]}
 */
function extractEmails_(headerValue) {
  if (!headerValue) {
    return [];
  }
  const matches = String(headerValue).match(/[^\s<>@,;"']+@[^\s<>@,;"']+/g);
  if (!matches) {
    return [];
  }
  return matches.map(function (e) { return e.trim().toLowerCase(); });
}

// ---------------------------------------------------------------------------
// Supabase status sync
// ---------------------------------------------------------------------------

/**
 * Set status = <status> and status_update_date = now (Sydney local) on the given
 * threads table's row whose thread_id matches the given Gmail thread id, via the
 * Supabase REST (PostgREST) API.
 *
 * @param {string} threadId  Gmail thread id (thread.getId()).
 * @param {string} status    New status value (e.g. REPLIED_STATUS).
 * @param {string} table     The channel's threads table (e.g. follow_up_sequence_threads
 *                           or cold_leads_follow_up_sequence_threads).
 * @return {boolean} true on HTTP 2xx (including "no matching row" — logged as a
 *                   warning so an untracked thread doesn't block routing); false
 *                   on a missing key, non-2xx response, or thrown error.
 */
function updateThreadStatus_(threadId, status, table) {
  const key = PropertiesService.getScriptProperties().getProperty(SUPABASE_KEY_PROPERTY);
  if (!key) {
    console.error('Missing Script Property "' + SUPABASE_KEY_PROPERTY +
                  '"; cannot update Supabase. Set it in Project Settings → Script Properties.');
    return false;
  }

  const url = SUPABASE_URL + '/rest/v1/' + table +
              '?thread_id=eq.' + encodeURIComponent(threadId);

  // Local wall-clock stamp for the `timestamp without time zone` column, e.g. 2026-09-21T14:05:09.
  const stamp = Utilities.formatDate(new Date(), STATUS_DATE_TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss");

  const options = {
    method: 'patch',
    contentType: 'application/json',
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      Prefer: 'return=representation'
    },
    payload: JSON.stringify({ status: status, status_update_date: stamp }),
    muteHttpExceptions: true
  };

  try {
    const resp = UrlFetchApp.fetch(url, options);
    const code = resp.getResponseCode();
    const body = resp.getContentText();

    if (code >= 200 && code < 300) {
      let rows = [];
      try {
        rows = JSON.parse(body);
      } catch (e) {
        rows = [];
      }
      if (!rows || rows.length === 0) {
        console.warn('Supabase: no row found for thread_id ' + threadId +
                     ' (thread will still be moved).');
      }
      return true;
    }

    console.error('Supabase update failed for thread_id ' + threadId +
                  ' (HTTP ' + code + '): ' + body);
    return false;
  } catch (err) {
    console.error('Supabase request error for thread_id ' + threadId + ': ' + err);
    return false;
  }
}

/**
 * Call the given bounce Postgres function (e.g. process_bounced_lead or
 * process_bounced_cold_lead), which takes a single _email_add_sent arg, via the
 * Supabase PostgREST RPC endpoint, passing the bounced recipient's email.
 *
 * @param {string} email  The address that bounced.
 * @param {string} rpc    The channel's bounce RPC name (CHANNELS[].bounceRpc).
 * @return {boolean} true on HTTP 2xx; false on a missing key, non-2xx, or thrown error.
 */
function processBouncedLead_(email, rpc) {
  const key = PropertiesService.getScriptProperties().getProperty(SUPABASE_KEY_PROPERTY);
  if (!key) {
    console.error('Missing Script Property "' + SUPABASE_KEY_PROPERTY +
                  '"; cannot call ' + rpc + '. Set it in Project Settings → Script Properties.');
    return false;
  }

  const url = SUPABASE_URL + '/rest/v1/rpc/' + rpc;

  const payload = {};
  payload[BOUNCE_RPC_ARG] = email;

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const resp = UrlFetchApp.fetch(url, options);
    const code = resp.getResponseCode();
    if (code >= 200 && code < 300) {
      console.log('Called ' + rpc + ' for bounced lead ' + email + '.');
      return true;
    }
    console.error('Supabase RPC ' + rpc + ' failed for ' + email +
                  ' (HTTP ' + code + '): ' + resp.getContentText());
    return false;
  } catch (err) {
    console.error('Supabase RPC ' + rpc + ' error for ' + email + ': ' + err);
    return false;
  }
}

/**
 * Invoke the process-bounced-leads Supabase Edge Function, which processes every
 * pending row in public.bounced_leads against ActiveCampaign (adds a deal note,
 * then marks the deal Lost). The function takes no arguments — it acts on all
 * unprocessed rows and is idempotent — so it's safe to call once per bounce.
 *
 * Uses the same service_role key from Script Properties as the REST/RPC calls; it
 * doubles as the apikey the Functions gateway requires (the function itself has
 * verify_jwt disabled).
 *
 * @return {boolean} true on HTTP 2xx; false on a missing key, non-2xx, or thrown error.
 */
function invokeProcessBouncedLeadsFunction_() {
  const key = PropertiesService.getScriptProperties().getProperty(SUPABASE_KEY_PROPERTY);
  if (!key) {
    console.error('Missing Script Property "' + SUPABASE_KEY_PROPERTY +
                  '"; cannot invoke the ' + BOUNCE_EDGE_FUNCTION + ' Edge Function.');
    return false;
  }

  const url = SUPABASE_URL + '/functions/v1/' + BOUNCE_EDGE_FUNCTION;

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key
    },
    payload: JSON.stringify({}),
    muteHttpExceptions: true
  };

  try {
    const resp = UrlFetchApp.fetch(url, options);
    const code = resp.getResponseCode();
    if (code >= 200 && code < 300) {
      console.log('Invoked ' + BOUNCE_EDGE_FUNCTION + ' Edge Function: ' + resp.getContentText());
      return true;
    }
    console.error('Edge Function ' + BOUNCE_EDGE_FUNCTION + ' failed (HTTP ' + code + '): ' +
                  resp.getContentText());
    return false;
  } catch (err) {
    console.error('Edge Function ' + BOUNCE_EDGE_FUNCTION + ' request error: ' + err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Label resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a GmailLabel from a Gmail "label:" search token. The token is not
 * always the display name (Gmail turns spaces/slashes into hyphens), so we match
 * on a normalized form of each user label's name.
 * @param {string} token
 * @param {boolean} createIfMissing
 * @return {GmailLabel|null}
 */
function resolveLabel_(token, createIfMissing) {
  const target = normalizeLabel_(token);
  const labels = GmailApp.getUserLabels();
  for (let i = 0; i < labels.length; i++) {
    if (normalizeLabel_(labels[i].getName()) === target) {
      return labels[i];
    }
  }
  if (createIfMissing) {
    console.log('Creating missing label: "' + token + '".');
    return GmailApp.createLabel(token);
  }
  return null;
}

/** Lowercase + collapse whitespace/slashes to single hyphens (Gmail label: token rules). */
function normalizeLabel_(name) {
  return String(name).toLowerCase().replace(/[\s\/]+/g, '-');
}

// ---------------------------------------------------------------------------
// Trigger management / setup
// ---------------------------------------------------------------------------

/**
 * Install a time-driven trigger that runs moveThreads() every minute.
 * Safe to run more than once: it clears existing moveThreads triggers first.
 */
function createEveryMinuteTrigger() {
  deleteTriggers();
  ScriptApp.newTrigger('moveThreads')
    .timeBased()
    .everyMinutes(1)
    .create();
  console.log('Trigger installed: moveThreads() every 1 minute.');
}

/** Remove all triggers for moveThreads() (the off switch). */
function deleteTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'moveThreads') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  console.log('Removed ' + removed + ' existing moveThreads trigger(s).');
}

/**
 * Run one scheduled-style sweep manually. Use this the first time to trigger the
 * Gmail authorization prompt and to sanity-check behaviour before scheduling.
 */
function testRunOnce() {
  moveThreads();
}
