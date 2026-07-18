# Deep research: context-window degradation & a "wrap-up now" sensor

*Deep-research harness run 2026-07-05. 5 search angles → 22 sources → 109 extracted
claims → 25 adversarially verified (3-vote panels) → 24 confirmed, 1 refuted.
Supersedes the quick note in [research-context-window-degradation.md](research-context-window-degradation.md).*

This answers the deeper question you raised: it's not one flat "quality drops as
context fills" curve — the slope depends on **model, task type, and whether the work
is single-shot or multi-turn/agentic**, and a model's own sense of "I'm still fine"
turns out to be an unreliable signal. All of that has direct consequences for how a
stop/wrap-up sensor should be built.

---

## Currency correction (2026-07-05, added after review)

The verified benchmark tables below (sections 1-2) test the **2024-25 model cohort**
(Claude 3.5/4, GPT-4o/4.1, Gemini 2.5) — NOT the current frontier. As of this date the
current models are **Claude Sonnet 5 / Opus 4.8**, both defaulting to a **1M-token
window** (not 200K), output capped at 128K, compaction built in. A 2026 recheck shows
the current frontier (GPT-5.5, Opus-4.x, DeepSeek V4 Pro) has **effective context
~200-400K tokens for demanding multi-needle/agentic work** — much later-degrading than
the tables below, but still far short of the advertised 1M (RULER multi-hop ~50-65% of
advertised). Two consequences that revise section 6:
- **Recalibrate bands to the 1M default.** The old 120-160K bands were for 200K windows.
  For current models the coding wrap-up zone is closer to **~150-250K tokens absolute
  (~15-25% of a 1M window)** — which is why a ~20% trigger on a 1M model is defensible,
  not premature (20% of 1M ~= 200K ~= where effective context tops out).
- **Claude may now decay *steeper* than GPT-5 under distractors** (2026 data), partly
  reversing the older Chroma "Claude abstains" finding — reinforcing churn-weighting for
  Claude coding sessions specifically.
The absolute-token rule and all mechanism / sections 3-5 findings still hold; only the
specific numbers and default window size move. Sources: llm-stats, Morph, ofox.ai 2026
recaps.

---

## 1. The headline: effective context ≪ advertised, and it's task-dependent

Every benchmark agrees the usable window is a fraction of the marketed one — but they
disagree by an **order of magnitude** on *how small*, and that disagreement is the
most important nuance for us.

**"Effective context length"** = the longest input at which a model still holds some
% of its own short-context score. Two rigorous benchmarks, two definitions, wildly
different answers:

| Benchmark | Threshold def. | What it measures | Typical effective context |
|---|---|---|---|
| **NoLiMa** (arXiv 2502.05167) | ≥85% of base | Associative retrieval, **no lexical overlap** (hard) | **1–8K** for 128K–2M models |
| **RULER** (arXiv 2404.06654) | > Llama-2-7B@4K (85.6%) | Mixed synthetic (NIAH, multi-hop, aggregation) | **16–64K** for 128K models |
| **LongCodeEdit** (practitioner) | ≥85%-ish | Bug-find/fix in long **real codebases** | **32K–128K**, model-dependent |

The reason they diverge: **the harder and less keyword-matchable the retrieval, the
sooner it rots.** NoLiMa deliberately removes literal matches so the model must infer
latent associations — and effective context collapses to single-digit-K. Real coding
work (find the caller, trace the bug across files) sits closer to NoLiMa's hard end
than to a vanilla needle-in-a-haystack. **Takeaway: there is no single "the effective
window is N tokens" number — it's a function of task difficulty, and coding is on the
hard side.**

---

## 2. Per-model effective-context table (verified numbers)

**NoLiMa** — hard associative retrieval, 85%-of-base threshold (arXiv 2502.05167):

