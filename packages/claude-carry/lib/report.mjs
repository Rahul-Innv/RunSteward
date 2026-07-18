// report — the morning summary. The first thing to read after an unattended
// run: what finished, what each cost, which branch to diff, and what needs a
// decision. Pure read over queue.json + runs.ndjson; writes a markdown file.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadQueue, STATE_DIR } from './store.mjs';
import { monthSpend, loadConfig, nextMonthlyRefresh } from './sentinel.mjs';

const STATUS_EMOJI = {
  done: '✅',
  'needs-approval': '🟣',
  parked: '🟣',
  waiting: '🕐',
  failed: '❌',
  running: '🔵',
  pending: '⬜',
};

// `nowIso` is passed in (the runner stamps it) — scripts can't call Date.now().
export function buildReport(q = loadQueue(), nowIso = new Date().toISOString()) {
  const cfg = loadConfig();
  const tasks = q.tasks;
  const by = (s) => tasks.filter((t) => t.status === s);
  const totalCost = tasks.reduce((sum, t) => sum + (t.cost_usd || 0), 0);

  const lines = [];
  lines.push(`# Claude Carry report — ${nowIso}`);
  lines.push('');
  lines.push(
    `**${by('done').length} done · ${by('needs-approval').length} need approval · ` +
      `${by('waiting').length} waiting · ${by('failed').length} failed · ` +
      `${by('pending').length} pending**`
  );
  lines.push('');
  lines.push(`This run cost ~$${totalCost.toFixed(2)} (estimate). Month-to-date: ~$${monthSpend().toFixed(2)} of $${cfg.monthly_credit_usd} credit (resets ${new Date(nextMonthlyRefresh(cfg)).toLocaleDateString()}).`);
  lines.push('');

  // the part that needs you, first
  const needs = by('needs-approval');
  if (needs.length) {
    lines.push('## ⚠️ Needs your decision');
    for (const t of needs) {
      lines.push(`- **${t.id}** — ${t.prompt.slice(0, 80)}`);
      for (const d of (t.parked_calls || []).filter((x) => x.kind === 'dontask')) {
        lines.push(`  - wanted to run \`${d.tool}: ${d.input?.command ?? JSON.stringify(d.input)}\``);
      }
      lines.push(`  - approve: \`carry approve ${t.id}\` · drop: \`carry rm ${t.id}\``);
    }
    lines.push('');
  }

  // everything, with the branch to review
  lines.push('## All tasks');
  lines.push('');
  lines.push('| | id | status | cost | model | review |');
  lines.push('|---|---|---|---|---|---|');
  for (const t of tasks) {
    const emoji = STATUS_EMOJI[t.status] || '';
    // in-folder mode: the deliverable is the carry/<id> branch in the
    // project itself; worktree mode: the isolated worktree branch.
    const review = t.branch
      ? `branch \`${t.branch}\``
      : t.worktree
        ? `worktree \`worktree-${t.worktree}\``
        : '—';
    const cost = t.cost_usd ? `${t.cost_estimated ? '~' : ''}$${t.cost_usd.toFixed(2)}` : '—';
    lines.push(`| ${emoji} | ${t.id} | ${t.status} | ${cost} | ${t.model || 'sonnet'} | ${review} |`);
  }
  lines.push('');

  // heads-up: any task that carried the user's uncommitted work into a baseline
  // commit, so they're never surprised their WIP moved onto a branch.
  const carried = tasks.filter((t) => t.baseline_commit);
  if (carried.length) {
    lines.push('## Carried your uncommitted work');
    for (const t of carried) {
      lines.push(`- **${t.id}** — your uncommitted changes were committed onto \`${t.branch}\` as baseline \`${t.baseline_commit.slice(0, 7)}\` (review before landing).`);
    }
    lines.push('');
  }

  const failed = by('failed');
  if (failed.length) {
    lines.push('## Failed (why)');
    for (const t of failed) lines.push(`- **${t.id}** — ${t.parked_reason || 'unknown'} (retries: ${t.retries})`);
    lines.push('');
  }

  const waiting = by('waiting');
  if (waiting.length) {
    lines.push('## Waiting (will resume automatically)');
    for (const t of waiting) lines.push(`- **${t.id}** — resumes ${t.resume_at ? new Date(t.resume_at).toLocaleString() : '?'} (${t.parked_reason || ''})`);
    lines.push('');
  }

  return lines.join('\n');
}

export function writeReport(nowIso = new Date().toISOString()) {
  mkdirSync(STATE_DIR, { recursive: true });
  const md = buildReport(loadQueue(), nowIso);
  const file = join(STATE_DIR, 'report.md');
  writeFileSync(file, md);
  return { file, md };
}
