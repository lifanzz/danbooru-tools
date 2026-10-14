"""Tag CRUD: general tags have exactly one persisted record."""
from catalogue_store import endpoint, CatalogueError, is_character, safe_path


@endpoint
def handle_add_tag(catalogue, data):
    name = str(data.get('name') or '').strip()
    if not name:
        raise CatalogueError('Tag name is required')
    original = str(data.get('original_name') or name).strip()
    tag = next((t for t in catalogue.tags if t['name'] == original), None)
    updated = tag is not None
    if any(t['name'].casefold() == name.casefold() and t is not tag for t in catalogue.tags):
        raise CatalogueError('该标签名已存在', 409)
    if data.get('original_name') and tag is None:
        raise CatalogueError('原标签不存在', 404)
    groups = data.get('groups', [])
    if not isinstance(groups, list) or not all(isinstance(g, str) for g in groups):
        raise CatalogueError('groups must be a list of group IDs')
    groups = list(dict.fromkeys(groups))
    for gid in groups:
        catalogue.group(gid, general=True)
    if tag is None:
        tag = {'name': name, 'category_by_group': {}}
        catalogue.tags.append(tag)
    tag.update({
        'name': name,
        'tag_cn': str(data.get('tag_cn') or ''),
        'confidence': str(data.get('confidence') or '').upper(),
        'tag_cn_long': str(data.get('tag_cn_long') or ''),
        'groups': groups,
        'wiki_url': str(data.get('wiki_url') or ''),
        'wiki_exists': bool(data.get('wiki_url')),
        'pinned': bool(data.get('pinned', tag.get('pinned', False))),
    })
    categories = tag.setdefault('category_by_group', {})
    category_group = str(data.get('category_group_id') or '')
    if category_group and category_group in groups:
        path = str(data.get('category_path') or '').strip()
        if path:
            categories[category_group] = path
        else:
            categories.pop(category_group, None)
    tag.pop('category_path', None)
    return {'updated': updated, 'name': name}


@endpoint
def handle_rename_tag(catalogue, data):
    old, new = str(data.get('old_name') or '').strip(), str(data.get('new_name') or '').strip()
    if not new:
        raise CatalogueError('New name is required')
    tag = catalogue.tag(old)
    if any(t is not tag and t['name'].casefold() == new.casefold() for t in catalogue.tags):
        raise CatalogueError('该标签名已存在', 409)
    tag['name'] = new
    return {'old_name': old, 'new_name': new}


def delete_names(catalogue, names):
    requested = set(names)
    found = {t['name'] for t in catalogue.tags if t['name'] in requested}
    catalogue.tags = [t for t in catalogue.tags if t['name'] not in requested]
    # Character cards can exist only in character files. Full deletion keeps
    # the established behaviour of removing all owning character copies.
    changed = 0
    for group in catalogue.groups:
        if not is_character(group):
            continue
        content = catalogue.character_data(group)
        before = content.get('tags', [])
        found.update(t['name'] for t in before if t.get('name') in requested)
        kept = [t for t in before if t.get('name') not in requested]
        if len(kept) != len(before):
            content['tags'] = kept
            content['total_tags'] = len(kept)
            changed += 1
        else:
            catalogue.extra.pop(safe_path(group['content_file']))
    missing = requested - found
    if missing:
        raise CatalogueError('部分标签已不存在，请刷新后重试', 404)
    return changed


@endpoint
def handle_delete_tag(catalogue, data):
    name = str(data.get('name') or '').strip()
    changed = delete_names(catalogue, [name])
    return {'deleted': name, 'updated_files': changed}


@endpoint
def handle_delete_tags(catalogue, data):
    names = data.get('names')
    if not isinstance(names, list) or not names or any(not isinstance(name, str) or not name.strip() for name in names):
        raise CatalogueError('请选择要删除的标签')
    names = list(dict.fromkeys(name.strip() for name in names))
    changed = delete_names(catalogue, names)
    return {'deleted_count': len(names), 'updated_files': changed}


@endpoint
def handle_toggle_tag_pin(catalogue, data):
    name, pinned = str(data.get('name') or ''), data.get('pinned')
    if not isinstance(pinned, bool):
        raise CatalogueError('pinned must be boolean')
    tag = next((t for t in catalogue.tags if t['name'] == name), None)
    if tag is not None:
        tag['pinned'] = pinned
    else:
        found = False
        for group in catalogue.groups:
            if not is_character(group):
                continue
            content = catalogue.character_data(group)
            matches = [t for t in content.get('tags', []) if t.get('name') == name]
            for card in matches:
                card['pinned'] = pinned
                found = True
            if not matches:
                catalogue.extra.pop(safe_path(group['content_file']))
        if not found:
            raise CatalogueError('Tag not found', 404)
    return {'name': name, 'pinned': pinned}


@endpoint
def handle_upsert_character_preset(catalogue, data):
    prompt = str(data.get('prompt') or '').strip()
    title = str(data.get('tag_cn') or '').strip()
    original = str(data.get('original_name') or '').strip()
    group_id = str(data.get('group_id') or '')
    group = next((g for g in catalogue.groups if g['id'] == group_id), None)
    if group is None or not is_character(group):
        # 未手动选分组的新角色卡默认落入固定“未分类”，不再报错。
        group = catalogue.ungrouped()
    if not prompt or not title:
        raise CatalogueError('请输入角色名称和完整提示词')
    content = catalogue.character_data(group)
    tags = content.setdefault('tags', [])
    card = next((t for t in tags if t.get('name') == original), None)
    if original and card is None:
        raise CatalogueError('原角色卡不存在', 404)
    updated = card is not None
    if card is None:
        if any(t.get('name') == prompt for t in tags):
            raise CatalogueError('该角色预设已存在', 409)
        card = {'name': prompt}
        tags.append(card)
    card.update({
        'tag_cn': title, 'prompt': prompt,
        'tag_cn_long': str(data.get('tag_cn_long') or '').strip(),
        'groups': [group['id']], 'groups_cn': [group['name_cn']],
        'category_path': str(data.get('category_path') or '__uncategorized__'),
        'wiki_exists': False, 'wiki_url': '',
    })
    content['total_tags'] = len(tags)
    return {'updated': updated, 'name': card['name']}
