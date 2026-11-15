#!/usr/bin/env python3
"""Refresh Redline's fixed Chinese UI and optional CJK atlas, without an SDK.

The staged app under package/ is the maintained source. This does not run a
vehicle export or regenerate it with the older localized/ app-kit generator.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
ROOT = APP.parents[1]
PACKAGE = APP / "package"
FONT_HASH = "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da"


def read(path):
    return json.loads(path.read_text())


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--font", type=Path, help="Verified NotoSansSC.ttf; rebuild local atlas")
    args = parser.parse_args()
    words = {
        **read(ROOT / "localized/kit/runtime/locales/zh-CN.json"),
        **read(PACKAGE / "javascript/kit/locales/zh-CN.json"),
        **read(APP / "cn-hud-translations.json"),
    }
    write(PACKAGE / "javascript/kit/locales/zh-CN.json", words)
    write(PACKAGE / "javascript/kit/locale.json", {
        "language": "zh-CN", "strings": words, "credit": "",
    })
    text = lambda value: words.get(value, value).replace(
        " (default)", "（默认）")
    spec = read(PACKAGE / "javascript/kit/app-spec.json")
    spec["version"] = read(PACKAGE / "package.json")["version"]
    spec["title"] = text(spec["title"])
    for screen in spec["screens"]:
        if "title" in screen:
            screen["title"] = text(screen["title"])
        for button in screen.get("buttons", []):
            button[1] = text(button[1])
    for setting in spec["settings"]:
        if setting["key"] == "demo":
            setting["default"] = "off"
        setting["label"] = text(setting["label"])
        if "group" in setting:
            setting["group"] = text(setting["group"])
        for option in setting.get("options", []):
            option[1] = text(option[1])
        if "labels" in setting:
            setting["labels"] = {k: text(v) for k, v in setting["labels"].items()}
    write(PACKAGE / "javascript/kit/app-spec.json", spec)
    # Static resources use StringId (not bare RHMI Text) for Unicode. Every
    # locale is Chinese intentionally, matching the existing CN packages.
    strings = read(PACKAGE / "rhmiData/variantGroups/Common/texts/en_GB.json")
    strings = {key: text(value) for key, value in strings.items()}
    assert len(strings) <= 1024, "HMI string resource budget exceeded"
    for path in (PACKAGE / "rhmiData/variantGroups/Common/texts").glob("*.json"):
        write(path, strings)

    if args.font:
        assert hashlib.sha256(args.font.read_bytes()).hexdigest() == FONT_HASH, "Unexpected font"
        module = importlib.util.spec_from_file_location(
            "bake_fonts", ROOT / "localized/kit/tools/bake_fonts.py")
        baker = importlib.util.module_from_spec(module)
        module.loader.exec_module(baker)
        baker.FONTDIR = str(args.font.resolve().parent)
        chars = "".join(sorted(set(baker.TEXT + "".join(words.values()))))
        atlas = baker.bake(args.font.name, (500,), 44, chars)
        # The native renderer reserves two 4096-high columns for the font.
        assert atlas["atlasH"] <= 4096, "Chinese atlas exceeds the renderer budget"
        cache_key = hashlib.sha256(
            json.dumps(atlas, separators=(",", ":")).encode()).hexdigest()[:16]
        output = {"family": "cjk", "source": "Noto Sans SC (OFL-1.1)",
                  "cacheKey": cache_key, "sizes": [atlas]}
        (PACKAGE / "javascript/kit/fonts/cjk.json").write_text(
            json.dumps(output, ensure_ascii=False, separators=(",", ":")) + "\n")
        print("CJK:", len(chars), "glyphs;", atlas["atlasW"], "x", atlas["atlasH"])
    print("Chinese UI refreshed:", len(words), "translations;", len(strings), "static strings")


if __name__ == "__main__":
    main()
