"""Thin launcher for the packaged RunSteward contract-compatibility verifier."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from runsteward.contract_compat import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main(["--root", str(ROOT)]))
