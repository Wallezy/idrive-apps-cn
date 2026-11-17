'use strict';

// RAM01 IDENT and STEUERN_ROUTINE from ram01.prg. F150's RAM01
// index is also present in Fault Scanner's SGBD index at address 0x37.
const ADDRESS = 0x37;
const STATUS = {
    0: '尚未启动',
    1: '校准进行中',
    2: '完成，无错误',
    3: '结束，有错误',
    4: 'RAM 报告校准超时',
    5: '校准被中断',
    255: '状态未定义',
};

async function request(diag, service, data, echo, exactLength) {
    if (!diag.available) throw new Error('车机诊断接口不可用');
    const matches = (uds) => echo.every((byte, index) => uds[index] === byte);
    let onFrame, timer;
    const reply = new Promise((resolve) => {
        onFrame = (frame) => {
            if (frame.ecu !== ADDRESS) return;
            const uds = frame.uds;
            if (uds[0] === 0x7F && uds[1] === service && uds.length === 3) {
                if (uds[2] !== 0x78) resolve(uds);
            } else if (matches(uds)) {
                resolve(uds);
            }
        };
        diag.on('frame', onFrame);
    });
    const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('等待 RAM 响应超时')), 12000);
    });
    // Use the same InternalTasu proxy and input shape as kit/diag.js. Issue each
    // call once, including when its outcome is ambiguous or TASU reports busy.
    const send = Promise.resolve().then(() => diag.signals.call(diag.p, 'sendTasuRequest', {
        sourceAddress: 0xF2,
        targetAddress: ADDRESS,
        serviceID: service,
        subroutineID: 0,
        udsDataLength: data.length,
        udsData: Buffer.from(data),
        deadlockTime: 0,
    }, 8000)).then((result) => {
        const verdict = result && typeof result === 'object'
            ? result.TasuErrorEnum || Object.keys(result).map((key) => result[key]).find((value) => typeof value === 'string')
            : result;
        // Some binding versions return void. A matching ECU reply is still required.
        if (verdict !== undefined && !['NO_ERROR', 'REQUEST_PENDING', '0', '1'].includes(String(verdict))) {
            throw new Error('诊断接口未确认请求：' + String(verdict));
        }
    });
    try {
        const [uds] = await Promise.race([Promise.all([reply, send]), timeout]);
        if (uds[0] === 0x7F) {
            const error = new Error('RAM 拒绝请求，NRC 0x' + uds[2].toString(16).toUpperCase());
            error.nrc = uds[2];
            throw error;
        }
        if (exactLength && uds.length !== exactLength) throw new Error('RAM 返回的数据长度不符');
        return uds;
    } finally {
        clearTimeout(timer);
        diag.removeListener('frame', onFrame);
    }
}

async function identify(diag) {
    const reply = await request(diag, 0x22, [0xF1, 0x50], [0x62, 0xF1, 0x50]);
    if (reply[3] !== 0x0F || reply[4] !== 0x25 || reply[5] !== 0x90) {
        throw new Error('当前模块未识别为 RAM01');
    }
}

async function readStatus(diag) {
    // The result record has the one-byte gain offset followed by the status.
    const reply = await request(diag, 0x31, [0x03, 0xA0, 0x91], [0x71, 0x03, 0xA0, 0x91], 6);
    const code = reply[5];
    return { code, text: STATUS[code] || '未知状态 ' + code };
}

async function calibrate(diag, assertParked, show, delay) {
    await identify(diag);
    try {
        const previous = await readStatus(diag);
        if (previous.code === 1) throw new Error('RAM 已在校准，请读取结果');
    } catch (error) {
        // NRC 24 means no routine result is available in the current sequence.
        if (error.nrc !== 0x24) throw error;
    }
    assertParked();
    try {
        await request(diag, 0x31, [0x01, 0xA0, 0x91], [0x71, 0x01, 0xA0, 0x91], 4);
        show('RAM 已接受校准请求，正在等待结果');
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
            await delay(1000);
            const status = await readStatus(diag);
            if (status.code === 2) return '校准成功，RAM 返回完成且无错误';
            if (status.code !== 0 && status.code !== 1) return '校准结果：' + status.text;
        }
        return '等待校准结果超时，请读取 RAM 状态';
    } catch (error) {
        if (error.nrc !== undefined) throw error;
        throw new Error(error.message + '，请先读取 RAM 状态');
    }
}

module.exports = { identify, readStatus, calibrate };
