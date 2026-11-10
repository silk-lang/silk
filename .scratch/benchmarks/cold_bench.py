#!/usr/bin/env python3
"""Cold AB compiler measurements in private, committed-source snapshots (Linux).

Each trial deletes only the snapshot's own build directory. The frontend exit time
is reported separately from detached cache writers; writers are reaped before the
next trial. Filesystem page caches are intentionally not flushed.
"""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time


def git(source, *args):
    return subprocess.check_output(["git", "-C", str(source), *args], text=True).strip()


def snapshot(source, destination):
    destination.mkdir()
    archive = subprocess.Popen(["git", "-C", str(source), "archive", "HEAD"], stdout=subprocess.PIPE)
    try:
        subprocess.run(["tar", "-xf", "-", "-C", str(destination)], stdin=archive.stdout, check=True)
    finally:
        archive.stdout.close()
    if archive.wait():
        raise RuntimeError(f"git archive failed: {source}")
    return git(source, "rev-parse", "HEAD")


def usage(r):
    return {
        "user_s": r.ru_utime, "sys_s": r.ru_stime, "max_rss_kib": r.ru_maxrss,
        "minor_faults": r.ru_minflt, "major_faults": r.ru_majflt,
        "voluntary_switches": r.ru_nvcsw, "involuntary_switches": r.ru_nivcsw,
    }


def measure(command, cwd, env, log_path):
    # Adopt a compiler's detached cache writer so its completion cannot overlap
    # the next cold trial. Linux PR_SET_CHILD_SUBREAPER does not alter the child.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0):
        raise OSError(ctypes.get_errno(), "PR_SET_CHILD_SUBREAPER")
    with log_path.open("wb") as log:
        started = time.perf_counter()
        child = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                 stdout=log, stderr=subprocess.STDOUT)
        _, status, resource = os.wait4(child.pid, 0)
        exited = time.perf_counter()
        child.returncode = os.waitstatus_to_exitcode(status)
        detached = []
        while True:
            try:
                pid, status, additional = os.wait4(-1, 0)
                detached.append({"pid": pid, "exit_code": os.waitstatus_to_exitcode(status), **usage(additional)})
            except ChildProcessError:
                break
        settled = time.perf_counter()
    primary = usage(resource)
    tree = dict(primary)
    for additional in detached:
        for key in primary:
            if key == "max_rss_kib":
                tree[key] = max(tree[key], additional[key])
            else:
                tree[key] += additional[key]
    return {"exit_code": child.returncode, "wall_s": exited - started,
            "settled_wall_s": settled - started, "primary": primary,
            "process_tree": tree, "detached": detached, "log": str(log_path)}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--compiler", action="append", required=True, metavar="LABEL=PATH")
    p.add_argument("--workload", choices=["compiler", "harfrust"], required=True)
    p.add_argument("--operation", choices=["check", "build"], default="check")
    p.add_argument("--profile", choices=["default", "release", "release-with-debug"], default="default")
    p.add_argument("--silk-source", type=Path, default=Path("/workspace/silk-baseline"))
    p.add_argument("--nonstd-source", type=Path, default=Path("/workspace/nonstd"))
    p.add_argument("--output-parent", type=Path, default=Path("/workspace/silk/.scratch/benchmarks"))
    p.add_argument("--clang", type=Path, default=Path("/workspace/silk/.scratch/llvm-22.1.8/bin/clang"))
    p.add_argument("--cpus", help="taskset list; omit for the environment's normal CPU budget")
    p.add_argument("--rounds", type=int, default=2)
    p.add_argument("--timings", action="store_true")
    p.add_argument("--prepare-only", action="store_true", help="Create snapshots and print commands without executing them")
    p.add_argument("--extra", action="append", default=[], help="Append one command argument (use --extra=--flag)")
    args = p.parse_args()
    if args.rounds < 1:
        p.error("--rounds must be positive")
    compilers = []
    for item in args.compiler:
        label, separator, path = item.partition("=")
        if not separator or not label or not path:
            p.error("--compiler must be LABEL=PATH")
        executable = Path(path).resolve()
        if not executable.is_file():
            p.error(f"compiler does not exist: {executable}")
        compilers.append((label, executable))
    args.output_parent.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="cold-", dir=args.output_parent.resolve()))
    silk = root / "silk"
    revisions = {"silk": snapshot(args.silk_source, silk)}
    if args.workload == "compiler":
        source = silk
        cwd = silk
        package = ["--package", "silk-compiler"]
    else:
        source = root / "nonstd"
        revisions["nonstd"] = snapshot(args.nonstd_source, source)
        cwd = source / "fonts/shape/tools/cli"
        package = []
    profile = [] if args.profile == "default" else ["--optimization", args.profile]
    progress = ["--progress", "plain", "--timings"] if args.timings else ["--progress", "never"]
    commands = []
    for label, compiler in compilers:
        command = [str(compiler), args.operation, *package, "--stdlib", str(silk / "stdlib"), *profile, *progress, *args.extra]
        if args.cpus:
            command = ["taskset", "-c", args.cpus, *command]
        commands.append({"label": label, "compiler": str(compiler),
                         "compiler_sha256": hashlib.file_digest(compiler.open("rb"), "sha256").hexdigest(),
                         "command": command})
    metadata = {"root": str(root), "revisions": revisions, "cwd": str(cwd),
                "cache_root": str(source / "build"), "workload": args.workload,
                "operation": args.operation, "profile": args.profile,
                "cpu_affinity": sorted(os.sched_getaffinity(0)), "cpus": args.cpus,
                "rounds": args.rounds, "commands": commands,
                "SILK_CLANG": str(args.clang.resolve()),
                "rss_note": "Maximum individual process RSS, including waited children; not simultaneous aggregate RSS.",
                "cold_note": "Fresh compiler build/cache directory for every trial; OS page cache is not flushed."}
    (root / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(json.dumps({"metadata": metadata}), flush=True)
    if args.prepare_only:
        return
    env = dict(os.environ, SILK_CLANG=str(args.clang.resolve()))
    with (root / "results.jsonl").open("a") as results:
        for repeat in range(args.rounds):
            for index, configured in enumerate(commands):
                build = source / "build"
                # source is a newly created directory owned only by this run.
                if build.is_symlink():
                    raise RuntimeError(f"refusing symlink cache directory: {build}")
                if build.exists():
                    shutil.rmtree(build)
                log = root / f"{repeat + 1}-{index + 1}.log"
                record = {"round": repeat + 1, "label": configured["label"],
                          "command": configured["command"], **measure(configured["command"], cwd, env, log)}
                encoded = json.dumps(record)
                results.write(encoded + "\n")
                results.flush()
                print(encoded, flush=True)
                if record["exit_code"]:
                    raise SystemExit(record["exit_code"])


if __name__ == "__main__":
    main()
