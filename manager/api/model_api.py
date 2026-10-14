"""Model library CRUD API handlers."""
import base64
import json
import os
import hashlib
import subprocess
import sys
import threading
import uuid
import functools
from pathlib import Path
from urllib.parse import urlparse

from config import MODEL_IMAGES_DIR, MODELS_PATH, MODEL_SCAN_ROOTS, COMFY_PYTHON, SOURCE_INDEX_TOOL
from utils import read_body, send_json
from catalogue_store import locked, commit


SOURCE_INDEX_FILES = {
    'LoRA': ('lora_source_index.json', 'loras_without_urls_metadata.json'),
    'UNet': ('unet_source_index.json', 'unet_without_urls_metadata.json'),
    'Checkpoints': ('checkpoint_source_index.json', 'checkpoints_without_urls_metadata.json'),
}
REFRESH_STATE = {'running': False, 'message': '尚未刷新模型。', 'models': [], 'summary': None, 'error': None}
REFRESH_LOCK = threading.Lock()
HASH_LOCK = threading.Lock()
SHA256_CACHE_FIELDS = ('sha256', 'sha256_size', 'sha256_mtime')

# Keep sidecar metadata, hashes, previews, and placeholder files out of the
# model library.  These are the formats this manager treats as model files.
MODEL_FILE_EXTENSIONS = {'.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.gguf', '.onnx'}
INVALID_WINDOWS_FILENAME_CHARS = set('<>:"/\\|?*')


def _model_locked(function):
    @functools.wraps(function)
    def wrapped(*args, **kwargs):
        with locked():
            return function(*args, **kwargs)
    return wrapped


def _normalize_prompt_sets(record):
    """Ordered sets are authoritative; legacy fields project the first set."""
    if 'prompt_sets' not in record:
        sets = [{'name': '', 'prompt': record.get('prompt', ''), 'image_url': record.get('image_url', '')}]
    else:
        sets = record['prompt_sets']
    if not isinstance(sets, list) or not sets:
        raise ValueError('至少保留一套常用提示词和图片')
    normalized = []
    for item in sets:
        if not isinstance(item, dict):
            raise ValueError('提示词图片组格式无效')
        values = {key: item.get(key, '') for key in ('name', 'prompt', 'image_url')}
        if not all(isinstance(value, str) for value in values.values()):
            raise ValueError('小名称、提示词和图片地址必须是文本')
        normalized.append({key: value.strip() for key, value in values.items()})
    record['prompt_sets'] = normalized
    record['prompt'] = normalized[0]['prompt']
    record['image_url'] = normalized[0]['image_url']
    return record


def _load_models():
    if not os.path.exists(MODELS_PATH):
        return []
    with open(MODELS_PATH, 'r', encoding='utf-8') as f:
        data = json.load(f)
    return [_normalize_prompt_sets(record) for record in data] if isinstance(data, list) else []


def _save_models(models):
    # Callers hold the catalogue lock for the complete read/modify/write.
    commit({Path(MODELS_PATH): [_normalize_prompt_sets(record) for record in models]})


def _normal_path(path):
    return os.path.normcase(os.path.abspath(path))


def _managed_model_file(path):
    """Return a real model file only when it is inside a scanned ComfyUI root."""
    candidate = Path(path).resolve()
    if not candidate.is_file() or candidate.suffix.lower() not in MODEL_FILE_EXTENSIONS:
        return None
    for _, root in MODEL_SCAN_ROOTS:
        try:
            candidate.relative_to(Path(root).resolve())
            return candidate
        except ValueError:
            continue
    return None


def _rename_managed_model_file(old_path, requested_filename):
    """Rename in place, rejecting path changes, collisions, and extension changes."""
    old_file = _managed_model_file(old_path)
    if old_file is None:
        raise ValueError('只能重命名 LoRA、UNet 或 Checkpoints 扫描目录中的现有模型文件')
    filename = str(requested_filename or '').strip()
    if not filename:
        raise ValueError('模型文件名不能为空')
    if Path(filename).name != filename or filename in {'.', '..'}:
        raise ValueError('模型文件名不能包含文件夹路径')
    if any(char in INVALID_WINDOWS_FILENAME_CHARS for char in filename) or filename.endswith((' ', '.')):
        raise ValueError('模型文件名包含 Windows 不支持的字符')
    target = old_file.with_name(filename)
    if target.suffix.casefold() != old_file.suffix.casefold():
        raise ValueError(f'必须保留原文件后缀：{old_file.suffix}')
    if _normal_path(target) == _normal_path(old_file):
        return old_file
    if target.exists():
        raise ValueError('同一文件夹中已存在同名模型文件')
    try:
        old_file.rename(target)
    except OSError as exc:
        raise ValueError(f'重命名模型文件失败：{exc}') from exc
    return target


