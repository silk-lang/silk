# R3 census probe (measurement only; never merge)

This branch is c4fbf46 (selfhost after 2b) plus a census probe. It must never be merged or carried
into a production branch.

- `compiler/src/semantic/RegionProbe.silk` and the `probe*` functions in `BorrowCheck.silk` print
  `; PROBE R3 2|3|4` receipts (exact instance-key join, as in #1654) and `; PROBEDBG` labels.
  Mask bits: 1 crossed, 2 types open, 4 contents, 8 provisional static, 16 approximate loan,
  32 outside/anonymous parameter in a relation, 64 outside local in a relation, 128 invocation,
  256 supplied, 512 meet, 1024 local endpoint without loan, 2048 ambiguous (several loans or
  approximate), 4096 inclusion failure, 8192 no-loans body; type atoms 16384 outside parameter,
  32768 outside local, 65536 invocation, 131072 supplied, 262144 meet; 1048576 walked.
- `; PROBE R3 9 offered wanted origin` / `10 regions flags origin` dump a pending body's relations
  and loans (code kind*10000+ordinal: 1 static, 2 own param, 3 own local, 4 other param,
  5 other local, 6 invocation, 7 supplied, 8 meet; loan flags 1 local, 2 approximate).
- `census.py LOG` joins receipts per emitted definition; `subset.py`/`byprog.py` filter masks;
  `run-corpus.mjs` runs the corpus with a compiler (paths are absolute: edit them);
  `exp.sh COMPILER file.silk` builds one program as `memory/driver.silk`; `measure.py` runs
  alternating clean/candidate one-shot IR builds and reports paired medians.
