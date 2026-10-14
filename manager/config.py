"""Portable configuration. Local configuration and runtime data are Git-ignored."""
import json
import os
from pathlib import Path
from initialize_data import initialize_data

DIRECTORY = str(Path(__file__).resolve().parent)
initialize_data(DIRECTORY)
_config_path = Path(DIRECTORY) / 'config.local.json'
_settings = json.loads(_config_path.read_text(encoding='utf-8')) if _config_path.exists() else {}
HOST = os.environ.get('DANBOORU_HOST', _settings.get('host', '127.0.0.1'))
PORT = int(os.environ.get('DANBOORU_PORT', _settings.get('port', 9090)))
TAGS_PATH = os.path.join(DIRECTORY, 'data', 'tags.json')
GROUPS_PATH = os.path.join(DIRECTORY, 'data', 'groups.json')
MODELS_PATH = os.path.join(DIRECTORY, 'data', 'models.json')
MODEL_IMAGES_DIR = os.path.join(DIRECTORY, 'data', 'model_images')
TRANSLATED_DIR = os.path.join(DIRECTORY, 'data', 'translated')
MODEL_SCAN_ROOTS = [(label, os.path.expandvars(os.path.expanduser(str(root)))) for label, root in _settings.get('model_scan_roots', [])]
COMFY_PYTHON = Path(os.environ.get('DANBOORU_MODEL_PYTHON') or _settings.get('model_python') or __import__('sys').executable)
SOURCE_INDEX_TOOL = Path(DIRECTORY) / 'tools' / 'build_model_source_index.py'
