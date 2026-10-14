"""Independent illustrated notes; catalogue locking and atomic commits protect writes."""
import base64
import binascii
import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from config import DIRECTORY
from catalogue_store import CatalogueError, locked, commit
from utils import read_body, send_json

ROOT = Path(DIRECTORY) / 'data' / 'illustrated_notes'
CATALOGUE = ROOT / 'catalogue.json'
IMAGE_PREFIX = '/data/illustrated_notes/images/'


def _load():
    if not CATALOGUE.exists():
        return {'version': 2, 'groups': [{'id': 'ungrouped', 'name': '未分类', 'revision': 1}], 'notes': []}
    catalogue = json.loads(CATALOGUE.read_text(encoding='utf-8'))
    if catalogue.get('version') != 2:
        raise CatalogueError('图文笔记数据版本不匹配')
    return catalogue


def _text(data, key, limit, required=False):
    value = data.get(key, '')
    if not isinstance(value, str):
        raise CatalogueError('字段格式无效：' + key)
    value = value.strip() if key != 'body' else value
    if len(value) > limit or (required and not value):
        raise CatalogueError('标题或分组名称不能为空，且不能超过长度限制' if key in ('title', 'name') else '笔记内容过长')
    return value


def _revision(data, record):
    revision = data.get('revision')
    if type(revision) is not int or revision != record['revision']:
        raise CatalogueError('内容已在其他窗口更新，请重新打开后再编辑。当前输入仍保留在编辑器中。', 409)


def _handle(handler, action):
    try:
        result = action(read_body(handler))
        send_json(handler, dict(success=True, **result))
    except CatalogueError as error:
        send_json(handler, {'error': str(error)}, error.status)
    except Exception as error:
        send_json(handler, {'error': str(error)}, 500)


def handle_list_illustrated_notes(handler):
    def action(_):
        with locked():
            catalogue = _load()
            return dict(catalogue, folders_revision=catalogue.get('folders_revision', 0), isolated_test=(Path(DIRECTORY) / 'data/.isolated-test').is_file())
    _handle(handler, action)


def _folder(catalogue, folder_id):
    folder = next((g for g in catalogue['groups'] if g['id'] == folder_id), None)
    if not folder or folder_id == 'ungrouped':
        raise CatalogueError('此文件夹不存在或不可修改')
    return folder


def _folder_tree_revision(data, catalogue):
    revision = data.get('folders_revision')
    if type(revision) is not int or revision != catalogue.get('folders_revision', 0):
        raise CatalogueError('文件夹已在其他窗口更新，请刷新后再操作。', 409)


def _descendants(catalogue, folder_id):
    result = {folder_id}
    while True:
        children = {g['id'] for g in catalogue['groups'] if g.get('parent_id') in result}
        if children.issubset(result):
            return result
        result.update(children)


def _folder_name_available(catalogue, name, parent_id, folder_id=''):
    if any(g['name'].casefold() == name.casefold() and g.get('parent_id') == parent_id and g['id'] != folder_id for g in catalogue['groups']):
        raise CatalogueError('此位置已有同名文件夹')


def _commit_folders(catalogue, folder_id):
    catalogue['folders_revision'] = catalogue.get('folders_revision', 0) + 1
    commit({CATALOGUE: catalogue})
    return dict(catalogue, group_id=folder_id)


def handle_save_illustrated_group(handler):
    def action(data):
        name = _text(data, 'name', 80, True)
        group_id = _text(data, 'id', 100)
        with locked():
            catalogue = _load()
            _folder_tree_revision(data, catalogue)
            if group_id:
                group = _folder(catalogue, group_id)
                _revision(data, group)
                _folder_name_available(catalogue, name, group.get('parent_id'), group_id)
                group.update(name=name, revision=group['revision'] + 1)
            else:
                parent_id = _text(data, 'parent_id', 100) or None
                if parent_id:
                    _folder(catalogue, parent_id)
                _folder_name_available(catalogue, name, parent_id)
                group = {'id': uuid.uuid4().hex, 'name': name, 'parent_id': parent_id, 'revision': 1}
                catalogue['groups'].append(group)
            return _commit_folders(catalogue, group['id'])
    _handle(handler, action)


