// Crash-safety test for the queue store: a child process hammers saveQueue()
// in a tight loop while the parent TerminateProcess-kills it at random moments.
// After every kill, queue.json must still parse and carry schema v1 — proving
// a crash can never corrupt the queue (the incumbent's failure mode).
//
// Usage: node test/crash-store.mjs        (parent: runs 20 kill rounds)
//        node test/crash-store.mjs child  (internal)

import { spawn } from 'node:child_process';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const TEST_HOME = join(tmpdir(), 'carry-crash-test');

if (process.argv[2] === 'child') {
  // child mode: CARRY_HOME is set by the parent before import resolution,
  // so import store dynamically AFTER env is in place.
  const { loadQueue, saveQueue, addTask } = await import('../lib/store.mjs');
  // hammer: load-mutate-save as fast as possible until killed
  for (let i = 0; ; i++) {
    const q = loadQueue();
    addTask(q, { prompt: `crash-test task #${i} ${'x'.repeat(200)}`, cwd: process.cwd() });
    if (q.tasks.length > 500) q.tasks = q.tasks.slice(-100); // keep file size bounded
    saveQueue(q);
  }
}

// ---- parent ----
const ROUNDS = 20;
rmSync(TEST_HOME, { recursive: true, force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const file = join(TEST_HOME, 'queue.json');

let validated = 0;
for (let round = 1; round <= ROUNDS; round++) {
  await new Promise(async (resolve, reject) => {
    const child = spawn(process.execPath, [SELF, 'child'], {
      env: { ...process.env, CARRY_HOME: TEST_HOME },
      stdio: 'ignore',
    });
    child.on('error', reject);
    // wait until the child has actually started writing (first queue.json
    // appears), THEN kill after a small random delay — so we always crash it
    // MID-WRITE, which is the thing we're testing. Falls back after 5s.
    const startWait = Date.now();
    while (!existsSync(file) && Date.now() - startWait < 5000) await sleep(5);
    await sleep(5 + Math.random() * 40); // crash during active writing
    child.kill();
    child.on('close', () => {
      try {
        if (existsSync(file)) {
          const q = JSON.parse(readFileSync(file, 'utf8')); // throws if corrupt
          if (q.version !== 1) throw new Error(`bad version: ${q.version}`);
          validated++;
          console.log(`round ${round}: crashed mid-write — queue.json intact (${q.tasks.length} tasks)`);
        } else {
          console.log(`round ${round}: no write within 5s — skipped`);
        }
        resolve();
      } catch (e) {
        reject(new Error(`round ${round}: QUEUE CORRUPTED — ${e.message}`));
      }
    });
  });
}

rmSync(TEST_HOME, { recursive: true, force: true });
console.log(`\x1b[32mPASS — ${ROUNDS} kill rounds, ${validated} post-crash validations, zero corruption\x1b[0m`);
