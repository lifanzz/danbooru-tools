"""App-wide settings storage and external-URL opening.

data/settings.json holds simple key/value settings; writes are atomic
(stage + os.replace), which is enough for a single small document.
"""
import json
import os
import subprocess
import uuid
import webbrowser
from pathlib import Path
from urllib.parse import urlsplit

from config import DIRECTORY
from utils import send_json, read_body

SETTINGS_PATH = Path(DIRECTORY) / 'data' / 'settings.json'

# Common Windows install locations; first existing match per name wins.
BROWSER_CANDIDATES = [
    ('Microsoft Edge', r'Microsoft\Edge\Application\msedge.exe'),
    ('Google Chrome', r'Google\Chrome\Application\chrome.exe'),
    ('Mozilla Firefox', r'Mozilla Firefox\firefox.exe'),
    ('Brave', r'BraveSoftware\Brave-Browser\Application\brave.exe'),
    ('Vivaldi', r'Vivaldi\Application\vivaldi.exe'),
    ('Opera', r'Opera Software\Opera Stable\opera.exe'),
]


def load_settings():
    try:
        value = json.loads(SETTINGS_PATH.read_text(encoding='utf-8'))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def save_settings(settings):
    stage = SETTINGS_PATH.with_name(SETTINGS_PATH.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        with stage.open('w', encoding='utf-8') as handle:
            json.dump(settings, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(stage, SETTINGS_PATH)
    finally:
        stage.unlink(missing_ok=True)


def detected_browsers():
    roots = [os.environ.get('ProgramFiles', r'C:\Program Files'),
             os.environ.get('ProgramFiles(x86)', r'C:\Program Files (x86)'),
             os.environ.get('LOCALAPPDATA', '')]
    found = []
    seen = set()
    for name, rel in BROWSER_CANDIDATES:
        for root in roots:
            if not root:
                continue
            path = Path(root) / rel
            if path.is_file() and str(path).lower() not in seen:
                found.append({'name': name, 'path': str(path)})
                seen.add(str(path).lower())
                break
    return found


def normalize_browser(value):
    """Return a cleaned executable path ('' = system default) or raise."""
    path = str(value or '').strip().strip('"')
    if not path:
        return ''
    if not Path(path).is_file():
        raise ValueError(f'浏览器程序不存在：{path}')
    return path


def valid_external_url(url):
    parts = urlsplit(str(url or ''))
    return parts.scheme in ('http', 'https') and bool(parts.netloc)


def open_external(url, browser_path):
    if not valid_external_url(url):
        raise ValueError('仅支持 http/https 链接')
    if browser_path:
        subprocess.Popen([browser_path, url], stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
        return 'browser'
    webbrowser.open(url)
    return 'default'


def handle_get_settings(handler):
    settings = load_settings()
    send_json(handler, {'success': True, 'open_url_browser': settings.get('open_url_browser', ''),
                        'group_language': settings.get('group_language', 'zh'),
                        'category_language': settings.get('category_language', 'zh'),
                        'unrated_confidence': settings.get('unrated_confidence', 'D'),
                        'browsers': detected_browsers()})


def handle_save_settings(handler):
    try:
        data = read_body(handler)
        settings = load_settings()
        browser = normalize_browser(data.get('open_url_browser', settings.get('open_url_browser', '')))
        settings['open_url_browser'] = browser
        for key in ('group_language', 'category_language'):
            value = data.get(key, settings.get(key, 'zh'))
            if value not in ('zh', 'en'):
                raise ValueError('显示语言只能选择中文或英文')
            settings[key] = value
        unrated = data.get('unrated_confidence', settings.get('unrated_confidence', 'D'))
        if unrated not in ('MANUAL', 'A', 'B', 'C', 'D'):
            raise ValueError('未评分置信度只能选择手写、A、B、C、D')
        settings['unrated_confidence'] = unrated
        save_settings(settings)
        send_json(handler, {'success': True, **settings})
    except ValueError as exc:
        send_json(handler, {'error': str(exc)}, 400)
    except OSError as exc:
        send_json(handler, {'error': f'无法保存设置：{exc}'}, 500)


def handle_open_url(handler):
    try:
        data = read_body(handler)
        url = str(data.get('url') or '')
        if not valid_external_url(url):
            raise ValueError('仅支持 http/https 链接')
        # “测试打开”可带一次性 browser 覆盖，未保存也能先试。
        browser = normalize_browser(data.get('browser', None) if 'browser' in data else load_settings().get('open_url_browser'))
        mode = open_external(url, browser)
        send_json(handler, {'success': True, 'mode': mode})
    except ValueError as exc:
        send_json(handler, {'error': str(exc)}, 400)
    except OSError as exc:
        send_json(handler, {'error': f'无法打开链接：{exc}'}, 500)
