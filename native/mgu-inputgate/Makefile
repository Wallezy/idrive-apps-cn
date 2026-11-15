# Same pinned Ubuntu 18.04 toolchain as cluster-render; no head-unit SDK.
CXX ?= c++
IMAGE = cluster-render-build:$(shell cksum < ../cluster-render/docker/Dockerfile | cut -d' ' -f1)
.PHONY: target target-in-docker
target:
	docker image inspect $(IMAGE) >/dev/null 2>&1 || docker build --platform linux/amd64 -t $(IMAGE) ../cluster-render/docker
	docker run --rm --platform linux/amd64 --user "$$(id -u):$$(id -g)" -v "$(CURDIR):/w" -w /w $(IMAGE) make target-in-docker

target-in-docker:
	mkdir -p build/target
	$(CXX) -std=c++14 -O2 -g0 -Wall -Wextra -shared -fPIC -Ivsomeip-include/interface/compat -o build/target/mgu-inputgate.so mgu-inputgate.cpp -ldl
	readelf -h build/target/mgu-inputgate.so | grep -q 'Advanced Micro Devices X86-64'
	! readelf --version-info build/target/mgu-inputgate.so | grep -E 'GLIBC_2\.(2[8-9]|[3-9][0-9])'

.PHONY: test
test:
	mkdir -p build
	$(CXX) -std=c++14 -Wall -Wextra -Itest/fake test/filter_test.cpp -ldl -o build/filter_test
	build/filter_test
	python3 test/guard_test.py
