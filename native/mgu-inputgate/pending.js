'use strict';
// Report the required normal restart; never restart or signal the HMI here.
console.log(JSON.stringify({
    reboot: process.argv[2] === 'remove'
        ? '旋钮输入组件将在下次车机启动时完全卸载'
        : '旋钮输入组件将在下次车机启动时生效',
}));
