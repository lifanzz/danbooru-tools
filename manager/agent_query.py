#!/usr/bin/env python3
"""Read-only, browser-free query tool for the local Danbooru prompt manager.

It reads the manager's JSON catalogue directly.  It never starts the HTTP
server and never writes to the catalogue.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"


def configure_utf8_console() -> None:
    """Keep Chinese results readable in a normal Windows terminal."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except AttributeError:
            pass


def read_json(path: Path, fallback: Any) -> Any:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"Warning: skipped unreadable JSON: {path} ({exc})", file=sys.stderr)
        return fallback


def text(value: Any) -> str:
    if isinstance(value, list):
        return " ".join(text(item) for item in value)
    if isinstance(value, dict):
        return " ".join(f"{key} {text(item)}" for key, item in value.items())
    return "" if value is None else str(value)


def compact(value: Any) -> str:
    """One-line output while retaining useful prompt detail."""
    return " ".join(text(value).split())


def tag_records() -> Iterable[dict[str, Any]]:
    groups = {g['id']: g for g in read_json(DATA / 'groups.json', [])}
    for item in read_json(DATA / "tags.json", []):
        if not isinstance(item, dict):
            continue
        yield {
            "kind": "tag",
            "source": "data/tags.json",
            "name": item.get("name", ""),
            "name_cn": item.get("tag_cn", ""),
            "description": item.get("tag_cn_long", ""),
            "groups": item.get("groups", []),
            "groups_cn": [groups.get(gid, {}).get('name_cn', gid) for gid in item.get('groups', [])],
            "category": item.get("category_by_group", {}),
            "pinned": bool(item.get("pinned", False)),
            "wiki_url": item.get("wiki_url", ""),
        }


def preset_records() -> Iterable[dict[str, Any]]:
    groups = read_json(DATA / 'groups.json', [])
    for metadata in groups:
        if metadata.get('library') != 'character':
            continue
        path = ROOT / metadata['content_file']
        group = read_json(path, {})
        if not isinstance(group, dict):
            continue
        for item in group.get("tags", []):
            if not isinstance(item, dict) or not item.get("prompt"):
                continue
            yield {
                "kind": "preset",
                "source": f"data/translated/{path.name}",
                "group_id": group.get("group_name", ""),
                "group_name": metadata.get("name_cn", ""),
                "name": item.get("name", ""),
                "name_cn": item.get("tag_cn", ""),
                "description": item.get("tag_cn_long", ""),
                "prompt": item.get("prompt", ""),
                "groups": item.get("groups", []),
                "groups_cn": [metadata['name_cn']],
                "category": item.get("category_path", ""),
                "pinned": bool(item.get("pinned", False)),
                "wiki_url": item.get("wiki_url", ""),
            }


def model_records() -> Iterable[dict[str, Any]]:
    for item in read_json(DATA / "models.json", []):
        if not isinstance(item, dict):
            continue
        yield {
            "kind": "model",
            "source": "data/models.json",
            "id": item.get("id", ""),
            "name": item.get("name", ""),
            "category": item.get("category", ""),
            "file_path": item.get("file_path", ""),
            "prompt": item.get("prompt", ""),
            "recommended_params": item.get("recommended_params", ""),
            "url": item.get("url", ""),
        }


def match_score(record: dict[str, Any], query: str, exact: bool) -> int | None:
    query = query.casefold().strip()
    if not query:
        return 0
    name = text(record.get("name")).casefold()
    name_cn = text(record.get("name_cn")).casefold()
    prompt = text(record.get("prompt")).casefold()
    searchable = " ".join(text(value).casefold() for value in record.values())
    if exact:
        return 0 if query in (name, name_cn) else None
    if query == name or query == name_cn:
        return 100
    if query in name or query in name_cn:
        return 80
    if query in prompt:
        return 60
    if query in searchable:
        return 40
    return None


def format_text(records: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for index, record in enumerate(records, start=1):
        title = record.get("name") or record.get("id") or "(unnamed)"
        chinese = record.get("name_cn")
        if chinese:
            title = f"{title} | {chinese}"
        lines.append(f"[{index}] {record['kind'].upper()}  {title}")
        for label, key in (
            ("分组", "group_name"),
            ("分类", "category"),
            ("提示词", "prompt"),
            ("说明", "description"),
            ("推荐参数", "recommended_params"),
            ("模型文件", "file_path"),
            ("来源", "source"),
        ):
            value = compact(record.get(key, ""))
            if value:
                lines.append(f"  {label}: {value}")
        groups = compact(record.get("groups_cn", []))
        if groups:
            lines.append(f"  标签分组: {groups}")
        if record.get("pinned"):
            lines.append("  已置顶: true")
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Query the local Danbooru prompt manager without a browser or server."
    )
    parser.add_argument("query", nargs="?", help="Chinese, English, tag, prompt, or model search text")
    parser.add_argument(
        "--kind", choices=("all", "tag", "preset", "model"), default="all",
        help="Catalogue to query (default: all)",
    )
    parser.add_argument("--group", help="Filter tag/preset records by group ID or name")
    parser.add_argument("--exact", action="store_true", help="Match query exactly against English or Chinese name")
    parser.add_argument("--limit", type=int, default=20, help="Maximum results (default: 20)")
    parser.add_argument("--format", choices=("text", "json"), default="text", help="Output format")
    parser.add_argument("--stats", action="store_true", help="Print local catalogue counts and exit")
    return parser.parse_args()


def main() -> int:
    configure_utf8_console()
    args = parse_args()
    if args.limit < 1:
        print("--limit must be at least 1", file=sys.stderr)
        return 2

    sources = {
        "tag": tag_records,
        "preset": preset_records,
        "model": model_records,
    }
    wanted = tuple(sources) if args.kind == "all" else (args.kind,)
    records = [record for kind in wanted for record in sources[kind]()]

    if args.stats:
        counts = {kind: sum(1 for record in records if record["kind"] == kind) for kind in wanted}
        counts["total"] = len(records)
        print(json.dumps(counts, ensure_ascii=False, indent=2))
        return 0
    if not args.query:
        print("query is required unless --stats is used", file=sys.stderr)
        return 2

    group_query = (args.group or "").casefold()
    ranked: list[tuple[int, dict[str, Any]]] = []
    for record in records:
        if group_query and record["kind"] in ("preset", "tag"):
            group_text = " ".join(
                text(record.get(key, "")).casefold()
                for key in ("group_id", "group_name", "groups", "groups_cn")
            )
            if group_query not in group_text:
                continue
        elif group_query and record["kind"] != "preset":
            continue
        score = match_score(record, args.query, args.exact)
        if score is not None:
            ranked.append((score, record))
    ranked.sort(key=lambda pair: (-pair[0], not pair[1].get("pinned", False), pair[1].get("name", "").casefold()))
    results = [record for _, record in ranked[:args.limit]]

    if args.format == "json":
        print(json.dumps({"query": args.query, "count": len(results), "results": results}, ensure_ascii=False, indent=2))
    elif results:
        print(format_text(results))
        print(f"\nReturned {len(results)} result(s).")
    else:
        print("No local matches.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
