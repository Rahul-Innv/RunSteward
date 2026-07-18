// limit-sentinel — ALL limit/credit/stop classification lives in this one file,
// so when Claude Code's signals change (e.g. the post-June-15 credit-exhaustion
// signal, still undocumented), the fix is a one-file change.
//
// It answers one question about a finished run: WHY did it stop, and WHEN can
// it continue?
//   done            -> result subtype 'success'
//   waiting         -> usage-limit hit; resume_at = the machine-readable
//                      resetsAt timestamp (+ small buffer), or a conservative
//                      fallback when only text evidence exists
//   parked          -> billing/credit exhausted; resume_at = monthly refresh
//   failed          -> everything else, with the reason recorded
//
// Signal priority: machine-readable events first (rate_limit_event, api_retry
// categories, result subtypes); error TEXT only as a last-resort detector —
// and never for parsing times out of prose (that's what killed the incumbent).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR, RUNS_LOG } from './store.mjs';

// resume slightly after the reset, not on the second (env-overridable for tests)
const RESUME_BUFFER_MS = Number(process.env.CARRY_RESUME_BUFFER_MS ?? 90_000);
const FALLBACK_WAIT_MS = 30 * 60_000; // text-only evidence: recheck in 30min

// epoch seconds (statusline style) vs milliseconds (Date.now style)
function normalizeEpoch(n) {
  if (!n || typeof n !== 'number') return null;
  return n > 1e12 ? n : n * 1000;
}

function rateLimitInfo(evt) {
  // shapes seen in the wild: {type:'rate_limit_event', rate_limit_info:{...}}
  // and flattened variants; parse defensively, never assume
  if (!evt) return null;
  const isRle = evt.type === 'rate_limit_event' || evt.subtype === 'rate_limit_event';
  if (!isRle) return null;
  const info = evt.rate_limit_info || evt.rateLimitInfo || evt;
  return {
    status: info.status ?? null, // allowed | allowed_warning | rejected
    resetsAt: normalizeEpoch(info.resetsAt ?? info.resets_at ?? null),
    type: info.rateLimitType ?? info.rate_limit_type ?? null,
  };
}

const LIMIT_TEXT = /you've hit your (session|weekly|opus) limit|usage limit reached/i;
const BILLING_TEXT = /billing_error|credit balance is too low|out of credits/i;

export function classify(events, { code = 0, stderrText = '' } = {}) {
  let result = null;
  let lastRejected = null;
  let lastRateLimit = null;
  let sawBilling = BILLING_TEXT.test(stderrText);
  let sawLimitText = LIMIT_TEXT.test(stderrText);
  let retryRateLimit = false;

  for (const evt of events) {
    if (evt.type === 'result') result = evt;
    const rl = rateLimitInfo(evt);
    if (rl) {
      lastRateLimit = rl;
      if (rl.status === 'rejected') lastRejected = rl;
    }
    if (evt.type === 'system' && evt.subtype === 'api_retry') {
      const category = evt.error?.category ?? evt.category ?? '';
      if (category === 'rate_limit') retryRateLimit = true;
    }
    const text = JSON.stringify(evt);
    if (BILLING_TEXT.test(text)) sawBilling = true;
    if (evt.type !== 'result' && LIMIT_TEXT.test(text)) sawLimitText = true;
  }

  if (result?.subtype === 'success') {
    return { status: 'done', reason: null, resume_at: null };
  }

  // credit/billing exhaustion outranks rate-limit (post-June-15: -p draws the
  // monthly Agent SDK credit; "reset" means the billing refresh, not a 5h window)
  if (sawBilling || result?.subtype === 'error_billing') {
    return {
      status: 'parked',
      reason: 'billing/credit exhausted — waiting for monthly refresh',
      resume_at: new Date(nextMonthlyRefresh()).toISOString(),
    };
  }

  if (lastRejected?.resetsAt) {
    return {
      status: 'waiting',
      reason: `usage limit (${lastRejected.type || 'window'}) — resets ${new Date(lastRejected.resetsAt).toLocaleString()}`,
      resume_at: new Date(lastRejected.resetsAt + RESUME_BUFFER_MS).toISOString(),
    };
  }

  // run died without a result and the only evidence is retry events or message
  // text — wait conservatively and recheck (NEVER parse times out of prose)
  if (!result && (retryRateLimit || sawLimitText || lastRateLimit?.status === 'allowed_warning')) {
    return {
      status: 'waiting',
      reason: 'limit signals without machine-readable resetsAt — conservative 30min recheck',
      resume_at: new Date(Date.now() + FALLBACK_WAIT_MS).toISOString(),
    };
  }

  if (result?.subtype === 'error_max_budget_usd') {
    return {
      status: 'failed',
      reason: 'hit its per-task budget cap (raise --budget or split the task)',
      resume_at: null,
    };
  }

  return {
    status: 'failed',
    reason: result ? `result: ${result.subtype}` : `exited code ${code} without result`,
    resume_at: null,
  };
}

