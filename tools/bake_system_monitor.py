#!/usr/bin/env python3
"""Regenerate the new app's Chinese atlas with the pinned OFL font."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys

root = Path(__file__).resolve().parents[1]
local = root / "localized/system-monitor"
font = Path(sys.argv[1]).resolve()
assert hashlib.sha256(font.read_bytes()).hexdigest() == "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da"
spec = importlib.util.spec_from_file_location("bake_fonts", root / "localized/cauliflower/kit/tools/bake_fonts.py")
baker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(baker)
baker.FONTDIR = str(font.parent)
words = json.loads((local / "translations.zh-CN.json").read_text())
source_chars = "".join(re.findall(r"[\u3000-\u9fff\uff00-\uffef]", (local / "apps/sys_monitor/main.js").read_text()))
chars = "".join(sorted(set(baker.TEXT + "".join(words.values()) + source_chars)))
atlas = baker.bake(font.name, (500,), 48, chars)
assert atlas["atlasH"] <= 2048
data = {"family": "cjk", "source": "Noto Sans SC (OFL-1.1)",
        "cacheKey": hashlib.sha256(json.dumps(atlas, sort_keys=True).encode()).hexdigest()[:16],
        "sizes": [atlas]}
(local / "cjk.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n")
