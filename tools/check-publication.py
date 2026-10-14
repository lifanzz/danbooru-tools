"""Audit the staged Git content (or a committed tree) before publication."""
import argparse
import json
import re
import subprocess
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
FORBIDDEN_PARTS = {'data', 'model_images', 'illustrated_notes', 'backups', 'data_backup', '__pycache__', 'bin', 'obj', 'gui-test-screenshots', 'test-artifacts', '.venv', 'node_modules'}
FORBIDDEN_NAMES = {'config.local.json', 'config.json', 'manual_url_overrides.json', 'models.json', 'settings.json'}
PRIVATE_PATH = re.compile(r'(?:[A-Z]:[\\/]+Users[\\/]+|[A-Z]:[\\/]+Desktop2[\\/]+|[A-Z]:[\\/]+Comfy-Desktop[\\/]+|[A-Z]:[\\/]+ComfyUI-aki[^\\/]*[\\/]+|[A-Z]:[\\/]+DeskBox[\\/]+)', re.I)
TOKEN = re.compile(r'(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{35,})')

def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args])

def audit(ref=None):
    if ref:
        names = git('ls-tree', '-r', '--name-only', '-z', ref).decode('utf-8').split('\0')
        tracked = set(names)
    else:
        names = git('ls-files', '--cached', '--others', '--exclude-standard', '-z').decode('utf-8').split('\0')
        tracked = set(git('ls-files', '--cached', '-z').decode('utf-8').split('\0'))
    names = sorted(set(filter(None, names)))
    problems = []
    for name in names:
        path = PurePosixPath(name)
        if FORBIDDEN_PARTS.intersection(path.parts) or path.name in FORBIDDEN_NAMES or path.suffix.lower() in {'.bak', '.pyc', '.pdb', '.exe', '.log'}:
            problems.append(name + ': private or generated path')
        if name in tracked:
            data = git('show', (ref + ':' if ref else ':') + name)
        else:
            data = (ROOT / name).read_bytes()
        if path.suffix.lower() in {'.ico'}:
            continue
        try:
            text = data.decode('utf-8-sig')
        except UnicodeDecodeError:
            problems.append(name + ': unreviewed binary file')
            continue
        if PRIVATE_PATH.search(text):
            problems.append(name + ': personal machine path')
        if TOKEN.search(text):
            problems.append(name + ': credential-like string')
    expected = {'manager/seed-data/tags.json', 'manager/seed-data/groups.json', 'manager/index.html', 'manager/illustrated.html',
                'comfyui/comfyui-danbooru-search/__init__.py', 'comfyui/comfyui-prompt-extractor/prompt_extractor.py'}
    for missing in expected - set(names):
        problems.append(missing + ': missing required public file')
    if problems:
        raise SystemExit('\n'.join(problems))
    print(json.dumps({'result': 'PASS', 'audited_files': len(names), 'ref': ref or 'index + untracked public files',
                      'private_models': 'excluded', 'private_notes': 'excluded'}, ensure_ascii=False))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--ref', help='Audit a committed tree, for example HEAD')
    audit(parser.parse_args().ref)
