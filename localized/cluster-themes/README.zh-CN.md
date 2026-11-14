# Cluster Themes 国内版

上游固定于 `provenance.json` 的提交。原版 `apps/cluster_themes/app.json`、
仪表布局和 `shared/` 引擎保持上游内容。修改集中于中控 `page.js`、
`page_locale.js`、翻译表和中文字体；主题选择弹窗支持翻页。

升级时先审阅上游变化，再更新 `provenance.json` 中的上游版本、CN 修订和
三段式发行版本。更新说明保持简短。

从仓库根目录执行：

```sh
python3 tools/import_cluster_themes.py
# 仅新增中文字形时需要 Pillow 和固定 SHA-256 的 Noto Sans SC 字体：
python3 localized/cluster-themes/kit/tools/bake_cjk.py /path/to/NotoSansSC.ttf
python3 tools/import_cluster_themes.py
node tools/test_cluster_themes.js
node tools/test_localized.js
```

生成的源码包不含 BMW SDK；车机使用已安装应用的 SDK 链接。测试使用实际页面、
字体和主题资源配合模拟车辆数据，不代表实车运行验证。
