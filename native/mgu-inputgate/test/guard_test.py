"""Run boot-guard scenarios in a temporary filesystem with a fake systemctl."""
import os
import pathlib
import subprocess
import tempfile

SOURCE = pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="mgu-inputgate-guard-") as tmp:
    root = pathlib.Path(tmp)
    state = root / "state"
    state.mkdir()
    (state / "1.1.1").mkdir()
    (state / "current").symlink_to("1.1.1")
    (state / "1.1.1/mgu-inputgate.so").write_bytes(b"fixture")
    run = root / "input.env"
    script = (SOURCE / "guard.sh").read_text().replace("/var/opt/mgu-inputgate", str(state)).replace("/run/mgu-inputgate.env", str(run))
    (root / "guard.sh").write_text(script)
    (root / "systemctl").write_text('#!/bin/sh\nprintf \'# /etc/systemd/system/hmi.service\\nEnvironment="LD_PRELOAD=/opt/existing.so"\\n# /etc/systemd/system/hmi.service.d/zz-mgu-inputgate.conf\\nEnvironment="LD_PRELOAD=/old/mgu-inputgate.so"\\n\'\n')
    (root / "systemctl").chmod(0o755)
    env = dict(os.environ, PATH=str(root) + ":" + os.environ["PATH"])
    def boot():
        subprocess.run(["sh", str(root / "guard.sh"), "boot"], env=env, check=True, capture_output=True)
    boot()
    assert run.read_text() == "LD_PRELOAD=/opt/existing.so " + str(state) + "/current/mgu-inputgate.so\n"
    assert (state / "strikes").read_text().strip() == "1"
    boot()
    assert run.exists() and (state / "strikes").read_text().strip() == "2"
    boot()
    assert not run.exists(), "Two unsuccessful starts disable injection"
    (state / "1.1.2").mkdir()
    (state / "1.1.2/mgu-inputgate.so").write_bytes(b"fixture")
    (state / "current").unlink()
    (state / "current").symlink_to("1.1.2")
    boot()
    assert run.exists() and (state / "strikes").read_text().strip() == "1"
    (state / "1.1.2/mgu-inputgate.so").unlink()
    boot()
    assert not run.exists(), "Missing binary must not leave a stale preload"
print("PASS preload preservation, strike limit, version retry and missing binary")
