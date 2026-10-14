"""Canonical category labels, duplicate merging and the last unclassified bucket."""
import re

UNCATEGORIZED_PATH = '__uncategorized__'


def label(category):
    return str(category.get('name_cn') or category.get('h5') or category.get('h4') or category['path']).strip()


def is_uncategorized(category, group=None):
    cn = label(category)
    en = str(category.get('name_en') or category.get('h5') or category.get('h4') or category['path']).strip().casefold()
    return (category.get('is_uncategorized') is True or category['path'] == UNCATEGORIZED_PATH
            or cn in {'未分类', '另见', '全部', '通用', '简介', '主要分类', '相关标签', '相关标签分组', '外部链接', '背景相关', '食物相关图集', '角色预设'}
            or cn.startswith(('其他', '其它', '更多'))
            or en in {'uncategorized', 'ungrouped', 'all', 'main', 'general', 'about', 'external links', 'background related', 'food-related pools'}
            or bool(re.match(r'^(other|miscellaneous|misc|more|related|see also)\b', en))
            or bool(group and group.get('library') == 'character' and
                    (cn == group['name_cn'] or en.endswith('/ characters'))))


def normalize_categories(categories, group=None):
    """Return ordered metadata and old-to-new paths; never discard record content."""
    result, by_label, paths = [], {}, {'': UNCATEGORIZED_PATH}
    for original in categories:
        category = dict(original)
        old_path = category['path']
        if is_uncategorized(category, group):
            paths[old_path] = UNCATEGORIZED_PATH
            continue
        name = re.sub(r'^按身体部位\s*[:：]\s*', '', label(category))
        key = re.sub(r'\s+', '', name).casefold().replace('其它', '其他')
        if key in by_label:
            paths[old_path] = by_label[key]['path']
            continue
        category['name_cn'] = name
        category.setdefault('name_en', category.get('h5') or category.get('h4') or old_path)
        category.pop('is_uncategorized', None)
        result.append(category)
        by_label[key] = category
        paths[old_path] = old_path
    result.append({'path': UNCATEGORIZED_PATH, 'h4': 'Uncategorized', 'h5': None,
                   'name_cn': '未分类', 'name_en': 'Uncategorized', 'is_uncategorized': True})
    paths[UNCATEGORIZED_PATH] = UNCATEGORIZED_PATH
    return result, paths
