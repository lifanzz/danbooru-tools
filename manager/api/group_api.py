"""Unified group management. There is no built-in/custom routing."""
from pathlib import Path
import uuid
from catalogue_store import endpoint, CatalogueError, is_character, safe_path
from utils import generate_group_id
from category_rules import normalize_categories


def require_unique_name(catalogue, name, exclude=None):
    if not name:
        raise CatalogueError('请输入分组名称')
    if any(g['id'] != exclude and g['name_cn'] == name for g in catalogue.groups):
        raise CatalogueError('分组名称已存在', 409)


@endpoint
def handle_create_group(catalogue, data):
    name = str(data.get('name_cn') or '').strip()
    require_unique_name(catalogue, name)
    library = data.get('library', 'general')
    if library not in ('general', 'character'):
        raise CatalogueError('Invalid library')
    gid = generate_group_id(name)
    group = {'id': gid, 'name_cn': name, 'name_en': gid, 'library': library,
             'search_enabled': True, 'categories': normalize_categories([])[0]}
    if library == 'character':
        group['content_file'] = f'data/translated/{gid}.json'
        catalogue.extra[safe_path(group['content_file'])] = {
            'group_name': gid, 'display_name': name, 'tags': [], 'categories': group['categories'], 'total_tags': 0}
    catalogue.groups.append(group)
    return {'group': group}


@endpoint
def handle_delete_group(catalogue, data):
    group = catalogue.group(str(data.get('id') or ''))
    if is_character(group):
        if group['id'] == 'character_ungrouped':
            raise CatalogueError('未分类分组是角色卡的默认归宿，不能删除；请改用批量移动把卡片移走')
        content = catalogue.character_data(group)
        # Preserve cards from a deleted group in the fixed 未分类 bucket.
        if content.get('tags'):
            orphan = catalogue.ungrouped()
            destination = catalogue.character_data(orphan)
            used = {t['name'] for t in destination['tags']}
            for entry in content['tags']:
                card = dict(entry)
                base = card['name']
                suffix = 2
                while card['name'] in used:
                    card['name'] = f'{base}__{group["id"]}_{suffix}'
                    suffix += 1
                used.add(card['name'])
                card['groups'] = ['character_ungrouped']
                card['groups_cn'] = [orphan['name_cn']]
                destination['tags'].append(card)
            destination['total_tags'] = len(destination['tags'])
        path = safe_path(group['content_file'])
        catalogue.extra.pop(path)
        catalogue.deletes.append(path)
    catalogue.groups.remove(group)
    for tag in catalogue.tags:
        tag['groups'] = [gid for gid in tag.get('groups', []) if gid != group['id']]
        tag.get('category_by_group', {}).pop(group['id'], None)
    return {}


@endpoint
def handle_rename_group(catalogue, data):
    group = catalogue.group(str(data.get('id') or ''))
    name = str(data.get('new_name_cn') or '').strip()
    require_unique_name(catalogue, name, group['id'])
    group['name_cn'] = name
    if is_character(group):
        content = catalogue.character_data(group)
        content['display_name'] = name
        for card in content.get('tags', []):
            if group['id'] in card.get('groups', []):
                card['groups_cn'] = [catalogue.group(gid)['name_cn'] for gid in card['groups']]
    return {'new_name_cn': name}


