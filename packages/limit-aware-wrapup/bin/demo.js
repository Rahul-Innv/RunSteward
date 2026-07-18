#!/usr/bin/env node
'use strict';
// A self-contained, HONEST demo of the decision flow — no live account, no real cliff needed.
// It feeds SYNTHETIC usage samples (rising weekly utilization) through the *real* decision engine
// (trigger/decide.js) and prints what the session would see at each step: silence -> heads-up ->
// the WRAPUP directive + the desktop notification text.
//
// This is a SIMULATION of the logic for a screen recording (asciinema / GIF), not a claim that a
// real session was driven to the cliff. Run:  node bin/demo.js   (add --slow to pace it for capture)

const decide = require('../trigger/decide');
const notify = require('../trigger/notify');

const SLOW = process.argv.includes('--slow');
const DELAY_MS = SLOW ? 1400 : 0;

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', b: '\x1b[1m', y: '\x1b[33m', r: '\x1b[31m', g: '\x1b[32m', c: '\x1b[36m', x: '\x1b[0m' }
  : { dim: '', b: '', y: '', r: '', g: '', c: '', x: '' };

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

// Build a state.json-shaped object with a single fresh sample at a given weekly %.
function stateAt(weeklyPct, nowMs) {
  return {
    samples: [{
      ts: nowMs - 30000,
      rate_limits: {
        five_hour: { used_percentage: 12, resets_at: Math.floor((nowMs + 2 * 3600e3) / 1000) },
        seven_day: { used_percentage: weeklyPct, resets_at: Math.floor((nowMs + 3 * 86400e3) / 1000) },
      },
    }],
    burn: { seven_day: { pctPerHour: 1.8 } },
  };
}

// Unattended config: auto-wrap at 98.5% (reserve 1.5%), live.
const CONFIG = { mode: 'auto', dry_run: false, reserve_pct: 1.5, warn_at: [70, 85] };

async function main() {
  const now = Date.now();
  const latch = {}; // one running "session" so latches behave as in real life

  console.log(`${C.b}Limit-Aware Wrapup — decision-flow demo${C.x} ${C.dim}(synthetic usage, real engine)${C.x}`);
  console.log(`${C.dim}config: unattended (mode:auto), auto-wrap at 98.5%, heads-ups at 70/85%${C.x}\n`);

  const steps = [55, 72, 88, 96, 99];
  for (const pct of steps) {
    const result = decide.decide(stateAt(pct, now), CONFIG, latch, now);
    for (const k of result.newLatchKeys) latch[k] = now; // persist latches across steps

    const tag = result.decision === 'WRAPUP' ? `${C.r}WRAPUP${C.x}`
      : result.decision === 'WARN' ? `${C.y}WARN  ${C.x}`
      : `${C.g}NONE  ${C.x}`;
    console.log(`${C.c}weekly ${String(pct).padStart(2)}%${C.x}  →  ${tag}`);

    if (result.decision === 'WARN') {
      console.log(indent(decide.buildWarning(result, now)));
    } else if (result.decision === 'WRAPUP') {
      console.log(indent(decide.buildWrapup(result, now)));
      const n = notify.buildNotifyText(result);
      console.log(`${C.dim}    🔔 desktop notification →${C.x} ${C.b}${n.title}${C.x}: ${n.message}`);
    } else {
      const why = (result.reasons || []).find((r) => /seven_day/.test(r)) || 'nothing to say';
      console.log(`${C.dim}    (silent — nothing injected into the session)${C.x}`);
      console.log(`${C.dim}      why: ${why}${C.x}`);
    }
    console.log();
    if (DELAY_MS) await sleep(DELAY_MS);
  }

  console.log(`${C.dim}The 99% step is the only one that STOPS the session. Everything below the cliff${C.x}`);
  console.log(`${C.dim}is either silent or an informational heads-up — the budget gets used.${C.x}`);
}

function indent(text) {
  return text.split('\n').map((l) => '    ' + C.dim + l + C.x).join('\n');
}

main();
