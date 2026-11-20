#!/usr/bin/env python3
"""Paired native tracing measurements. Run on Linux with two optimized N1 compilers."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import resource
import shutil
import statistics
import subprocess
import time


def digest(path):
    with path.open("rb") as data:
        return hashlib.file_digest(data, "sha256").hexdigest()


def compiler_build(n1, repo, output):
    # CompilationBuild.prepare uses this manifest-aware definition. All object caches
    # are siblings of output, so a fresh directory cold-starts each measurement.
    definition = output.with_suffix(".definition.toml")
    request = output.with_suffix(".request.toml")
    definition.write_text(
        f'manifest = {json.dumps(str(repo / "compiler/silk.toml"))}\n'
        f'stdlib = {json.dumps(str(repo / "stdlib"))}\n'
        'artifact = "executable"\n[settings]\nmodules = []\nemit = "final"\n'
        '[settings.profile]\noptimization = "speed"\ndebug = false\n'
        '[settings.native]\nsources = []\nlink = []\n'
    )
    return [
        [n1, "resolve", "--definition", definition, "--output", request, "--artifact", output],
        [n1, "compile", "--request", request],
    ]


def fixture(n1, repo, fixture_repo, out, env):
    fixture_dir = fixture_repo / "compiler/fixtures/ambient-services"
    stdlib = out / "stdlib"
    shutil.copytree(repo / "stdlib", stdlib)
    shutil.copyfile(fixture_dir / "counter.silk", stdlib / "silk/counter.silk")
    source = (fixture_dir / "scheduler-main.silk").read_text()
    single = "  run Fiber.yieldNow()\n"
    assert source.count(single) == 1
    # Each of the two child fibers keeps its inherited provider; their original
    # post-join assertions still check both provider counts and results.
    text = source.replace(single, """  let mut yielded: i32 = 0
  while yielded < 500000 {
    run Fiber.yieldNow()
    yielded = yielded + 1
  }
""")
    (out / "main.silk").write_text(text)
    binary = out / "benchmark"
    subprocess.run([n1, "build", out / "main.silk", "--stdlib", stdlib,
                    "--clang", env["SILK_CLANG"], "--optimization", "speed",
                    "--debug", "false", "-o", binary], check=True, env=env)
    return binary


def invocation(commands, env, cwd, logfile, output=None):
    cgroup_stat = Path("/sys/fs/cgroup/cpu.stat")
    def cgroup_ms():
        return int(dict(line.split() for line in cgroup_stat.read_text().splitlines())["usage_usec"]) / 1000
    group_start = cgroup_ms() if cgroup_stat.exists() else None
    start_cpu = resource.getrusage(resource.RUSAGE_CHILDREN)
    start = time.monotonic_ns()
    with logfile.open("xb") as log:
        for command in commands:
            subprocess.run(command, env=env, cwd=cwd, stdout=log,
                           stderr=subprocess.STDOUT, check=True)
    wall_ms = (time.monotonic_ns() - start) / 1_000_000
    end_cpu = resource.getrusage(resource.RUSAGE_CHILDREN)
    total_cpu = (end_cpu.ru_utime - start_cpu.ru_utime +
                 end_cpu.ru_stime - start_cpu.ru_stime)
    result = {"cpu_ms": total_cpu * 1000, "wall_ms": wall_ms}
    if group_start is not None:
        result["cgroup_cpu_ms"] = cgroup_ms() - group_start
    if output:
        result["artifact_sha256"] = digest(output)
        result["compiler_version"] = subprocess.check_output([output, "--version"], text=True).strip()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["main-repo", "stage-repo", "main-n1", "stage-n1", "clang", "out"]:
        parser.add_argument("--" + name, required=True, type=lambda p: Path(p).resolve())
    parser.add_argument("mode", choices=["scheduler", "selfbuild"])
    parser.add_argument("--pairs", type=int)
    opts = parser.parse_args()
    pairs = opts.pairs if opts.pairs is not None else (11 if opts.mode == "scheduler" else 3)
    if pairs < 1:
        parser.error("--pairs must be positive")
    units = {"main": (opts.main_repo, opts.main_n1), "stage": (opts.stage_repo, opts.stage_n1)}
    opts.out.mkdir()
    meta = {"mode": opts.mode, "pairs": pairs, "platform": platform.platform(),
            "affinity": sorted(os.sched_getaffinity(0)), "clang_sha256": digest(opts.clang),
            "clang_version": subprocess.check_output([opts.clang, "--version"], text=True),
            "profile": {"optimization": "speed", "debug": False}, "inputs": {}}
    programs = {}
    env = {k: os.environ[k] for k in ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"] if k in os.environ}
    env["SILK_CLANG"] = str(opts.clang)
    for label, (repo, n1) in units.items():
        # Ignore untracked scratch output and reject any authored source change.
        subprocess.run(["git", "diff", "--quiet", "HEAD", "--"], cwd=repo, check=True)
        meta["inputs"][label] = {
            "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip(),
            "n1_sha256": digest(n1), "seed_pin_sha256": digest(repo / "compiler/native-seed.json"),
        }
    assert meta["inputs"]["main"]["seed_pin_sha256"] == meta["inputs"]["stage"]["seed_pin_sha256"]
    (opts.out / "inputs.json").write_text(json.dumps(meta, indent=2) + "\n")
    if opts.mode == "scheduler":
        for label, (repo, n1) in units.items():
            build_dir = opts.out / label
            build_dir.mkdir()
            programs[label] = fixture(n1, repo, opts.main_repo, build_dir, env)
            meta["inputs"][label]["scheduler_sha256"] = digest(programs[label])
            meta["inputs"][label]["scheduler_bytes"] = programs[label].stat().st_size
            subprocess.run([programs[label]], check=True, env=env)
        (opts.out / "inputs.json").write_text(json.dumps(meta, indent=2) + "\n")
    records = []
    with (opts.out / "samples.jsonl").open("x") as samples:
        for pair in range(pairs):
            for label in (["main", "stage"] if pair % 2 == 0 else ["stage", "main"]):
                repo, n1 = units[label]
                sample = opts.out / f"pair-{pair + 1:02d}-{label}"
                sample.mkdir()
                output = sample / "N2" if opts.mode == "selfbuild" else None
                commands = (compiler_build(n1, repo, output) if output else [[programs[label]]])
                record = {"pair": pair + 1, "side": label, **invocation(
                    commands, env, repo / "compiler", sample / "run.log", output
                )}
                records.append(record)
                print(json.dumps(record), file=samples, flush=True)
                print(json.dumps(record), flush=True)
    result = {}
    for label in units:
        values = [r for r in records if r["side"] == label]
        result[label] = {k: statistics.median(r[k] for r in values) for k in ["cpu_ms", "wall_ms"]}
    (opts.out / "medians.json").write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