@endpoint
def handle_update_group(catalogue, data):
    group = catalogue.group(str(data.get('id') or ''))
    name_cn = str(data.get('name_cn') or '').strip()
    name_en = str(data.get('name_en') or '').strip()
    require_unique_name(catalogue, name_cn, group['id'])
    if not name_en:
        raise CatalogueError('请输入分组英文名')
    rows = data.get('categories')
    if not isinstance(rows, list):
        raise CatalogueError('二级分组格式无效')
    if data.get('expected_categories') != group.get('categories', []) or data.get('expected_name_cn') != group['name_cn'] or data.get('expected_name_en') != group.get('name_en', ''):
        raise CatalogueError('分组已被其他操作修改，请关闭后重新打开编辑', 409)
    previous = {c['path']: c for c in group.get('categories', [])}
    if is_character(group):
        existing_content = catalogue.character_data(group)
        existing_paths = {t.get('category_path', '') for t in existing_content.get('tags', [])}
    else:
        existing_paths = {t.get('category_by_group', {}).get(group['id'], '') for t in catalogue.tags}
    for path in existing_paths - {''}:
        previous.setdefault(path, {'path': path, 'h4': path, 'h5': None})
    categories, used = [], set()
    for row in rows:
        if not isinstance(row, dict) or not all(isinstance(row.get(key), str) and row[key].strip() for key in ('name_cn', 'name_en')):
            raise CatalogueError('每个二级分组都需要中文名和英文名')
        path = row.get('path')
        if path is not None and (not isinstance(path, str) or path not in previous):
            raise CatalogueError('二级分组不存在，请重新打开编辑')
        path = path or ('category_' + uuid.uuid4().hex[:12])
        if path in used:
            raise CatalogueError('二级分组不能重复')
        used.add(path)
        category = dict(previous.get(path, {'path': path, 'h4': row['name_en'].strip(), 'h5': None}))
        category.update(name_cn=row['name_cn'].strip(), name_en=row['name_en'].strip())
        categories.append(category)
    categories, path_map = normalize_categories(categories, group)
    used = {c['path'] for c in categories}
    removed = set(previous) - used
    group.update(name_cn=name_cn, name_en=name_en, categories=categories)
    if 'display_name' in group:
        group['display_name'] = name_cn
    if is_character(group):
        content = catalogue.character_data(group)
        content.update(display_name=name_cn, categories=categories)
        for card in content.get('tags', []):
            card['groups_cn'] = [catalogue.group(gid)['name_cn'] for gid in card.get('groups', [group['id']])]
            path = card.get('category_path', '')
            if path in path_map:
                card['category_path'] = path_map[path]
            elif path in removed:
                card['category_path'] = '__uncategorized__'
    else:
        for tag in catalogue.tags:
            if group['id'] in tag.get('groups', []):
                path = tag.get('category_by_group', {}).get(group['id'], '')
                if path in path_map:
                    tag.setdefault('category_by_group', {})[group['id']] = path_map[path]
                elif path in removed:
                    tag['category_by_group'][group['id']] = '__uncategorized__'
    return {'group': group}


@endpoint
def handle_reorder_categories(catalogue, data):
    group = catalogue.group(str(data.get('id') or ''))
    categories = group.get('categories', [])
    current = [c['path'] for c in categories]
    paths = data.get('paths')
    if not isinstance(paths, list) or not all(isinstance(path, str) for path in paths) or len(paths) != len(set(paths)) or set(paths) != set(current):
        raise CatalogueError('分类列表已变化，请刷新后重试', 409)
    if data.get('expected_paths') != current:
        raise CatalogueError('分类顺序已被其他操作修改，请刷新后重试', 409)
    lookup = {c['path']: c for c in categories}
    ordered = [lookup[path] for path in paths if path != '__uncategorized__']
    if '__uncategorized__' in lookup:
        ordered.append(lookup['__uncategorized__'])
    group['categories'] = ordered
    if is_character(group):
        catalogue.character_data(group)['categories'] = ordered
    return {'id': group['id'], 'categories': ordered}


@endpoint
def handle_move_tags_to_category(catalogue, data):
    group = catalogue.group(str(data.get('group_id') or ''))
    names = selected_names(catalogue, data)
    path = data.get('category_path')
    if not isinstance(path, str) or not any(c['path'] == path for c in group.get('categories', [])):
        raise CatalogueError('目标二级分组不存在，请重新选择')
    if is_character(group):
        content = catalogue.character_data(group)
        wanted = set(names)
        cards = [t for t in content.get('tags', []) if t.get('name') in wanted]
        if {t['name'] for t in cards} != wanted:
            raise CatalogueError('部分角色卡不在所选分组中，请重新选择', 409)
        for card in cards:
            card['category_path'] = path
    else:
        tags = [catalogue.tag(name) for name in names]
        if any(group['id'] not in tag.get('groups', []) for tag in tags):
            raise CatalogueError('部分标签不在所选分组中，请重新选择', 409)
        for tag in tags:
            tag.setdefault('category_by_group', {})[group['id']] = path
    return {'moved': len(names), 'group_id': group['id'], 'category_path': path}


@endpoint
def handle_toggle_group_search(catalogue, data):
    group = catalogue.group(str(data.get('id') or ''))
    enabled = data.get('search_enabled')
    if not isinstance(enabled, bool):
        raise CatalogueError('search_enabled must be boolean')
    group['search_enabled'] = enabled
    return {'id': group['id'], 'search_enabled': enabled}


def selected_names(catalogue, data):
    names = data.get('tag_names', [])
    if not isinstance(names, list) or not names or not all(isinstance(n, str) for n in names):
        raise CatalogueError('请选择标签')
    return list(dict.fromkeys(names))


def find_character_cards(catalogue, names):
    """Map each requested name to its first card copy across character files.

    Returns (found, scanned_paths).  Every scanned file is registered in
    catalogue.extra; the caller must pop the paths it did not actually modify
    so unchanged files are not rewritten.
    """
    wanted = set(names)
    found = {}
    scanned = set()
    for group in catalogue.groups:
        if not is_character(group):
            continue
        content = catalogue.character_data(group)
        scanned.add(safe_path(group['content_file']))
        for card in content.get('tags', []):
            name = card.get('name')
            if name in wanted and name not in found:
                found[name] = card
    return found, scanned


