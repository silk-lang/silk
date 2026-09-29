"""Temporary Linux-only B4 timeout diagnosis; removed before final handoff."""
import os
from pathlib import Path
import subprocess
import tempfile
import time

with tempfile.TemporaryDirectory(prefix="silk-b4-profile-") as directory:
    root = Path(directory)
    subprocess.run([
        "pnpm", "--filter", "@silklang/compiler", "exec", "tsx", "-e",
        'import {writeFileSync} from "node:fs"; import {integerOperationMatrix} from "./test/support/scalarOperationMatrix.ts"; writeFileSync(process.argv[1], integerOperationMatrix)',
        str(root / "main.silk"),
    ], check=True)
    with (root / "stdout").open("wb") as output, (root / "stderr").open("wb") as error:
        started = time.monotonic()
        process = subprocess.Popen([os.environ["SILKC"], "build", "main.silk", "-o", "program"], cwd=root, stdout=output, stderr=error)
        try:
            for ordinal in range(8):
                time.sleep(5)
                if process.poll() is not None:
                    break
                snapshot = subprocess.run([
                    "sudo", "gdb", "--batch", "--quiet", "-ex", "set pagination off",
                    "-ex", "thread apply all bt 20", "-p", str(process.pid),
                ], capture_output=True, text=True, timeout=15)
                print(f"[B4-profile] sample={ordinal} elapsed={time.monotonic()-started:.3f} gdb={snapshot.returncode}\n{snapshot.stdout}\n{snapshot.stderr}", flush=True)
            try:
                process.wait(timeout=120)
            except subprocess.TimeoutExpired:
                print("[B4-profile] build still running after extended diagnosis cap", flush=True)
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)
        print(f"[B4-profile] exit={process.returncode} elapsed={time.monotonic()-started:.3f}", flush=True)
    print("[B4-profile] stderr=" + (root / "stderr").read_text()[:4000], flush=True)
