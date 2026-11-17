'use strict';
const cp = require('child_process'), path = require('path');
const root = path.resolve(__dirname, '..');
function run(file, ...args) {
    const p = cp.spawnSync(process.execPath, [file, ...args], { cwd: root, stdio: 'inherit', timeout: 60000 });
    if (p.error) throw p.error;
    if (p.status !== 0) process.exit(p.status || 1);
}
for (const test of ['test_ram_mic', 'test_camera_cleanup', 'test_community_controls'])
    run('tools/' + test + '.js');
for (const item of require('../release/community-import-plan.json').apps) {
    if (item.format !== 'unit') run('tools/test_community_startup.js', item.id);
}
for (const id of ['ram_mic_calibration', 'dpf_monitor', 'spotify', 'true_time_cn', 'jap_ridetube', 'mgu_browser'])
    run('tools/test_ambient_renderer.js', 'apps/' + id + '/package/javascript/kit');
