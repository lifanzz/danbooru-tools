"""Create missing runtime files from public seeds; never replace existing user data."""
import json
import msvcrt
from pathlib import Path

def initialize_data(root):
    root = Path(root)
    data = root / 'data'
    data.mkdir(parents=True, exist_ok=True)
    lock_path = data / '.initialize.lock'
    with lock_path.open('a+b') as lock:
        if lock_path.stat().st_size == 0:
            lock.write(b'0')
            lock.flush()
        lock.seek(0)
        msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
        try:
            seed = root / 'seed-data'
            for source in seed.rglob('*.json'):
                target = data / source.relative_to(seed)
                target.parent.mkdir(parents=True, exist_ok=True)
                if not target.exists():
                    with target.open('xb') as output:
                        output.write(source.read_bytes())
            defaults = {
                'models.json': [],
                'settings.json': {'open_url_browser': '', 'group_language': 'zh', 'category_language': 'zh'},
                'illustrated_notes/catalogue.json': {'version': 2, 'groups': [{'id': 'ungrouped', 'name': '未分类', 'revision': 1}], 'notes': []},
            }
            for name, value in defaults.items():
                target = data / name
                target.parent.mkdir(parents=True, exist_ok=True)
                if not target.exists():
                    with target.open('x', encoding='utf-8') as output:
                        json.dump(value, output, ensure_ascii=False, indent=2)
            (data / 'model_images').mkdir(exist_ok=True)
            (data / 'illustrated_notes/images').mkdir(parents=True, exist_ok=True)
        finally:
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
