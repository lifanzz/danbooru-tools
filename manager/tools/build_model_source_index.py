"""Build the LoRA release-URL index used by the LoRA 发布网址 ComfyUI node.

Only the SafeTensors JSON header is read; tensor weights are never loaded.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
import re
import struct
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen


DEFAULT_LORA_ROOT = Path(os.environ.get("DANBOORU_LORA_ROOT", "models/loras"))
DEFAULT_INDEX_NAME = "lora_source_index.json"
DEFAULT_UNRESOLVED_METADATA_NAME = "loras_without_urls_metadata.json"
DEFAULT_MANUAL_OVERRIDES_PATH = Path(__file__).resolve().parents[1] / "manual_url_overrides.json"
MAX_HEADER_BYTES = 128 * 1024 * 1024
URL_RE = re.compile(r"https?://[^\s\"'<>\\]+", re.IGNORECASE)
CIVITAI_LOOKUP_SITES = ("civitai.red", "civitai.com")
CIVITAI_HASH_API = "https://{}/api/v1/model-versions/by-hash/{}"
PUBLISH_HOSTS = {"civitai.com", "civitai.red", "civitaiarchive.com"}
MAX_HASH_LOOKUP_WORKERS = 12


def walk_strings(value: Any, path: str = "metadata") -> Iterator[tuple[str, str]]:
    if isinstance(value, str):
        yield path, value
    elif isinstance(value, dict):
        for key, child in value.items():
            yield from walk_strings(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from walk_strings(child, f"{path}[{index}]")


def is_publish_url(url: str) -> bool:
    """Only accept the model publishing sites chosen for this library."""
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return False
    return host in PUBLISH_HOSTS or any(host.endswith(f".{domain}") for domain in PUBLISH_HOSTS)


def extract_urls(model_path: Path) -> tuple[list[dict[str, str]], dict[str, Any], str | None]:
    try:
        with model_path.open("rb") as handle:
            raw_size = handle.read(8)
            if len(raw_size) != 8:
                raise ValueError("文件过短，不是有效的 SafeTensors 文件")
            header_size = struct.unpack("<Q", raw_size)[0]
            if not 0 < header_size <= MAX_HEADER_BYTES:
                raise ValueError(f"异常的头长度：{header_size:,} 字节")
            header = json.loads(handle.read(header_size).decode("utf-8"))
        metadata = header.get("__metadata__", {})
        if not isinstance(metadata, dict):
            raise ValueError("__metadata__ 不是 JSON 对象")
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        return [], {}, str(exc)

    seen: set[str] = set()
    urls: list[dict[str, str]] = []
    for key_path, text in walk_strings(metadata):
        for match in URL_RE.findall(text):
            url = match.rstrip(".,;:)]}")
            if url and is_publish_url(url) and url not in seen:
                seen.add(url)
                urls.append({"url": url, "metadata_key": key_path})
    return urls, metadata, None


def civitai_url_from_hash(hash_value: str, timeout: float) -> tuple[str | None, str | None]:
    """Return a Civitai model-version page for a known SafeTensors hash.

    A 404 is a normal result: locally saved models are often not from Civitai,
    were deleted, or have been re-packed so their hash changed.
    """
    errors: list[str] = []
    for site in CIVITAI_LOOKUP_SITES:
        request = Request(
            CIVITAI_HASH_API.format(site, quote(hash_value, safe="")),
            headers={"User-Agent": "ComfyUI-LoRA-Source-Info/1.0"},
        )
        try:
            with urlopen(request, timeout=timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            if exc.code == 404:
                errors.append(f"{site} HTTP 404")
                continue
            errors.append(f"{site} HTTP {exc.code}")
            continue
        except (URLError, TimeoutError, OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            errors.append(f"{site} 查询失败：{exc}")
            continue

        model = payload.get("model") if isinstance(payload, dict) else None
        model_id = payload.get("modelId") if isinstance(payload, dict) else None
        if model_id is None and isinstance(model, dict):
            model_id = model.get("id")
        version_id = payload.get("id") if isinstance(payload, dict) else None
        if model_id is None or version_id is None:
            errors.append(f"{site} 返回的数据不包含模型或版本 ID")
            continue
        return f"https://{site}/models/{model_id}?modelVersionId={version_id}", None

    if errors and all(message.endswith("HTTP 404") for message in errors):
        return None, "Civitai HTTP 404"
    return None, "; ".join(errors) or "Civitai 查询失败"


def file_sha256(model_path: Path) -> str:
    """Calculate the SHA-256 of the actual file bytes, not header metadata."""
    digest = hashlib.sha256()
    with model_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def hash_candidates(model_path: Path) -> list[tuple[str, str]]:
    """Civitai lookup must use the SHA-256 of this exact local file."""
    return [("file_sha256", file_sha256(model_path))]


def lookup_civitai_candidates(candidates: list[tuple[str, str]], timeout: float) -> tuple[str | None, list[dict[str, str]]]:
    """Try a model's hashes in order and return the first matching Civitai URL."""
    checks: list[dict[str, str]] = []
    for metadata_key, hash_value in candidates:
        civitai_url, lookup_error = civitai_url_from_hash(hash_value, timeout)
        check = {"metadata_key": metadata_key, "hash": hash_value}
        if civitai_url:
            check["status"] = "matched"
            check["url"] = civitai_url
            checks.append(check)
            return civitai_url, checks
        check["status"] = "not_found" if lookup_error == "Civitai HTTP 404" else "error"
        check["message"] = lookup_error or "未知错误"
        checks.append(check)
    return None, checks


