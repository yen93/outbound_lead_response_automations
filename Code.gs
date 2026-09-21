/**
 * Gmail lead-response router for james@myadventuregroup.com.au
 * ------------------------------------------------------------
 * The source label holds OUTBOUND follow-up threads James started. They should
 * STAY there while James keeps following up, and only move to the destination
 * label once a LEAD REPLIES.
 *
 * Trigger rule: a thread is moved only when the LAST message in the thread is
 * from a lead — i.e. a sender outside our own domain (and not a bounce/system
 * sender). James's own follow-ups leave the last message as "ours", so the
 * thread stays put until a lead actually responds.
 *
 * Runs on a 1-minute time trigger. Idempotent: once moved, the source label is
 * removed, so the thread is never reprocessed (further replies land in the
 * destination label's thread and don't re-add the source label).
 *
 * Setup: see README.md. Run testRunOnce() once to authorize, run
 * processBacklogOnce() once to clear any already-replied threads, then run
 * createEveryMinuteTrigger() to schedule it.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Gmail "label:" search token for the label to watch (outbound follow-ups). */
const SOURCE_LABEL_TOKEN = 'follow-up-sequence-soc-med';

/** Gmail "label:" search token for the label to move replied-to threads into. */
const DEST_LABEL_TOKEN = '@-sales-to-action-outbound-lead-responses';

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

// ---------------------------------------------------------------------------
// Main (scheduled)
// ---------------------------------------------------------------------------

/**
 * Scheduled entry point. Moves threads whose latest message is a lead reply,
 * limited to threads with activity in the last ACTIVE_WINDOW_MINUTES.
 */
function moveThreads() {
  processRepliedThreads_(ACTIVE_WINDOW_MINUTES);
}

/**
 * One-time cleanup: scan the whole source label (up to BATCH_SIZE) with no time
 * window, and move every thread whose latest message is already a lead reply.
 * Run this once after deploying to clear any pre-existing replied threads.
 */
function processBacklogOnce() {
  processRepliedThreads_(null);
}

/**
 * Core routine.
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
    const source = resolveLabel_(SOURCE_LABEL_TOKEN, false);
    if (!source) {
      console.log('Source label not found: "' + SOURCE_LABEL_TOKEN + '". Nothing to do.');
      return;
    }

    const dest = resolveLabel_(DEST_LABEL_TOKEN, CREATE_DEST_IF_MISSING);
    if (!dest) {
      console.log('Destination label not found and CREATE_DEST_IF_MISSING is false: "' +
                  DEST_LABEL_TOKEN + '". Aborting.');
      return;
    }

    // Newest-activity-first: a fresh lead reply bumps its thread to the top.
    const threads = GmailApp.search('label:' + SOURCE_LABEL_TOKEN, 0, BATCH_SIZE);
    if (threads.length === 0) {
      return;
    }

    const cutoffMs = windowMinutes == null ? null : (Date.now() - windowMinutes * 60 * 1000);

    let inspected = 0;
    let moved = 0;
    for (let i = 0; i < threads.length; i++) {
      const thread = threads[i];

      // Cheap metadata check: skip threads with no recent activity (no message fetch).
      if (cutoffMs != null && thread.getLastMessageDate().getTime() < cutoffMs) {
        continue;
      }

      inspected++;
      const msgs = thread.getMessages();
      const last = msgs[msgs.length - 1];

      if (isLeadReply_(last.getFrom())) {
        try {
          thread.addLabel(dest);
          thread.removeLabel(source);
          moved++;
        } catch (err) {
          console.error('Failed to move thread ' + thread.getId() + ': ' + err);
        }
      }
    }

    if (moved > 0 || windowMinutes == null) {
      console.log('Inspected ' + inspected + ' thread(s); moved ' + moved +
                  ' with a lead reply from "' + SOURCE_LABEL_TOKEN + '" to "' + DEST_LABEL_TOKEN + '".');
    }
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Decide whether a message's "From" header represents a lead reply, i.e. an
 * external sender that is not one of our addresses and not a bounce/system sender.
 * @param {string} fromHeader  e.g. "Jane Doe <jane@leadco.com>" or "jane@leadco.com".
 * @return {boolean}
 */
function isLeadReply_(fromHeader) {
  const email = extractEmail_(fromHeader);
  if (!email) {
    return false;
  }

  // Ours (James / colleagues) → not a lead reply.
  if (email.indexOf('@' + OUR_DOMAIN.toLowerCase()) !== -1) {
    return false;
  }
  if (OUR_EXTRA_ADDRESSES.map(function (a) { return a.toLowerCase(); }).indexOf(email) !== -1) {
    return false;
  }

  // Bounces / automated system senders → not a lead reply.
  for (let i = 0; i < SYSTEM_SENDER_HINTS.length; i++) {
    if (email.indexOf(SYSTEM_SENDER_HINTS[i].toLowerCase()) !== -1) {
      return false;
    }
  }

  return true;
}

/**
 * Extract a lowercase email address from a "From" header value.
 * @param {string} fromHeader
 * @return {string} lowercase email, or '' if none found.
 */
function extractEmail_(fromHeader) {
  if (!fromHeader) {
    return '';
  }
  const angle = fromHeader.match(/<([^>]+)>/);
  const raw = angle ? angle[1] : fromHeader;
  const bare = raw.match(/[^\s<>@]+@[^\s<>@]+/);
  return bare ? bare[0].trim().toLowerCase() : '';
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
