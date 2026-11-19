// mgu-inputgate.so - lets a full-screen app (Doom) have the iDrive controller to itself.
//
// Loaded into the HMI (HmiMain3D) with LD_PRELOAD (systemd drop-in, deploy-car.sh). The HMI gets
// the controller as SOME/IP notifications of service 0xb508 (FrontCCU), event 0x8002
// (RotaryEncoderStateFront: [0] sequence, [1..2] knob position u16 BE, [3] press, [4] tilt, ...).
// While the gate is closed, this shim rewrites that event for the HMI only: the knob stands
// still, not pressed, centred. Apps read the controller over their own SOME/IP connection and
// still get the real values. The buttons (BACK, MENU, ... event 0x8001) and the touchscreen are
// never touched, so BACK always gets you out.
//
// The gate is closed only while /run/mgu-renderd/inputgate is fresh: mgu-renderd (root) touches
// it every ~200 ms while a connected app asks for the controller (M_GRAB). App closed, crashed or
// renderer gone -> the file goes stale and the HMI has the controller back within GATE_MS.
// Afterwards the knob position carries on from where the HMI last saw it (no focus jump).
// While closed, the real event goes on to mgu-renderd (abstract unix datagram socket
// "@mgu-renderd-ccu"), which hands it to the app holding the controller: the app gets exactly
// what the HMI would have got, even where its own SOME/IP copy doesn't arrive (the VM).
//
// The hook: CommonAPI-SomeIP's Connection::handleProxyReceive (every notification for the HMI's
// proxies passes there; called through the PLT, so the preloaded definition is the one used).
#include <vsomeip/vsomeip.hpp>   // compat (v2) API, as used by CommonAPI-SomeIP 3.1.12

#include <dlfcn.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>
#include <time.h>

#include <atomic>
#include <memory>
#include <mutex>