def reject_library_mix(catalogue, names, character_target):
    """General tags and character cards may never share one batch target."""
    general = [n for n in names if next((t for t in catalogue.tags if t['name'] == n), None) is not None]
    if character_target and general:
        raise CatalogueError('通用标签不能加入角色卡分组')
    if not character_target and len(general) != len(names):
        raise CatalogueError('角色卡不能加入通用标签分组')


@endpoint
def handle_add_tags_to_group(catalogue, data):
    group = catalogue.group(str(data.get('group_id') or ''))
    names = selected_names(catalogue, data)
    if is_character(group):
        reject_library_mix(catalogue, names, character_target=True)
        cards, scanned = find_character_cards(catalogue, names)
        missing = [n for n in names if n not in cards]
        if missing:
            raise CatalogueError(f"角色卡 '{missing[0]}' 不存在", 404)
        content = catalogue.character_data(group)
        tags = content.setdefault('tags', [])
        existing = {t.get('name') for t in tags}
        added = 0
        for name in names:
            if name in existing:
                continue
            card = dict(cards[name])
            card['groups'] = [group['id']]
            card['groups_cn'] = [group['name_cn']]
            tags.append(card)
            existing.add(name)
            added += 1
        target_path = safe_path(group['content_file'])
        if added:
            content['total_tags'] = len(tags)
            scanned.discard(target_path)
        for path in scanned:
            catalogue.extra.pop(path, None)
        return {'added': added, 'processed': len(names)}
    catalogue.group(group['id'], general=True)
    reject_library_mix(catalogue, names, character_target=False)
    tags = [catalogue.tag(name) for name in names]
    added = 0
    for tag in tags:
        if group['id'] not in tag.get('groups', []):
            tag.setdefault('groups', []).append(group['id'])
            added += 1
    return {'added': added, 'processed': len(tags)}


@endpoint
def handle_remove_tag_from_group(catalogue, data):
    group = catalogue.group(str(data.get('group_id') or ''), general=True)
    tag = catalogue.tag(str(data.get('tag_name') or ''))
    before = tag.get('groups', [])
    tag['groups'] = [gid for gid in before if gid != group['id']]
    tag.get('category_by_group', {}).pop(group['id'], None)
    return {'removed': len(before) != len(tag['groups'])}


@endpoint
def handle_move_tags_to_group(catalogue, data):
    names = selected_names(catalogue, data)
    raw = data.get('groups', [])
    if not isinstance(raw, list) or not raw:
        raise CatalogueError('请选择目标分组')
    ids = list(dict.fromkeys(str(g.get('id') or '') for g in raw))
    targets = [catalogue.group(gid) for gid in ids]
    to_character = [is_character(g) for g in targets]
    if not all(flag == to_character[0] for flag in to_character):
        raise CatalogueError('通用分组与角色分组不能混选')
    if to_character[0]:
        reject_library_mix(catalogue, names, character_target=True)
        cards, scanned = find_character_cards(catalogue, names)
        missing = [n for n in names if n not in cards]
        if missing:
            raise CatalogueError(f"角色卡 '{missing[0]}' 不存在", 404)
        modified = set()
        wanted = set(names)
        # “移动”意味着只属于勾选分组：先从每个角色文件移除全部同名副本。
        for group in catalogue.groups:
            if not is_character(group):
                continue
            content = catalogue.character_data(group)
            before = content.get('tags', [])
            kept = [t for t in before if t.get('name') not in wanted]
            if len(kept) != len(before):
                content['tags'] = kept
                content['total_tags'] = len(kept)
                modified.add(safe_path(group['content_file']))
        for group in targets:
            content = catalogue.character_data(group)
            tags = content.setdefault('tags', [])
            existing = {t.get('name') for t in tags}
            for name in names:
                if name in existing:
                    continue
                card = dict(cards[name])
                card['groups'] = [group['id']]
                card['groups_cn'] = [group['name_cn']]
                tags.append(card)
                existing.add(name)
            content['total_tags'] = len(tags)
            modified.add(safe_path(group['content_file']))
        for path in scanned - modified:
            catalogue.extra.pop(path, None)
        return {'moved': len(names), 'groups': ids}
    for gid in ids:
        catalogue.group(gid, general=True)
    reject_library_mix(catalogue, names, character_target=False)
    tags = [catalogue.tag(name) for name in names]
    for tag in tags:
        tag['groups'] = list(ids)
    return {'moved': len(tags), 'groups': ids}
