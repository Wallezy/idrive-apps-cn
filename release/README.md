# Releases

## CN distribution

The GitHub publish target is `Wallezy/idrive-apps-cn`; `publish.js` refuses a
different GitHub target. `MGU_PUBLISH=dir:<folder>` remains available for
isolated local build and emulator catalogs. No push automatically publishes.

The reserved public catalog is
`https://mgu.walle.pw/mgu/cn/idrive-apps/catalog.json` (not published yet).
It must contain validated CN artifacts and dependencies, never a relabelled
upstream mirror. Application/component IDs remain upstream's for compatible
migration; the CN Store owns source selection and migration.

Before a real Release workflow run, commit the stamped versions, complete
the CN Store integration, update-order and recovery tests, and record their
evidence in a successful commit status named `release-check/cn-integration`
on that exact commit. CI unit tests alone do not set this status. Publishing
checks it before any remote write. A later source or version change needs its
own validation. The Release workflow defaults to dry run; a dry run may stamp
locally but neither pushes nor publishes.

国内发行版在配套商店集成和恢复验证完成前不发布。发布状态必须对应实际验证的提交，
不能把源码仓库、中文截图或上游镜像可用当成国内版安装就绪。

The initial CN localization preserves the reviewed numeric versions recorded
in `cn-localization-versions.json`; do not stamp that preparation. Run
`node release/test/cn_localization_test.js` to check the catalog coverage and
all version fields. An unpublished, isolated CN catalog can start with these
versions, but an existing installation of the same number needs an explicitly
validated migration/reinstall path. Never overwrite a published artifact at
the same version. Later releases follow the versioning rules below. See
[the localization scope and migration limits](../docs/LOCALIZATION.zh-CN.md).

`release.js` builds the repository's components from HEAD and publishes
them with the catalog the [mgu Store](https://github.com/robertnisipeanu/mgu-store)
reads (its `docs/PUBLISHING.md`, "2. Catalog"): each tool with a
`native/<id>/component.json` as a tool kit, each app with an
`apps/<id>/release.json` (a source package the head unit builds).

```sh
node release/release.js list                          # versions and publish state
node release/release.js build [<id>...]               # artifacts and catalog.json into release/out/
node release/release.js check [<id>...]               # build twice, compare byte for byte
node release/release.js versions <base>               # a pull request's version and CHANGELOG checks
node release/release.js stamp [<id>...] [--dry-run]   # next versions into the tree, the release commit
node release/release.js publish [<id>...] [--dry-run] # validated committed versions, then the catalog
MGU_PUBLISH=dir:<folder> node release/release.js publish   # a local catalog (test unit, USB stick)
node release/test/release_test.js
```

**Versions.** The release sets them; a pull request never does
([`CONTRIBUTING.md`](../CONTRIBUTING.md)). The tree holds each component's
last released version: a tool's `component.json`, an app's `mgu-app.json`
and its `package/` tree. `stamp` finds each component changed since its
release tag `<id>@<version>` and gives it the next version: a patch, or a
minor or major one when a merged pull request carries the label
`release:minor` or `release:major`. Any number of changes give one new
version. It writes the version in, moves the CHANGELOG's `## Unreleased`
lines under `## <version>` (leaving an empty `## Unreleased`), writes each `"requires"` of `"next"` as the version
that component has after this release, and commits `release: <id>@<version>,
...`. A version stamped but not published yet keeps its number at the next
run. An app's package tree is `package/`; the build names it
`<id>@<version>` inside the package.

One version has exactly one artifact. Builds run on `git archive HEAD` with
`SOURCE_DATE_EPOCH` from the last commit that touched what the component
ships. `publish` builds each component twice and publishes a version only
when both builds match; it skips a version already published with other
bytes. A tool kit holds what mgu-store's `deploy/hu artifact` packs, byte
for byte.

**Catalog.** The release `catalog` holds `catalog.json` (schema 2); each
version is the release `<id>@<version>`, its artifact the one asset. An
entry's `artifact.url` is the asset's release download
(`https://github.com/<owner>/<repo>/releases/download/<tag>/<name>`) while
this repository is public, which a car without a GitHub sign-in downloads
without GitHub's API and its rate limit, and the asset's API URL while it
is private. `publish` lists the entries it carries over the same way, and
publishes the catalog when only that changed. An app's `icon` is
`<id>.png`, an asset of the release `catalog` beside `catalog.json`, with
its `iconSha256`: the PNG its staged tree's `rhmiData/application.json`
names on its first entry point (what the car's app list shows), uploaded
by the publish of that version. The Store shows it while the app is not
installed.

**Languages.** An entry's `texts` is its title and description in other
languages, from `release/texts/<code>.json`, one file per language of the
Store (`de`, `pt-BR`, `zh-TW`, ...):

```json
{ "waze-on-cluster": { "title": "Waze im Kombiinstrument", "description": "…" } }
```

The Store shows the head unit's language and English where a language has
none. A file that names an id that is not a component, or holds anything
but a `title` and a `description` (either may be left out; a title of at
most 80 characters on one line, a description of at most 1000), is
refused.
`publish` lists them on every entry it carries over too, so changed texts
need no new version.

| Entry | Fields |
|---|---|
| `cluster-render` (tool) | `requires: {"mgu-deploy": "0.4.0"}`, `uninstallable`, `mguHmi: ["ID7"]` (`native/cluster-render/component.json`) |
| `waze-on-cluster` (tool) | `requires: {"mgu-deploy": "0.7.11", "cluster-render": …}`, `uninstallable`, `mguHmi: ["ID7"]` (`native/waze-on-cluster/component.json`) |
| `robertn_waze_cluster` (app) | `build: "unit"`, `requires: {"waze-on-cluster": …}`, `uninstallable`, `mguHmi: ["ID7"]` (`apps/robertn_waze_cluster/release.json`) |

The catalog is not signed: the Store fetches it over HTTPS and checks each
artifact's size and sha256 against it.

**Publishing.** Run `.github/workflows/release.yml` by hand (Actions,
Release) on an already stamped and validated `main` commit, with component
ids or none for all components. It publishes that exact commit after checking
the CN validation status and tags each new version `<id>@<version>`.
**Dry run** stamps and builds without pushing or publishing, and lists what
it would publish.
It uses the workflow's `GITHUB_TOKEN` (`contents: write`) and publishes
whether this repository is private or public
(`MGU_PUBLISH_VISIBILITY=any`). `.github/workflows/test.yml` runs every
test on each push to main and builds every component twice from a clean
export, on two runners, comparing the artifacts as `check` does; a pull
request runs the tests and the double build of the components it changes,
and `versions` against its base.

## License

GPL-3.0-or-later (`LICENSE` at the repository root).