def handle_move_illustrated_group(handler):
    def action(data):
        folder_id = _text(data, 'id', 100, True)
        parent_id = _text(data, 'parent_id', 100) or None
        before_id = _text(data, 'before_id', 100)
        with locked():
            catalogue = _load()
            _folder_tree_revision(data, catalogue)
            folder = _folder(catalogue, folder_id)
            _revision(data, folder)
            if parent_id:
                _folder(catalogue, parent_id)
                if parent_id in _descendants(catalogue, folder_id):
                    raise CatalogueError('不能把文件夹移动到自己或自己的子文件夹中')
            _folder_name_available(catalogue, folder['name'], parent_id, folder_id)
            if before_id:
                before = _folder(catalogue, before_id)
                if before_id == folder_id or before.get('parent_id') != parent_id:
                    raise CatalogueError('排序位置无效')
            folder['parent_id'] = parent_id
            folder['revision'] += 1
            catalogue['groups'].remove(folder)
            if before_id:
                position = next(i for i, g in enumerate(catalogue['groups']) if g['id'] == before_id)
                catalogue['groups'].insert(position, folder)
            else:
                catalogue['groups'].append(folder)
            return _commit_folders(catalogue, folder_id)
    _handle(handler, action)


def handle_delete_illustrated_group(handler):
    def action(data):
        folder_id = _text(data, 'id', 100, True)
        with locked():
            catalogue = _load()
            _folder_tree_revision(data, catalogue)
            folder = _folder(catalogue, folder_id)
            _revision(data, folder)
            removed = _descendants(catalogue, folder_id)
            catalogue['groups'] = [g for g in catalogue['groups'] if g['id'] not in removed]
            timestamp = datetime.now(timezone.utc).isoformat(timespec='seconds')
            for note in catalogue['notes']:
                if note['group_id'] in removed:
                    note['group_id'] = 'ungrouped'
                    note['revision'] += 1
                    note['updated_at'] = timestamp
            return _commit_folders(catalogue, 'ungrouped')
    _handle(handler, action)


def handle_save_illustrated_note(handler):
    def action(data):
        title = _text(data, 'title', 200, True)
        body = _text(data, 'body', 500000)
        note_id = _text(data, 'id', 100)
        group_id = _text(data, 'group_id', 100) or 'ungrouped'
        with locked():
            catalogue = _load()
            image_urls = data.get('image_urls')
            if not isinstance(image_urls, list) or len(image_urls) > 100:
                raise CatalogueError('图片列表无效，每张笔记最多关联 100 张图片')
            if any(not isinstance(url, str) or not re.fullmatch(re.escape(IMAGE_PREFIX) + r'[a-f0-9]{32}\.(png|jpg|gif|webp)', url) for url in image_urls):
                raise CatalogueError('图片地址无效')
            image_urls = list(dict.fromkeys(image_urls))
            if any(not (ROOT / 'images' / url.rsplit('/', 1)[-1]).is_file() for url in image_urls):
                raise CatalogueError('图片不存在，请重新选择图片')
            if not any(g['id'] == group_id for g in catalogue['groups']):
                raise CatalogueError('分组不存在')
            timestamp = datetime.now(timezone.utc).isoformat(timespec='seconds')
            if note_id:
                note = next((n for n in catalogue['notes'] if n['id'] == note_id), None)
                if note is None:
                    raise CatalogueError('笔记不存在', 404)
                _revision(data, note)
                note['revision'] += 1
            else:
                note = {'id': uuid.uuid4().hex, 'revision': 1, 'created_at': timestamp}
                catalogue['notes'].insert(0, note)
            note.update(title=title, body=body, group_id=group_id, image_urls=image_urls, updated_at=timestamp)
            commit({CATALOGUE: catalogue})
            return {'note': note}
    _handle(handler, action)


def handle_upload_illustrated_image(handler):
    def action(data):
        data_url = _text(data, 'data_url', 22 * 1024 * 1024)
        match = re.fullmatch(r'data:(image/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)', data_url)
        if not match:
            raise CatalogueError('只支持 PNG、JPG、GIF、WEBP 图片')
        try:
            raw = base64.b64decode(match.group(2), validate=True)
        except (binascii.Error, ValueError):
            raise CatalogueError('图片数据无效')
        if not raw or len(raw) > 15 * 1024 * 1024:
            raise CatalogueError('图片不能超过 15 MB')
        mime = match.group(1)
        signatures = {'image/png': raw.startswith(b'\x89PNG\r\n\x1a\n'), 'image/jpeg': raw.startswith(b'\xff\xd8\xff'), 'image/gif': raw[:6] in (b'GIF87a', b'GIF89a'), 'image/webp': raw[:4] == b'RIFF' and raw[8:12] == b'WEBP'}
        if not signatures[mime]:
            raise CatalogueError('图片格式与内容不匹配')
        extension = {'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp'}[mime]
        filename = uuid.uuid4().hex + extension
        (ROOT / 'images').mkdir(parents=True, exist_ok=True)
        with (ROOT / 'images' / filename).open('xb') as file:
            file.write(raw)
        return {'url': IMAGE_PREFIX + filename}
    _handle(handler, action)
