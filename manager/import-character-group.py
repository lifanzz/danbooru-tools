"""Import a verified character group through the unified catalogue store.

Input JSON: {"group": {"id": "...", "name_cn": "..."}, "tags": [...]}.
Does not research spellings or modify the general-tag catalogue.
"""
import argparse
from datetime import datetime
from catalogue_store import transaction, safe_path, read_json, CatalogueError


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('input', help='UTF-8 JSON containing group and tags')
    args = parser.parse_args()
    incoming = read_json(args.input)
    definition = incoming['group']
    gid, name = str(definition['id']).strip(), str(definition['name_cn']).strip()
    records = incoming['tags']
    if not gid or not name or not isinstance(records, list):
        raise CatalogueError('Invalid input group/tags')
    if any(not isinstance(t, dict) or not t.get('name') for t in records):
        raise CatalogueError('Every character record requires name')
    if len({t['name'] for t in records}) != len(records):
        raise CatalogueError('Duplicate character names in input')
    with transaction() as catalogue:
        group = next((g for g in catalogue.groups if g['id'] == gid), None)
        if group is None:
            if any(g['name_cn'] == name for g in catalogue.groups):
                raise CatalogueError('Group name already exists')
            group = {'id':gid, 'name_cn':name, 'name_en':gid, 'library':'character',
                     'search_enabled':True, 'categories':[], 'content_file':f'data/translated/{gid}.json'}
            catalogue.groups.append(group)
            catalogue.extra[safe_path(group['content_file'])] = {'group_name':gid, 'display_name':name, 'tags':[]}
        content = catalogue.character_data(group)
        catalogue.extra[safe_path(f'data_backup/character-import/{datetime.now():%Y%m%d-%H%M%S-%f}-{gid}.json')] = read_json(safe_path(group['content_file'])) if safe_path(group['content_file']).exists() else {'tags':[]}
        by_name = {t['name']:t for t in content['tags']}
        added = 0
        for source in records:
            target = by_name.get(source['name'])
            if target is None:
                target = dict(source)
                content['tags'].append(target)
                by_name[target['name']] = target
                added += 1
            else:
                target.update(source)
            target['groups'] = [gid]
            target['groups_cn'] = [group['name_cn']]
        content['total_tags'] = len(content['tags'])
    print(f'Imported {len(records)} character records; added {added}.')


if __name__ == '__main__':
    main()
