# Security policy

## Reporting

Report a suspected vulnerability privately to the repository owner. Do not include credentials,
tokens, raw provider transcripts, private runtime evidence, or customer data in an issue.

## Supported state

The `0.1.1` source/package line is the only supported state. All skills are inactive. No
marketplace, registry, or hosted service is supported yet.

## Security boundaries

- Provider evidence must remain bounded and redacted.
- Unknown evidence never authorizes wrap, resume, or execution.
- Stale leases never authorize takeover.
- Checkpoints and final reports remain digest-bound.
- The external lifecycle authority governs capability state; package presence is not activation.

Rotate a credential before removing it if one is ever committed. History repair is a separate,
destructive owner-gated operation and must not be attempted from an ordinary contribution lane.
