// pricing — a rough USD estimate from token usage, for the ONE case the
// authoritative number is missing: a task killed/crashed before its `result`
// event (which carries total_cost_usd) was emitted. The normal path always uses
// the real total_cost_usd; this is a labelled fallback so a stopped task shows a
// ballpark instead of $0.
//
// Rates are per MILLION tokens (public Anthropic list prices). cache_read ≈
// 0.1× input and cache_write(5m) ≈ 1.25× input, so we derive both from the
// input rate and only table input/output per model.

const RATES = {
  haiku: { input: 1.0, output: 5.0 },
  sonnet: { input: 3.0, output: 15.0 },
  opus: { input: 15.0, output: 75.0 },
};
const DEFAULT = RATES.sonnet;

function rateFor(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('haiku')) return RATES.haiku;
  if (m.includes('opus')) return RATES.opus;
  if (m.includes('sonnet')) return RATES.sonnet;
  return DEFAULT;
}

// usage fields follow the stream-json `usage` shape:
//   input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens
export function estimateUsd(model, usage = {}) {
  const r = rateFor(model);
  const inp = usage.input_tokens || 0;
  const out = usage.output_tokens || 0;
  const cr = usage.cache_read_input_tokens || 0;
  const cw = usage.cache_creation_input_tokens || 0;
  const usd = (inp * r.input + out * r.output + cr * r.input * 0.1 + cw * r.input * 1.25) / 1e6;
  return usd;
}