def write_json_atomically(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=path.parent, suffix=".tmp") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temporary_path = Path(handle.name)
    os.replace(temporary_path, path)


def load_manual_overrides(path: Path) -> dict[str, list[str]]:
    """Load user-maintained URLs; they take priority over automatic results."""
    if not path.is_file():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"人工修正文件读取失败：{path} ({exc})") from exc
    if not isinstance(raw, dict):
        raise ValueError("人工修正文件必须是 {LoRA相对路径: [网址]} 格式的 JSON 对象")

    result: dict[str, list[str]] = {}
    for relative_name, values in raw.items():
        if isinstance(values, str):
            values = [values]
        if not isinstance(relative_name, str) or not isinstance(values, list):
            raise ValueError(f"人工修正格式无效：{relative_name!r}")
        urls = [str(value).strip() for value in values if URL_RE.fullmatch(str(value).strip())]
        if not urls:
            raise ValueError(f"人工修正没有有效 http/https 网址：{relative_name}")
        result[relative_name.replace("\\", "/")] = list(dict.fromkeys(urls))
    return result


def load_existing_entries(index_path: Path) -> dict[str, dict[str, Any]]:
    """Return the previous index so an incremental refresh can reuse URLs."""
    if not index_path.is_file():
        return {}
    try:
        payload = json.loads(index_path.read_text(encoding="utf-8"))
        entries = payload.get("entries", {})
    except (OSError, json.JSONDecodeError):
        return {}
    return entries if isinstance(entries, dict) else {}


def load_existing_unresolved_metadata(path: Path) -> dict[str, dict[str, Any]]:
    """Keep the detailed report for cached 404 entries without rereading their headers."""
    if not path.is_file():
        return {}
    try:
        entries = json.loads(path.read_text(encoding="utf-8")).get("entries", [])
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(entries, list):
        return {}
    return {
        entry["relative_path"]: entry.get("metadata", {})
        for entry in entries
        if isinstance(entry, dict) and isinstance(entry.get("relative_path"), str) and isinstance(entry.get("metadata"), dict)
    }


def needs_red_priority_refresh(entry: dict[str, Any]) -> bool:
    """Upgrade previously indexed civitai.com results to the red-first policy."""
    if entry.get("manual_override"):
        return False
    return any((urlparse(str(url)).hostname or "").lower() == "civitai.com" for url in entry.get("urls", []))


def has_unchanged_not_found(entry: dict[str, Any], stat_result: os.stat_result) -> bool:
    """Reuse a previous Civitai 404 while the exact local file is unchanged."""
    if not isinstance(entry, dict) or entry.get("urls"):
        return False
    if entry.get("size_bytes") != stat_result.st_size or entry.get("modified_at_ns") != stat_result.st_mtime_ns:
        return False
    checks = entry.get("hash_lookup")
    return isinstance(checks, list) and bool(checks) and all(
        isinstance(check, dict) and check.get("status") == "not_found" for check in checks
    )


