"""Run preserved scripts in temporary directories; never overwrite historical evidence."""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import tempfile

here = Path(__file__).resolve().parent
root = here.parent
inputs = [
    ('baseline', root/'model.py', root/'model-results.json', root/'model.log'),
    ('repair1', root/'repair1/model.py', root/'repair1/results.json', root/'repair1/model.log'),
    ('review1', root/'repair1/review1-probes.py', root/'repair1/review1-probes.json', root/'repair1/review1-replay.json'),
    ('review2', here/'review2/probes.py', here/'review2/probes.json', here/'review2/probes.log'),
]
receipts = []
for name, source, expected_json, expected_log in inputs:
    with tempfile.TemporaryDirectory(prefix='source-policy-replay-') as temporary:
        copied = Path(temporary)/source.name
        shutil.copyfile(source, copied)
        run = subprocess.run(['python3', str(copied)], capture_output=True, check=True)
        assert not run.stderr, run.stderr
        assert run.stdout == expected_log.read_bytes(), name
        json_outputs = list(Path(temporary).glob('*.json'))
        # Review1 only prints JSON; the other preserved scripts write one file.
        assert len(json_outputs) == (0 if name == 'review1' else 1), name
        emitted_json = run.stdout if name == 'review1' else json_outputs[0].read_bytes()
        assert emitted_json == expected_json.read_bytes(), name
        receipts.append({'case': name, 'exit': run.returncode, 'stdout_identical': True,
                         'json_identical': True, 'script_sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                         'stdout_sha256': hashlib.sha256(run.stdout).hexdigest(),
                         'json_sha256': hashlib.sha256(emitted_json).hexdigest()})
text = json.dumps(receipts, indent=2)+'\n'
(here/'replay-results.json').write_text(text)
print(text, end='')
