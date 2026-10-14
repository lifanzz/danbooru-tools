"""Standalone local Danbooru search node; no LoRA or gallery launcher nodes."""
from __future__ import annotations
import asyncio
import json
import os
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from urllib.request import urlopen
from aiohttp import web
from server import PromptServer

NODE_DIR = Path(__file__).resolve().parent
_config_path = NODE_DIR / 'config.json'
_config = json.loads(_config_path.read_text(encoding='utf-8')) if _config_path.exists() else {}
_root = os.environ.get('DANBOORU_MANAGER_DIR', _config.get('manager_dir', ''))
DANBOORU_PROJECT_DIR = Path(os.path.expandvars(os.path.expanduser(_root))).resolve() if _root else NODE_DIR.parents[1] / 'manager'
DANBOORU_URL = os.environ.get('DANBOORU_MANAGER_URL', _config.get('manager_url', 'http://127.0.0.1:9090')).rstrip('/')
DANBOORU_TAGS_PATH = DANBOORU_PROJECT_DIR / 'data/tags.json'
DANBOORU_TRANSLATED_DIR = DANBOORU_PROJECT_DIR / 'data/translated'
DANBOORU_GROUPS_PATH = DANBOORU_PROJECT_DIR / 'data/groups.json'
MODEL_MANAGER_PATH = DANBOORU_PROJECT_DIR / 'data/models.json'
_DANBOORU_TAGS_CACHE = None
_DANBOORU_TAGS_CACHE_MTIME_NS = None

@PromptServer.instance.routes.get('/danbooru_tools/config')
async def get_config(request):
    return web.json_response({'manager_url': DANBOORU_URL + '/'})

def _ready():
    try:
        with urlopen(DANBOORU_URL + '/api/catalogue', timeout=1) as response:
            result = json.load(response)
            return isinstance(result.get('tags'), list) and isinstance(result.get('groups'), list)
    except (OSError, ValueError):
        return False

