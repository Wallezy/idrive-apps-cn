// Exercise the real filtering implementation with fake SOME/IP payload objects.
// No HMI, vehicle connection or system preload is involved.
#include "../mgu-inputgate.cpp"
#include <cassert>
#include <fcntl.h>
#include <cstdlib>
#include <iostream>

static std::shared_ptr<vsomeip::message> event(uint16_t pos, int press = 1, int tilt = 2) {
    auto m = std::make_shared<vsomeip::message>();
    m->value->bytes = {0, uint8_t(pos >> 8), uint8_t(pos), uint8_t(press), uint8_t(tilt)};
    return m;
}
static int position(const std::shared_ptr<vsomeip::message>& m) {
    return (m->value->bytes[1] << 8) | m->value->bytes[2];
}
int main() {
    char name[] = "/tmp/mgu-inputgate-test-XXXXXX";
    int fd = mkstemp(name); assert(fd >= 0); close(fd); unlink(name);
    GATE_FILE = name;
    auto initial = event(100); filter(initial);
    assert(position(initial) == 100 && initial->value->bytes[3] == 1);
    fd = open(name, O_CREAT | O_WRONLY, 0600); assert(fd >= 0); close(fd);
    usleep(60000);
    auto grabbed = event(105); filter(grabbed);
    assert(position(grabbed) == 100 && grabbed->value->bytes[3] == 0 && grabbed->value->bytes[4] == 0);
    auto backMenu = event(107); backMenu->method = 0x8001; filter(backMenu);
    assert(position(backMenu) == 107 && backMenu->value->bytes[3] == 1);
    auto unrelated = event(108); unrelated->service = 0x1234; filter(unrelated);
    assert(position(unrelated) == 108 && unrelated->value->bytes[3] == 1);
    auto shortEvent = event(1); shortEvent->value->bytes.resize(3); filter(shortEvent);
    assert(shortEvent->value->bytes.size() == 3);
    // A stopped/crashed renderer ceases renewing the file: input returns by itself.
    usleep(760000);
    auto released = event(110); filter(released);
    assert(position(released) == 100 && released->value->bytes[3] == 1);
    auto next = event(111); filter(next); assert(position(next) == 101);
    unlink(name);
    auto setter = event(0);
    setter->method = SET_ROTARY_CONTROL;
    setter->value->bytes = {0, 0};
    recentre(setter); assert(g_offset == 10);
    setter->value->bytes = {0, 1};
    recentre(setter); assert(g_offset == 0 && g_hmi_pos == KNOB_MID);
    auto afterWake = event(KNOB_MID + 1); filter(afterWake);
    assert(position(afterWake) == KNOB_MID + 1);
    g_offset = 5; g_hmi_pos = 100;
    auto overflow = event(106); overflow->value->bytes.push_back(1); filter(overflow);
    assert(position(overflow) == 101 && g_hmi_pos == KNOB_MID && g_offset == 0);
    auto overflowStill = event(KNOB_MID); overflowStill->value->bytes.push_back(1);
    filter(overflowStill); assert(g_hmi_pos == KNOB_MID);
    g_offset = 5; g_hmi_pos = 0;
    auto low = event(4); filter(low); assert(position(low) == 0);
    g_offset = 5; g_hmi_pos = 0xfffe;
    auto high = event(4); filter(high); assert(position(high) == 0xfffe);
    auto invalid = event(0xffff); filter(invalid); assert(position(invalid) == 0xffff);
    std::cout << "PASS recenter setter, overflow, edge clamp and invalid position\n";
    std::cout << "PASS controller filter, BACK/MENU, unrelated/short events, stale release and no focus jump\n";
}