| Model | Claimed window | Base score | Score @32K | Effective ctx |
|---|---|---|---|---|
| GPT-4o | 128K | 99.3 | 69.7 | **8K** |
| Claude 3.5 Sonnet | 200K | 87.5 | 29.8 | **4K** |
| Gemini 1.5 Pro | 2M | 92.6 | 48.2 | **2K** |
| Gemini 2.0 Flash | 1M | 89.4 | 41.0 | **4K** |
| Llama 3.3 70B | 128K | — | 42.7 | **2K** |
| GPT-4o mini | 128K | 84.8 | 13.7 | **<1K** |

*At 32K, 11 of 13 tested models score below **half** their own short-context baseline.*

**RULER** — mixed synthetic tasks, Llama-2-7B@4K threshold (arXiv 2404.06654):

| Model | Claimed window | Score @4K→128K | Effective ctx |
|---|---|---|---|
| Gemini 1.5 Pro | 1M | 96.7 → 94.4 | **>128K** |
| GPT-4-1106 | 128K | 96.6 → 81.2 | **64K** |
| Llama 3.1 70B | 128K | — → 66.6 | **64K** |
| Qwen2 72B | 128K | — | **32K** |
| Yi-34B | 200K | — | **32K** |
| Command-R-plus | 128K | — → 63.1 | **32K** |
| Mixtral-8x22B | 64K | 95.6 → 31.7 | **32K** |
| Mistral-v0.2 7B | 32K | — | **16K** |
| LWM 7B | 1M | — | **<4K** |

### Does newer / bigger degrade less? Yes — the slope is model-dependent.
- **Frontier & long-context-trained models degrade far less.** Gemini 1.5 Pro holds
  94.4 at 128K (effective >128K) while Mixtral-8x22B collapses 95.6→31.7 over the same
  range. Same benchmark, opposite slopes.
- **Model tier matters within a family.** Llama 3.1 **70B** stays effective to 64K;
  the **8B** only to ~32K (NoLiMa/RULER). Small models rot sooner.
- **But a bigger advertised window buys nothing by itself.** Extended-context variants
  (GPT-3.5-Turbo-16K vs -4K; Claude-1.3-100K vs -1.3) perform *nearly identically* on
  inputs that fit both — the window size is a container, not a quality guarantee
  (arXiv 2307.03172). A 1M-token model is not 5× more usable than a 200K one.

---

## 3. Mechanisms — why it rots, and why agentic work rots faster

**Positional bias ("lost in the middle").** Retrieval accuracy is U-shaped over
position: high at the very start and end, sagging in the middle — a drop that can
exceed **20 points**, and in the worst case a 20–30-document context scores *below the
closed-book baseline* (adding context made the model worse than no context) (arXiv
2307.03172). The cause is structural, not data-driven: models put **higher attention
on the first and last tokens regardless of relevance**, and the pattern persists even
when documents are shuffled (arXiv 2406.16008). It's a property of the model, so it
can't be fixed by reordering your prompt — only by keeping the important stuff out of
the mushy middle. *(One popular claim — that RoPE's long-term-decay components are the
root cause — was the single claim our panel refuted 1-2; treat RoPE-specific
mechanistic stories as unsettled.)*

**Distractor sensitivity.** Even a **single** near-miss distractor measurably lowers
retrieval accuracy vs a clean needle-only prompt, and the damage compounds
non-uniformly with more distractors (Chroma Context Rot). Lower query–answer semantic
similarity steepens the decline further.

