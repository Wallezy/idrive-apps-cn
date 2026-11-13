/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Real compositor/slot loop on fake backends; proves lifecycle and canvas
 * requests, never the physical KOMBI's clipping or foreground content. */
#include <cassert>
#include <cstdio>
#include "../src/compositor.h"
#include "../include/cluster_render/protocol.h"
#include "fake_graph.h"
#include "fake_port.h"

using namespace crs;

struct Rig {
    FakeGpu gpu;
    FakePort port;
    SlotManager slots{&port, nullptr};
    std::unique_ptr<Compositor> c;
    int64_t now = 10000;
    uint32_t video = 0;
    std::string err;
    explicit Rig(uint64_t slot = 0x100) {
        TargetSpec m, h;
        m.name="map"; m.slot=slot; m.scene_id=0x010004f0; m.width=1088; m.height=480; m.linger_ms=0;
        h.name="hud"; h.slot=0x323; h.scene_id=0x01000400; h.width=800; h.height=480;
        slots.add(m); slots.add(h); port.m=&slots;
        GovernorConfig gc; gc.max_bps=0;
        c.reset(new Compositor(&gpu,&slots,gc,250)); slots.set_scenes(c.get());
        assert(c->init(&err));
        LayerParams lp; lp.rect={0,0,1088,480}; lp.contend=true;
        VideoParams vp; vp.w=64; vp.h=32;
        video=c->add_video(1,0,lp,vp,now,&err); assert(video);
        std::vector<uint8_t> pixels(64*48,128);
        static_cast<VideoLayer*>(c->layer(1,video))->offer(pixels.data(),now);
        lp.rect={0,0,800,480};
        assert(c->add_effect(2,1,lp,"","void main(){gl_FragColor=vec4(1.0);}",0,now,&err));
        run(200);
        assert(slots.status(0).state==TargetState::Shown);
    }
    void run(int ms, bool stream=true) {
        for(int i=0;i<ms;i+=10) {
            now+=10;
            if(stream && c->layer(1,video)) static_cast<VideoLayer*>(c->layer(1,video))->repeat(now);
            port.tick(now); c->arrange(now); slots.follow(now); slots.tick(now); c->render(now);
        }
    }
    cr::Json status() { cr::Json j; assert(cr::parse_json(c->underlay_status(3,now),&j)); return j; }
    void start(const char* mode="expanded") { err.clear(); assert(c->underlay(3,mode,true,now,&err)); }
    void mapped() {
        for(int i=0;i<8;i++) {
            run(500);
            assert(c->underlay(3,"keep",false,now,&err));
            auto g=gpu.graph("map");
            if(g && g->width==1632 && slots.status(0).state==TargetState::Shown) return;
        }
        assert(false && "expanded scene did not map within four seconds");
    }
    void restored() {
        run(3000);
        assert(status()["active"]=="0");
        auto g=gpu.graph("map"); assert(g && g->width==1088 && g->height==480);
        assert(c->layer(1,video)->params.rect.w==1088);
        std::string reason; assert(c->state(video,&reason)==LayerState::Shown);
    }
};

int main() {
    {
        Rig r; auto hud=r.gpu.graph("hud");
        assert(!r.c->underlay(3,"expanded",false,r.now,&r.err));
        assert(!r.c->underlay(3,"0x200",true,r.now,&r.err));
        r.start(); r.mapped();
        assert(r.status()["active"]=="1");
        assert(r.gpu.graph("map")->width==1632 && r.gpu.graph("map")->height==720);
        assert(r.gpu.graph("hud")==hud);
        assert(r.slots.targets()[0].width==1088 && r.slots.targets()[0].slot==0x100);
        std::string reason; assert(r.c->state(r.video,&reason)==LayerState::Suspended);
        assert(!r.c->underlay(4,"stop",false,r.now,&r.err));
        assert(!r.c->underlay(4,"keep",false,r.now,&r.err));
        assert(!r.c->underlay(3,"expanded",true,r.now,&r.err));
        assert(r.c->underlay(3,"stop",false,r.now,&r.err)); r.restored();
        assert(r.gpu.graph("hud")==hud);
        std::puts("ok explicit stop restores map and retains HUD and client geometry");
    }
    {
        Rig r; r.start(); r.run(2100); r.restored();
        assert(r.status()["reason"]=="lease expired");
        assert(!r.c->underlay(3,"keep",false,r.now,&r.err));
        std::puts("ok missing UI heartbeat expires without replay");
    }
    {
        Rig r; r.start(); r.mapped(); r.c->remove_owner(3); r.restored();
        assert(r.status()["reason"]=="client disconnected");
        std::puts("ok client death restores the standard canvas");
    }
    {
        Rig r; r.start();
        for(int i=0;i<39;i++){r.run(500);assert(r.c->underlay(3,"keep",false,r.now,&r.err));}
        r.run(600); r.restored(); assert(r.status()["reason"]=="timeout");
        std::puts("ok heartbeats cannot extend the hard 20 second deadline");
    }
    {
        Rig r; r.start("standard"); r.run(500);
        assert(r.gpu.graph("map")->width==1088);
        r.port.steal(r.slots.targets()[0]); r.run(10);
        assert(r.status()["active"]=="0"); assert(r.status()["reason"]=="display interrupted");
        std::puts("ok a display interruption ends calibration");
    }
    {
        Rig r; r.start(); r.run(500); r.c->remove_owner(1); r.run(20);
        assert(r.status()["active"]=="0"); assert(r.status()["reason"]=="map stream stopped");
        std::puts("ok map producer death ends calibration");
    }
    {
        Rig r; r.start();
        for(int i=0;i<12;i++) {r.run(500,false); r.c->underlay(3,"keep",false,r.now,&r.err);}
        r.run(100,false); assert(r.status()["active"]=="0");
        assert(r.status()["reason"]=="map stream stopped");
        std::puts("ok a stalled map ends calibration");
    }
    {
        Rig r; r.start(); r.run(500);
        LayerParams lp; lp.klass=Klass::Alert; lp.rect={0,0,100,100};
        assert(r.c->add_effect(5,0,lp,"","void main(){gl_FragColor=vec4(1.0);}",0,r.now,&r.err));
        r.run(20); assert(r.status()["active"]=="0"); assert(r.status()["reason"]=="map alert");
        std::puts("ok app alerts cancel the grid");
    }
    {
        Rig r(0x200); assert(!r.c->underlay_supported());
        assert(!r.c->underlay(3,"expanded",true,r.now,&r.err));
        std::puts("ok other slot configurations are refused");
    }
    return 0;
}