def build_index(
    lora_root: Path,
    index_path: Path,
    unresolved_metadata_path: Path,
    manual_overrides: dict[str, list[str]],
    offline: bool,
    timeout: float,
    only_missing: bool,
) -> tuple[int, int, int, int, int, int, int]:
    entries: dict[str, dict[str, Any]] = {}
    unresolved_metadata: list[dict[str, Any]] = []
    unresolved_metadata_by_name: dict[str, dict[str, Any]] = {}
    pending_hash_lookups: dict[str, list[tuple[str, str]]] = {}
    existing_entries = load_existing_entries(index_path) if only_missing else {}
    existing_unresolved_metadata = load_existing_unresolved_metadata(unresolved_metadata_path) if only_missing else {}
    scanned = with_urls = failed = hash_checked = hash_matches = manual_applied = reused_urls = 0
    for model_path in sorted(lora_root.rglob("*.safetensors"), key=lambda item: str(item).lower()):
        if not model_path.is_file():
            continue
        scanned += 1
        relative_name = model_path.relative_to(lora_root).as_posix()
        stat_result = model_path.stat()
        manual_urls = manual_overrides.get(relative_name)
        if manual_urls:
            manual_applied += 1
            entries[relative_name] = {
                "urls": manual_urls.copy(),
                "url_metadata": [{"url": url, "metadata_key": "manual_override"} for url in manual_urls],
                "size_bytes": stat_result.st_size,
                "modified_at_ns": stat_result.st_mtime_ns,
                "manual_override": True,
            }
            with_urls += 1
            continue

        existing_entry = existing_entries.get(relative_name)
        if (
            only_missing
            and isinstance(existing_entry, dict)
            and existing_entry.get("urls")
            and not needs_red_priority_refresh(existing_entry)
        ):
            entries[relative_name] = dict(existing_entry)
            entries[relative_name]["size_bytes"] = stat_result.st_size
            entries[relative_name]["modified_at_ns"] = stat_result.st_mtime_ns
            with_urls += 1
            reused_urls += 1
            continue

        if only_missing and has_unchanged_not_found(existing_entry, stat_result):
            entries[relative_name] = dict(existing_entry)
            unresolved_metadata_by_name[relative_name] = existing_unresolved_metadata.get(relative_name, {})
            reused_urls += 1
            continue

        url_details, metadata, error = extract_urls(model_path)
        urls = [item["url"] for item in url_details]
        entries[relative_name] = {
            "urls": urls,
            "url_metadata": url_details,
            "size_bytes": stat_result.st_size,
            "modified_at_ns": stat_result.st_mtime_ns,
        }
        if error:
            entries[relative_name]["error"] = error
            failed += 1
        elif not urls and not offline:
            try:
                candidates = hash_candidates(model_path)
            except OSError as exc:
                entries[relative_name]["hash_lookup"] = [{"status": "error", "message": f"文件 SHA-256 计算失败：{exc}"}]
            else:
                entries[relative_name]["file_sha256"] = candidates[0][1]
                pending_hash_lookups[relative_name] = candidates
        elif not urls and offline:
            entries[relative_name]["hash_lookup"] = [{"status": "skipped", "message": "离线模式"}]
        unresolved_metadata_by_name[relative_name] = metadata

    if pending_hash_lookups:
        with ThreadPoolExecutor(max_workers=min(MAX_HASH_LOOKUP_WORKERS, len(pending_hash_lookups))) as executor:
            futures = {
                executor.submit(lookup_civitai_candidates, candidates, timeout): relative_name
                for relative_name, candidates in pending_hash_lookups.items()
            }
            for future in as_completed(futures):
                relative_name = futures[future]
                try:
                    civitai_url, checks = future.result()
                except Exception as exc:
                    civitai_url, checks = None, [{"status": "error", "message": f"Civitai 查询异常：{exc}"}]
                hash_checked += len(checks)
                entry = entries[relative_name]
                if checks:
                    entry["hash_lookup"] = checks
                if civitai_url:
                    entry["urls"] = [civitai_url]
                    entry["url_metadata"] = [{"url": civitai_url, "metadata_key": "civitai.by_hash"}]
                    hash_matches += 1

    for relative_name, metadata in unresolved_metadata_by_name.items():
        entry = entries[relative_name]
        if entry.get("urls"):
            with_urls += 1
            continue
        # Keep the complete original metadata only in this separate report,
        # so the fast UI index remains compact.
        report_entry = {
            "relative_path": relative_name,
            "size_bytes": entry["size_bytes"],
            "hash_lookup": entry.get("hash_lookup", []),
            "metadata": metadata,
        }
        if entry.get("error"):
            report_entry["read_error"] = entry["error"]
        elif not metadata:
            report_entry["metadata_status"] = "empty"
        unresolved_metadata.append(report_entry)

    payload = {
        "format": "comfyui-lora-source-index",
        "version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "lora_root": str(lora_root),
        "entries": entries,
    }
    unresolved_payload = {
        "format": "comfyui-lora-unresolved-metadata",
        "version": 1,
        "generated_at": payload["generated_at"],
        "lora_root": str(lora_root),
        "description": "Only LoRAs with no metadata URL and no successful Civitai hash lookup.",
        "entries": unresolved_metadata,
    }
    write_json_atomically(index_path, payload)
    write_json_atomically(unresolved_metadata_path, unresolved_payload)
    return scanned, with_urls, failed, hash_checked, hash_matches, len(unresolved_metadata), manual_applied, reused_urls