**Why coding agents are the worst case — the multi-turn cliff.** This is the finding
most relevant to the product, and it's bigger than the raw context-length effect:
- Across 15 top models (GPT-4.1, o3, Claude 3.7 Sonnet, Gemini 2.5, Llama 4,
  DeepSeek-R1), performance drops an **average 39%** in multi-turn conversations vs a
  single fully-specified turn — across six generation tasks (arXiv 2505.06120, "Lost
  in Conversation").
- That 39% decomposes into a **minor ~16% aptitude loss + a ~112% *increase in
  unreliability*** (200k+ simulated conversations). The model doesn't get uniformly
  dumber — it gets **wildly inconsistent**. Same question, sometimes right, sometimes
  not.
- On coding specifically (MT-Sec, 32 models), "correct **and** secure" output drops
  **20–27%** going single→multi-turn, worsening with more turns.

A long debugging session is the perfect storm: **large context + full of distractors
(failed attempts, stale tool output, reverted diffs) + many turns.** All three
degradation mechanisms stack. This is why a coding session feels "off" long before the
context bar looks full — the benchmarks that measure clean single-shot retrieval
*understate* what happens in an agent loop.

---

## 4. "Model health": can you trust the model to know it's degrading? No.

This is the subtlest and most decision-relevant finding for a sensor design.

- **Response quality is an unreliable proxy for session health.** In a token-statistics
  study (arXiv 2604.13061), a structural-coupling metric tracked genuine consistency in
  **85%** of conditions but tracked LLM-judge *quality scores* in only **44%** — i.e.
  a session can **keep emitting confident, high-scoring answers while its underlying
  consistency has already decoupled** ("silent uncoupling"). The outputs look fine
  after the model has started drifting.
- **So a model's self-assessment of "I'm still good" is not trustworthy.** The widely-
  cited Claude Code issue where a 1M-model "self-reported" degrading at ~40% and
  recommended restarting at ~48% is the model *guessing about itself* — interesting,
  not authoritative. Anthropic closed it "not planned" with no official thresholds.
- **Vendors do confirm the underlying effect.** Anthropic's own docs state plainly that
  "as a conversation grows, response quality degrades" and that "LLM performance
  degrades as context fills… Claude may start forgetting earlier instructions and
  making mistakes" — positioning compaction as the mitigation.

**Does compaction/summarization fix it or mask it?** Both. It reclaims tokens and
genuinely helps, but a summary **loses exactly the early decisions the lost-in-the-
middle effect was already eroding**, and it can paper over silent uncoupling — the bar
goes green while the thread's real coherence is already frayed. Compaction is
compression, not a reset. **A fresh session with a good handoff beats a compacted one**
for anything where early architectural decisions matter — which is the core wager of
this product.

**Design consequence: the wrap-up sensor must be external and objective (token counts,
turn counts, churn), never the model's own "do I feel degraded?" — because both its
outputs and its introspection are unreliable precisely when you most need the warning.**

---

## 5. Practitioner & vendor thresholds (what people actually use)

- **Effective capacity ≈ 60–70% of advertised** across tracked leaderboards — the
  rule-of-thumb version of §1–2.
- **Degradation onset commonly cited at 16K–64K tokens** for most models, regardless of
  window size.
- **Practitioner consensus for Claude Code: reset/wrap-up at ~60% of the 200K window
  (~120K tokens).** One widely-followed guide names **60%+ the hard "Red Zone"** — do
  not start a new feature, refactor, or research thread past it.
- **Don't spend the final ~20%** of the window on complex multi-file work; at ~80% the
  advice is to reset, not push.
- **Claude Code auto-compact fires late — ~167K of 200K (~83.5%), ~33K reserve** — well
  past where quality has already dropped. This is the gap the product exploits: the
  built-in safety net triggers *after* the degradation zone; a good sensor fires
  *before* it, at a natural breakpoint.

---

## 6. Recommended threshold bands for the wrap-up sensor

Denominate in **absolute tokens** (primary) with **% of window** as the human-readable
overlay. Bands below are calibrated for a **200K-class Claude coding session**; the
key design rules follow.

| Context | ~% of 200K | Band | Sensor action |
|---|---|---|---|
| < 80K | <40% | 🟢 green | full quality — no action |
| 80–120K | 40–60% | 🟡 yellow | note it; plan to land the current thread by ~120K |
| 120–150K | 60–75% | 🟠 orange | **fire WRAPUP** at the next clean breakpoint (subtask done) |
| > 150K | >75% | 🔴 red | stop now, commit WIP, write HANDOFF, fresh session |

**Design rules that make it correct (these matter more than the exact numbers):**

1. **Absolute tokens, not % of window.** A 1M-model is *not* 5× more usable — hold the
   same absolute bands and only stretch them for models with benchmark-proven shallow
   slopes (e.g. Gemini-1.5-Pro-class). Never trust a big window as headroom.
2. **Fire at the next natural breakpoint, not a hard cutoff.** Crossing 120K is a
   "wrap up when you finish this step" signal, not a mid-edit kill — this is exactly
   the wrapping-up ritual's "finish the current atomic step" clause. Aligns with your
   existing design.
3. **Weight by churn/distractor load, not just size.** A 120K session that's mostly one
   clean file reads healthier than a 90K session full of failed attempts and stale tool
   output. If cheaply measurable (tool-call count, revert/retry count, error-output
   volume), a high-churn session should trip a band *earlier*. This is the coding-
   specific edge the raw context-length benchmarks miss (§3).
4. **Count turns as a second axis.** The 39% multi-turn drop is driven by *unreliability*
   that accumulates with turns independent of token count. A very long back-and-forth
   can warrant wrap-up even below the token bands.
5. **Never rely on the model's self-report** (§4). The sensor reads objective signals;
   it does not ask Claude how it feels.
6. **Prefer stop+handoff over auto-compact for decision-heavy work** — compaction loses
   the early decisions that lost-in-the-middle already erodes.

---

## 7. Product implications

- **Two orthogonal sensors, one ritual.** Usage-budget sensor = "how much quota is left
  across sessions." Context/health sensor = "how degraded is *this* session." Both feed
  the **same** trigger-hook → wrapping-up skill. The hook, latching, dry-run mode, and
  handoff machinery are all reusable as-is — only the sensor input differs.
- **The defensible gap vs built-ins.** Claude Code already has `/compact`, ~83.5% auto-
  compact, and `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`. All of them **compress late**. Nobody
  ships *"stop cleanly at a natural breakpoint before the degradation zone, with a
  handoff a fresh session can resume from."* That's the wedge — and §4 (a fresh session
  beats a compacted one for decision-heavy work) is the evidence-backed reason it's
  worth doing.