// ---- monthly credit budget (post-June-15 Agent SDK credit) ----

const DEFAULT_CONFIG = {
  monthly_credit_usd: 100, // Max 5x; set 200 for Max 20x
  park_threshold: 0.8, // park before the undocumented wall (graft 4)
  billing_refresh_day: 1, // day-of-month the credit refreshes; adjust to billing cycle
  default_model: 'sonnet', // workhorse for agentic coding; override per task with --model
  concurrency: 1, // how many tasks the runner dispatches at once (1 = sequential).
  // >1 parallelizes across DIFFERENT projects freely; same-project in-folder tasks
  // still serialize (one checkout), so queue same-repo parallel work with --worktree.
  // per-task spend ceiling by model (catches runaway loops without killing
  // legitimate work). Bands from the Max-5x capacity estimate (2026-06-13):
  // typical Sonnet task $0.40-2.50, hard Opus $3-15+, trivial Haiku <$0.08.
  // A runaway therefore costs at most this, not a chunk of the $100/mo pool.
  default_max_budget_usd: { haiku: 1, sonnet: 5, opus: 20, _default: 10 },
};

// resolve a task's spend ceiling: explicit per-task value wins, else the
// per-model default (config may also be a single number, or null for no cap)
export function resolveTaskBudget(model, cfg = loadConfig()) {
  const caps = cfg.default_max_budget_usd;
  if (caps == null) return null;
  if (typeof caps === 'number') return caps;
  const m = (model || '').toLowerCase();
  if (m.includes('haiku')) return caps.haiku ?? caps._default ?? null;
  if (m.includes('opus')) return caps.opus ?? caps._default ?? null;
  if (m.includes('sonnet')) return caps.sonnet ?? caps._default ?? null;
  return caps._default ?? null;
}

export function loadConfig() {
  const file = join(STATE_DIR, 'config.json');
  if (!existsSync(file)) return { ...DEFAULT_CONFIG };
  return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(file, 'utf8')) };
}

export function nextMonthlyRefresh(cfg = loadConfig(), now = new Date()) {
  const day = Math.min(Math.max(cfg.billing_refresh_day, 1), 28);
  const candidate = new Date(now.getFullYear(), now.getMonth(), day, 0, 5, 0, 0);
  if (candidate <= now) candidate.setMonth(candidate.getMonth() + 1);
  return candidate.getTime();
}

// month-to-date spend, summed from the append-only run log (cost figures are
// client-side estimates — hence the safety threshold)
export function monthSpend(now = new Date()) {
  if (!existsSync(RUNS_LOG)) return 0;
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  let total = 0;
  for (const line of readFileSync(RUNS_LOG, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.event === 'closed' && entry.ts?.startsWith(monthKey)) total += entry.cost || 0;
    } catch {
      /* tolerate partial lines */
    }
  }
  return total;
}

// gate checked before every dispatch: are we clear to spend?
export function budgetGate() {
  const cfg = loadConfig();
  const spent = monthSpend();
  const cap = cfg.monthly_credit_usd * cfg.park_threshold;
  if (spent >= cap) {
    return {
      ok: false,
      spent,
      cap,
      reason: `month-to-date $${spent.toFixed(2)} >= ${cfg.park_threshold * 100}% of $${cfg.monthly_credit_usd} credit`,
      until: new Date(nextMonthlyRefresh(cfg)).toISOString(),
    };
  }
  return { ok: true, spent, cap };
}