def main() -> int:
    parser = argparse.ArgumentParser(description="递归索引 LoRA SafeTensors 元数据中的发布网址。")
    parser.add_argument("lora_root", nargs="?", type=Path, default=DEFAULT_LORA_ROOT)
    parser.add_argument("--index", type=Path, help="输出索引路径（默认：LoRA 根目录/lora_source_index.json）")
    parser.add_argument(
        "--unresolved-metadata",
        type=Path,
        help="未找到网址的完整元数据报告路径（默认：LoRA 根目录/loras_without_urls_metadata.json）",
    )
    parser.add_argument(
        "--manual-overrides",
        type=Path,
        default=DEFAULT_MANUAL_OVERRIDES_PATH,
        help="人工网址修正 JSON（默认：custom_nodes/comfyui-lora-source-info/manual_url_overrides.json）",
    )
    parser.add_argument("--offline", action="store_true", help="只读取元数据，不请求 Civitai 哈希接口")
    parser.add_argument("--timeout", type=float, default=3.0, help="每个 Civitai 查询的超时秒数（默认：3）")
    parser.add_argument(
        "--only-missing",
        action="store_true",
        help="复用已有网址和人工修正，只重新查询仍未找到网址的 LoRA",
    )
    args = parser.parse_args()
    lora_root = args.lora_root.expanduser().resolve()
    index_path = (args.index or lora_root / DEFAULT_INDEX_NAME).expanduser().resolve()
    unresolved_metadata_path = (
        args.unresolved_metadata or lora_root / DEFAULT_UNRESOLVED_METADATA_NAME
    ).expanduser().resolve()
    manual_overrides_path = args.manual_overrides.expanduser().resolve()
    if not lora_root.is_dir():
        parser.error(f"LoRA 文件夹不存在：{lora_root}")
    if args.timeout <= 0:
        parser.error("--timeout 必须大于 0")
    manual_overrides = load_manual_overrides(manual_overrides_path)
    scanned, with_urls, failed, hash_checked, hash_matches, unresolved_count, manual_applied, reused_urls = build_index(
        lora_root, index_path, unresolved_metadata_path, manual_overrides, args.offline, args.timeout, args.only_missing
    )
    print(f"索引已写入：{index_path}")
    print(f"扫描 SafeTensors：{scanned}；含网址：{with_urls}；读取失败：{failed}")
    print(f"人工网址修正：{manual_applied} / {len(manual_overrides)} 条已应用")
    if args.only_missing:
        print(f"复用之前已找到的网址：{reused_urls} 条")
    if args.offline:
        print("Civitai 哈希查询：已跳过（离线模式）")
    else:
        print(f"Civitai 哈希查询：{hash_checked}；命中：{hash_matches}")
    print(f"未找到网址的完整元数据：{unresolved_metadata_path}（{unresolved_count} 个）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