def _start_and_open(query):
    if not _ready():
        script = DANBOORU_PROJECT_DIR / 'serve.py'
        if not script.is_file():
            raise ValueError('请在插件 config.json 中设置 manager_dir，或先手动启动管理器。')
        env = os.environ.copy()
        env['DANBOORU_OPEN_BROWSER'] = '0'
        env['DANBOORU_PORT'] = str(urlsplit(DANBOORU_URL).port or 9090)
        env['PYTHONUTF8'] = '1'
        env['PYTHONIOENCODING'] = 'utf-8'
        subprocess.Popen([sys.executable, '-X', 'utf8', str(script)], cwd=str(DANBOORU_PROJECT_DIR), env=env,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        for _ in range(40):
            if _ready(): break
            time.sleep(0.15)
        if not _ready(): raise ValueError('管理器尚未启动成功，请检查配置或手动运行 start-manager.cmd。')
    url = DANBOORU_URL + '/'
    if query: url += '?' + urlencode({'search': query})
    webbrowser.open(url)
    return {'running': True, 'url': url}

@PromptServer.instance.routes.post('/danbooru_tools/open_danbooru')
async def open_danbooru(request):
    try:
        result = await asyncio.to_thread(_start_and_open, request.query.get('search', ''))
        return web.json_response(result)
    except (OSError, ValueError) as error:
        return web.json_response({'message': str(error)}, status=400)

def _danbooru_tags() -> list[dict]:
    """Reload the local catalogue whenever tags.json has changed on disk."""
    global _DANBOORU_TAGS_CACHE, _DANBOORU_TAGS_CACHE_MTIME_NS
    modified_at = DANBOORU_TAGS_PATH.stat().st_mtime_ns
    if _DANBOORU_TAGS_CACHE is None or _DANBOORU_TAGS_CACHE_MTIME_NS != modified_at:
        data = json.loads(DANBOORU_TAGS_PATH.read_text(encoding="utf-8"))
        _DANBOORU_TAGS_CACHE = [item for item in data if isinstance(item, dict)]
        _DANBOORU_TAGS_CACHE_MTIME_NS = modified_at
    return _DANBOORU_TAGS_CACHE

def _is_character_group(group: dict) -> bool:
    """Keep this in sync with the Tag Manager's dedicated 角色库 sidebar."""
    if group.get("library"):
        return group["library"] == "character"
    group_id = str(group.get("id") or "").casefold()
    name = str(group.get("name_cn") or "")
    return bool(group.get("character_library")) or "character" in group_id or "角色" in name

def _danbooru_groups() -> list[dict]:
    """Read the unified group registry, including explicit library flags."""
    data = json.loads(DANBOORU_GROUPS_PATH.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError("groups.json 应为分组数组")
    return [group for group in data if isinstance(group, dict)]

def _character_groups() -> list[dict]:
    return [group for group in _danbooru_groups() if _is_character_group(group)]

def _search_terms(query: str) -> list[str]:
    return [term.casefold() for term in query.replace(",", " ").replace("，", " ").split() if term]

def _matches_terms(fields: tuple[str, ...], terms: list[str]) -> bool:
    """Offline equivalent of assets/search-engine.js default matching."""
    values = [str(field or "").casefold() for field in fields]
    normalize = lambda value: value.replace("_", " ").replace("-", " ")
    return all(any(term in value or normalize(term) in normalize(value) for value in values) for term in terms)

def _character_group_file(group: dict) -> Path:
    relative = str(group.get("content_file") or "").strip()
    if not relative:
        raise ValueError(f"角色分组 {group.get('id', '')} 缺少 content_file")
    path = (DANBOORU_PROJECT_DIR / relative).resolve()
    if not path.is_relative_to(DANBOORU_PROJECT_DIR.resolve()):
        raise ValueError(f"角色分组 {group.get('id', '')} 的 content_file 超出管理器目录")
    return path

def _search_character_prompts(query: str, group_id: str = "", limit: int | None = None, match_long_description: bool = False) -> list[dict]:
    """Search only character-library outer groups and retain their full prompt cards."""
    terms = _search_terms(query)
    if not terms:
        return []

    matches: list[tuple[tuple[int, int, str], dict]] = []
    for group in _character_groups():
        if group_id and group.get("id") != group_id:
            continue
        payload = json.loads(_character_group_file(group).read_text(encoding="utf-8"))
        for item in payload.get("tags", []) if isinstance(payload, dict) else []:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "").strip()
            chinese = str(item.get("tag_cn") or "").strip()
            prompt = str(item.get("prompt") or name).strip()
            description = str(item.get("tag_cn_long") or "").strip()
            fields = (name, chinese, prompt, description) if match_long_description else (name, chinese, prompt)
            if not _matches_terms(fields, terms):
                continue
            title_key = chinese.casefold()
            name_key = name.casefold()
            exact_rank = 0 if any(title_key.startswith(term) or name_key.startswith(term) for term in terms) else 1
            prompt_rank = 0 if item.get("prompt") else 1
            group_name = str(group.get("name_cn") or group.get("id") or "角色分组")
            matches.append(((exact_rank, prompt_rank, title_key or name_key), {
                "group_id": str(group.get("id") or ""),
                "group_name": group_name,
                "display_name": chinese or name or "未命名角色",
                "name": name,
                "copy_text": prompt,
                "description": description or "点击复制完整角色提示词",
                "kind": "preset" if item.get("prompt") else "character",
                "has_full_prompt": bool(item.get("prompt")),
            }))
    matches.sort(key=lambda item: item[0])
    results = [item[1] for item in matches]
    return results if limit is None else results[:limit]

def _search_danbooru_tags(query: str, limit: int | None = None, match_long_description: bool = False) -> list[dict]:
    """Find ordinary local Danbooru tags for the ComfyUI launcher node."""
    terms = _search_terms(query)
    needle = query.strip().casefold()
    if not terms:
        return []

    groups = _danbooru_groups()
    hidden_groups = {str(group.get("id") or "") for group in groups
                     if _is_character_group(group) or group.get("search_enabled") is False}

    matches: list[tuple[tuple[int, int, str], dict]] = []
    for tag in _danbooru_tags():
        name = str(tag.get("name") or "")
        # The unified tags.json is the sole general catalogue. Character files
        # no longer need to be opened to search ordinary tags.
        if hidden_groups.intersection(tag.get("groups") or []):
            continue
        chinese = str(tag.get("tag_cn") or "")
        description = str(tag.get("tag_cn_long") or "")
        name_key, chinese_key = name.casefold(), chinese.casefold()
        fields = (name, chinese, description) if match_long_description else (name, chinese)
        if not _matches_terms(fields, terms):
            continue
        rank = 0 if name_key.startswith(needle) else 1 if needle in name_key else 2 if chinese_key.startswith(needle) else 3
        pinned = bool(tag.get("pinned", False))
        matches.append(((0 if pinned else 1, rank, name_key), {
            "name": name,
            "display_name": name,
            "copy_text": name,
            "tag_cn": chinese,
            "description": description,
            "pinned": pinned,
            "kind": "tag",
        }))

    matches.sort(key=lambda item: item[0])
    results = [item[1] for item in matches]
    return results if limit is None else results[:limit]

@PromptServer.instance.routes.get("/danbooru_tools/search_danbooru")
async def search_danbooru(request: web.Request) -> web.Response:
    """Return local Danbooru tag matches for the launcher node, without opening a browser."""
    query = request.query.get("query", "")
    match_long_description = request.query.get("match_long_description", "false").lower() in {"true", "1"}
    raw_limit = request.query.get("limit")
    try:
        limit = max(1, min(20, int(raw_limit))) if raw_limit is not None else None
    except ValueError:
        limit = None
    try:
        return web.json_response({"query": query, "results": _search_danbooru_tags(query, limit=limit, match_long_description=match_long_description)})
    except FileNotFoundError as exc:
        return web.json_response({"message": f"找不到本地数据文件：{exc.filename}"}, status=500)
    except (OSError, ValueError) as exc:
        return web.json_response({"message": f"读取本地标签库失败：{exc}"}, status=500)

@PromptServer.instance.routes.get("/danbooru_tools/search_character_prompts")
async def search_character_prompts(request: web.Request) -> web.Response:
    """Search full character prompts without mixing in ordinary Danbooru tags."""
    query = request.query.get("query", "")
    group_id = request.query.get("group_id", "")
    match_long_description = request.query.get("match_long_description", "false").lower() in {"true", "1"}
    try:
        return web.json_response({
            "query": query,
            "group_id": group_id,
            "results": _search_character_prompts(query, group_id, match_long_description=match_long_description),
        })
    except FileNotFoundError as exc:
        return web.json_response({"message": f"找不到本地角色数据文件：{exc.filename}"}, status=500)
    except (OSError, ValueError) as exc:
        return web.json_response({"message": f"读取角色提示词组失败：{exc}"}, status=500)

def _model_prompt_sets(model: dict) -> list[dict]:
    sets = model.get("prompt_sets")
    return sets if isinstance(sets, list) and sets else [{
        "name": "", "prompt": model.get("prompt", ""), "image_url": model.get("image_url", ""),
    }]

@PromptServer.instance.routes.get("/danbooru_tools/search_models")
async def search_models(request: web.Request) -> web.Response:
    query = request.query.get("query", "").strip().lower()
    try:
        models = json.loads(MODEL_MANAGER_PATH.read_text(encoding="utf-8"))
        results = []
        for model in models:
            for index, prompt_set in enumerate(_model_prompt_sets(model)):
                fields = [model.get(field) for field in ("name", "category", "recommended_params", "file_path", "url")]
                fields.extend((prompt_set.get("name"), prompt_set.get("prompt")))
                if not query or not any(query in str(value or "").lower() for value in fields):
                    continue
                image = str(prompt_set.get("image_url") or "").strip()
                if image and urlsplit(image).scheme not in {"http", "https"}:
                    image = "/danbooru_tools/model_cover?" + urlencode({"model_id": model["id"], "set_index": index})
                results.append({"name": model.get("name") or "未命名模型",
                                "set_name": str(prompt_set.get("name") or "").strip(),
                                "prompt": str(prompt_set.get("prompt") or "").strip(), "image_url": image})
        return web.json_response({"query": query, "results": results})
    except (OSError, ValueError) as exc:
        return web.json_response({"message": f"读取本地模型库失败：{exc}"}, status=500)

@PromptServer.instance.routes.get("/danbooru_tools/model_cover")
async def model_cover(request: web.Request) -> web.Response:
    try:
        models = json.loads(MODEL_MANAGER_PATH.read_text(encoding="utf-8"))
        model = next((row for row in models if row.get("id") == request.query.get("model_id")), None)
        if model is None:
            raise web.HTTPNotFound()
        sets = _model_prompt_sets(model)
        index = int(request.query.get("set_index", "0"))
        if not 0 <= index < len(sets):
            raise web.HTTPNotFound()
        image = str(sets[index].get("image_url") or "").replace("\\", "/").lstrip("/")
        root = (DANBOORU_PROJECT_DIR / "data/model_images").resolve()
        path = (DANBOORU_PROJECT_DIR / image).resolve()
        path.relative_to(root)
        if not path.is_file():
            raise web.HTTPNotFound()
        return web.FileResponse(path)
    except (OSError, ValueError):
        raise web.HTTPNotFound()

class DanbooruSearchHub:
    """Display-only search for local tags, character prompts and models."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "show"
    CATEGORY = "utils/lora"

    def show(self):
        return ()

NODE_CLASS_MAPPINGS = {"DanbooruSearchHub": DanbooruSearchHub}
NODE_DISPLAY_NAME_MAPPINGS = {"DanbooruSearchHub": "本地danbooru搜索器"}
WEB_DIRECTORY = "./web"
