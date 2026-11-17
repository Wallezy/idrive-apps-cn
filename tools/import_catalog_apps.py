#!/usr/bin/env python3
"""Stage reviewed, SDK-free community apps from hash-pinned source packages.

This command prepares source trees only. It never publishes a channel, installs
anything on a head unit, or executes a downloaded application.
"""
import argparse
import hashlib
import json
import pathlib
import re
import shutil
import tarfile
import tempfile
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parents[1]


def read(path):
    return json.loads(path.read_text())


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def clean_ui(package):
    """Remove promotional UI entries, retaining source and licence attribution."""
    kit = package / "javascript/kit"
    locale = kit / "locale.json"
    if locale.exists():
        value = read(locale)
        value.pop("credit", None)
        value["language"] = "zh-CN"
        if not value.get("strings") and (kit / "locales/zh-CN.json").exists():
            value["strings"] = read(kit / "locales/zh-CN.json")
        write(locale, value)
    credits = kit / "credits.js"
    if credits.exists():
        credits.write_text(
            "'use strict';\n"
            "// Author and translator attribution is retained in NOTICE.zh-CN.md and licences.\n"
            "const CREDIT = '';\nfunction drawCredit() {}\n"
            "module.exports = { CREDIT, drawCredit };\n"
        )
    spec = kit / "app-spec.json"
    if spec.exists():
        value = read(spec)
        for screen in value.get("screens", []):
            if "items" in screen:
                screen["items"] = [
                    item for item in screen["items"]
                    if not (isinstance(item, list) and len(item) > 1
                            and str(item[1]).startswith("CREDIT_"))
                ]
        write(spec, value)
    for path in package.glob("rhmiData*/uiDescriptions/*/uiDescription.json"):
        value = read(path)
        removed = set()
        promotional = lambda comp: (str(comp.get("name", "")).startswith("CREDIT_")
                                    or comp.get("name") == "translationCredit")
        for container in value.get("containers", {}).values():
            if isinstance(container.get("components"), dict):
                removed.update(key for key, comp in container["components"].items()
                               if promotional(comp))
                container["components"] = {
                    key: comp for key, comp in container["components"].items()
                    if not promotional(comp)
                }
        write(path, value)
        xml_path = path.with_name("application.xml")
        if removed and xml_path.exists():
            tree = ET.parse(xml_path)
            for parent in tree.iter():
                for child in list(parent):
                    if child.tag == "component" and child.get("id") in removed:
                        parent.remove(child)
            tree.write(xml_path, encoding="utf-8", xml_declaration=True)
    for path in package.glob("rhmiData*/variantGroups/*/texts/*.json"):
        value = read(path)
        write(path, {key: text for key, text in value.items()
                     if "_CREDIT_" not in key})


def adapt_connection(kit):
    """Use CN negotiation and retry rules, preserving each app's media protocol."""
    path = kit / "renderd.js"
    if not path.exists():
        return
    text = path.read_text()
    text = text.replace(
        "['/run/mgu-renderd/renderd.sock', '/run/mgu-render/render.sock']",
        "['/run/mgu-render/render.sock', '/run/mgu-renderd/renderd.sock']")
    base = (ROOT / "apps/live_data/package/javascript/kit/renderd.js").read_text()
    start = base.index("    _paths()")
    end = base.index("    /**\n     * Have the iDrive controller", start)
    a = text.index("    connect()")
    b = text.index("    /**\n     * Have the iDrive controller", a)
    text = text[:a] + base[start:end] + text[b:]
    text = text.replace("const SOCKET = SOCKETS[0];",
                        "const SOCKET = SOCKETS[0];\nconst CONNECT_MS = 2000, RETRY_MS = 3000;")
    a = text.index("        this.onScreen = null;")
    a = text.index("\n", a)
    text = text[:a] + "\n        this.area = null; this.failed = new Set(); this.failures = new Map();" + text[a:]
    text = text.replace("        if (this.retry) clearTimeout(this.retry);",
                        "        if (this.retry) clearTimeout(this.retry);\n"
                        "        if (this.connectTimer) clearTimeout(this.connectTimer);")
    start = base.index("            if (type === X.READY")
    end = base.index("                this.screen =", start)
    a = text.index("            if (type === X.READY")
    b = text.index("                this.screen =", a)
    text = text[:a] + base[start:end] + text[b:]
    path.write_text(text)
    path = kit / "display.js"
    text = path.read_text()
    text = text.replace("Object.assign({ native }, file ?", "Object.assign({ native, interactive: native }, file ?")
    path.write_text(text)


