#!/usr/bin/env python3
"""Apply reviewed contributor records to SDK-free application source packages."""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
ROLES = {
    "author": "上游作者",
    "translation": "中文翻译",
    "adaptation": "适配与维护",
    "runtime": "共享代码",
    "assets": "资源与数据",
}
CHANGE = "- 补充上游作者及各项贡献的来源说明。"


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def apply(identity):
    records = read(ROOT / "release/contributors.json")["components"]
    contributors = records[identity]
    package = ROOT / "apps" / identity / "package"
    if not package.is_dir():
        return
    write(package / "ATTRIBUTION.json", {"schema": 1, "component": identity, "contributors": contributors})
    lines = ["# 作者与贡献", ""]
    for c in contributors:
        lines.extend(["## " + ROLES[c["role"]] + "：" + c["name"], "",
                      c["contribution"], "", "来源：" + c["source"], ""])
    lines.append("许可证、版权声明和第三方声明保留在本包的许可文件及相应源码中。")
    provenance = next((name for name in ("PROVENANCE.json", "provenance.json") if (package / name).exists()), None)
    lines.extend(["固定上游版本、提交和导入来源见本包的 " + provenance + "。" if provenance
                  else "上游版本和提交见对应发行目录及源码记录。", ""])
    (package / "CONTRIBUTORS.zh-CN.md").write_text("\n".join(lines), encoding="utf-8")
    pkg = read(package / "package.json")
    # Iterio's author strings and branding stay as provided by its authors.
    if identity not in ("iteriodev_turnview", "oap-driverecorder-next"):
        pkg["author"] = " / ".join(c["name"] for c in contributors if c["role"] == "author")
    if isinstance(pkg.get("files"), list):
        for name in ("ATTRIBUTION.json", "CONTRIBUTORS.zh-CN.md"):
            if name not in pkg["files"]:
                pkg["files"].append(name)
    write(package / "package.json", pkg)
    # Each existing row describes this app's own author/translator. The kit's
    # copyright and contributor notices remain in its license and source files.
    authors = " / ".join(c["name"] for c in contributors if c["role"] == "author")
    translators = " / ".join(c["name"] for c in contributors if c["role"] == "translation")
    if identity not in ("iteriodev_turnview", "oap-driverecorder-next"):
        for path in sorted((package / "rhmiData/variantGroups").glob("*/texts/*.json")):
            original = path.read_text(encoding="utf-8")
            strings = read(path)
            updates = {}
            for key in strings:
                if key.endswith("_REPO_CREDITS_TITLE"):
                    updates[key] = "上游作者"
                elif key.endswith("_REPO_CREDITS_LINK"):
                    updates[key] = authors
                elif key.endswith("_CN_CREDITS_TITLE") and translators:
                    updates[key] = "中文翻译"
                elif key.endswith("_CN_CREDITS_LINK") and translators:
                    updates[key] = translators
            for key, value in updates.items():
                pattern = r'(' + re.escape(json.dumps(key)) + r'\s*:\s*)"(?:\\.|[^"\\])*"'
                original = re.sub(pattern, lambda m: m[1] + json.dumps(value, ensure_ascii=False), original)
            path.write_text(original, encoding="utf-8")
    # System Monitor has its own CN dictionary. The builder's generic entry
    # header describes the shared kit's translation, not this application.
    if identity == "sys_monitor":
        entry = package / "javascript/localized-entry.js"
        body = entry.read_text(encoding="utf-8")
        body = body.replace("// Translation by: 抖音 小白科技杂物社 / BiliBili 小白151 / GitHub JackieZ123430\n"
                            "// https://github.com/JackieZ123430/idrive7-apps-cn\n", "")
        entry.write_text(body, encoding="utf-8")
    changelog = package / "CHANGELOG.md"
    if changelog.exists():
        body = changelog.read_text(encoding="utf-8")
        unreleased = body.partition("## Unreleased\n")[2].split("\n## ", 1)[0]
        if CHANGE not in unreleased:
            body = body.replace("## Unreleased\n", "## Unreleased\n\n" + CHANGE + "\n", 1)
            changelog.write_text(body, encoding="utf-8")


def main():
    records = read(ROOT / "release/contributors.json")["components"]
    selected = sys.argv[1:] or sorted(records)
    for identity in selected:
        apply(identity)


if __name__ == "__main__":
    main()
