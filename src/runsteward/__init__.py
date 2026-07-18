"""RunSteward deterministic contract-verification surface."""

from runsteward.contract_compat import (
    canonical_runsteward,
    choicegate_native_digest,
    configure_root,
    main,
    normalized_utf8_lf_sha256,
    parse_runsteward_json,
    read_runsteward_json,
    runsteward_digest,
)

__version__ = "0.1.0"

__all__ = [
    "__version__",
    "canonical_runsteward",
    "choicegate_native_digest",
    "configure_root",
    "main",
    "normalized_utf8_lf_sha256",
    "parse_runsteward_json",
    "read_runsteward_json",
    "runsteward_digest",
]
