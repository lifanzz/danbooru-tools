"""Single catalogue authority, with a process/thread lock and recoverable writes.

General tags live only in tags.json; groups.json registers every group.
Character content remains in its explicitly registered content_file.
"""
from contextlib import contextmanager
from pathlib import Path
import functools
import json
import msvcrt
import os
import threading
import uuid

from config import DIRECTORY, TAGS_PATH, GROUPS_PATH
from category_rules import normalize_categories

ROOT = Path(DIRECTORY).resolve()
LOCK_PATH = ROOT / 'data/.catalogue.lock'
JOURNAL_PATH = ROOT / 'data/.catalogue-transaction.json'
_lock = threading.RLock()


class CatalogueError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def safe_path(relative):
    path = (ROOT / relative).resolve()
    if not path.is_relative_to(ROOT):
        raise CatalogueError('Invalid catalogue path')
    return path


def _replace_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    stage = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with stage.open('w', encoding='utf-8') as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(stage, path)
    finally:
        stage.unlink(missing_ok=True)


def recover():
    """Finish the durable redo journal before allowing the next read/write."""
    if not JOURNAL_PATH.exists():
        return
    journal = read_json(JOURNAL_PATH)
    for entry in journal['writes']:
        target, stage = safe_path(entry['target']), safe_path(entry['stage'])
        if stage.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(stage, target)
        elif not target.exists():
            raise OSError(f'Missing transaction file: {target}')
    for relative in journal.get('deletes', []):
        safe_path(relative).unlink(missing_ok=True)
    JOURNAL_PATH.unlink()


@contextmanager
def locked():
    with _lock:
        LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOCK_PATH.open('a+b') as handle:
            if handle.seek(0, 2) == 0:
                handle.write(b'0')
                handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
            try:
                recover()
                yield
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)


def commit(payloads, deletes=()):
    writes = []
    durable = False
    try:
        for path, value in payloads.items():
            target = safe_path(str(Path(path).relative_to(ROOT)))
            stage = target.with_name(target.name + '.' + uuid.uuid4().hex + '.stage')
            _replace_json(stage, value)
            writes.append({'target': str(target.relative_to(ROOT)), 'stage': str(stage.relative_to(ROOT))})
        _replace_json(JOURNAL_PATH, {'writes': writes, 'deletes': [str(Path(p).relative_to(ROOT)) for p in deletes]})
        durable = True
        recover()
    finally:
        if not durable:
            for entry in writes:
                safe_path(entry['stage']).unlink(missing_ok=True)


def is_character(group):
    return group.get('library') == 'character'


class Catalogue:
    def __init__(self):
        self.tags = read_json(TAGS_PATH)
        self.groups = read_json(GROUPS_PATH)
        self.extra = {}
        self.deletes = []

    def group(self, group_id, general=False):
        group = next((g for g in self.groups if g['id'] == group_id), None)
        if group is None:
            raise CatalogueError('分组不存在', 404)
        if general and is_character(group):
            raise CatalogueError('通用标签不能加入角色卡分组')
        return group

    def tag(self, name):
        tag = next((t for t in self.tags if t['name'] == name), None)
        if tag is None:
            raise CatalogueError(f"Tag '{name}' not found", 404)
        return tag

    def character_data(self, group):
        if not is_character(group):
            raise CatalogueError('请选择角色分组')
        path = safe_path(group['content_file'])
        if path not in self.extra:
            self.extra[path] = read_json(path)
        return self.extra[path]

    def ungrouped(self):
        """Find or create the fixed 未分类 catch-all group for character cards.

        Deleting a character group parks its cards here, and new cards saved
        without an explicit group default to it.
        """
        group = next((g for g in self.groups if g['id'] == 'character_ungrouped'), None)
        if group is None:
            name = '未分类'
            suffix = 2
            while any(g['name_cn'] == name for g in self.groups):
                name = f'未分类{suffix}'
                suffix += 1
            group = {'id': 'character_ungrouped', 'name_cn': name, 'name_en': 'character_ungrouped',
                     'library': 'character', 'search_enabled': True, 'categories': normalize_categories([])[0],
                     'content_file': 'data/translated/character_ungrouped.json'}
            self.groups.append(group)
            self.extra[safe_path(group['content_file'])] = {
                'group_name': 'character_ungrouped', 'display_name': name,
                'tags': [], 'categories': group['categories'], 'total_tags': 0}
        return group

    def validate(self):
        ids = [g['id'] for g in self.groups]
        names = [g['name_cn'] for g in self.groups]
        if len(ids) != len(set(ids)) or len(names) != len(set(names)):
            raise CatalogueError('分组 ID 或名称重复', 409)
        tag_names = [t['name'] for t in self.tags]
        if len(tag_names) != len(set(tag_names)):
            raise CatalogueError('标签名重复', 409)
        for tag in self.tags:
            for gid in tag.get('groups', []):
                self.group(gid, general=True)
            tag.pop('groups_cn', None)
            categories = tag.setdefault('category_by_group', {})
            tag['category_by_group'] = {gid: path for gid, path in categories.items() if gid in tag.get('groups', []) and path}

    def save(self, old_tags, old_groups):
        self.validate()
        payloads = dict(self.extra)
        if self.tags != old_tags:
            payloads[Path(TAGS_PATH)] = self.tags
        if self.groups != old_groups:
            payloads[Path(GROUPS_PATH)] = self.groups
        if payloads or self.deletes:
            commit(payloads, self.deletes)


@contextmanager
def transaction():
    with locked():
        catalogue = Catalogue()
        old_tags = json.loads(json.dumps(catalogue.tags))
        old_groups = json.loads(json.dumps(catalogue.groups))
        yield catalogue
        catalogue.save(old_tags, old_groups)


def snapshot():
    with locked():
        return {'tags': read_json(TAGS_PATH), 'groups': read_json(GROUPS_PATH),
                'isolated_test': (ROOT / 'data/.isolated-test').is_file()}


def endpoint(function):
    from utils import read_body, send_json
    @functools.wraps(function)
    def handle(handler):
        try:
            data = read_body(handler)
            if not isinstance(data, dict):
                raise CatalogueError('Request must be an object')
            with transaction() as catalogue:
                result = function(catalogue, data)
            send_json(handler, {'success': True, **result})
        except CatalogueError as exc:
            send_json(handler, {'error': str(exc)}, exc.status)
        except (KeyError, TypeError, ValueError) as exc:
            send_json(handler, {'error': str(exc)}, 400)
        except OSError as exc:
            send_json(handler, {'error': f'无法保存数据：{exc}'}, 500)
    return handle
