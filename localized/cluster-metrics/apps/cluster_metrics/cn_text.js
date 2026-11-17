'use strict';
// Apply only to RHMI text, never to protocol values or the Latin glyph atlas.
const words = {
    'Metrics Paused': '数据显示已暂停，请选择显示位置后开启',
    'Metrics Active': '数据显示已开启',
    'Waiting for cluster-render': '等待仪表显示服务就绪',
    'Map 0x100 (BC OK)': '地图叠加（保留行车信息）',
    'HUD over Waze': '地图上叠加抬头数据',
    'HUD + Nav': '抬头数据与导航',
    'HUD yielded': '抬头内容已让位',
    'No active route': '暂无导航路线',
    'Cluster & HUD Renderer': '仪表与抬头显示服务',
    'HUD Navigation & Mini-Map Detector': '抬头导航与路口地图',
    'Read-Only UDS & Aux Telemetry': '只读诊断与辅助数据',
    'HV Battery (Charge / Power / Temp)': '动力电池（电量／功率／温度）',
    'Engine & Gearbox Temperatures': '发动机与变速箱温度',
    'Gearbox & Friction Brake': '挡位与机械制动',
    'HUD 3-line over Waze': '地图上叠加三行抬头数据',
    'HUD 3-line + Full Nav': '三行抬头数据与导航',
    'HUD 3-line': '三行抬头数据',
    'HUD off': '抬头显示已关闭',
    'map 0x100 (BC widget OK)': '地图叠加（保留行车信息）',
    'cluster idle': '仪表未占用',
    'Connected': '已连接', 'Handshake': '正在连接', 'Disconnected': '未连接',
    'Layers': '图层', 'Refused': '未接受', 'Mode': '模式',
    'Brake ECU': '制动模块', 'Pedal': '踏板', 'Regen': '能量回收',
    'Demo mode (connect to car for live DSC 0x29 hydraulic pressure & 30s probe)': '演示数据；连接车辆后可读取制动压力并记录 30 秒数据',
    'Caliper': '制动钳', 'Powertrain': '动力系统', 'Efficiency': '能耗',
    'Secondary': '辅助数据', 'Speed': '车速', 'SoC': '电量', 'SOC': '电量',
    'Power': '功率', 'Temp': '温度', 'EV Range': '纯电续航',
    'Oil': '机油', 'OIL': '机油', 'Coolant': '冷却液', 'Gearbox': '变速箱',
    'IAT': '进气温度', 'Gear': '挡位', 'Stage': '挡位',
    'white digit shown next to D': '数字显示在 D 挡旁',
    'hidden': '已隐藏', 'Brake': '机械制动', 'Off': '关闭',
    'Hidden in Park': '驻车时隐藏', 'Pedal hold': '踏板保持',
    'idle': '待机', 'Nominal': '正常', 'Units': '单位',
    'Alerts': '提醒', 'Demo': '演示', 'Live': '实时', 'DEMO': '演示', 'LIVE': '实时',
    'Reading UDS...': '正在读取传感器…',
    'Read UDS Sensors Now': '立即读取传感器',
    'Recording Probe': '正在记录', 'Saved': '已保存',
    'Action Needed: Revert cluster-render.local.conf': '检测到仪表显示配置冲突',
    'Slot 0x202 hides Power Gauge; run configure-cluster-slot.sh --revert for 0x203': '请先关闭本应用并检查显示配置，避免遮挡原厂仪表',
    '(BLOCKS POWER GAUGE - revert local.conf!)': '（配置可能遮挡原厂仪表）',
    'own_nav_minimap': '显示导航，路口地图让位',
    'own_nav_keep': '持续显示应用导航', 'yield_lanes': '车道／路口地图让位',
    'yield_route': '导航期间隐藏', 'mini-map': '路口地图', 'waze_hud': '手机地图',
    'route': '导航路线', 'lanes': '车道指引', 'nav': '导航',
    'sent': '发送', 'ok': '成功', 'miss': '未响应', 'blk': '已拦截',
    'prog': '程序', 'gear': '挡位', 'sw': '制动开关',
    'ON': '开启', 'OFF': '关闭', 'EV': '纯电', 'GAS': '燃油',
    'PHEV': '插混', 'ICE': '燃油', 'HYBRID': '混动',
};
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pattern = new RegExp('(^|[^A-Za-z0-9_./])(' +
    Object.keys(words).sort((a, b) => b.length - a.length).map(escape).join('|') +
    ')(?=$|[^A-Za-z0-9_./])', 'g');
function text(value) {
    return String(value == null ? '' : value).replace(pattern, (_, before, phrase) => before + words[phrase]);
}
module.exports = { text };
