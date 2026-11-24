# BMRMODZ 应用

来源：`dzooky/bmrmodz`，审阅提交
`a12105d46eccf5de2eaeb9a3800446fd17992074`，MIT 许可。
原作者、共享运行库作者及中文翻译署名保留于应用的 LICENSE。

| 应用 | CN 版本 | 上游版本 | 功能及限制 |
| --- | --- | --- | --- |
| 油温助手 | 0.2.65 | 0.2.63 | 查看机油、冷却液、变速箱温度，估算暖机时间并保存本地历史。变速箱诊断取决于车辆控制器。 |
| DPF 状态 | 0.1.76 | 0.1.75 | 只读查看受支持 B47、B57 柴油机的积碳、灰分和再生信息。与现有 `dpf_monitor` 分别安装，不代替原应用。 |
| 加油记录 | 0.1.46 | 0.1.45 | 记录燃油及 AdBlue 补充。账户关联、车辆选择和同步需要 Spritmonitor.de 服务可访问。 |

应用适配 ID7，使用商店已发布的 `mgu-render`、`mgu-inputgate` 和
`mgu-uplink`。BMRMODZ 的设置动作、数据存储和直接只读诊断路径保留；
绘图协议、字体图集、输入握手使用维护中的 CN 实现。字体为 Ubuntu、
Barlow 和 Noto Sans SC，无 BMW SDK 或固件资源。源码包由车机使用自身
SDK 链接，仓库不包含生成的 `javascript/app.js`。

油温助手和 DPF 状态的依赖由商店自动安装：

- **车辆配置缓存 0.1.6**：只读获取选装配置。使用已发布
  `iteriodev-turnview` 服务提供的 `hmictl`，不需要安装舒适控制应用。
  仅允许网关 `22 3F 06`，失败时保留缓存并按上游规则重试。
- **仪表通知服务 0.1.2**：通过 `cluster-render` 显示短时通知，保留
  原厂告警让位、并发占用检查和到期释放。应用未确认受支持仪表配置时，
  不自动开启通知。

仓库中的舒适控制 `climate-comfort` 明示尚未准备公开使用，
数据诊断 `data-diagnostics` 及其数据服务存在已记录的 ECU 通信问题，
均不包含于本次发行。DPF 使用上游 0.1.75 的直接 TASU 路径，
不安装实验数据服务。

## 检查

`node tools/test_bmrmodz.js` 使用打包后的绘图、中文、字体和设置代码，
隔离车机与外网接口，检查三款应用的 11 个主页面及设置滚动状态。
`node tools/test_localized.js` 同时检查 SDK 排除、可重复源码包、
RHMI 标识与依赖。上游 DPF、车辆配置缓存、通知服务和当前油温通知
投递测试纳入 CI。

上游 `apps/osa/oil-notification.test.js` 的断言对应旧版的重复触发语义，
并固定检查 0.2.62；它与当前 0.2.63 实现不一致。该文件作为原始
来源保留，CI 使用较新的 `test-oil-notification-delivery.js`，
检查单次触发、降温复位、重试和发送次数上限。
CN 油温通知使用旧车机支持的 Promise 完成处理；
`tools/test_bmrmodz_notification.js` 在禁用 `Promise.finally` 的条件下
验证首次投递、发送状态释放及冷却后再次通知。

本次发行未连接车机；真车信号、具体车型诊断及真实账户联网验证待进行。