def _scanned_id(path):
    return 'scan-' + hashlib.sha1(_normal_path(path).encode('utf-8')).hexdigest()[:20]


def _collect_indexed_hashes():
    """SHA-256 values already computed by the ComfyUI source-index tool, by path."""
    hashes = {}
    for label, root in MODEL_SCAN_ROOTS:
        index_name, unresolved_name = SOURCE_INDEX_FILES[label]
        index_path = Path(root) / index_name
        try:
            entries = json.loads(index_path.read_text(encoding='utf-8')).get('entries', {})
        except (OSError, json.JSONDecodeError, AttributeError):
            entries = {}
        for relative_path, entry in entries.items():
            value = entry.get('file_sha256', '') if isinstance(entry, dict) else ''
            if isinstance(value, str) and len(value) == 64:
                hashes[_normal_path(os.path.join(root, relative_path))] = value.lower()
        unresolved_path = Path(root) / unresolved_name
        try:
            pending = json.loads(unresolved_path.read_text(encoding='utf-8')).get('entries', [])
        except (OSError, json.JSONDecodeError, AttributeError):
            pending = []
        for entry in pending if isinstance(pending, list) else []:
            if not isinstance(entry, dict):
                continue
            for lookup in entry.get('hash_lookup', []):
                value = lookup.get('hash', '') if isinstance(lookup, dict) else ''
                if isinstance(value, str) and len(value) == 64:
                    hashes.setdefault(_normal_path(os.path.join(root, entry.get('relative_path', ''))), value.lower())
                    break
    return hashes


