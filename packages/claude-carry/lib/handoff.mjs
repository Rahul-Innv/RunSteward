// handoff — the "open a new session in the morning" briefing. Unlike report.md
// (a status snapshot), the handoff is TODO-shaped: it tells a fresh interactive
// session what the night produced AND, crucially, the list of things Claude Carry
// could NOT do unattended but a human-in-the-loop session now can — approvals it
// parked, actions it was forbidden to take overnight (push/deploy/network), and
// failures to investigate. The /carry skill reads this to greet a new
// session with an actionable plate, not just a status dump.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadQueue, STATE_DIR } from './store.mjs';

const oneLine = (s, n) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);
// a blocked action's command, flattened to one short line (some are huge — e.g.
// a multi-line commit message — and would otherwise swamp the handoff).
const inputStr = (input) => oneLine((input?.command ?? (input ? JSON.stringify(input) : '')) || '', 80);

export function buildHandoff(q = loadQueue(), nowIso = new Date().toISOString()) {
  const tasks = q.tasks;
  const by = (s) => tasks.filter((t) => t.status === s);
  const L = [];
  L.push(`# Claude Carry handoff — ${nowIso}`);
  L.push('');
  if (!tasks.length) {
    L.push('Queue is empty — nothing to bring in.');
    return L.join('\n');
  }
  L.push(
    `**${by('done').length} done · ${by('needs-approval').length} need you · ` +
      `${by('failed').length} failed · ${by('waiting').length + by('parked').length} waiting**`
  );
  L.push('');

  // ✅ Done — the work to review and bring in.
  const done = by('done');
  if (done.length) {
    L.push('## ✅ Done — review & bring in');
    for (const t of done) {
      L.push(`- **${t.id}** — ${oneLine(t.prompt, 80)}`);
      if (t.result_summary) L.push(`  - ${oneLine(t.result_summary, 200)}`);
      if (t.branch) L.push(`  - on branch \`${t.branch}\` — review & land it (or just ask: "bring in ${t.id}")`);
      else if (t.worktree) L.push(`  - in worktree branch \`worktree-${t.worktree}\``);
      // anything it was FORBIDDEN to do overnight (hard-deny) is a manual todo
      for (const d of (t.parked_calls || []).filter((x) => x.kind === 'rule')) {
        L.push(`  - ⚠ it couldn't run \`${d.tool}: ${inputStr(d.input)}\` (blocked overnight) — do this yourself`);
      }
    }
    L.push('');
  }

  // ▶ To do in this session — what Claude Carry couldn't do unattended.
  const todos = [];
  for (const t of by('needs-approval')) {
    const gray = (t.parked_calls || []).filter((d) => d.kind === 'dontask');
    if (/plan ready/i.test(t.parked_reason || '')) {
      todos.push(`- **${t.id}** — plan is ready for your OK. Review \`carry plan ${t.id}\`, then \`carry approve ${t.id}\`.`);
    } else if (gray.length) {
      todos.push(`- **${t.id}** — it needed to run \`${gray[0].tool}: ${inputStr(gray[0].input)}\`. Approve & resume: \`carry approve ${t.id}\` (or just do it yourself).`);
    } else {
      todos.push(`- **${t.id}** — parked: ${oneLine(t.parked_reason || 'needs your decision', 100)} → \`carry approve ${t.id}\`.`);
    }
  }
  for (const t of by('failed')) {
    todos.push(`- **${t.id}** — failed: ${oneLine(t.parked_reason || 'unknown', 100)} (retries ${t.retries}). Investigate or requeue.`);
  }
  if (todos.length) {
    L.push("## ▶ To do in this session — Claude Carry couldn't do these unattended");
    L.push(...todos);
    L.push('');
  }

  // 💤 Waiting — will resume on their own; no action needed now.
  const waiting = [...by('waiting'), ...by('parked')];
  if (waiting.length) {
    L.push('## 💤 Waiting — resumes on its own');
    for (const t of waiting) {
      const when = t.resume_at ? ` (resumes ${new Date(t.resume_at).toLocaleString()})` : '';
      L.push(`- **${t.id}** — ${oneLine(t.parked_reason || '', 80)}${when}`);
    }
    L.push('');
  }

  if (!done.length && !todos.length && !waiting.length) L.push('All clear — nothing needs you.');
  return L.join('\n').replace(/\n+$/, '') + '\n';
}

export function writeHandoff(nowIso = new Date().toISOString()) {
  mkdirSync(STATE_DIR, { recursive: true });
  const md = buildHandoff(loadQueue(), nowIso);
  const file = join(STATE_DIR, 'handoff.md');
  writeFileSync(file, md);
  return { file, md };
}