- **Signal source — needs a spike.** Confirm what a hook can actually read for live
  context usage: Claude Code statusline JSON / `/context`, else transcript-file token
  estimation as a proxy. Churn/turn signals are derivable from the transcript. This
  determines feasibility.
- **Honest risk.** Newer models degrade less and vendor context-management keeps
  improving, so a bare "warn at N tokens" feature could commoditize. The durable value
  is **the ritual + churn/turn-aware timing + the handoff**, not the threshold constant.
- **Nuance to bake in, per your instinct:** the sensor shouldn't hardcode one number.
  Effective context varies ~10× by task difficulty (§1) and model (§2), and agentic
  multi-turn work degrades on a different axis than raw length (§3). A defensible v1 is
  **token-band + churn weight + turn count**, tuned per model tier, firing at the next
  breakpoint — not a single global percentage.

---

## Sources (all primary unless noted)

- NoLiMa: Long-Context Evaluation Beyond Literal Matching — https://arxiv.org/abs/2502.05167
- RULER: What's the Real Context Size of Your Long-Context LLMs? — https://arxiv.org/abs/2404.06654
- Chroma, "Context Rot: How Increasing Input Tokens Impacts LLM Performance" — https://research.trychroma.com/context-rot
- Lost in the Middle: How LMs Use Long Contexts (TACL 2023) — https://arxiv.org/abs/2307.03172
- Found in the Middle: Calibrating Positional Attention Bias (ACL Findings 2024) — https://arxiv.org/abs/2406.16008
- Lost in Conversation: multi-turn degradation (avg 39% drop) — https://arxiv.org/abs/2505.06120
- Token Statistics Reveal Conversational Drift ("silent uncoupling") — https://arxiv.org/abs/2604.13061
- MT-Sec: multi-turn secure-coding degradation — https://arxiv.org/html/2502.11028v3
- Anthropic, "Effective context engineering for AI agents" — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic API docs, Compaction — https://platform.claude.com/docs/en/build-with-claude/compaction
- Claude Code best practices — https://code.claude.com/docs/en/best-practices
- claude-code issue #34685 (1M self-reported degradation; closed "not planned") — https://github.com/anthropics/claude-code/issues/34685