def _sha256_of_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(4 * 1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


@_model_locked
def handle_model_hash(handler):
    """Return a model file's SHA-256, reusing index/cache values and hashing on demand."""
    try:
        data = read_body(handler)
        path = str(data.get('path', '')).strip()
        candidate = Path(path)
        if not path or not candidate.is_file() or candidate.suffix.lower() not in MODEL_FILE_EXTENSIONS:
            raise ValueError('未找到该模型文件')
        stat = candidate.stat()
        with HASH_LOCK:
            models = _load_models()
            record = next((item for item in models if _normal_path(item.get('file_path', '')) == _normal_path(path)), None)
            if (record or {}).get('sha256') and record.get('sha256_size') == stat.st_size and record.get('sha256_mtime') == int(stat.st_mtime):
                send_json(handler, {'success': True, 'sha256': record['sha256'], 'source': 'cache'})
                return
            sha256 = _collect_indexed_hashes().get(_normal_path(path), '')
            source = 'index'
            if not sha256:
                sha256 = _sha256_of_file(candidate)
                source = 'computed'
            if record is not None:
                record['sha256'] = sha256
                record['sha256_size'] = stat.st_size
                record['sha256_mtime'] = int(stat.st_mtime)
                _save_models(models)
        send_json(handler, {'success': True, 'sha256': sha256, 'source': source})
    except Exception as e:
        send_json(handler, {'error': str(e)}, 400)


def _valid_url(value):
    if not isinstance(value, str):
        return False
    parsed = urlparse(value.strip())
    return parsed.scheme in {'http', 'https'} and bool(parsed.netloc)


def _refresh_source_indices():
    """Run the former Plus-node missing-URL lookup for each model family."""
    if not COMFY_PYTHON.is_file() or not SOURCE_INDEX_TOOL.is_file():
        return ['找发布网址工具不可用，已仅完成文件扫描。']

    warnings = []
    for label, root in MODEL_SCAN_ROOTS:
        index_name, unresolved_name = SOURCE_INDEX_FILES[label]
        try:
            completed = subprocess.run(
                [
                    str(COMFY_PYTHON), str(SOURCE_INDEX_TOOL), root,
                    '--index', os.path.join(root, index_name),
                    '--unresolved-metadata', os.path.join(root, unresolved_name),
                    '--only-missing',
                ],
                capture_output=True,
                text=True,
                encoding='utf-8',
                errors='replace',
                timeout=900,
            )
            if completed.returncode != 0:
                warnings.append(f'{label} 的发布网址查询失败。')
        except (OSError, subprocess.TimeoutExpired) as exc:
            warnings.append(f'{label} 的发布网址查询无法完成：{exc}')
    return warnings


def _fill_urls_from_source_indices(models):
    """Copy verified index URLs into blank Tag Manager records, never overwrite manual URLs."""
    urls_by_path = {}
    for label, root in MODEL_SCAN_ROOTS:
        index_name, _ = SOURCE_INDEX_FILES[label]
        index_path = Path(root) / index_name
        try:
            entries = json.loads(index_path.read_text(encoding='utf-8')).get('entries', {})
        except (OSError, json.JSONDecodeError):
            continue
        for relative_path, entry in entries.items():
            urls = entry.get('urls', []) if isinstance(entry, dict) else []
            url = next((item for item in urls if _valid_url(item)), '')
            if url:
                urls_by_path[_normal_path(os.path.join(root, relative_path))] = url

    filled = 0
    for record in models:
        if _valid_url(record.get('url')):
            continue
        url = urls_by_path.get(_normal_path(record.get('file_path', '')))
        if url:
            record['url'] = url
            filled += 1
    return filled


@_model_locked
def _scan_model_roots():
    """Inventory model files below the three requested ComfyUI model folders."""
    existing = _load_models()
    by_path = {_normal_path(item.get('file_path', '')): item for item in existing if item.get('file_path')}
    managed_roots = [_normal_path(path) for _, path in MODEL_SCAN_ROOTS]
    scanned = []
    folders = []
    for label, root in MODEL_SCAN_ROOTS:
        root_path = os.path.abspath(root)
        count = 0
        total_bytes = 0
        if os.path.isdir(root_path):
            for base, _, filenames in os.walk(root_path):
                for filename in filenames:
                    if Path(filename).suffix.lower() not in MODEL_FILE_EXTENSIONS:
                        continue
                    path = os.path.join(base, filename)
                    try:
                        stat = os.stat(path)
                    except OSError:
                        continue
                    normal_path = _normal_path(path)
                    previous = by_path.get(normal_path, {})
                    relative_parent = os.path.relpath(os.path.dirname(path), root_path)
                    # Always derive scanned records from their real folder.
                    # This repairs stale cached categories such as a root-level
                    # "Illustrious" beside "LoRA / Illustrious".
                    category = label if relative_parent == '.' else f'{label} / {relative_parent.replace(os.sep, " / ")}'
                    record = dict(previous)
                    record.update({
                        'id': previous.get('id') or _scanned_id(path),
                        'name': previous.get('name') or os.path.splitext(filename)[0],
                        'file_path': path,
                        'category': category,
                        'url': previous.get('url', ''),
                        'prompt': previous.get('prompt', ''),
                        'recommended_params': previous.get('recommended_params', ''),
                        'image_url': previous.get('image_url', ''),
                        'scan_scope': label,
                        'file_size': stat.st_size,
                        'modified_at': int(stat.st_mtime),
                    })
                    scanned.append(record)
                    count += 1
                    total_bytes += stat.st_size
        folders.append({'label': label, 'path': root_path, 'count': count, 'bytes': total_bytes})

    # Keep deliberately manual records outside the three managed folders.
    manual = []
    for record in existing:
        path = _normal_path(record.get('file_path', '')) if record.get('file_path') else ''
        if not any(path == root or path.startswith(root + os.sep) for root in managed_roots):
            manual.append(record)
    models = sorted(scanned, key=lambda item: (item.get('scan_scope', ''), item.get('file_path', '').casefold())) + manual
    return models, {'folders': folders, 'total': len(scanned), 'bytes': sum(item['bytes'] for item in folders)}, {item['id'] for item in existing}


def _refresh_models_and_urls(lookup_urls=False):
    """Refresh the file inventory and, only when requested, find missing publication URLs."""
    try:
        models, summary, original_ids = _scan_model_roots()
        warnings = []
        filled = 0
        if lookup_urls:
            REFRESH_STATE.update({'message': '正在通过模型元数据和 Civitai 哈希查找缺失网址…'})
            warnings = _refresh_source_indices()
            filled = _fill_urls_from_source_indices(models)
        with locked():
            # A scan/URL lookup may take time. Keep edits made while it runs.
            latest = {item['id']: item for item in _load_models()}
            merged = []
            for scanned in models:
                looked_up_url = scanned.get('url', '')
                current = latest.pop(scanned['id'], None)
                if current is None and scanned['id'] in original_ids:
                    continue  # This record was deleted while the scan ran.
                if current is not None:
                    for key, value in current.items():
                        if key not in {'scan_scope', 'file_size', 'modified_at', 'category'}:
                            scanned[key] = value
                    if not current.get('url') and lookup_urls:
                        scanned['url'] = looked_up_url
                merged.append(scanned)
            merged.extend(item for model_id, item in latest.items() if model_id not in original_ids)
            models = merged
            _save_models(models)
        if lookup_urls:
            message = f'已扫描：{summary["total"]} 个模型文件，新增 {filled} 个发布网址。'
        else:
            message = f'已刷新模型文件：扫描到 {summary["total"]} 个模型文件。'
        if warnings:
            message += ' ' + ' '.join(warnings)
        REFRESH_STATE.update({'running': False, 'message': message, 'models': models, 'summary': summary, 'error': None})
    except Exception as e:
        REFRESH_STATE.update({'running': False, 'message': f'模型刷新失败：{e}', 'models': [], 'summary': None, 'error': str(e)})


def handle_refresh_models(handler):
    """Start a model scan, optionally also looking up missing publication URLs."""
    try:
        data = read_body(handler)
    except Exception:
        data = {}
    lookup_urls = bool(isinstance(data, dict) and data.get('lookup_urls'))
    with REFRESH_LOCK:
        if REFRESH_STATE['running']:
            send_json(handler, {'success': True, 'started': False, 'message': REFRESH_STATE['message']})
            return
        REFRESH_STATE.update({
            'running': True,
            'message': '正在扫描模型文件并补全缺失网址…' if lookup_urls else '正在扫描模型文件…',
            'models': [], 'summary': None, 'error': None,
        })
        threading.Thread(target=_refresh_models_and_urls, kwargs={'lookup_urls': lookup_urls}, daemon=True).start()
    send_json(handler, {'success': True, 'started': True, 'message': REFRESH_STATE['message']})


def handle_refresh_models_status(handler):
    """Return progress and the completed model list to the browser."""
    send_json(handler, {'success': not bool(REFRESH_STATE['error']), **REFRESH_STATE})


def handle_open_model_category_folder(handler):
    """Open an existing scanned category folder in Windows Explorer."""
    try:
        category = str(read_body(handler).get('category', '')).strip()
        parts = [part.strip() for part in category.split('/')]
        if not parts or any(part in ('', '.', '..') or '\\' in part or ':' in part for part in parts):
            raise ValueError('请选择实际模型分类目录')
        root = next((Path(path).resolve() for label, path in MODEL_SCAN_ROOTS if label == parts[0]), None)
        if root is None:
            raise ValueError('此分类没有对应的扫描目录')
        folder = root.joinpath(*parts[1:]).resolve()
        if folder != root and root not in folder.parents:
            raise ValueError('分类目录不在模型扫描范围内')
        if not folder.is_dir():
            raise ValueError('分类文件夹不存在，请先刷新模型目录')
        os.startfile(str(folder))
        send_json(handler, {'success': True, 'path': str(folder)})
    except ValueError as error:
        send_json(handler, {'error': str(error)}, 400)
    except OSError as error:
        send_json(handler, {'error': f'打开资源管理器失败：{error}'}, 500)


@_model_locked
def handle_save_model(handler):
    """Create or update a model-library record."""
    try:
        data = read_body(handler)
        name = str(data.get('name', '')).strip()
        required_fields = {
            '模型名称': name,
            '文件位置': str(data.get('file_path', '')).strip(),
        }
        missing = [label for label, value in required_fields.items() if not value]
        if missing:
            raise ValueError('请填写：' + '、'.join(missing))

        models = _load_models()
        model_id = str(data.get('id', '')).strip() or uuid.uuid4().hex
        index = next((i for i, item in enumerate(models) if item.get('id') == model_id), None)
        existing = models[index] if index is not None else None
        # Validate before any physical file rename; old clients update only set 1.
        if 'prompt_sets' in data:
            prompt_data = _normalize_prompt_sets({'prompt_sets': data['prompt_sets']})
        else:
            prompt_data = _normalize_prompt_sets(dict(existing or {}))
            for field in ('prompt', 'image_url'):
                if field in data:
                    prompt_data['prompt_sets'][0][field] = str(data[field]).strip()
            _normalize_prompt_sets(prompt_data)
        renamed_from = ''
        file_path = str(data.get('file_path', '')).strip()
        if existing is not None:
            current_file_path = str(existing.get('file_path', '')).strip()
            submitted_original = str(data.get('original_file_path', '')).strip()
            if submitted_original and _normal_path(submitted_original) != _normal_path(current_file_path):
                raise ValueError('模型文件记录已变化，请刷新后重试')
            requested_filename = str(data.get('file_name', '')).strip()
            if requested_filename and requested_filename != Path(current_file_path).name:
                renamed_file = _rename_managed_model_file(current_file_path, requested_filename)
                renamed_from = current_file_path
                file_path = str(renamed_file)
            else:
                file_path = current_file_path
        record = dict(existing or {})
        record.update({
            'id': model_id,
            'name': name,
            'file_path': file_path,
            'category': str(data.get('category', '')).strip(),
            'url': str(data.get('url', '')).strip(),
            'prompt_sets': prompt_data['prompt_sets'],
            'prompt': prompt_data['prompt'],
            'recommended_params': str(data.get('recommended_params', '')).strip(),
            'image_url': prompt_data['image_url'],
        })
        # Renaming a file does not change its content; keep the hash cache usable.
        if existing is not None:
            for field in SHA256_CACHE_FIELDS:
                if field in existing:
                    record[field] = existing[field]
        if index is None:
            models.append(record)
        else:
            models[index] = record
        try:
            _save_models(models)
        except OSError as exc:
            if renamed_from:
                try:
                    Path(file_path).rename(renamed_from)
                except OSError:
                    pass
            raise ValueError(f'保存模型库记录失败：{exc}') from exc
        send_json(handler, {'success': True, 'model': record, 'renamed_file': bool(renamed_from)})
    except Exception as e:
        send_json(handler, {'error': str(e)}, 400)


@_model_locked
def handle_delete_model(handler):
    """Delete one model-library record by its stable ID."""
    try:
        data = read_body(handler)
        model_id = str(data.get('id', '')).strip()
        if not model_id:
            raise ValueError('模型 ID 不能为空')
        models = _load_models()
        remaining = [item for item in models if item.get('id') != model_id]
        if len(remaining) == len(models):
            send_json(handler, {'error': '未找到该模型'}, 404)
            return
        _save_models(remaining)
        send_json(handler, {'success': True})
    except Exception as e:
        send_json(handler, {'error': str(e)}, 400)


@_model_locked
def handle_reorder_models(handler):
    """Persist the exact card order sent by the model-library drag and drop UI."""
    try:
        data = read_body(handler)
        ordered_ids = data.get('ids', [])
        if not isinstance(ordered_ids, list) or not all(isinstance(item, str) for item in ordered_ids):
            raise ValueError('模型排序数据无效')
        models = _load_models()
        current_ids = [item.get('id') for item in models]
        if len(ordered_ids) != len(current_ids) or len(set(ordered_ids)) != len(ordered_ids) or set(ordered_ids) != set(current_ids):
            raise ValueError('模型排序与当前记录不一致，请刷新后重试')
        by_id = {item['id']: item for item in models}
        _save_models([by_id[item_id] for item_id in ordered_ids])
        send_json(handler, {'success': True})
    except Exception as e:
        send_json(handler, {'error': str(e)}, 400)


def handle_upload_model_image(handler):
    """Store a dropped local cover image under the project data directory."""
    try:
        data = read_body(handler)
        filename = os.path.basename(str(data.get('filename', 'cover.png')))
        data_url = str(data.get('data_url', ''))
        if not data_url.startswith('data:image/') or ',' not in data_url:
            raise ValueError('请拖入图片文件')
        encoded = data_url.split(',', 1)[1]
        image_bytes = base64.b64decode(encoded, validate=True)
        if not image_bytes or len(image_bytes) > 15 * 1024 * 1024:
            raise ValueError('图片必须小于 15 MB')
        extension = os.path.splitext(filename)[1].lower()
        if extension not in {'.png', '.jpg', '.jpeg', '.webp', '.gif'}:
            raise ValueError('仅支持 PNG、JPG、WEBP 或 GIF 图片')
        os.makedirs(MODEL_IMAGES_DIR, exist_ok=True)
        stored_name = f'{uuid.uuid4().hex}{extension}'
        with open(os.path.join(MODEL_IMAGES_DIR, stored_name), 'wb') as f:
            f.write(image_bytes)
        send_json(handler, {'success': True, 'url': f'data/model_images/{stored_name}'})
    except Exception as e:
        send_json(handler, {'error': str(e)}, 400)
