/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#include <string>

namespace crk {

/* ID7 panel overlay contour. Coordinates describe the 1088x480 reference
 * layout in UV space, independently of the decoded video's resolution.
 * Both video paths use exactly the same alpha. The inner speed readout is
 * also kept clear; a transparent edge must never count as opaque coverage.
 * This is a fixed layout, not a detector for arbitrary warning messages. */
inline std::string gauge_video_shader(const char *source)
{
    const char *mask = R"(
uniform float u_gauge_mask;
float gauge_smooth_max(float a, float b) {
    float h = clamp(0.5 + (a - b) / 64.0, 0.0, 1.0);
    return mix(b, a, h) + 32.0 * h * (1.0 - h);
}
float gauge_alpha(vec2 uv) {
    if (u_gauge_mask < 0.5) return 1.0;
    vec2 p = uv * vec2(1088.0, 480.0);
    float x = min(p.x, 1088.0 - p.x);
    float d = gauge_smooth_max(84.0 - p.y, p.y - 374.0);
    d = gauge_smooth_max(d, 130.0 - x);
    float lower = ((204.0 - x) * 94.0 + (p.y - 374.0) * 74.0) / length(vec2(94.0, 74.0));
    float original = gauge_smooth_max(d, ((320.0 - x) * 42.0 + (84.0 - p.y) * 88.0) / length(vec2(42.0, 88.0)));
    original = gauge_smooth_max(original, ((232.0 - x) * 112.0 + (126.0 - p.y) * 102.0) / length(vec2(112.0, 102.0)));
    original = gauge_smooth_max(original, lower);
    float refined = gauge_smooth_max(d, ((320.0 - x) * 20.0 + (84.0 - p.y) * 68.0) / length(vec2(20.0, 68.0)));
    refined = gauge_smooth_max(refined, ((252.0 - x) * 42.0 + (104.0 - p.y) * 56.0) / length(vec2(42.0, 56.0)));
    refined = gauge_smooth_max(refined, ((196.0 - x) * 92.0 + (146.0 - p.y) * 66.0) / length(vec2(92.0, 66.0)));
    refined = gauge_smooth_max(refined, lower);
    d = mix(refined, original, smoothstep(210.0, 238.0, p.y));
    float border = 1.0 - smoothstep(-20.0, 4.0, d);
    float band = smoothstep(32.0, 58.0, p.y) * (1.0 - smoothstep(414.0, 438.0, p.y));
    vec2 speed = abs(p - vec2(275.0, 251.0)) - vec2(96.0, 23.0);
    float speed_d = length(max(speed, vec2(0.0))) + min(max(speed.x, speed.y), 0.0) - 12.0;
    return border * band * smoothstep(-5.0, 8.0, speed_d);
}
)";
    std::string shader(source);
    const size_t main = shader.find("void main()");
    if (main == std::string::npos)
        return {};
    shader.insert(main, mask);
    const size_t alpha = shader.rfind(", u_opacity)");
    if (alpha == std::string::npos)
        return {};
    shader.replace(alpha, std::string(", u_opacity)").size(), ", u_opacity * gauge_alpha(v_uv))");
    return shader;
}

}  // namespace crk
