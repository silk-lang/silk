#!/bin/bash
# diff.sh <binary>: hashes many input sizes with a build of main.silk and with ref.py (run from this folder)

bin=$1; fail=0
for n in $(seq 0 300) 447 448 449 511 512 513 575 576 577 1000 4095 4096 4097 8191 8193 65537 100000 1048576 10485763; do
  head -c $n /dev/urandom > in.bin
  $bin < in.bin > silk.txt 2> err.txt; st=$?
  python3 ref.py < in.bin > py.txt
  if ! cmp -s silk.txt py.txt; then echo "MISMATCH n=$n status=$st"; diff silk.txt py.txt | head -4; fail=$((fail+1)); fi
done
# piped in irregular chunks
(for i in $(seq 1 200); do head -c $((RANDOM % 5000)) /dev/urandom; done) > in.bin
(while read -r -n 1 -d '' x; do :; done; ) </dev/null
python3 -c "
import sys,time,os
d=open('in.bin','rb').read(); i=0
import random
while i<len(d):
  k=random.randint(1,9000); os.write(1,d[i:i+k]); i+=k
" | $bin > silk.txt; python3 ref.py < in.bin > py.txt; cmp -s silk.txt py.txt || { echo "MISMATCH chunked"; fail=$((fail+1)); }
echo "done fail=$fail"
