#!/usr/bin/env python3
"""Stage the pinned BMRMODZ apps as SDK-free CN source packages."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / "localized/bmrmodz"
CN = ROOT / "localized/cauliflower/kit/runtime"
sys.path.insert(0, str(LOCAL / "kit/tools"))
import build
import localize

PLAN = {
    "osa": ("0.2.65", "油温助手", "查看机油、冷却液和变速箱油温，估算暖机时间并保存本地历史。",
            ["新增油温助手，支持暖机估算与本地历史。", "简体中文界面，适配商店渲染器和仪表通知。",
             "兼容旧版车机运行时的油温通知。"]),
    "dpf": ("0.1.76", "DPF 状态", "只读查看支持的 B47、B57 柴油机颗粒过滤器数据、再生状态与距离；保留原有 DPF 监测应用。",
            ["新增 DPF 状态，查看积碳、灰分与再生信息。", "采用上游直接诊断路径，不启用实验数据服务。"]),
    "spritmonitor": ("0.1.46", "加油记录", "记录加油与 AdBlue 补充，支持关联 Spritmonitor.de 账户；联网同步需要该服务可访问。",
                     ["新增加油记录，支持燃油与 AdBlue 补充。", "提供中文界面，账户关联和联网同步由用户发起。"]),
}


def read(path):
    return json.loads(path.read_text())


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def words_for(identity):
    module = {"osa": "locales", "dpf": "translations",
              "spritmonitor": "additional-locales"}[identity]
    script = "process.stdout.write(JSON.stringify(require(process.argv[1])['zh-CN']));"
    return json.loads(subprocess.check_output(
        ["node", "-e", script, str(LOCAL / "apps" / identity / module)]))


def main():
    provenance = read(LOCAL / "provenance.json")
    baseline = read(ROOT / "release/cn-localization-versions.json")
    repository = read(ROOT / "release/repo.json")
    notes = read(ROOT / "release/notes.json")
    generic = read(CN / "locales/zh-CN.json")
    for identity, (version, title, description, changes) in PLAN.items():
        original = read(LOCAL / "apps" / identity / "app.json")
        words = dict(generic, **words_for(identity))
        words[original["title"]] = title
        words.update({"CN Store renderer and input compatibility": "适配国内版商店渲染与旋钮输入",
                      "CN Store compatibility": "国内版商店兼容"})
        build.load_locale = lambda language, words=words: words
        localize.load_locale = build.load_locale
        build.credit = lambda language: None
        localize.credit = build.credit

        def spec_for(spec, language):
            value = localize.localize_spec(spec, language)
            value.update(version=version, title=title, description=description)
            for setting in value.get("settings", []):
                if setting["key"] == "language":
                    setting.update(default="zh-CN", options=[["zh-CN", "简体中文"]])
            return value

        build.localize_spec = spec_for
        with tempfile.TemporaryDirectory(prefix="mgu-bmrmodz-") as temp:
            build.DIST = temp
            os.environ["MGU_OUT"] = temp
            build.build(identity, "zh-CN")
            app = ROOT / "apps" / identity
            package = app / "package"
            if package.exists():
                shutil.rmtree(package)
            shutil.copytree(Path(temp) / identity / "source", package)
        os.environ.pop("MGU_OUT", None)
        entry = package / "javascript/app.js"
        source = entry.read_text()
        entry.unlink()
        (package / "javascript/localized-entry.js").write_text("require('./app.js');\n" + source)
        kit = package / "javascript/kit"
        runtime = kit / "mgu.js"
        runtime.write_text(runtime.read_text().replace("require('oap-sdk')", "global.__mguLocalizedSdk"))
        if identity == "osa":
            notification = package / "javascript/oil-notification.js"
            notification.write_text(notification.read_text().replace(
                ".finally(() => { sending = false; });",
                ".then(() => { sending = false; }, () => { sending = false; });"))
        # Use the maintained CN wire dialect, glyph identities and shared atlas pieces.
        for name in ["canvas.js", "record.js", "renderd.js", "fonts.js", "credits.js", "text-layout.js"]:
            shutil.copy2(CN / name, kit / name)
        display = kit / "display.js"
        display.write_text(display.read_text().replace(
            "Object.assign({ native },", "Object.assign({ native, interactive: native },"))
        for path in (kit / "fonts").glob("*.json"):
            path.unlink()
        for path in (CN / "fonts").iterdir():
            if path.is_file() and path.name != "cjk.json":
                shutil.copy2(path, kit / "fonts" / path.name)
        shutil.copy2(LOCAL / "cjk.json", kit / "fonts/cjk.json")
        write(kit / "locale.json", {"language": "zh-CN", "strings": words})
        for path in (package / "javascript").glob("*.test.js"):
            path.unlink()
        main = package / "javascript/localized-entry.js"
        body = main.read_text()
        anchor = {"osa": "['0.2.63',", "dpf": "['0.1.75',", "spritmonitor": "['0.1.45',"}[identity]
        assert anchor in body
        body = body.replace(anchor, "['" + version + "', 'CN Store renderer and input compatibility'],\n                " + anchor, 1)
        main.write_text(body)
        pkg = read(package / "package.json")
        pkg.update(main="javascript/localized-entry.js", mguLocalOnly=True, license="MIT",
                   author="BMRMODZ / dzooky", description=description,
                   files=["package.json", "npm-shrinkwrap.json", "manifest.json", "permissions.json",
                          "config", "javascript", "rhmiData", "LICENSE", "NOTICE.zh-CN.md",
                          "PROVENANCE.json", "CHANGELOG.md"])
        if (package / "rhmiDataStartWidget").exists():
            pkg["files"].append("rhmiDataStartWidget")
        write(package / "package.json", pkg)
        shutil.copy2(LOCAL / "LICENSE", package / "LICENSE")
        write(package / "PROVENANCE.json", {
            "repository": provenance["repository"], "commit": provenance["commit"],
            "upstreamVersion": original["version"], "releaseVersion": version,
            "cnRevision": 2 if identity == "osa" else 1,
            "runtimeValidation": "pending; no vehicle contacted",
            "sourceFilesSha256": {k: v for k, v in provenance["sourceFilesSha256"].items()
                                  if k.startswith("apps/" + identity + "/")},
        })
        (package / "NOTICE.zh-CN.md").write_text(
            "原作者：BMRMODZ / dzooky。共享运行库原作者与中文翻译署名保留于 LICENSE。\n"
            "使用现有商店渲染器与旋钮输入，未打包 BMW SDK；字体许可随资源保留。\n"
            "本次尚未进行真车验证。\n")
        (package / "CHANGELOG.md").write_text(
            "# " + title + "\n\n## Unreleased\n\n## " + version + "\n\n" +
            "\n".join("- " + change for change in changes) + "\n")
        (app / "src").mkdir(exist_ok=True)
        shutil.copy2(ROOT / "apps/warmup/src/sdk.js", app / "src/sdk.js")
        write(app / "mgu-app.json", {
            "schema": 1, "id": identity, "version": version, "tree": "package",
            "modules": ["src/sdk.js"],
            "sdk": ["oap-sdk/src/core/OnlineApp.js", "oap-sdk/src/logging/logging"],
        })
        requires = {"mgu-deploy": "0.8.28", "mgu-render": "0.6.28",
                    "mgu-inputgate": "1.2.2", "robertn_store": "0.9.48"}
        if identity in ("osa", "dpf"):
            requires.update({"bmrmodz-car-equipment": "0.1.6", "bmrmodz-notification": "0.1.2"})
        if original.get("mguInternet"):
            requires["mgu-uplink"] = "0.7.14"
        write(app / "release.json", {
            "build": "node ../../tools/build_localized.js", "requires": requires,
            "uninstallable": True, "mguHmi": ["ID7"],
        })
        note = {"version": version, "upstreamVersion": original["version"],
                "cnRevision": 2 if identity == "osa" else 1, "changes": changes}
        write(app / "release-notes.json", [note])
        notes[identity] = [note]
        baseline["components"][identity] = version
        for path in (ROOT / "release/texts").glob("*.json"):
            texts = read(path)
            texts[identity] = {"title": title, "description": description}
            write(path, texts)
    for identity in ["bmrmodz-car-equipment", "bmrmodz-notification"]:
        component = read(ROOT / "native" / identity / "component.json")
        upstream = read(ROOT / "native" / identity / "PROVENANCE.json")
        notes[identity] = [{"version": component["version"], "upstreamVersion": upstream["upstreamVersion"],
                            "cnRevision": 1, "changes": [component["description"]]}]
        baseline["components"][identity] = component["version"]
        for path in (ROOT / "release/texts").glob("*.json"):
            texts = read(path)
            texts[identity] = {key: component[key] for key in ["title", "description"]}
            write(path, texts)
    repository["unprefixedAppIds"] = sorted(set(repository["unprefixedAppIds"]) | set(PLAN))
    write(ROOT / "release/repo.json", repository)
    write(ROOT / "release/notes.json", notes)
    write(ROOT / "release/cn-localization-versions.json", baseline)


if __name__ == "__main__":
    main()
    from apply_attribution import apply
    for identity in PLAN:
        apply(identity)
