#pragma once
#include <cstdint>
#include <memory>
#include <vector>
namespace vsomeip {
struct payload {
    std::vector<uint8_t> bytes;
    uint32_t get_length() const { return bytes.size(); }
    const uint8_t* get_data() const { return bytes.data(); }
    void set_data(const uint8_t* p, uint32_t n) { bytes.assign(p, p + n); }
};
struct message {
    uint16_t service = 0xb508, method = 0x8002;
    std::shared_ptr<payload> value{new payload};
    uint16_t get_service() const { return service; }
    uint16_t get_method() const { return method; }
    std::shared_ptr<payload> get_payload() const { return value; }
};
}
