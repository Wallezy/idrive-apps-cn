require('./app.js');
'use strict';

// 开发维护：抖音 小白科技杂物社 / BiliBili 小白151 / GitHub JackieZ123430
// 基于 cauliflowermossgrape/idrive7-apps 的 OAP 应用框架。

const mgu = require('./kit/mgu');
const { Diag } = require('./kit/diag');
const ram = require('./ram');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

mgu.run({
    async start(ctx) {
        const { ui, log } = ctx;
        const diag = new Diag(ctx.signals, log);
        let speedAt = 0;
        let stopped = false;
        let busy = false;
        let confirmAt = 0;
        let pending = null;
        function invalidate(reason) {
            confirmAt = 0;
            if (pending && !pending.reason) pending.reason = reason;
        }
        let statusUpdate = Promise.resolve();

        function show(message) {
            log.info(message);
            statusUpdate = statusUpdate.then(() => ui.text('STATUS', message))
                .catch((error) => log.warn('RAM 界面更新失败：' + error));
        }

        function assertParked() {
            if (!ui.isVisible('MAIN') || !ui.hasFocus('MAIN')) throw new Error('请在校准页面确认操作');
            if (!stopped || Date.now() - speedAt > 5000) throw new Error('需要有效且为零的车速，请停车后再试');
        }

        async function run(operation) {
            busy = true;
            try {
                show(await operation());
            } catch (error) {
                show(error.message || String(error));
            } finally {
                busy = false;
            }
        }

        ui.onClick('BTN_READ', () => {
            if (busy) return;
            confirmAt = 0;
            return run(async () => {
                show('正在识别 RAM 并读取校准状态');
                await ram.identify(diag);
                const result = await ram.readStatus(diag);
                return 'RAM01 上次校准状态：' + result.text;
            });
        });

        ui.onClick('BTN_START', () => {
            if (pending) {
                invalidate('已取消校准');
                return;
            }
            if (busy) return;
            try {
                assertParked();
                if (!diag.available) throw new Error('车机诊断接口不可用');
            } catch (error) {
                confirmAt = 0;
                show(error.message);
                return;
            }
            const now = Date.now();
            if (!confirmAt || now - confirmAt > 15000) {
                confirmAt = now;
                show('请确认点火已接通、供电稳定、车内安静。15 秒内再次点击开始校准');
                return;
            }
            if (now - confirmAt < 1000) return;
            confirmAt = 0;
            return run(async () => {
                const attempt = pending = {};
                const check = () => {
                    if (attempt.reason) throw new Error(attempt.reason);
                    assertParked();
                };
                try {
                    for (let left = 20; left > 0; left--) {
                        check();
                        show(left + ' 秒后校准，请下车关门；再按开始可取消');
                        await delay(1000);
                    }
                    check();
                    show('正在检查 RAM01 和例程状态');
                    return await ram.calibrate(diag, () => {
                        check();
                        // The start request follows this check; it can no longer be cancelled.
                        pending = null;
                    }, show, delay);
                } finally {
                    pending = null;
                }
            });
        });

        const resetConfirmation = (name, on) => {
            if (name === 'MAIN' && !on) invalidate('已离开校准页面，请重新确认');
        };
        ui.onVisible(resetConfirmation);
        ui.onFocus(resetConfirmation);

        ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusCarSpeed2(value) {
                // Vehicle2 supplies speed in units of 1/64 km/h; zero is exact.
                const now = Date.now();
                if (now - speedAt > 5000) invalidate('车速信号中断，请停车后重新确认');
                speedAt = now;
                stopped = value && value.speedVehicleCentreOfGravity === 0;
                if (!stopped) invalidate('未确认车辆静止，请停车后重新确认');
            },
        }, log, { pollMs: 2000, onUnavailable() {
            stopped = false;
            invalidate('车速信号中断，请停车后重新确认');
        } }).catch((error) => log.warn('车速信号不可用：' + error));
        diag.init();
    },
});