def stage(plan, item, cache):
    identity = item["id"]
    assert re.fullmatch(r"[a-z0-9_]+", identity)
    artifact = cache / item["artifact"]["name"]
    data = artifact.read_bytes()
    assert len(data) == item["artifact"]["size"]
    assert hashlib.sha256(data).hexdigest() == item["artifact"]["sha256"]
    destination = ROOT / "apps" / identity
    if destination.exists():
        raise ValueError("Refusing to replace an existing app: " + identity)
    with tempfile.TemporaryDirectory(prefix="mgu-catalog-import-") as tmp:
        unpacked = pathlib.Path(tmp)
        with tarfile.open(artifact) as archive:
            members = archive.getmembers()
            assert sum(m.size for m in members) < 200_000_000
            for member in members:
                path = pathlib.PurePosixPath(member.name)
                assert not path.is_absolute() and ".." not in path.parts
                assert member.isfile() or member.isdir()
                if member.isfile():
                    target = unpacked / member.name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(archive.extractfile(member).read())
        unit = read(unpacked / "mgu-app.json") if item.get("format") == "unit" else None
        source = unpacked / unit["tree"] if unit else unpacked / "package"
        if not source.exists() and (unpacked / "package.json").exists():
            source = unpacked
        assert unit or (source / "javascript/app.js").is_file()
        assert not list(source.rglob("node_modules"))
        package = destination / "package"
        shutil.copytree(source, package)
        if unit:
            shutil.copytree(unpacked / "src", destination / "src")
    clean_ui(package)
    version = item["releaseVersion"]
    pkg = read(package / "package.json")
    assert pkg["name"] == identity and pkg["version"] == item["version"]
    pkg.update(version=version, mguLocalOnly=True, license=item["license"])
    if not unit:
        pkg["main"] = "javascript/localized-entry.js"
    pkg["description"] = item["description"]
    # Every input file remains shipped, including original legal notices.
    pkg["files"] = sorted({p.name for p in package.iterdir()} |
                          {"NOTICE.zh-CN.md", "PROVENANCE.json", "CHANGELOG.md"})
    write(package / "package.json", pkg)
    shrink = read(package / "npm-shrinkwrap.json")
    shrink["version"] = version
    write(package / "npm-shrinkwrap.json", shrink)
    for path in package.glob("rhmiData*/application.json"):
        value = read(path)
        value["application"]["version"] = version
        write(path, value)
    app_spec = package / "javascript/kit/app-spec.json"
    if app_spec.exists():
        value = read(app_spec)
        value["version"] = version
        write(app_spec, value)
    if not unit:
        entry = package / "javascript/app.js"
        text = entry.read_text()
        entry.unlink()
        (package / "javascript/localized-entry.js").write_text("require('./app.js');\n" + text)
        runtime = package / "javascript/kit/mgu.js"
        text = runtime.read_text()
        assert "require('oap-sdk')" in text
        runtime.write_text(text.replace("require('oap-sdk')", "global.__mguLocalizedSdk"))
    else:
        translated = destination / "src/i18n.js"
        text = translated.read_text()
        text = re.sub(r'CREDIT: "Translation by:[^"]*"', 'CREDIT: ""', text)
        translated.write_text(text)
    i18n = package / "javascript/kit/i18n.js"
    if i18n.exists():
        text = i18n.read_text()
        # A natively Chinese app may have no translation entries. An empty
        # alternation must not insert "undefined" into mixed Latin/Chinese text.
        text = text.replace("out = out.replace(pattern,", "out = phrases.length ? out.replace(pattern,")
        text = text.replace(
            "before + (dict[word] || folded[word.toLowerCase()]));",
            "before + (dict[word] || folded[word.toLowerCase()])) : out;"
        )
        i18n.write_text(text)
    if not unit:
        adapt_connection(package / "javascript/kit")
    if not unit:
        (destination / "src").mkdir()
        shutil.copy2(ROOT / "apps/warmup/src/sdk.js", destination / "src/sdk.js")
    for name, content in item.get("legalNotices", {}).items():
        assert "/" not in name and name not in {".", ".."}
        (package / name).write_text(content)
        if name not in pkg["files"]:
            pkg["files"].append(name)
    write(package / "package.json", pkg)
    (package / "NOTICE.zh-CN.md").write_text(
        "# 来源与修改\n\n"
        + item["attribution"] + "\n\n"
        + "目录来源：" + plan["catalogUrl"] + "\n\n"
        + "本次修改：接入 CN 商店的 SDK 链接流程，清理界面推广水印；"
        "保留原作者、译者的版权声明和许可证。"
        "BMW SDK 不随包分发，由部署工具在用户自己的车机上链接。\n"
    )
    write(package / "PROVENANCE.json", {
        "catalogUrl": plan["catalogUrl"], "catalogSha256": plan["catalogSha256"],
        "component": identity, "sourceArtifact": item["artifact"],
        "upstreamVersion": item["version"], "releaseVersion": version,
        "cnRevision": 1, "source": item["source"], "license": item["license"],
        "vehicleTested": False,
    })
    changes = item["changes"]
    (package / "CHANGELOG.md").write_text(
        "# " + item["title"] + "\n\n## Unreleased\n\n## " + version + "\n\n"
        + "".join("- " + change + "\n" for change in changes)
    )
    write(destination / "mgu-app.json", {
        "schema": 1, "id": identity, "version": version, "tree": "package",
        "modules": unit["modules"] if unit else ["src/sdk.js"],
        "sdk": unit["sdk"] if unit else ["oap-sdk/src/core/OnlineApp.js", "oap-sdk/src/logging/logging"],
        **({"internet": True} if pkg.get("mguInternet") else {}),
    })
    write(destination / "release.json", {
        "build": "node ../../tools/build_localized.js",
        "requires": item["cnRequires"], "uninstallable": True, "mguHmi": ["ID7"],
    })
    write(destination / "release-notes.json", [{
        "version": version, "upstreamVersion": item["version"], "cnRevision": 1,
        "changes": changes,
    }])
    baseline = read(ROOT / "release/cn-localization-versions.json")
    baseline["components"][identity] = version
    write(ROOT / "release/cn-localization-versions.json", baseline)
    repo = read(ROOT / "release/repo.json")
    repo["unprefixedAppIds"] = sorted(set(repo["unprefixedAppIds"]) | {identity})
    write(ROOT / "release/repo.json", repo)
    for path in (ROOT / "release/texts").glob("*.json"):
        value = read(path)
        value[identity] = {"title": item["title"], "description": item["description"]}
        write(path, value)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", type=pathlib.Path, required=True)
    parser.add_argument("--cache", type=pathlib.Path, required=True)
    parser.add_argument("ids", nargs="+")
    args = parser.parse_args()
    plan = read(args.plan)
    selected = {item["id"]: item for item in plan["apps"]}
    for identity in args.ids:
        stage(plan, selected[identity], args.cache)
        print("Staged", identity)


if __name__ == "__main__":
    main()
