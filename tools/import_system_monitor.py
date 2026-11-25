#!/usr/bin/env python3
"""Package the pinned system monitor with the maintained CN app runtime."""
import json
import pathlib
import shutil
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
LOCAL = ROOT / "localized/system-monitor"
KIT = ROOT / "localized/cauliflower/kit"
sys.path.insert(0, str(KIT / "tools"))
import build
import localize


def read(path):
    return json.loads(path.read_text())


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def main():
    provenance = read(LOCAL / "provenance.json")
    version = provenance["releaseVersion"]
    words = read(LOCAL / "translations.zh-CN.json")
    # This app owns its dictionary; other published applications keep theirs.
    localize.load_locale = lambda language: words if language == "zh-CN" else {}
    build.load_locale = localize.load_locale
    build.localize_spec = lambda spec, language: dict(
        localize.localize_spec(spec, language), version=version)
    build.APPS = str(LOCAL / "apps")
    with tempfile.TemporaryDirectory(prefix="mgu-system-monitor-") as temp:
        build.DIST = temp
        build.build("sys_monitor", "zh-CN", include_sdk=False)
        app = ROOT / "apps/sys_monitor"
        package = app / "package"
        if package.exists():
            shutil.rmtree(package)
        shutil.copytree(pathlib.Path(temp) / "sys_monitor/source", package)
        shutil.rmtree(package / "node_modules")
        entry = package / "javascript/app.js"
        body = entry.read_text()
        entry.unlink()
        (package / "javascript/localized-entry.js").write_text("require('./app.js');\n" + body)
        runtime = package / "javascript/kit/mgu.js"
        runtime.write_text(runtime.read_text().replace("require('oap-sdk')", "global.__mguLocalizedSdk"))
        # All display strings, including generated settings, use this app's catalog.
        write(package / "javascript/kit/locale.json", {"language": "zh-CN", "strings": words})
        shutil.copy2(LOCAL / "cjk.json", package / "javascript/kit/fonts/cjk.json")
        for rhmi in ["rhmiData", "rhmiDataStartWidget"]:
            path = package / rhmi / "application.json"
            if path.exists():
                data = read(path)
                data["application"]["uiDescriptions"] = [
                    u for u in data["application"]["uiDescriptions"] if "ID7" in u["hmi"]]
                write(path, data)
                shutil.rmtree(package / rhmi / "uiDescriptions/ID8", ignore_errors=True)
        pkg = read(package / "package.json")
        pkg.update(main="javascript/localized-entry.js", mguLocalOnly=True,
                   license="GPL-3.0-or-later",
                   description="查看车机内存、处理器、温度和进程占用，支持排序与趋势图；只读监控。",
                   files=["package.json", "npm-shrinkwrap.json", "manifest.json", "permissions.json",
                          "config", "javascript", "rhmiData", "LICENSE", "LICENSE.MIT",
                          "NOTICE.zh-CN.md", "PROVENANCE.json", "CHANGELOG.md"])
        write(package / "package.json", pkg)
        for name in ["LICENSE", "LICENSE.MIT", "NOTICE.zh-CN.md"]:
            shutil.copy2(LOCAL / name, package / name)
        write(package / "PROVENANCE.json", provenance)
        changes = ["新增系统监控：查看车机内存、处理器、温度和进程占用。",
                   "支持排序、进程详情和近三分钟趋势，离开应用后停止采集。",
                   "简体中文界面，兼容国内版渲染和旋钮输入。"]
        (package / "CHANGELOG.md").write_text(
            "# 系统监控\n\n## Unreleased\n\n## " + version + "\n\n" +
            "\n".join("- " + change for change in changes) + "\n")
        (app / "src").mkdir(exist_ok=True)
        shutil.copy2(ROOT / "apps/warmup/src/sdk.js", app / "src/sdk.js")
        write(app / "mgu-app.json", {
            "schema": 1, "id": "sys_monitor", "version": version, "tree": "package",
            "modules": ["src/sdk.js"],
            "sdk": ["oap-sdk/src/core/OnlineApp.js", "oap-sdk/src/logging/logging"]})
        write(app / "release.json", {
            "build": "node ../../tools/build_localized.js",
            "requires": {"mgu-deploy": "0.8.25", "mgu-render": "0.6.26",
                         "mgu-inputgate": "1.2.2", "robertn_store": "0.9.47"},
            "uninstallable": True, "mguHmi": ["ID7"]})
        note = {"version": version, "upstreamVersion": provenance["upstreamVersion"],
                "cnRevision": 1, "changes": changes}
        write(app / "release-notes.json", [note])
        notes = read(ROOT / "release/notes.json")
        notes["sys_monitor"] = [note]
        write(ROOT / "release/notes.json", notes)
    repo = read(ROOT / "release/repo.json")
    repo["unprefixedAppIds"] = sorted(set(repo["unprefixedAppIds"]) | {"sys_monitor"})
    write(ROOT / "release/repo.json", repo)
    baseline = read(ROOT / "release/cn-localization-versions.json")
    baseline["components"]["sys_monitor"] = version
    write(ROOT / "release/cn-localization-versions.json", baseline)
    for path in (ROOT / "release/texts").glob("*.json"):
        texts = read(path)
        texts["sys_monitor"] = {
            "title": "系统监控",
            "description": "查看车机内存、处理器、温度和进程占用，支持排序与趋势图；只读监控。"}
        write(path, texts)


if __name__ == "__main__":
    main()
    from apply_attribution import apply
    apply("sys_monitor")