namespace {

const char *GATE_FILE = "/run/mgu-renderd/inputgate";
const long GATE_MS = 700;           // file older than this: gate open (HMI has the controller)
const uint16_t SVC_CCU = 0xb508, EVT_ROTARY = 0x8002, SET_ROTARY_CONTROL = 3;
const uint16_t KNOB_MID = 0x7fff;

typedef void (*handle_proxy_receive_t)(void *self, const std::shared_ptr<vsomeip::message> &);
handle_proxy_receive_t g_real;

long mono_ms()
{
    timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1000L + t.tv_nsec / 1000000L;
}

// gate state, looked up at most every 50 ms
bool gate_closed()
{
    static std::atomic<long> checked{-1000};
    static std::atomic<bool> closed{false};
    long now = mono_ms();
    if (now - checked.load() < 50) return closed.load();
    checked.store(now);
    struct stat st;
    bool c = false;
    if (stat(GATE_FILE, &st) == 0) {
        timespec rt; clock_gettime(CLOCK_REALTIME, &rt);
        long age = (rt.tv_sec - st.st_mtim.tv_sec) * 1000L + (rt.tv_nsec - st.st_mtim.tv_nsec) / 1000000L;
        c = age >= 0 && age < GATE_MS;          // a clock jump backwards opens it (safe side)
    }
    closed.store(c);
    return c;
}

// the real event -> mgu-renderd (best effort, never blocks)
void forward(const uint8_t *d, uint32_t n)
{
    static int fd = -1;
    if (fd < 0) fd = socket(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    if (fd < 0) return;
    sockaddr_un a{};
    a.sun_family = AF_UNIX;
    static const char name[] = "\0mgu-renderd-ccu";
    memcpy(a.sun_path, name, sizeof name - 1);
    sendto(fd, d, n, MSG_DONTWAIT | MSG_NOSIGNAL, reinterpret_cast<sockaddr *>(&a),
           socklen_t(offsetof(sockaddr_un, sun_path) + sizeof name - 1));
}

// knob position as the HMI sees it: real position - offset; frozen while the gate is closed
std::mutex g_mu;
uint16_t g_offset, g_hmi_pos;
bool g_have_pos, g_was_closed;

// Match the HMI's new origin after a setter or a moving overflow event.
void recentred()
{
    g_offset = 0;
    g_hmi_pos = KNOB_MID;
    g_have_pos = true;
}

void filter(const std::shared_ptr<vsomeip::message> &msg)
{
    if (!msg || msg->get_service() != SVC_CCU || msg->get_method() != EVT_ROTARY) return;
    std::shared_ptr<vsomeip::payload> pl = msg->get_payload();
    if (!pl || pl->get_length() < 5) return;
    uint8_t d[64];
    uint32_t n = pl->get_length();
    if (n > sizeof d) return;
    memcpy(d, pl->get_data(), n);
    uint16_t pos = uint16_t(d[1] << 8 | d[2]);
    bool closed = gate_closed();
    std::lock_guard<std::mutex> lk(g_mu);
    uint16_t hmi_was = g_hmi_pos;
    bool had_pos = g_have_pos;
    if (pos != 0xffff && !closed) {
        if (g_was_closed && g_have_pos) g_offset = uint16_t(pos - g_hmi_pos);   // carry on
        g_was_closed = false;
        uint16_t hmi = uint16_t(pos - g_offset);
        if (g_offset && g_have_pos) {
            int v = g_hmi_pos + int16_t(uint16_t(hmi - g_hmi_pos));
            if (v < 0 || v > 0xfffe) {
                v = v < 0 ? 0 : 0xfffe;
                g_offset = uint16_t(pos - v);
            }
            hmi = uint16_t(v);
        }
        g_hmi_pos = hmi;
        g_have_pos = true;
    }
    if (!closed) {
        if (pos != 0xffff && g_offset) {
            d[1] = uint8_t(g_hmi_pos >> 8); d[2] = uint8_t(g_hmi_pos);
            pl->set_data(d, n);
        }
    } else {
        forward(d, n);
        g_was_closed = true;
        if (g_have_pos) { d[1] = uint8_t(g_hmi_pos >> 8); d[2] = uint8_t(g_hmi_pos); }
        d[3] = 0;
        d[4] = 0;
        pl->set_data(d, n);
    }
    if (n > 5 && d[5] == 1 && pos != 0xffff && had_pos && g_hmi_pos != hmi_was) recentred();
}

void recentre(const std::shared_ptr<vsomeip::message> &msg)
{
    if (!msg || msg->get_service() != SVC_CCU || msg->get_method() != SET_ROTARY_CONTROL) return;
    auto pl = msg->get_payload();
    if (!pl || pl->get_length() < 2 || pl->get_data()[1] != 1) return;
    std::lock_guard<std::mutex> lk(g_mu);
    recentred();
}

// CommonAPI's Message contains the vsomeip shared pointer; the by-value
// unique_ptr handler is forwarded through the caller-owned ABI storage.
typedef bool (*send_async_t)(const void *, const void *, void *, const void *);
send_async_t g_real_send;
const char SEND_ASYNC[] = "_ZNK9CommonAPI6SomeIP10Connection25sendMessageWithReplyAsyncERKNS0_7MessageESt10unique_ptr"
    "INS0_15ProxyConnection24MessageReplyAsyncHandlerESt14default_deleteIS7_EEPKNS_8CallInfoE";

}  // namespace

extern "C" bool _ZNK9CommonAPI6SomeIP10Connection25sendMessageWithReplyAsyncERKNS0_7MessageESt10unique_ptrINS0_15ProxyConnection24MessageReplyAsyncHandlerESt14default_deleteIS7_EEPKNS_8CallInfoE(
    const void *self, const void *message, void *handler, const void *info)
{
    if (!g_real_send) g_real_send = reinterpret_cast<send_async_t>(dlsym(RTLD_NEXT, SEND_ASYNC));
    try {
        if (message) recentre(*static_cast<const std::shared_ptr<vsomeip::message> *>(message));
    } catch (...) { /* never break the HMI */ }
    return g_real_send ? g_real_send(self, message, handler, info) : false;
}

extern "C" void _ZN9CommonAPI6SomeIP10Connection18handleProxyReceiveERKSt10shared_ptrIN7vsomeip7messageEE(
    void *self, const std::shared_ptr<vsomeip::message> &msg)
{
    if (!g_real)
        g_real = reinterpret_cast<handle_proxy_receive_t>(dlsym(RTLD_NEXT,
            "_ZN9CommonAPI6SomeIP10Connection18handleProxyReceiveERKSt10shared_ptrIN7vsomeip7messageEE"));
    try { filter(msg); } catch (...) { /* never break the HMI */ }
    if (g_real) g_real(self, msg);
}

__attribute__((constructor)) static void init()
{
    g_real_send = reinterpret_cast<send_async_t>(dlsym(RTLD_NEXT, SEND_ASYNC));
    g_real = reinterpret_cast<handle_proxy_receive_t>(dlsym(RTLD_NEXT,
        "_ZN9CommonAPI6SomeIP10Connection18handleProxyReceiveERKSt10shared_ptrIN7vsomeip7messageEE"));
}
