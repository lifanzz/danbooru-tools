/* Danbooru 标签管理器 — shared runtime + general-tag / character-library views.
   Model management lives in model-library.js; search rules in search-engine.js. */

const DATA_DIR = 'data';
var displaySettings = { group_language: 'zh', category_language: 'zh', unrated_confidence: 'D' };
function groupDisplayName(group) {
  return (displaySettings.group_language === 'en' ? group.name_en : group.name_cn) || group.name_cn || group.id;
}
function groupNameMarkup(cn, en) {
  return '<div class="group-name"><span class="cn">' + escapeHtml(displaySettings.group_language === 'en' ? en : cn) + '</span></div>';
}
function categoryDisplayName(category) {
  return (displaySettings.category_language === 'en' ? category.name_en : category.name_cn) || category.h5 || category.h4 || category.path;
}
function orderCategories(categories) {
  return categories.slice().sort(function(a, b) {
    return Number(a.path === '__uncategorized__' || a.is_uncategorized === true) - Number(b.path === '__uncategorized__' || b.is_uncategorized === true);
  });
}
function categoryDisplayPath(path, groupId) {
  var group = state.groups.find(function(g) { return g.id === (groupId || state.currentGroup); });
  var category = group && (group.categories || []).find(function(c) { return c.path === path; });
  return category ? categoryDisplayName(category) : path;
}

// Each half needs room for the enlarged selection target and action buttons.
var DUAL_COL_THRESHOLD = 1400;

function isDualColumn() {
  var container = document.getElementById('tableContainer');
  return (container ? container.clientWidth : window.innerWidth) >= DUAL_COL_THRESHOLD;
}

// Dynamic page size: measure actual DOM heights to fit exactly within visible area
function getPageSize() {
  var dual = isDualColumn();
  var tableContainer = document.getElementById('tableContainer');

  if (!tableContainer || tableContainer.offsetHeight === 0) {
    var availH = window.innerHeight - 64 - 50 - 48 - 48 - 42;
    var rows = Math.max(1, Math.floor(availH / 42));
    return dual ? rows * 2 : rows;
  }

  var selector = dual ? '#tagTableLeft thead' : '#tagTable thead';
  var thead = document.querySelector(selector);
  var tHeadH = (thead && thead.offsetHeight) || 44;
  var availH = tableContainer.offsetHeight - tHeadH;

  var rowSelector = dual ? '#tagBodyLeft tr' : '#tagBody tr';
  var existingRow = document.querySelector(rowSelector);
  var rowH = (existingRow && existingRow.offsetHeight) || tagTablePreferences.rowHeight;
  if (rowH < 10) rowH = tagTablePreferences.rowHeight;

  var rows = Math.max(1, Math.floor(availH / rowH));
  return dual ? rows * 2 : rows;
}

const state = {
  groups: [],
  allTags: [],
  currentGroupTags: [],
  currentGroup: null,
  currentCategory: null,
  confidenceFilter: 'all',
  searchQuery: '',
  sortKey: 'name',
  sortDir: 'asc',
  page: 1,
  filteredTags: [],
  displayMode: 'table',
  view: null,
  selectedTagNames: new Set(),
};

// Cached source arrays for the two aggregate views (“全部通用标签” and
// “全部角色卡片”) plus per-group counts.  They are rebuilt only after the
// catalogue changes, so typing in a search box never re-fetches group files.
var allGeneralTagsCache = null;
var characterAllTagsCache = null;
var groupCountCache = new Map();

function invalidateViewCaches() {
  allGeneralTagsCache = null;
  characterAllTagsCache = null;
  groupCountCache.clear();
}

function getAllGeneralTags() {
  if (!allGeneralTagsCache) {
    allGeneralTagsCache = state.allTags.filter(function(t) { return !isCharacterTag(t); }).map(normalizeTag);
  }
  return allGeneralTagsCache;
}

async function getCharacterAllTags() {
  if (!characterAllTagsCache) characterAllTagsCache = await loadAllCharacterGroupTags();
  return characterAllTagsCache;
}

var tagTablePreferences = { rowHeight: 48, hideCategory: false, hideConfidence: false, matchLongDescription: false };
try {
  var savedTagTablePreferences = JSON.parse(localStorage.getItem('danbooruTagTablePreferences') || '{}');
  if (savedTagTablePreferences && typeof savedTagTablePreferences === 'object') {
    tagTablePreferences.rowHeight = Math.max(38, Math.min(160, Number(savedTagTablePreferences.rowHeight) || 48));
    tagTablePreferences.hideCategory = !!savedTagTablePreferences.hideCategory;
    // 旧的“隐藏置信度列”与“隐藏置信度筛选”两个开关已合并为一个：任一为真即整体隐藏。
    tagTablePreferences.hideConfidence = !!savedTagTablePreferences.hideConfidence || !!savedTagTablePreferences.hideConfidenceFilter;
    tagTablePreferences.matchLongDescription = !!savedTagTablePreferences.matchLongDescription;
  }
} catch (e) {}

function saveTagTablePreferences() {
  localStorage.setItem('danbooruTagTablePreferences', JSON.stringify(tagTablePreferences));
}

function applyTagTablePreferences() {
  document.documentElement.style.setProperty('--tag-row-height', tagTablePreferences.rowHeight + 'px');
  document.body.classList.toggle('hide-category-column', tagTablePreferences.hideCategory);
  // 置信度筛选行与置信度列由同一个开关控制。
  document.body.classList.toggle('hide-confidence-column', tagTablePreferences.hideConfidence);
  document.body.classList.toggle('hide-confidence-filter', tagTablePreferences.hideConfidence);
  var heightInput = document.getElementById('tagRowHeightInput');
  if (heightInput) heightInput.value = tagTablePreferences.rowHeight;
  var heightValue = document.getElementById('tagRowHeightValue');
  if (heightValue) heightValue.textContent = tagTablePreferences.rowHeight + 'px';
  var categoryButton = document.getElementById('toggleCategoryColumnBtn');
  if (categoryButton) categoryButton.textContent = tagTablePreferences.hideCategory ? '显示分类' : '隐藏分类';
  var confidenceFilterButton = document.getElementById('toggleConfidenceFilterBtn');
  if (confidenceFilterButton) confidenceFilterButton.textContent = tagTablePreferences.hideConfidence ? '显示置信度筛选' : '隐藏置信度筛选';
  var longDescriptionButton = document.getElementById('toggleLongDescriptionSearchBtn');
  if (longDescriptionButton) {
    longDescriptionButton.classList.toggle('active', tagTablePreferences.matchLongDescription);
    longDescriptionButton.setAttribute('aria-pressed', String(tagTablePreferences.matchLongDescription));
  }
}

function getSidebarGroups() {
  return state.groups.filter(function(group) {
    return (state.view === 'characters') ? isCharacterGroup(group) : !isCharacterGroup(group);
  });
}

function getGroupSelectionTags() {
  // A named group means its entire membership, independent of page and filters.
  // Aggregate views retain their archive visibility rules.
  return state.groups.some(function(g) { return g.id === state.currentGroup; }) ?
    state.currentGroupTags : state.currentGroupTags.filter(isVisibleInCurrentGroup);
}

function getRenderedTagRows() {
  // Card mode lists preset articles; table mode lists rows of the active table.
  var scope = state.displayMode === 'preset_cards'
    ? '#presetGrid .preset-card[data-tag-name]'
    : (isDualColumn() ? '#dualTableWrap' : '#tagTable') + ' tr[data-tag-name]';
  return Array.prototype.slice.call(document.querySelectorAll(scope));
}

var deletingSelectedTags = false;

function updateSelectionControls() {
  var count = state.selectedTagNames.size;
  var countEl = document.getElementById('selectedTagCount');
  if (countEl) countEl.textContent = count;
  var operationsButton = document.getElementById('batchOperationsBtn');
  if (operationsButton) operationsButton.disabled = count === 0 || deletingSelectedTags;
  var categoryButton = document.getElementById('batchMoveCategoryBtn');
  if (categoryButton) categoryButton.disabled = count === 0;
  var moveCountEl = document.getElementById('selectedTagCountMove');
  if (moveCountEl) moveCountEl.textContent = count;
  var batchButton = document.getElementById('batchAddGroupBtn');
  if (batchButton) batchButton.disabled = count === 0;
  var moveButton = document.getElementById('batchMoveGroupBtn');
  if (moveButton) moveButton.disabled = count === 0;
  var deleteCountEl = document.getElementById('selectedTagCountDelete');
  if (deleteCountEl) deleteCountEl.textContent = count;
  var deleteButton = document.getElementById('deleteSelectedTagsBtn');
  if (deleteButton) deleteButton.disabled = count === 0 || deletingSelectedTags;
  var currentPageNames = getRenderedTagRows().map(function(tr) { return tr.dataset.tagName; });
  var allSelected = currentPageNames.length > 0 && currentPageNames.every(function(name) { return state.selectedTagNames.has(name); });
  document.querySelectorAll('.select-page-checkbox').forEach(function(cb) { cb.checked = allSelected; cb.indeterminate = !allSelected && currentPageNames.some(function(name) { return state.selectedTagNames.has(name); }); });
  var wholeGroup = getGroupSelectionTags();
  var selectAllButton = document.getElementById('selectAllTagsBtn');
  selectAllButton.disabled = !wholeGroup.length;
  selectAllButton.textContent = wholeGroup.length && wholeGroup.every(function(tag) { return state.selectedTagNames.has(tag.name); }) ? '取消全选' : '选择全部';
}

function toggleTagSelection(tagName, checked) {
  if (checked) state.selectedTagNames.add(tagName);
  else state.selectedTagNames.delete(tagName);
  updateSelectionControls();
}

// Drag from one row checkbox across other rows to select a continuous run.
// The initial checkbox decides the intent: selecting it selects every row
// crossed; starting from a selected checkbox clears every row crossed.
var tagDragSelection = { active: false, pointerId: null, select: true, touched: new Set() };
var suppressTagRowClick = false;

function setDraggedTagSelection(row, selected) {
  if (!row || !row.dataset.tagName) return;
  var tagName = row.dataset.tagName;
  if (selected) state.selectedTagNames.add(tagName);
  else state.selectedTagNames.delete(tagName);
  var checkbox = row.querySelector('input[data-tag]');
  if (checkbox) checkbox.checked = selected;
  tagDragSelection.touched.add(tagName);
}

function finishTagDragSelection() {
  if (!tagDragSelection.active) return;
  tagDragSelection.active = false;
  tagDragSelection.pointerId = null;
  updateSelectionControls();
  // Do not open the details modal after releasing a drag selection.
  suppressTagRowClick = true;
  setTimeout(function() { suppressTagRowClick = false; }, 0);
}

function bindTagDragSelection() {
  var container = document.getElementById('tableContainer');
  if (!container || container.dataset.tagDragSelectionBound) return;
  container.dataset.tagDragSelectionBound = '1';
  container.addEventListener('pointerdown', function(event) {
    if (event.button !== 0) return;
    var cell = event.target.closest('td.tag-select-cell');
    var checkbox = cell && cell.querySelector('input[data-tag]');
    if (!checkbox || !container.contains(checkbox)) return;
    var row = checkbox.closest('tr[data-tag-name]');
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    tagDragSelection.active = true;
    tagDragSelection.pointerId = event.pointerId;
    tagDragSelection.select = !state.selectedTagNames.has(row.dataset.tagName);
    tagDragSelection.touched = new Set();
    checkbox.setPointerCapture?.(event.pointerId);
    setDraggedTagSelection(row, tagDragSelection.select);
    updateSelectionControls();
  });
  document.addEventListener('pointermove', function(event) {
    if (!tagDragSelection.active || event.pointerId !== tagDragSelection.pointerId) return;
    var row = document.elementFromPoint(event.clientX, event.clientY)?.closest('tr[data-tag-name]');
    if (row && container.contains(row)) setDraggedTagSelection(row, tagDragSelection.select);
    updateSelectionControls();
  });
  document.addEventListener('pointerup', function(event) {
    if (tagDragSelection.active && event.pointerId === tagDragSelection.pointerId) finishTagDragSelection();
  });
  document.addEventListener('pointercancel', finishTagDragSelection);
  container.addEventListener('click', function(event) {
    if (suppressTagRowClick) { event.preventDefault(); event.stopPropagation(); }
  }, true);
  container.addEventListener('change', function(event) {
    if (event.target.matches('input[data-tag]')) toggleTagSelection(event.target.dataset.tag, event.target.checked);
  });
}

function updateHeaderSearchSpace() {
  var header = document.querySelector('.header');
  var searchBox = document.querySelector('.header .search-box');
  var stats = document.querySelector('.header-stats');
  if (!header || !searchBox || !stats || stats.style.display === 'none') return;

  // Measure the space the search box would have while the statistics are shown.
  // This avoids a hide/show feedback loop after hiding the statistics expands it.
  var availableSearchWidth;
  if (!header.classList.contains('search-space-limited')) {
    // When statistics are visible, the DOM gives the exact usable width.
    availableSearchWidth = searchBox.getBoundingClientRect().width;
  } else {
    var headerStyle = getComputedStyle(header);
    var horizontalPadding = parseFloat(headerStyle.paddingLeft) + parseFloat(headerStyle.paddingRight);
    var gap = parseFloat(headerStyle.columnGap || headerStyle.gap) || 0;
    var fixedChildren = Array.from(header.children).filter(function(child) {
      return child !== searchBox && child !== stats && getComputedStyle(child).display !== 'none';
    });
    var fixedWidth = fixedChildren.reduce(function(total, child) {
      var style = getComputedStyle(child);
      return total + child.getBoundingClientRect().width + parseFloat(style.marginLeft) + parseFloat(style.marginRight);
    }, 0);
    // Estimate the width after restoring the currently hidden statistics.
    var statsWidth = stats.dataset.visibleWidth ? Number(stats.dataset.visibleWidth) : 0;
    if (!statsWidth) {
      header.classList.remove('search-space-limited');
      statsWidth = stats.getBoundingClientRect().width;
      header.classList.add('search-space-limited');
    }
    var childCountWithStats = fixedChildren.length + 2;
    availableSearchWidth = header.clientWidth - horizontalPadding - fixedWidth - statsWidth - gap * (childCountWithStats - 1);
  }
  if (stats.getBoundingClientRect().width) stats.dataset.visibleWidth = stats.getBoundingClientRect().width;
  header.classList.toggle('search-space-limited', availableSearchWidth < 500);
}

window.addEventListener('resize', updateHeaderSearchSpace);
new ResizeObserver(updateHeaderSearchSpace).observe(document.querySelector('.header'));

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2000);
}

function copyText(text) {
  function done() {
    var preview = text.length > 72 ? text.slice(0, 72) + '…' : text;
    showToast('已复制: ' + preview);
  }
  function fallback() {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    document.body.appendChild(area);
    area.select();
    try {
      if (document.execCommand('copy')) done();
      else showToast('复制失败，请手动选择标签');
    } finally {
      document.body.removeChild(area);
    }
  }
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(fallback);
  } else {
    fallback();
  }
}

async function loadJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + path);
  return r.json();
}

async function init() {
  try {
    var catalogue = await loadJSON('/api/catalogue');
    state.groups = catalogue.groups;
    state.allTags = catalogue.tags;
    var settings = await loadJSON('/api/settings').catch(function() { return {}; });
    displaySettings.group_language = settings.group_language || 'zh';
    displaySettings.category_language = settings.category_language || 'zh';
    displaySettings.unrated_confidence = settings.unrated_confidence || 'D';
    renderGroups();
    renderStats();

  } catch(e) {
    console.error('Init error:', e);
    document.getElementById('welcomeView').innerHTML =
      '<h2 style="color:var(--confidence-d)">加载失败</h2>' +
      '<p style="color:var(--text-secondary); max-width:500px; margin-top:12px;">' +
      '无法加载数据文件。<br><br>' +
      '<b>请双击 <code style="background:var(--bg-tertiary); padding:4px 8px; border-radius:4px;">启动服务器.bat</code> 打开本页面。</b><br><br>' +
      '<small style="color:var(--text-muted);">不要直接双击此HTML文件，浏览器安全策略会阻止读取本地JSON。</small>' +
      '</p>';
  }
}

function renderGroups() {
  const list = document.getElementById('groupList');
  var visibleGroups = getSidebarGroups();
  document.getElementById('groupCount').textContent = visibleGroups.length;
  document.querySelector('.sidebar-header > span:first-child').textContent = (state.view === 'characters') ? '角色提示词分组' : '通用标签分组';

  var searchVal = (document.getElementById('groupSearch').value || '').trim().toLowerCase();

  // Apply saved group order
  var savedOrder = loadGroupOrder();
  var sorted = applyGroupOrder(visibleGroups, savedOrder);

  let html = '';
  if (!(state.view === 'characters')) {
    html += '<div class="group-item ' + (!state.currentGroup ? 'active' : '') + '" data-group="all">' +
      '<div class="drag-handle" style="visibility:hidden;">&#8942;&#8942;</div>' +
      groupNameMarkup('全部通用标签', 'All general tags') +
      '<div class="group-count">' + state.allTags.filter(function(tag) { return !isCharacterTag(tag) && !tagInArchivedGroup(tag); }).length + '</div></div>';
    html += '<div class="group-item" data-group="ungrouped"><div class="drag-handle" style="visibility:hidden;">&#8942;&#8942;</div>' +
      groupNameMarkup('未分组', 'Ungrouped') +
      '<div class="group-count">' + state.allTags.filter(function(t) { return !(t.groups || []).length; }).length + '</div></div>';
  } else {
    html += '<div class="group-item ' + (state.currentGroup === 'character_all' ? 'active' : '') + '" data-group="character_all">' +
      '<div class="drag-handle" style="visibility:hidden;">&#8942;&#8942;</div>' +
      groupNameMarkup('全部角色卡片', 'All character cards') +
      '<div class="group-count" data-character-all-count>' + (characterAllTagsCache ? characterAllTagsCache.length : '…') + '</div></div>';
    // 固定的“未分类”入口：删除角色分组后的卡片与新卡未选分组时的默认归宿。
    html += '<div class="group-item ' + (state.currentGroup === 'character_ungrouped' ? 'active' : '') + '" data-group="character_ungrouped">' +
      '<div class="drag-handle" style="visibility:hidden;">&#8942;&#8942;</div>' +
      groupNameMarkup((state.groups.find(function(g) { return g.id === 'character_ungrouped'; }) || {}).name_cn || '未分类', (state.groups.find(function(g) { return g.id === 'character_ungrouped'; }) || {}).name_en || 'Ungrouped') +
      '<div class="group-count" data-group-id="character_ungrouped">' + (groupCountCache.has('character_ungrouped') ? groupCountCache.get('character_ungrouped') : '-') + '</div>' +
      '<div class="group-actions" data-gid="character_ungrouped"><span class="group-action-btn rename-btn" title="编辑分组">&#9998;</span></div></div>';
  }

  // 归档区只属于通用标签库：折叠本视图停用的分组；角色库侧栏不显示归档。
  function groupItemHtml(g) {
    var searchEnabled = g.search_enabled !== false;
    var actionsHtml = '<div class="group-actions" data-gid="' + escapeHtml(g.id) + '" data-gcn="' + escapeHtml(g.name_cn) + '">' +
      '<span class="group-action-btn search-toggle-btn' + (searchEnabled ? '' : ' disabled') + '" title="归档：' + (searchEnabled ? '否（点击归档，组内提示词将对外隐藏）' : '是（点击取消归档）') + '">&#128230;</span>' +
      '<span class="group-action-btn rename-btn" title="编辑分组">&#9998;</span>' +
      '<span class="group-action-btn delete-btn" title="删除">&#10005;</span></div>';
    return '<div class="group-item" data-group="' + escapeHtml(g.id) + '" draggable="true">' +
      '<div class="drag-handle">&#8942;&#8942;</div>' +
      '<div class="group-name"><span class="cn">' + escapeHtml(groupDisplayName(g)) + '</span></div>' +
      '<div class="group-count" data-group-id="' + escapeHtml(g.id) + '">-</div>' +
      actionsHtml + '</div>';
  }

  function matchesGroupSearch(g) {
    if (!searchVal) return true;
    var cn = (g.name_cn || '').toLowerCase();
    var en = (g.name_en || '').toLowerCase();
    return cn.indexOf(searchVal) !== -1 || en.indexOf(searchVal) !== -1;
  }

  var enabledHtml = '';
  var disabledHtml = '';
  var disabledVisible = 0;

  for (const g of sorted) {
    // 固定的“未分类”入口已在顶部单独渲染，常规列表跳过。
    if ((state.view === 'characters') && g.id === 'character_ungrouped') continue;
    if (!matchesGroupSearch(g)) continue;
    if (g.search_enabled === false) {
      disabledHtml += groupItemHtml(g);
      disabledVisible++;
    } else {
      enabledHtml += groupItemHtml(g);
    }
  }

  html += enabledHtml;
  if (disabledVisible > 0) {
    // The sidebar search forces the section open so matches stay visible.
    var expanded = !!searchVal || !disabledGroupsCollapsed();
    html += '<div class="disabled-groups-header' + (expanded ? '' : ' collapsed') + '" id="disabledGroupsHeader" title="已归档的分组：其中的提示词只在归档分组内可见；点击展开或收起">' +
      '<span class="toggle-arrow">&#9656;</span><span>归档</span>' +
      '<span class="disabled-groups-count">' + disabledVisible + '</span></div>';
    if (expanded) html += '<div class="disabled-groups-list">' + disabledHtml + '</div>';
  }
  html += '<button type="button" class="new-group-btn" id="newGroupBtn">+ 新建分组</button>';
  list.innerHTML = html;

  var disabledHeader = document.getElementById('disabledGroupsHeader');
  if (disabledHeader) disabledHeader.addEventListener('click', function() {
    setDisabledGroupsCollapsed(!disabledGroupsCollapsed());
    renderGroups();
  });

  list.querySelectorAll('.group-item').forEach(function(el) {
    el.addEventListener('click', function(e) {
      if (e.target.classList.contains('drag-handle')) return;
      if (e.target.closest('.group-actions')) return;
      selectGroup(el.dataset.group);
    });
  });

  // New group button
  var newGroupBtn = document.getElementById('newGroupBtn');
  if (newGroupBtn) newGroupBtn.addEventListener('click', openNewGroupModal);

  // Group actions (rename/delete)
  list.querySelectorAll('.group-actions .rename-btn').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var actions = btn.closest('.group-actions');
      openRenameGroupModal(actions.dataset.gid, actions.dataset.gcn);
    });
  });
  list.querySelectorAll('.group-actions .search-toggle-btn').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var actions = btn.closest('.group-actions');
      toggleGroupSearch(actions.dataset.gid);
    });
  });
  list.querySelectorAll('.group-actions .delete-btn').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var actions = btn.closest('.group-actions');
      deleteGroup(actions.dataset.gid, actions.dataset.gcn);
    });
  });

  if (!(state.view === 'characters')) setupDragAndDrop();
  loadGroupCounts();
}

// Character data stays in its original group files.  This only gives it a
// dedicated library view instead of mixing it with ordinary composition tags.
function isCharacterGroup(group) {
  return DanbooruSearch.isCharacterGroup(group);
}

function isCharacterTag(tag) {
  return DanbooruSearch.isCharacterTag(tag,state.groups);
}

async function loadAllCharacterGroupTags() {
  var characterGroups = state.groups.filter(isCharacterGroup);
  var results = await Promise.all(characterGroups.map(async function(group) {
    var filename = group.content_file;
    try {
      var data = await loadJSON(filename);
      return (data.tags || []).map(function(tag) {
        return Object.assign({}, tag, { source_group_id: group.id, groups: tag.groups && tag.groups.length ? tag.groups : [group.id] });
      });
    } catch (error) {
      console.warn('Load character group error:', group.id, error);
      return [];
    }
  }));

  var tagsByName = new Map();
  results.forEach(function(tags) {
    tags.forEach(function(tag) {
      if (!tag || !tag.name || tagsByName.has(tag.name)) return;
      tagsByName.set(tag.name, tag);
    });
  });
  return Array.from(tagsByName.values());
}

async function loadGroupCounts() {
  var countGroups = getSidebarGroups();
  for (const g of countGroups) {
    var countEl = document.querySelector('.group-count[data-group-id="' + g.id + '"]');
    if (!countEl) continue;
    if (groupCountCache.has(g.id)) {
      countEl.textContent = groupCountCache.get(g.id);
      continue;
    }
    try {
      var data = await loadGroupData(g);
      var count = (data.tags || []).length;
      groupCountCache.set(g.id, count);
      countEl.textContent = count;
    } catch(e) {}
  }
}

// One canonical tag shape for every view built from either tags.json or a
// group file, so browse, global search and the character library agree.
function normalizeTag(t, groupId) {
  var ids = t.groups || (t.source_group_id ? [t.source_group_id] : []);
  var names = ids.map(function(id) { var group = state.groups.find(function(g) { return g.id === id; }); return group ? groupDisplayName(group) : id; });
  var categoryGroup = typeof groupId === 'string' ? groupId : ids[0];
  var categoryPath = t.category_by_group ? (t.category_by_group[categoryGroup] || '') : (t.category_path || '');
  var categoryMetadata = state.groups.find(function(g) { return g.id === categoryGroup; });
  if (!categoryPath && categoryMetadata && (categoryMetadata.categories || []).some(function(c) { return c.path === '__uncategorized__'; })) categoryPath = '__uncategorized__';
  return {
    name: t.name,
    source_group_id: t.source_group_id,
    tag_cn: t.tag_cn || '',
    confidence: t.confidence || '',
    tag_cn_long: t.tag_cn_long || '',
    prompt: t.prompt || '',
    category_path: categoryPath,
    category_by_group: t.category_by_group || {},
    category_group_id: categoryGroup,
    groups: ids,
    groups_cn: names,
    wiki_exists: t.wiki_exists || false,
    wiki_url: t.wiki_url || '',
    pinned: !!t.pinned
  };
}

// Reload the catalogue after any mutation and refresh everything derived from it.
async function reloadTagCatalogue() {
  var catalogue = await loadJSON('/api/catalogue');
  state.allTags = catalogue.tags;
  state.groups = catalogue.groups;
  var existingNames = new Set(state.allTags.map(function(tag) { return tag.name; }));
  state.selectedTagNames.forEach(function(name) { if (!existingNames.has(name)) state.selectedTagNames.delete(name); });
  invalidateViewCaches();
  renderStats();
  renderGroups();
}

function buildGeneralGroupData(group) {
  var tags = state.allTags.filter(function(t) { return (t.groups || []).includes(group.id); })
    .map(function(t) { return normalizeTag(t, group.id); });
  var counts = new Map();
  tags.forEach(function(t) { if (t.category_path) counts.set(t.category_path, (counts.get(t.category_path) || 0) + 1); });
  var categories = (group.categories || [])
    .map(function(c) { return Object.assign({}, c, {tag_count: counts.get(c.path) || 0}); });
  var known = new Set(categories.map(function(c) { return c.path; }));
  counts.forEach(function(count, path) { if (!known.has(path)) categories.push({h4:'分类', h5:path, path:path, tag_count:count}); });
  return {tags:tags, categories:orderCategories(categories)};
}

async function loadGroupData(group) {
  if (!isCharacterGroup(group)) return buildGeneralGroupData(group);
  var data = await loadJSON(group.content_file);
  data.tags = (data.tags || []).map(function(t) {
    return Object.assign({}, t, {source_group_id: group.id, groups:t.groups && t.groups.length ? t.groups : [group.id], category_path:t.category_path || '__uncategorized__'});
  });
  var counts = new Map();
  data.tags.forEach(function(t) { if (t.category_path) counts.set(t.category_path, (counts.get(t.category_path) || 0) + 1); });
  data.categories = (group.categories || data.categories || []).map(function(c) { return Object.assign({}, c, {tag_count: counts.get(c.path) || 0}); });
  var paths = new Set(data.categories.map(function(c) { return c.path; }));
  counts.forEach(function(count, path) { if (!paths.has(path)) data.categories.push({path:path, h4:path, h5:null, name_cn:path, name_en:path, tag_count:count}); });
  data.categories = orderCategories(data.categories);
  return data;
}

/* ========== Group Order Persistence ========== */

var STORAGE_KEY = 'danbooru_group_order';
var DISABLED_GROUPS_COLLAPSED_KEY = 'danbooru_disabled_groups_collapsed';

function loadGroupOrder() {
  try {
    var data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : null;
  } catch(e) { return null; }
}

function saveGroupOrder(groupIdList) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(groupIdList));
  } catch(e) {}
}

function disabledGroupsCollapsed() {
  try { return localStorage.getItem(DISABLED_GROUPS_COLLAPSED_KEY) !== '0'; } catch(e) { return true; }
}

function setDisabledGroupsCollapsed(collapsed) {
  try { localStorage.setItem(DISABLED_GROUPS_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch(e) {}
}

function applyGroupOrder(groups, savedOrder) {
  if (!savedOrder || !savedOrder.length) return groups;
  var ordered = [];
  var used = {};
  for (var i = 0; i < savedOrder.length; i++) {
    var gid = savedOrder[i];
    var g = groups.find(function(x) { return x.id === gid; });
    if (g) { ordered.push(g); used[gid] = true; }
  }
  for (var j = 0; j < groups.length; j++) {
    if (!used[groups[j].id]) ordered.push(groups[j]);
  }
  return ordered;
}

/* ========== Drag & Drop ========== */

var dragSrcEl = null;
var groupAutoScrollFrame = null;
var groupAutoScrollSpeed = 0;
var GROUP_AUTO_SCROLL_EDGE = 120;
var GROUP_AUTO_SCROLL_MAX_SPEED = 42;

function setupDragAndDrop() {
  var list = document.getElementById('groupList');
  var items = list.querySelectorAll('.group-item[draggable="true"]');

  items.forEach(function(item) {
    item.addEventListener('dragstart', handleDragStart);
    item.addEventListener('dragend', handleDragEnd);
    item.addEventListener('dragover', handleDragOver);
    item.addEventListener('dragenter', handleDragEnter);
    item.addEventListener('dragleave', handleDragLeave);
    item.addEventListener('drop', handleDrop);
  });
  list.addEventListener('drop', stopGroupAutoScroll);
  // The whole left side is an activation zone, including the app title,
  // group header and search field above the scrollable list.
  if (!document.documentElement.dataset.groupAutoScrollBound) {
    document.addEventListener('dragover', handleGroupSidebarDragOver);
    document.addEventListener('dragleave', handleGroupSidebarDragLeave);
    document.documentElement.dataset.groupAutoScrollBound = '1';
  }
}

function stopGroupAutoScroll() {
  groupAutoScrollSpeed = 0;
  if (groupAutoScrollFrame !== null) {
    cancelAnimationFrame(groupAutoScrollFrame);
    groupAutoScrollFrame = null;
  }
}

function runGroupAutoScroll() {
  var list = document.getElementById('groupList');
  if (!list || !dragSrcEl || !groupAutoScrollSpeed) {
    stopGroupAutoScroll();
    return;
  }
  var before = list.scrollTop;
  list.scrollTop += groupAutoScrollSpeed;
  // Stop at the physical end instead of spinning an idle animation forever.
  if (list.scrollTop === before) {
    stopGroupAutoScroll();
    return;
  }
  groupAutoScrollFrame = requestAnimationFrame(runGroupAutoScroll);
}

function updateGroupAutoScroll(clientX, clientY) {
  var list = document.getElementById('groupList');
  var sidebar = document.getElementById('sidebar');
  if (!list || !sidebar || !dragSrcEl) return;
  var sidebarRect = sidebar.getBoundingClientRect();
  // Expand upward to the top of the app, so the header area in the left
  // column is also a valid fast-scroll target.
  var rect = { left: 0, right: sidebarRect.right, top: 0, bottom: sidebarRect.bottom };
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    stopGroupAutoScroll();
    return;
  }
  var topDistance = clientY - rect.top;
  var bottomDistance = rect.bottom - clientY;
  var speed = 0;
  if (topDistance >= 0 && topDistance < GROUP_AUTO_SCROLL_EDGE) {
    // The edge is fastest; the middle of the activation zone is deliberately gentler.
    var topRatio = 1 - topDistance / GROUP_AUTO_SCROLL_EDGE;
    speed = -Math.ceil(GROUP_AUTO_SCROLL_MAX_SPEED * topRatio * topRatio);
  } else if (bottomDistance >= 0 && bottomDistance < GROUP_AUTO_SCROLL_EDGE) {
    var bottomRatio = 1 - bottomDistance / GROUP_AUTO_SCROLL_EDGE;
    speed = Math.ceil(GROUP_AUTO_SCROLL_MAX_SPEED * bottomRatio * bottomRatio);
  }
  groupAutoScrollSpeed = speed;
  if (!speed) {
    stopGroupAutoScroll();
  } else if (groupAutoScrollFrame === null) {
    groupAutoScrollFrame = requestAnimationFrame(runGroupAutoScroll);
  }
}

function handleGroupSidebarDragOver(e) {
  if (!dragSrcEl) return;
  updateGroupAutoScroll(e.clientX, e.clientY);
  var sidebar = document.getElementById('sidebar');
  if (sidebar && e.clientX >= 0 && e.clientX <= sidebar.getBoundingClientRect().right && e.clientY >= 0 && e.clientY <= sidebar.getBoundingClientRect().bottom) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }
}

function handleGroupSidebarDragLeave(e) {
  var sidebar = document.getElementById('sidebar');
  if (!sidebar || !sidebar.contains(e.relatedTarget)) stopGroupAutoScroll();
}

function handleDragStart(e) {
  dragSrcEl = this;
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', this.dataset.group);
}

function handleDragEnd(e) {
  this.classList.remove('dragging');
  document.querySelectorAll('.group-item').forEach(function(item) {
    item.classList.remove('drag-over');
  });
  stopGroupAutoScroll();
  dragSrcEl = null;
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  updateGroupAutoScroll(e.clientX, e.clientY);
  return false;
}

function handleDragEnter(e) {
  e.preventDefault();
  if (this !== dragSrcEl && this.draggable) {
    this.classList.add('drag-over');
  }
}

function handleDragLeave(e) {
  this.classList.remove('drag-over');
}

function handleDrop(e) {
  e.stopPropagation();
  e.preventDefault();
  stopGroupAutoScroll();

  if (dragSrcEl === this || !this.draggable) return;

  // Sections are fixed by search participation; only reorder within one.
  var scope = this.parentElement;
  if (dragSrcEl.parentElement !== scope) return;

  this.classList.remove('drag-over');

  // Swap positions in DOM
  var allItems = Array.from(scope.querySelectorAll(':scope > .group-item'));
  var srcIdx = allItems.indexOf(dragSrcEl);
  var tgtIdx = allItems.indexOf(this);

  if (srcIdx < tgtIdx) {
    scope.insertBefore(dragSrcEl, this.nextSibling);
  } else {
    scope.insertBefore(dragSrcEl, this);
  }

  // Persist new order
  var list = document.getElementById('groupList');
  var newOrder = [];
  list.querySelectorAll('.group-item[draggable="true"]').forEach(function(item) {
    newOrder.push(item.dataset.group);
  });
  saveGroupOrder(newOrder);
  showToast('排序已保存');
}

function renderStats() {
  var total = state.allTags.length;
  var confA = state.allTags.filter(function(t) { return t.confidence === 'A'; }).length;
  var confB = state.allTags.filter(function(t) { return t.confidence === 'B'; }).length;
  var confC = state.allTags.filter(function(t) { return t.confidence === 'C'; }).length;
  var confD = state.allTags.filter(function(t) { return t.confidence === 'D'; }).length;

  document.getElementById('statTotal').textContent = total;

  document.getElementById('wTotal').textContent = total;
  document.getElementById('wGroups').textContent = state.groups.length;
  document.getElementById('wConfA').textContent = confA;
  document.getElementById('wConfB').textContent = confB;
  document.getElementById('wConfC').textContent = confC;
  document.getElementById('wConfD').textContent = confD;
}

async function selectGroup(gid) {
  if (state.currentGroup !== gid) state.selectedTagNames.clear();
  document.querySelectorAll('.group-item').forEach(function(el) {
    el.classList.toggle('active', el.dataset.group === gid);
  });

  state.currentGroup = gid;
  state.currentCategory = null;
  state.page = 1;

  document.getElementById('welcomeView').style.display = 'none';
  document.getElementById('tableContainer').classList.remove('preset-mode');
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('loadingView').style.display = 'flex';
  document.getElementById('dualTableWrap').style.display = 'none';
  document.getElementById('tagTable').style.display = 'none';
  document.getElementById('presetGrid').style.display = 'none';
  document.getElementById('toolbar').style.display = 'flex';
  state.displayMode = 'table';

  if (gid === 'all' || gid === 'character_all' || gid === 'ungrouped') {
    var sourceTags = gid === 'character_all' ? await getCharacterAllTags() : getAllGeneralTags();
    if (gid === 'ungrouped') sourceTags = sourceTags.filter(function(t) { return !t.groups.length; });
    if (gid === 'character_all') {
      state.displayMode = 'preset_cards';
      var count = document.querySelector('[data-character-all-count]');
      if (count) count.textContent = sourceTags.length;
    }
    state.currentGroupTags = sourceTags;
    document.getElementById('categoryTree').style.display = 'none';
    applyFilters();
  } else {
    try {
      var group = state.groups.find(function(g) { return g.id === gid; });
      if (!group) return;
      // The character library uses one consistent, copy-first card surface.
      // Ordinary tag management keeps each group's original table/card mode.
      state.displayMode = ((state.view === 'characters') && isCharacterGroup(group)) ? 'preset_cards' : 'table';
      var data = await loadGroupData(group);
      state.currentGroupTags = (data.tags || []).map(function(t) { return normalizeTag(t, gid); });
      renderCategories(data.categories || []);
      applyFilters();
    } catch(e) {
      console.error('Load group error:', e);
      document.getElementById('loadingView').style.display = 'none';
      document.getElementById('emptyState').style.display = 'flex';
      document.getElementById('emptyState').querySelector('div').textContent = '无法加载该分组的数据';
    }
  }
}

var categoryDrag = null;
var categoryDragClickUntil = 0;
var categoryOrderSaving = false;

function renderCategories(categories) {
  var tree = document.getElementById('categoryTree');
  if (!categories || categories.length === 0) {
    tree.style.display = 'none';
    return;
  }

  categories = orderCategories(categories);
  var html = '<span class="cat-chip ' + (!state.currentCategory ? 'active' : '') + '" data-cat="">' + (displaySettings.category_language === 'en' ? 'All' : '全部') + '</span>';
  for (var c = 0; c < categories.length; c++) {
      var cat = categories[c];
      var movable = cat.path !== '__uncategorized__';
      html += '<span class="cat-chip ' + (state.currentCategory === cat.path ? 'active' : '') + '"' +
        ' data-cat="' + escapeHtml(cat.path) + '"' +
        ' data-sortable="' + movable + '" title="' + escapeHtml(categoryDisplayName(cat)) + ' (' + cat.tag_count + ')' + (movable ? ' · 拖动排序' : ' · 固定在最后') + '">' +
        escapeHtml(categoryDisplayName(cat)) + ' <small style="color:var(--text-muted)">(' + cat.tag_count + ')</small></span>';
  }
  tree.innerHTML = html;
  tree.style.display = 'flex';

  tree.querySelectorAll('.cat-chip').forEach(function(el) {
    el.addEventListener('click', function() {
      if (categoryDrag || Date.now() < categoryDragClickUntil) return;
      state.currentCategory = el.dataset.cat;
      state.page = 1;
      tree.querySelectorAll('.cat-chip').forEach(function(c) {
        c.classList.toggle('active', c.dataset.cat === state.currentCategory);
      });
      applyFilters();
    });
    el.addEventListener('pointerdown', function(event) {
      var group = state.groups.find(function(g) { return g.id === state.currentGroup; });
      if (event.button !== 0 || !group || !el.dataset.cat || el.dataset.cat === '__uncategorized__' || categoryDrag || categoryOrderSaving) return;
      event.preventDefault();
      el.setPointerCapture(event.pointerId);
      categoryDrag = {groupId:group.id, path:el.dataset.cat, expected:(group.categories || []).map(function(c) { return c.path; }), pointerId:event.pointerId, startX:event.clientX, startY:event.clientY, moved:false, target:null};
    });
    el.addEventListener('pointermove', function(event) {
      if (!categoryDrag || categoryDrag.pointerId !== event.pointerId || categoryDrag.groupId !== state.currentGroup) return;
      if (!categoryDrag.moved && Math.hypot(event.clientX-categoryDrag.startX,event.clientY-categoryDrag.startY) < 6) return;
      event.preventDefault();
      categoryDrag.moved = true;
      el.classList.add('category-dragging');
      tree.querySelectorAll('.category-drop-before, .category-drop-after').forEach(function(chip) { chip.classList.remove('category-drop-before','category-drop-after'); });
      var hit = document.elementFromPoint(event.clientX,event.clientY);
      var target = hit && hit.closest('.cat-chip');
      categoryDrag.target = null;
      if (!target || !tree.contains(target) || !target.dataset.cat || target.dataset.cat === categoryDrag.path) return;
      var bounds = target.getBoundingClientRect();
      categoryDrag.target = target;
      categoryDrag.after = target.dataset.cat !== '__uncategorized__' && event.clientX > bounds.left + bounds.width / 2;
      target.classList.add(categoryDrag.after ? 'category-drop-after' : 'category-drop-before');
    });
    el.addEventListener('pointerup', async function(event) {
      if (!categoryDrag || categoryDrag.pointerId !== event.pointerId) return;
      var drag = categoryDrag;
      categoryDrag = null;
      if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
      tree.querySelectorAll('.category-dragging, .category-drop-before, .category-drop-after').forEach(function(chip) { chip.classList.remove('category-dragging','category-drop-before','category-drop-after'); });
      if (!drag.moved) return;
      categoryDragClickUntil = Date.now() + 400;
      if (!drag.target || drag.groupId !== state.currentGroup) return;
      event.preventDefault();
      tree.insertBefore(el, drag.after ? drag.target.nextSibling : drag.target);
      var paths = Array.from(tree.querySelectorAll('.cat-chip[data-cat]')).map(function(chip) { return chip.dataset.cat; }).filter(Boolean);
      if (JSON.stringify(paths) === JSON.stringify(drag.expected)) return;
      categoryOrderSaving = true;
      try {
        var response = await fetch('/api/reorder-categories', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id:drag.groupId, paths:paths, expected_paths:drag.expected})});
        var result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error || '保存失败');
        var group = state.groups.find(function(g) { return g.id === drag.groupId; });
        if (group) group.categories = result.categories;
        if (state.currentGroup === drag.groupId) {
          var counts = new Map(categories.map(function(c) { return [c.path,c.tag_count]; }));
          renderCategories(result.categories.map(function(c) { return Object.assign({},c,{tag_count:counts.get(c.path) || 0}); }));
        }
        showToast('二级分组顺序已保存');
      } catch (error) {
        if (state.currentGroup === drag.groupId) {
          try { await reloadTagCatalogue(); var fresh = state.groups.find(function(g) { return g.id === drag.groupId; }); var data = await loadGroupData(fresh); renderCategories(data.categories); }
          catch (_) { renderCategories(categories); }
        }
        showToast('排序保存失败: ' + error.message);
      } finally { categoryOrderSaving = false; }
    });
    el.addEventListener('pointercancel', function() {
      categoryDrag = null;
      categoryDragClickUntil = Date.now() + 400;
      tree.querySelectorAll('.category-dragging, .category-drop-before, .category-drop-after').forEach(function(chip) { chip.classList.remove('category-dragging','category-drop-before','category-drop-after'); });
    });
  });
}

function tagInArchivedGroup(tag) {
  return DanbooruSearch.inArchivedGroup(tag,state.groups);
}
function isVisibleInCurrentGroup(tag) {
  return DanbooruSearch.visible(tag,state.groups,{characterLibrary:(state.view === 'characters'),currentGroup:state.currentGroup,excludeCharacters:!(state.view === 'characters')});
}
function getSearchTerms(query) { return DanbooruSearch.terms(query); }
function tagMatchesSearch(tag,terms) {
  return DanbooruSearch.matches(tag,terms,{matchLongDescription:tagTablePreferences.matchLongDescription,characterLibrary:(state.view === 'characters')});
}

function applyFilters() {
  var tags = state.currentGroupTags.slice();

  tags = tags.filter(isVisibleInCurrentGroup);

  if (state.searchQuery) {
    var searchTerms = getSearchTerms(state.searchQuery);
    tags = tags.filter(function(t) {
      return tagMatchesSearch(t, searchTerms);
    });
  }

  if (state.currentCategory) {
    tags = tags.filter(function(t) { return t.category_path === state.currentCategory; });
  }

  if (state.confidenceFilter !== 'all') {
    tags = tags.filter(function(t) {
      return DanbooruSearch.matchesConfidence(t.confidence, state.confidenceFilter, displaySettings.unrated_confidence);
    });
  }

  tags.sort(function(a, b) {
    // Pinning affects search results only. Normal browsing keeps the selected
    // column sort untouched.
    if (state.searchQuery) {
      var pinOrder = Number(!!b.pinned) - Number(!!a.pinned);
      if (pinOrder) return pinOrder;
    }
    var va = a[state.sortKey] || '';
    var vb = b[state.sortKey] || '';
    if (state.sortKey === 'confidence') {
      va = DanbooruSearch.confidenceRank(a.confidence, displaySettings.unrated_confidence);
      vb = DanbooruSearch.confidenceRank(b.confidence, displaySettings.unrated_confidence);
    }
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va < vb) return state.sortDir === 'asc' ? -1 : 1;
    if (va > vb) return state.sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  state.filteredTags = tags;
  // Clamp current page after filter change
  var ps = getPageSize();
  var maxPage = Math.max(1, Math.ceil(tags.length / ps));
  if (state.page > maxPage) state.page = maxPage;
  renderTable();
  renderPagination();
}

function formatConfidence(value) {
  return value === 'MANUAL' ? '手写' : (value || '-');
}

function bindTagRowClick(tr) {
  tr.addEventListener('click', function(event) {
    if (event.target.closest('button, input, .tag-select-cell, .group-picker-popup')) return;
    if (!suppressTagRowClick) showDetail(tr.dataset.tagName);
  });
}

function syncSortHeaders(scope) {
  document.querySelectorAll(scope + ' th[data-sort]').forEach(function(th) {
    th.classList.toggle('sorted', th.dataset.sort === state.sortKey);
    var arrow = th.querySelector('.sort-arrow');
    if (th.dataset.sort === state.sortKey) {
      arrow.innerHTML = state.sortDir === 'asc' ? '&#9650;' : '&#9660;';
    } else {
      arrow.innerHTML = '&#9650;';
    }
  });
}

function renderTable() {
  var tags = state.filteredTags;
  if (state.displayMode === 'preset_cards') {
    renderPresetCards(tags);
    return;
  }
  document.getElementById('toolbar').classList.remove('preset-toolbar');
  // Reserve the footer before measuring rows on first load or after an empty view.
  document.getElementById('pagination').style.display = tags.length ? 'flex' : 'none';
  var dual = isDualColumn();
  var PAGE_SIZE = getPageSize();
  var start = (state.page - 1) * PAGE_SIZE;
  var pageTags = tags.slice(start, start + PAGE_SIZE);

  document.getElementById('loadingView').style.display = 'none';

  var dualWrap = document.getElementById('dualTableWrap');
  var singleTable = document.getElementById('tagTable');

  if (tags.length === 0) {
    dualWrap.style.display = 'none';
    singleTable.style.display = 'none';
    document.getElementById('emptyState').style.display = 'flex';
    document.getElementById('pagination').style.display = 'none';
    document.getElementById('resultCount').textContent = '0 条结果';
    updateSelectionControls();
    return;
  }

  // Toggle between dual and single layout
  if (dual) {
    dualWrap.style.display = 'flex';
    singleTable.style.display = 'none';
  } else {
    dualWrap.style.display = 'none';
    singleTable.style.display = '';
  }
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('resultCount').textContent = tags.length + ' 条结果';

  // Render row HTML
  function buildRow(t) {
    var conf = t.confidence || '';
    var confClass = conf ? 'confidence-' + conf : 'confidence-none';
    var cnDisplay = t.tag_cn || '';
    var cnClass = 'tag-cn';
    var longDesc = t.tag_cn_long || '';
    var longDescClass = longDesc ? 'tag-long-desc' : 'tag-long-desc empty';
    var longDescDisplay = longDesc || '暂无说明';

    var selected = state.selectedTagNames.has(t.name);
    return '<tr data-tag-name="' + escapeHtml(t.name) + '">' +
      '<td class="tag-select-cell"><input type="checkbox" data-tag="' + escapeHtml(t.name) + '"' + (selected ? ' checked' : '') + ' aria-label="选择 ' + escapeHtml(t.name) + '"></td>' +
      '<td><div class="tag-name-cell">' +
      '<span class="tag-name">' + escapeHtml(t.name) + '</span>' +
      '<button class="copy-btn" data-action="copy-tag" data-tag="' + escapeHtml(t.name) + '">复制</button>' +
      '</div></td>' +
      '<td class="' + cnClass + '">' + escapeHtml(cnDisplay) + '</td>' +
      '<td><span class="' + longDescClass + '" title="' + escapeHtml(longDesc) + '">' + escapeHtml(longDescDisplay) + '</span></td>' +
      '<td class="confidence-column"><span class="confidence-badge ' + confClass + '">' + formatConfidence(conf) + '</span></td>' +
      '<td class="category-column category-path" title="' + escapeHtml(categoryDisplayPath(t.category_path, t.category_group_id)) + '">' + escapeHtml(categoryDisplayPath(t.category_path, t.category_group_id) || '-') + '</td>' +
      '<td class="tag-action-cell"><div class="tag-actions"><button class="edit-tag-btn pin-tag-btn' + (t.pinned ? ' pinned' : '') + '" data-action="toggle-pin" data-tag="' + escapeHtml(t.name) + '" data-pinned="' + (!!t.pinned) + '" title="' + (t.pinned ? '取消置顶' : '置顶：搜索时优先显示') + '">&#9733;</button><button class="edit-tag-btn" data-action="edit-tag" data-tag="' + escapeHtml(t.name) + '" title="编辑">&#9998;</button><button class="add-to-group-btn" data-action="group-picker" data-tag="' + escapeHtml(t.name) + '" title="添加到分组">+</button></div>' +
      '<div class="group-picker-popup" style="display:none;"></div></td>' +
      '</tr>';
  }

  // Build rows
  var allHtml = '';
  for (var k = 0; k < pageTags.length; k++) allHtml += buildRow(pageTags[k]);

  if (dual) {
    // Dual column: split into left/right
    var half = Math.ceil(pageTags.length / 2);
    var leftTags = pageTags.slice(0, half);
    var rightTags = pageTags.slice(half);
    var tbodyL = document.getElementById('tagBodyLeft');
    var tbodyR = document.getElementById('tagBodyRight');
    var htmlL = '', htmlR = '';
    for (var i = 0; i < leftTags.length; i++) htmlL += buildRow(leftTags[i]);
    for (var j = 0; j < rightTags.length; j++) htmlR += buildRow(rightTags[j]);
    tbodyL.innerHTML = htmlL;
    tbodyR.innerHTML = htmlR;

    // Bind click events
    tbodyL.querySelectorAll('tr').forEach(bindTagRowClick);
    tbodyR.querySelectorAll('tr').forEach(bindTagRowClick);

    // Sync sort header state across both tables
    syncSortHeaders('#dualTableWrap');
  } else {
    // Single column: render all rows into tagBody
    var tbody = document.getElementById('tagBody');
    tbody.innerHTML = allHtml;
    tbody.querySelectorAll('tr').forEach(bindTagRowClick);

    // Sync sort header
    syncSortHeaders('#tagTable');
  }

  // Overflow shrink for dual column
  if (dual) {
    var tableEl = document.getElementById('tagTableLeft');
    var containerEl = document.getElementById('tableContainer');
    if (tableEl && containerEl && tableEl.offsetHeight > containerEl.offsetHeight) {
      var halfRows = Math.max(1, Math.floor(containerEl.offsetHeight / (tableEl.querySelector('tbody tr') || {offsetHeight:42}).offsetHeight) - 1);
      if (halfRows * 2 < pageTags.length) {
        pageTags = pageTags.slice(0, halfRows * 2);
        var newHalf = Math.ceil(pageTags.length / 2);
        var lt = pageTags.slice(0, newHalf);
        var rt = pageTags.slice(newHalf);
        var hL = '', hR = '';
        for (var i = 0; i < lt.length; i++) hL += buildRow(lt[i]);
        for (var j = 0; j < rt.length; j++) hR += buildRow(rt[j]);
        document.getElementById('tagBodyLeft').innerHTML = hL;
        document.getElementById('tagBodyRight').innerHTML = hR;
      }
    }
  }
  updateSelectionControls();
}

function getPresetGroup(preset) {
  var groupId = state.currentGroup === 'character_all' ? preset.source_group_id : state.currentGroup;
  return state.groups.find(function(group) { return group.id === groupId; });
}

function renderPresetCards(presets) {
  var grid = document.getElementById('presetGrid');
  var activeGroup = state.groups.find(function(group) { return group.id === state.currentGroup; });
  var activeGroupName = (activeGroup && groupDisplayName(activeGroup)) || '角色提示词库';
  // The preset grid lives inside the normal table container. Switch that
  // container into a column flex layout so the grid receives a real height.
  document.getElementById('tableContainer').classList.add('preset-mode');
  document.getElementById('loadingView').style.display = 'none';
  document.getElementById('dualTableWrap').style.display = 'none';
  document.getElementById('tagTable').style.display = 'none';
  // 卡片视图复用工具栏，只保留结果计数与批量选择工具（见 .preset-toolbar 样式）。
  document.getElementById('toolbar').style.display = 'flex';
  document.getElementById('toolbar').classList.add('preset-toolbar');
  document.getElementById('pagination').style.display = 'none';
  document.getElementById('resultCount').textContent = presets.length + ' 个角色卡片';
  if (!presets.length) {
    grid.style.display = 'none';
    document.getElementById('emptyState').style.display = 'flex';
    updateSelectionControls();
    return;
  }
  document.getElementById('emptyState').style.display = 'none';
  grid.innerHTML = presets.map(function(preset, index) {
    var prompt = preset.prompt || preset.name || '';
    var category = categoryDisplayPath(preset.category_path, preset.source_group_id) || activeGroupName;
    var cardGroup = getPresetGroup(preset);
    var selected = state.selectedTagNames.has(preset.name);
    var actions = (cardGroup && cardGroup.preset_group) ?
      '<button type="button" class="preset-edit-btn" data-preset-index="' + index + '">编辑角色卡</button>' +
      '<button type="button" class="preset-delete-btn" data-preset-index="' + index + '">删除角色卡</button>' :
      '<button type="button" class="character-edit-btn preset-edit-btn" data-preset-index="' + index + '">编辑角色卡</button>' +
      '<button type="button" class="character-delete-btn preset-delete-btn" data-preset-index="' + index + '">删除角色卡</button>';
    return '<article class="preset-card" data-tag-name="' + escapeHtml(preset.name) + '">' +
      '<div class="preset-header">' +
      '<label class="preset-select" title="选择此角色卡"><input type="checkbox" data-tag="' + escapeHtml(preset.name) + '"' + (selected ? ' checked' : '') + ' aria-label="选择 ' + escapeHtml(preset.tag_cn || preset.name) + '"></label>' +
      '<div class="preset-title">' + escapeHtml(preset.tag_cn || preset.name || '未命名角色') + '</div>' +
      '<div class="preset-actions">' + actions +
      '<button type="button" class="preset-copy-btn" data-preset-index="' + index + '">复制完整提示词</button>' +
      '</div></div>' +
      '<div class="preset-subtitle">' + escapeHtml(category) + ' · 点击复制会复制整串提示词</div>' +
      '<div class="preset-prompt">' + escapeHtml(prompt) + '</div>' +
      '</article>';
  }).join('');
  grid.style.display = 'grid';
  grid.querySelectorAll('.preset-copy-btn').forEach(function(button) {
    button.addEventListener('click', function() {
      var preset = presets[Number(button.dataset.presetIndex)];
      copyText((preset && (preset.prompt || preset.name)) || '');
    });
  });
   grid.querySelectorAll('.preset-delete-btn').forEach(function(button) {
     button.addEventListener('click', async function() {
       var preset = presets[Number(button.dataset.presetIndex)];
       if (!preset) return;
       var group = getPresetGroup(preset);
       var displayName = preset.tag_cn || preset.name || '此预设';
       var isPreset = !!(group && group.preset_group);
       var itemType = isPreset ? '角色预设' : '角色卡片';
       if (!confirm('确定完整删除' + itemType + '“' + displayName + '”吗？\n这会从提示词目录及所有所属分组中删除，不能只从当前分组移除。')) return;
       try {
         var resp = await fetch('/api/delete-tag', {
           method: 'POST',
           headers: {'Content-Type': 'application/json'},
           body: JSON.stringify({name: preset.name})
         });
         var result = await resp.json();
	       if (!result.success) throw new Error(result.error || '删除失败');
	       showToast('已完整删除' + itemType + '：' + displayName);
	       await reloadTagCatalogue();
	       if (state.currentGroup) await selectGroup(state.currentGroup);
	       loadGroupCounts();
       } catch (error) {
         showToast('删除失败: ' + error.message);
       }
     });
   });
  grid.querySelectorAll('.preset-edit-btn').forEach(function(button) {
    button.addEventListener('click', function() {
      var preset = presets[Number(button.dataset.presetIndex)];
      if (!preset) return;
      openPresetEditModal(preset);
    });
  });
  updateSelectionControls();
}

function renderPagination() {
  var pag = document.getElementById('pagination');
  // 角色预设以完整卡片列表呈现，当前没有实际分页行为；不要显示误导性的分页栏。
  if (state.displayMode === 'preset_cards') {
    pag.style.display = 'none';
    return;
  }

  var total = state.filteredTags.length;
  var PAGE_SIZE = getPageSize();
  var totalPages = Math.ceil(total / PAGE_SIZE);

  if (totalPages <= 1) {
    pag.style.display = 'none';
    return;
  }

  pag.style.display = 'flex';
  var html = '';
  html += '<button class="page-btn" ' + (state.page <= 1 ? 'disabled' : '') + ' data-page="' + (state.page - 1) + '">&#8249;</button>';

  var maxVisible = 7;
  var startPage = Math.max(1, state.page - Math.floor(maxVisible / 2));
  var endPage = Math.min(totalPages, startPage + maxVisible - 1);
  if (endPage - startPage < maxVisible - 1) {
    startPage = Math.max(1, endPage - maxVisible + 1);
  }

  if (startPage > 1) {
    html += '<button class="page-btn" data-page="1">1</button>';
    if (startPage > 2) html += '<span class="page-info">...</span>';
  }

  for (var i = startPage; i <= endPage; i++) {
    html += '<button class="page-btn ' + (i === state.page ? 'active' : '') + '" data-page="' + i + '">' + i + '</button>';
  }

  if (endPage < totalPages) {
    if (endPage < totalPages - 1) html += '<span class="page-info">...</span>';
    html += '<button class="page-btn" data-page="' + totalPages + '">' + totalPages + '</button>';
  }

  html += '<span class="page-info">' + state.page + ' / ' + totalPages + '</span>';
  html += '<button class="page-btn" ' + (state.page >= totalPages ? 'disabled' : '') + ' data-page="' + (state.page + 1) + '">&#8250;</button>';

  pag.innerHTML = html;

  pag.querySelectorAll('.page-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      if (btn.disabled) return;
      state.page = parseInt(btn.dataset.page);
      renderTable();
      renderPagination();
      document.getElementById('tableContainer').scrollTop = 0;
    });
  });
}

function showDetail(tagName) {
  var tag = state.filteredTags.find(function(t) { return t.name === tagName; });
  if (!tag) tag = state.allTags.find(function(t) { return t.name === tagName; });
  if (!tag) return;

  document.getElementById('modalTitle').textContent = tagName;
  document.getElementById('modalEditBtn').style.display = 'inline-block';
  document.getElementById('modalEditBtn').onclick = function() {
    document.getElementById('modalOverlay').classList.remove('show');
    openEditModal(tagName);
  };

  var conf = tag.confidence || '';
  var confClass = conf ? 'confidence-' + conf : 'confidence-none';
  var groups = tag.groups_cn || [];
  var tagCn = tag.tag_cn || '';
  var tagLong = tag.tag_cn_long || '';
  var catPath = categoryDisplayPath(tag.category_path || '', tag.category_group_id);
  var wikiUrl = tag.wiki_exists ? 'https://danbooru.donmai.us' + tag.wiki_url : '';

  var body = '<div class="detail-row"><div class="detail-label">标签名</div>' +
    '<div class="detail-value" style="font-family:Consolas,Monaco,monospace; color:var(--accent);">' + escapeHtml(tagName) + '</div></div>' +
    '<div class="detail-row"><div class="detail-label">中文翻译</div>' +
    '<div class="detail-value">' + escapeHtml(tagCn) + '</div></div>' +
    '<div class="detail-row"><div class="detail-label">置信度</div>' +
    '<div class="detail-value"><span class="confidence-badge ' + confClass + '">' + (conf ? formatConfidence(conf) : '未评分') + '</span></div></div>';

  if (tagLong) {
    body += '<div class="detail-row"><div class="detail-label">详细说明</div>' +
      '<div class="detail-value long-desc">' + escapeHtml(tagLong) + '</div></div>';
  }
  if (catPath) {
    body += '<div class="detail-row"><div class="detail-label">分类路径</div>' +
      '<div class="detail-value">' + escapeHtml(catPath) + '</div></div>';
  }
  if (groups.length > 0) {
    body += '<div class="detail-row"><div class="detail-label">所属分组</div>' +
      '<div class="detail-value groups">';
    for (var i = 0; i < groups.length; i++) {
      body += '<span class="group-tag">' + escapeHtml(groups[i]) + '</span>';
    }
    body += '</div></div>';
  }
  if (wikiUrl) {
    body += '<div class="detail-row"><div class="detail-label">Wiki</div>' +
      '<div class="detail-value"><a href="' + escapeHtml(wikiUrl) + '" target="_blank" style="color:var(--accent); text-decoration:none;">' + escapeHtml(wikiUrl) + '</a></div></div>';
  }

  document.getElementById('modalBody').innerHTML = body;
  document.getElementById('modalOverlay').classList.add('show');
}

function showGlobalSearchResults() {
  // Search across ordinary tag groups, with the same character boundary as
  // browsing “全部标签”, independent of the previously selected category.
  if (state.currentGroup !== 'all') state.selectedTagNames.clear();
  state.currentGroup = 'all';
  state.currentCategory = null;
  state.currentGroupTags = getAllGeneralTags();
  document.querySelectorAll('.group-item').forEach(function(el) {
    el.classList.toggle('active', el.dataset.group === 'all');
  });
  document.getElementById('welcomeView').style.display = 'none';
  document.getElementById('dualTableWrap').style.display = 'none';
  document.getElementById('tagTable').style.display = 'none';
  document.getElementById('toolbar').style.display = 'flex';
  document.getElementById('categoryTree').style.display = 'none';
  applyFilters();
}

async function toggleTagPin(tagName, currentlyPinned) {
  try {
    var response = await fetch('/api/toggle-tag-pin', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name: tagName, pinned: !currentlyPinned})
    });
    var result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || '保存失败');
    state.allTags.forEach(function(tag) {
      if (tag.name === tagName) tag.pinned = result.pinned;
    });
    state.currentGroupTags.forEach(function(tag) {
      if (tag.name === tagName) tag.pinned = result.pinned;
    });
    showToast(result.pinned ? '已置顶：' + tagName : '已取消置顶：' + tagName);
    applyFilters();
  } catch (error) {
    showToast('置顶保存失败：' + error.message);
  }
}

// Every search inside the character library stays on its current character
// data source; a search from the general view switches to the full catalogue.
document.getElementById('globalSearch').addEventListener('input', function(e) {
  state.searchQuery = e.target.value.trim();
  state.page = 1;
  if (state.searchQuery) {
    if ((state.view === 'characters')) {
      applyFilters();
    } else {
      showGlobalSearchResults();
    }
  } else if (state.currentGroup) {
    applyFilters();
  }
});

// A keyword passed by the ComfyUI launcher node opens directly in tag search.
// This must run after init() loads tags.json; firing it during script parsing
// searches an empty state.allTags array and leaves the page at zero results.
document.getElementById('toolbar').addEventListener('click', function(e) {
  var btn = e.target.closest('.filter-btn');
  if (!btn) return;

  var filter = btn.dataset.filter;
  var value = btn.dataset.value;
  if (filter !== 'confidence') return;

  if (filter === 'confidence') {
    state.confidenceFilter = value;
    document.querySelectorAll('.filter-btn[data-filter="confidence"]').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
  }

  state.page = 1;
  applyFilters();
});

document.querySelectorAll('.tag-table th[data-sort]').forEach(function(th) {
  th.addEventListener('click', function() {
    var key = th.dataset.sort;
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortKey = key;
      state.sortDir = 'asc';
    }
    applyFilters();
  });
});

document.getElementById('modalClose').addEventListener('click', function() {
  document.getElementById('modalOverlay').classList.remove('show');
});
document.getElementById('modalOverlay').addEventListener('click', function(e) {
  if (e.target === document.getElementById('modalOverlay')) {
    document.getElementById('modalOverlay').classList.remove('show');
  }
});
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    document.getElementById('modalOverlay').classList.remove('show');
    CardEditors.requestClose('tag');
    CardEditors.requestClose('model');
    document.getElementById('settingsModalOverlay').classList.remove('show');
  }
});

/* ========== Edit Tag Logic ========== */

// Track the original tag name when editing (for rename detection)
var _editingOriginalName = null;
var _editingPresetOriginalName = null;
var _editingPresetGroupId = null;
var _presetFormMode = false;
var _editingCategoryGroupId = '';
function populateCategoryOptions(selectId, groupId, currentPath) {
  var select = document.getElementById(selectId);
  var group = state.groups.find(function(g) { return g.id === groupId; });
  var categories = group && group.categories || [];
  var uncategorized = categories.find(function(c) { return c.path === '__uncategorized__'; });
  select.innerHTML = categories.filter(function(c) { return c !== uncategorized; }).map(function(c) {
    return '<option value="' + escapeHtml(c.path) + '">' + escapeHtml(categoryDisplayName(c)) + '</option>';
  }).join('');
  if (currentPath && !categories.some(function(c) { return c.path === currentPath; })) select.add(new Option(currentPath, currentPath));
  select.add(new Option(displaySettings.category_language === 'en' ? 'Uncategorized' : '未分类', uncategorized ? uncategorized.path : ''));
  select.value = currentPath || (uncategorized ? uncategorized.path : '');
}

function fillGeneralTagForm(tag) {
  document.getElementById('addTagCn').value = tag.tag_cn || '';
  document.getElementById('addTagConfidence').value = tag.confidence || '';
  document.getElementById('addTagLongDesc').value = tag.tag_cn_long || '';
  _editingCategoryGroupId = (tag.groups || []).includes(state.currentGroup) ? state.currentGroup : ((tag.groups || [])[0] || '');
  populateCategoryOptions('addTagCategory', _editingCategoryGroupId, (tag.category_by_group || {})[_editingCategoryGroupId] || '');
  var group = state.groups.find(function(g) { return g.id === _editingCategoryGroupId; });
  document.getElementById('addTagCategoryLabel').textContent = group ? '分类（' + group.name_cn + '）' : '分类（保存到首个勾选分组）';
  document.getElementById('addTagWiki').value = tag.wiki_url || '';
}

function openEditModal(tagName) {
  var tag = state.allTags.find(function(t) { return t.name === tagName; });
  if (!tag) return;
  openAddModal({presetMode:false});
  _editingOriginalName = tag.name;
  document.getElementById('addTagName').value = tag.name;
  document.getElementById('addModalTitle').textContent = '编辑通用标签';
  document.getElementById('addTagSubmit').textContent = '更新';
  fillGeneralTagForm(tag);
  populateGroupCheckboxes(tag.groups || []);
  document.getElementById('addTagDeleteRow').style.display = 'flex';
  CardEditors.begin('tag');
}

/* ========== Add Tag Logic ========== */

function openAddModal(options) {
  var modal = document.getElementById('addModalOverlay');
  document.getElementById('addTagError').classList.remove('show');
  document.getElementById('addTagExistsHint').classList.remove('show');
  var activeGroup = state.groups.find(function(group) { return group.id === state.currentGroup; });
  // The whole character view creates cards, including “全部角色卡片” and
  // character groups without the optional preset_group flag.
  _presetFormMode = options && typeof options.presetMode === 'boolean'
    ? options.presetMode : (state.view === 'characters') || !!(activeGroup && activeGroup.preset_group);
  var metaRow = document.getElementById('addTagMetaRow');
  metaRow.children[0].style.flex = '';
  metaRow.children[1].style.display = '';
  _editingPresetOriginalName = null;
  _editingPresetGroupId = null;
  var nameInput = document.getElementById('addTagName');
  nameInput.value = '';
  nameInput.readOnly = false;
  nameInput.style.opacity = '';
  document.getElementById('addTagCn').value = '';
  // Tags created manually in this manager default to the dedicated 手写 level.
  // Editing an existing tag replaces this value with its persisted confidence.
  document.getElementById('addTagConfidence').value = 'MANUAL';
  document.getElementById('addTagLongDesc').value = '';
  document.getElementById('addTagCategory').value = '';
  _editingCategoryGroupId = activeGroup && !isCharacterGroup(activeGroup) ? activeGroup.id : '';
  populateCategoryOptions('addTagCategory', _editingCategoryGroupId, '');
  document.getElementById('addTagCategoryLabel').textContent = _editingCategoryGroupId ? '分类（' + activeGroup.name_cn + '）' : '分类（保存到首个勾选分组）';
  document.getElementById('addTagWiki').value = '';
  document.getElementById('addModalTitle').textContent = _presetFormMode ? '新建角色提示词卡' : '新建通用标签';
  document.getElementById('addTagSubmit').disabled = false;
  document.getElementById('addTagSubmit').textContent = _presetFormMode ? '保存角色卡' : '保存通用标签';
  document.getElementById('addTagDeleteRow').style.display = 'none';
  _editingOriginalName = null;

  document.getElementById('addGroupRow').style.display = _presetFormMode ? 'none' : 'block';
  metaRow.style.display = 'flex';
  metaRow.children[0].style.flex = _presetFormMode ? '1 1 auto' : '';
  metaRow.children[1].style.display = _presetFormMode ? 'none' : '';
  document.getElementById('addTagSourceRow').style.display = _presetFormMode ? 'none' : 'flex';
  document.getElementById('addTagNameLabel').textContent = _presetFormMode ? '完整角色提示词（可多行）' : '通用标签名 (English)';
  document.getElementById('addTagCnLabel').textContent = _presetFormMode ? '角色名称（卡片标题）' : '中文翻译';
  document.getElementById('addTagCn').placeholder = _presetFormMode ? '例如：符玄（可注明服装或形态）' : 'e.g. 红色眼睛';
  document.getElementById('addTagCnLabel').classList.toggle('required', _presetFormMode);
  document.getElementById('addTagLongDescLabel').textContent = _presetFormMode ? '角色卡备注' : '详细说明';
  document.getElementById('addTagLongDesc').placeholder = _presetFormMode ? '角色、服装版本或提示词的补充说明（可选）' : '标签的详细中文解释...';
  nameInput.rows = _presetFormMode ? 8 : 1;
  nameInput.placeholder = _presetFormMode ? '作品、完整角色标签、外貌、服装、配饰……' : 'e.g. red_eyes, long_hair';
  document.getElementById('addPresetGroupRow').style.display = _presetFormMode ? 'block' : 'none';
  var destination = document.getElementById('addPresetGroup');
  destination.disabled = false;
  destination.innerHTML = state.groups.filter(isCharacterGroup).map(function(group) {
    var label = groupDisplayName(group) + (group.id === 'character_ungrouped' ? '（默认）' : '');
    return '<option value="' + escapeHtml(group.id) + '">' + escapeHtml(label) + '</option>';
  }).join('');
  // 没有主动选分组时默认落到固定的“未分类”，提交不再被拦截。
  destination.value = activeGroup && isCharacterGroup(activeGroup) ? activeGroup.id :
    (state.groups.some(function(g) { return g.id === 'character_ungrouped'; }) ? 'character_ungrouped' : '');
  document.getElementById('addPresetCategoryRow').style.display = _presetFormMode ? 'block' : 'none';
  populateCategoryOptions('addPresetCategory', destination.value, '');
  populateGroupCheckboxes();
  modal.classList.add('show');
  document.getElementById('addTagName').focus();
  CardEditors.begin('tag');
}

function openPresetEditModal(preset) {
  openAddModal({presetMode:true});
  _presetFormMode = true;
  _editingPresetOriginalName = preset.name;
  var group = getPresetGroup(preset);
  _editingPresetGroupId = group && group.id;
  document.getElementById('addModalTitle').textContent = '编辑角色提示词卡';
  document.getElementById('addTagSubmit').textContent = '更新角色卡';
  document.getElementById('addPresetGroup').value = _editingPresetGroupId || '';
  populateCategoryOptions('addPresetCategory', _editingPresetGroupId, preset.category_path || '');
  document.getElementById('addPresetGroup').disabled = true;
  document.getElementById('addGroupRow').style.display = 'none';
  var metaRow = document.getElementById('addTagMetaRow');
  // The card title is stored in tag_cn. Keep this field visible while editing
  // a preset so the name shown in the card's upper-left corner can be changed.
  metaRow.style.display = 'flex';
  metaRow.children[0].style.flex = '1 1 auto';
  metaRow.children[1].style.display = 'none';
  document.getElementById('addTagSourceRow').style.display = 'none';
  document.getElementById('addTagNameLabel').textContent = '完整角色提示词（可多行）';
  document.getElementById('addTagCnLabel').textContent = '卡片左上角角色名（保存后立即更新）';
  document.getElementById('addTagName').rows = 12;
  document.getElementById('addTagName').placeholder = '作品、角色、外貌、服装、配饰……';
  document.getElementById('addTagName').value = preset.prompt || preset.name || '';
  document.getElementById('addTagCn').value = preset.tag_cn || '';
  document.getElementById('addTagLongDesc').value = preset.tag_cn_long || '';
  document.getElementById('addTagCn').focus();
  CardEditors.begin('tag');
}

function groupChoiceSections(groups) {
  var sorted = groups.slice().sort(function(a, b) {
    return (a.name_cn || '').localeCompare(b.name_cn || '', 'zh-CN');
  });
  return [
    {title: '常用分组', archived: false, groups: sorted.filter(function(g) { return g.search_enabled !== false; })},
    {title: '归档分组', archived: true, groups: sorted.filter(function(g) { return g.search_enabled === false; })}
  ].filter(function(section) { return section.groups.length; });
}

function renderGroupCheckboxes(containerId, selectedGroups) {
  var selected = selectedGroups || [];
  var container = document.getElementById(containerId);
  container.innerHTML = groupChoiceSections(getSidebarGroups()).map(function(section) {
    return '<section class="group-choice-section' + (section.archived ? ' archived' : '') + '">' +
      '<div class="group-choice-heading">' + section.title + ' <span>' + section.groups.length + '</span></div>' +
      '<div class="group-choice-items">' + section.groups.map(function(g) {
        var checked = selected.includes(g.id);
        return '<label class="group-checkbox-item' + (checked ? ' selected' : '') + '" ' +
          'data-group-id="' + escapeHtml(g.id) + '" data-group-cn="' + escapeHtml(g.name_cn) + '">' +
          '<input type="checkbox" value="' + escapeHtml(g.id) + '"' + (checked ? ' checked' : '') + '>' +
          escapeHtml(groupDisplayName(g)) + '</label>';
      }).join('') + '</div></section>';
  }).join('');
  // Native label activation also supports Space and keeps checked state reliable.
  container.querySelectorAll('input').forEach(function(input) {
    input.addEventListener('change', function() {
      input.closest('.group-checkbox-item').classList.toggle('selected', input.checked);
    });
  });
}

function populateGroupCheckboxes(selectedGroups) {
  renderGroupCheckboxes('addGroupCheckboxes', selectedGroups || [state.currentGroup]);
}

function setBatchError(id, message) {
  var error = document.getElementById(id);
  error.textContent = message || '';
  error.classList.toggle('show', !!message);
  error.setAttribute('role', 'alert');
}

// Live check: tag exists?
document.getElementById('addTagName').addEventListener('input', function() {
  if (_presetFormMode) return;
  var name = this.value.trim().toLowerCase();
  var hint = document.getElementById('addTagExistsHint');
  if (!name) { hint.classList.remove('show'); return; }

  // In edit mode, exclude the original tag name from conflict check
  var isSelf = _editingOriginalName && _editingOriginalName.toLowerCase() === name;
  var exists = state.allTags.some(function(t) { return t.name.toLowerCase() === name; });

  if (_editingOriginalName) {
    // Edit mode
    if (exists && !isSelf) {
      hint.classList.add('show');
      hint.textContent = '该标签名已被其他标签使用！';
    } else {
      hint.classList.remove('show');
    }
    document.getElementById('addModalTitle').textContent = '编辑通用标签';
    document.getElementById('addTagSubmit').textContent = '更新';
  } else {
    // Add mode
    if (exists) {
      hint.classList.add('show');
      hint.textContent = '该标签已存在，提交将更新现有数据';
      document.getElementById('addModalTitle').textContent = '更新通用标签';
      document.getElementById('addTagSubmit').textContent = '更新';
      // Auto-fill existing data
      var existing = state.allTags.find(function(t) { return t.name.toLowerCase() === name; });
      if (existing) {
        fillGeneralTagForm(existing);
        populateGroupCheckboxes(existing.groups || []);
      }
    } else {
      hint.classList.remove('show');
      document.getElementById('addModalTitle').textContent = '新建通用标签';
      document.getElementById('addTagSubmit').textContent = '保存通用标签';
    }
  }
});

async function submitAddTag() {
  document.getElementById('addTagError').classList.remove('show');
  var tagName = document.getElementById('addTagName').value.trim();
  if (!tagName) {
    var errorEl = document.getElementById('addTagError');
    errorEl.textContent = _presetFormMode ? '请输入完整角色提示词' : '请输入通用标签名';
    errorEl.classList.add('show');
    return;
  }

  if (_presetFormMode) {
    await submitCharacterPreset(tagName);
    return;
  }

  // In edit mode, check new name doesn't conflict with another existing tag
  if (_editingOriginalName && _editingOriginalName !== tagName) {
    var conflict = state.allTags.some(function(t) { return t.name !== _editingOriginalName && t.name.toLowerCase() === tagName.toLowerCase(); });
    if (conflict) {
      var errorEl = document.getElementById('addTagError');
      errorEl.textContent = '标签名 "' + tagName + '" 已被其他标签使用，无法重命名';
      errorEl.classList.add('show');
      return;
    }
  }

  var groups = [];
  var groupsCn = [];
  document.querySelectorAll('#addGroupCheckboxes input:checked').forEach(function(cb) {
    var item = cb.closest('.group-checkbox-item');
    groups.push(cb.value);
    groupsCn.push(item.dataset.groupCn);
  });

  var payload = {
    name: tagName,
    tag_cn: document.getElementById('addTagCn').value.trim(),
    confidence: document.getElementById('addTagConfidence').value,
    tag_cn_long: document.getElementById('addTagLongDesc').value.trim(),
    original_name: _editingOriginalName,
    category_group_id: _editingCategoryGroupId && groups.indexOf(_editingCategoryGroupId) !== -1 ? _editingCategoryGroupId : (groups[0] || ''),
    category_path: document.getElementById('addTagCategory').value.trim(),
    groups: groups,
    groups_cn: groupsCn,
    wiki_url: document.getElementById('addTagWiki').value.trim(),
  };

  var submitBtn = document.getElementById('addTagSubmit');
  submitBtn.disabled = true;
  submitBtn.textContent = '提交中...';

  try {
    // Rename and content changes commit together in one catalogue transaction.
    var r = await fetch('/api/add-tag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    var result = await r.json();
    if (result.error) {
      var errorEl = document.getElementById('addTagError');
      errorEl.textContent = result.error;
      errorEl.classList.add('show');
      submitBtn.disabled = false;
      submitBtn.textContent = '更新';
      return;
    }

    document.getElementById('addModalOverlay').classList.remove('show');
    showToast('已更新: ' + tagName);
    _editingOriginalName = null;
    submitBtn.disabled = false;

    await reloadTagCatalogue();
    if (state.currentGroup) {
      await selectGroup(state.currentGroup);
    }
  } catch (e) {
    var errorEl = document.getElementById('addTagError');
    errorEl.textContent = '提交失败: ' + e.message;
    errorEl.classList.add('show');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = _editingOriginalName ? '更新' : '保存通用标签';
  }
}

async function submitCharacterPreset(prompt) {
  var groupId = _editingPresetGroupId || document.getElementById('addPresetGroup').value;
  var group = state.groups.find(function(item) { return item.id === groupId && isCharacterGroup(item); });
  // 未手动选分组时后端落入固定“未分类”，这里不再拦截报错。
  var title = document.getElementById('addTagCn').value.trim();
  if (!title) {
    var titleError = document.getElementById('addTagError');
    titleError.textContent = '请输入卡片左上角角色名';
    titleError.classList.add('show');
    return;
  }
  var submitBtn = document.getElementById('addTagSubmit');
  submitBtn.disabled = true;
  submitBtn.textContent = '提交中...';
  try {
    var response = await fetch('/api/upsert-character-preset', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        original_name: _editingPresetOriginalName || '',
        prompt: prompt,
        tag_cn: title,
        tag_cn_long: document.getElementById('addTagLongDesc').value.trim(),
        group_id: group ? group.id : '',
        group_cn: group ? group.name_cn : '未分类',
        category_path: document.getElementById('addPresetCategory').value,
      }),
    });
    var result = await response.json();
    if (!result.success) throw new Error(result.error || '保存失败');
    document.getElementById('addModalOverlay').classList.remove('show');
    showToast(_editingPresetOriginalName ? '已更新角色提示词卡' : '已新建角色提示词卡');
    if (!_editingPresetOriginalName) {
      // A previous search must not hide the card that was just created.
      state.searchQuery = '';
      document.getElementById('globalSearch').value = '';
    }
    _editingPresetOriginalName = null;
    characterAllTagsCache = null;
    if (group) groupCountCache.delete(group.id);
    else await reloadTagCatalogue(); // 未分类可能刚由后端建立，同步分组表
    await selectGroup(state.currentGroup === 'character_all' ? 'character_all' : (group ? group.id : 'character_ungrouped'));
    loadGroupCounts();
  } catch (e) {
    var errorEl = document.getElementById('addTagError');
    errorEl.textContent = '保存失败: ' + e.message;
    errorEl.classList.add('show');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = _editingPresetOriginalName ? '更新角色卡' : '保存角色卡';
  }
}

async function deleteSelectedTags() {
  if (deletingSelectedTags || !state.selectedTagNames.size) return;
  var names = Array.from(state.selectedTagNames);
  if (!confirm('确定删除已选择的 ' + names.length + ' 个标签吗？\n这些标签或角色卡将从所有分组中删除，不生成备份。')) return;
  closeBatchOperations();
  deletingSelectedTags = true;
  updateSelectionControls();
  try {
    var response = await fetch('/api/delete-tags', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({names: names})
    });
    var result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || '删除失败');
    names.forEach(function(name) { state.selectedTagNames.delete(name); });
    await reloadTagCatalogue();
    await selectGroup(state.currentGroup || ((state.view === 'characters') ? 'character_all' : 'all'));
    showToast('已删除 ' + result.deleted_count + ' 个标签');
  } catch (error) {
    showToast('删除失败: ' + error.message);
  } finally {
    deletingSelectedTags = false;
    updateSelectionControls();
  }
}

async function deleteCurrentTag() {
  var tagName = _editingOriginalName || document.getElementById('addTagName').value.trim();
  if (!tagName) return;
  if (!confirm('确定要删除标签 "' + tagName + '" 吗？\n此操作将从所有分组中移除该标签，且不可撤销。')) return;

  try {
    var resp = await fetch('/api/delete-tag', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name: tagName})
    });
    var result = await resp.json();
    if (result.success) {
      document.getElementById('addModalOverlay').classList.remove('show');
      showToast('已删除: ' + tagName);
      _editingOriginalName = null;
      await reloadTagCatalogue();
      if (state.currentGroup) {
        await selectGroup(state.currentGroup);
      }
    } else {
      var errorEl = document.getElementById('addTagError');
      errorEl.textContent = '删除失败: ' + (result.error || 'unknown');
      errorEl.classList.add('show');
    }
  } catch(e) {
    var errorEl = document.getElementById('addTagError');
    errorEl.textContent = '删除失败: ' + e.message;
    errorEl.classList.add('show');
  }
}

document.getElementById('addTagDeleteBtn').addEventListener('click', deleteCurrentTag);
document.getElementById('addTagHeaderBtn').addEventListener('click', openAddModal);
document.getElementById('addModalClose').addEventListener('click', function() {
  CardEditors.requestClose('tag');
});
document.getElementById('addTagCancel').addEventListener('click', function() {
  CardEditors.requestClose('tag');
});
// 编辑表单不能因误点遮罩层关闭，避免尚未保存的输入丢失。
document.getElementById('addTagSubmit').addEventListener('click', submitAddTag);
CardEditors.register('tag', {
  overlay: document.getElementById('addModalOverlay'), baseline: null,
  title: function() { return _presetFormMode ? '角色卡片' : '通用标签卡片'; },
  busy: function() { return document.getElementById('addTagSubmit').disabled; },
  snapshot: function() {
    var values = ['addTagName', 'addTagCn', 'addTagLongDesc'].map(function(id) { return document.getElementById(id).value.trim(); });
    if (_presetFormMode) values.push(document.getElementById('addPresetGroup').value, document.getElementById('addPresetCategory').value);
    else {
      values.push(document.getElementById('addTagConfidence').value, document.getElementById('addTagCategory').value.trim(), document.getElementById('addTagWiki').value.trim());
      values.push(Array.from(document.querySelectorAll('#addGroupCheckboxes input:checked')).map(function(input) { return input.value; }).sort());
    }
    return values;
  },
  save: submitAddTag,
  close: function() { document.getElementById('addModalOverlay').classList.remove('show'); }
});

// 普通 Enter 提交；Shift+Enter 保留多行提示词的换行行为。
document.getElementById('addTagName').addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitAddTag(); }
});

/* ========== Unified Group Functions ========== */

// Close any open group picker
function closeAllGroupPickers() {
  document.querySelectorAll('.group-picker-popup').forEach(function(p) { p.style.display = 'none'; });
}

// Toggle group picker popup for a tag row
function toggleGroupPicker(btn) {
  var popup = btn.nextElementSibling;
  var wasOpen = popup.style.display !== 'none';
  closeAllGroupPickers();
  if (wasOpen) return;

  var tagName = btn.dataset.tag;

  // Check which groups this tag is already in
  var tagData = state.allTags.find(function(t) { return t.name === tagName; });
  var tagGroups = tagData ? (tagData.groups || []) : [];

  // Only offer groups that are visible in the current left sidebar.
  var allGroups = getSidebarGroups().slice().sort(function(a, b) {
    return (a.name_cn || '').localeCompare(b.name_cn || '');
  });

  var html = groupChoiceSections(allGroups).map(function(section) {
    return '<div class="group-choice-heading">' + section.title + '</div>' + section.groups.map(function(g) {
      var inGroup = tagGroups.indexOf(g.id) !== -1;
      return '<div class="picker-item ' + (inGroup ? 'in-group' : '') + '" data-gid="' + escapeHtml(g.id) + '" data-gcn="' + escapeHtml(g.name_cn) + '" data-tag="' + escapeHtml(tagName) + '">' +
        escapeHtml(groupDisplayName(g)) + '</div>';
    }).join('');
  }).join('');
  popup.innerHTML = html;

  popup.querySelectorAll('.picker-item').forEach(function(item) {
    item.addEventListener('click', function() {
      var gid = item.dataset.gid;
      var gcn = item.dataset.gcn;
      var tn = item.dataset.tag;
      var isIn = item.classList.contains('in-group');
      if (isIn) {
        removeTagFromGroup(tn, gid, gcn, item);
      } else {
        addTagToGroup(tn, gid, gcn, item);
      }
    });
  });

  popup.style.display = 'block';

  // Close on outside click
  setTimeout(function() {
    document.addEventListener('click', closePickerOutside);
  }, 0);
}

function closePickerOutside(e) {
  if (!e.target.closest('.group-picker-popup') && !e.target.closest('.add-to-group-btn')) {
    closeAllGroupPickers();
    document.removeEventListener('click', closePickerOutside);
  }
}

async function addTagToGroup(tagName, groupId, groupCn, itemEl) {
  try {
    var resp = await fetch('/api/add-tags-to-group', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({tag_names: [tagName], group_id: groupId, group_cn: groupCn})
    });
    var result = await resp.json();
    if (result.success) {
      showToast('已添加到: ' + groupCn);
      if (itemEl) itemEl.classList.add('in-group');
      await reloadTagCatalogue();
      if (state.currentGroup === groupId || state.currentGroup === 'character_all') {
        selectGroup(state.currentGroup);
      }
      loadGroupCounts();
    } else {
      showToast('错误: ' + (result.error || 'unknown'));
    }
  } catch(e) {
    showToast('请求失败: ' + e.message);
  }
}

function closeBatchOperations() {
  document.getElementById('batchOperationsOverlay').classList.remove('show');
}
function openBatchOperations() {
  if (!state.selectedTagNames.size) return;
  updateSelectionControls();
  document.getElementById('batchOperationsHint').textContent = '已选择 ' + state.selectedTagNames.size + ' 个标签或角色卡，请选择操作。';
  document.getElementById('batchOperationsOverlay').classList.add('show');
}
function closeBatchCategoryModal() {
  document.getElementById('batchCategoryOverlay').classList.remove('show');
}
function refreshBatchCategoryTargets() {
  var gid = document.getElementById('batchCategoryGroup').value;
  var group = state.groups.find(function(g) { return g.id === gid; });
  populateCategoryOptions('batchCategoryTarget', gid, '');
  var available = !!(group && group.categories && group.categories.length);
  document.getElementById('batchCategoryTarget').disabled = !available;
  document.getElementById('batchCategorySubmit').disabled = !available;
}
function openBatchCategoryModal() {
  var names = Array.from(state.selectedTagNames);
  if (!names.length) return;
  closeBatchOperations();
  var memberships = new Map();
  state.currentGroupTags.forEach(function(tag) {
    if (!state.selectedTagNames.has(tag.name)) return;
    if (!memberships.has(tag.name)) memberships.set(tag.name,new Set());
    (tag.groups || []).forEach(function(id) { memberships.get(tag.name).add(id); });
    if (tag.source_group_id) memberships.get(tag.name).add(tag.source_group_id);
  });
  var groups = getSidebarGroups().filter(function(group) {
    return names.every(function(name) { return memberships.has(name) && memberships.get(name).has(group.id); });
  });
  document.getElementById('batchCategoryHint').textContent = '已选择 ' + names.length + ' 个标签或角色卡。';
  document.getElementById('batchCategoryGroup').innerHTML = groups.map(function(group) {
    return '<option value="' + escapeHtml(group.id) + '">' + escapeHtml(groupDisplayName(group)) + '</option>';
  }).join('');
  if (groups.some(function(g) { return g.id === state.currentGroup; })) document.getElementById('batchCategoryGroup').value = state.currentGroup;
  setBatchError('batchCategoryError',groups.length ? '' : '所选标签没有共同所属分组，请进入具体分组选择，或先使用“移动分组”。');
  refreshBatchCategoryTargets();
  document.getElementById('batchCategoryOverlay').classList.add('show');
}
async function submitBatchCategoryMove() {
  var names = Array.from(state.selectedTagNames);
  var gid = document.getElementById('batchCategoryGroup').value;
  var path = document.getElementById('batchCategoryTarget').value;
  var button = document.getElementById('batchCategorySubmit');
  if (!names.length || !gid || !path) return;
  button.disabled = true;
  setBatchError('batchCategoryError','');
  try {
    var response = await fetch('/api/move-tags-to-category',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tag_names:names,group_id:gid,category_path:path})});
    var result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || '移动失败');
    names.forEach(function(name) { state.selectedTagNames.delete(name); });
    closeBatchCategoryModal();
    await reloadTagCatalogue();
    await selectGroup(state.currentGroup || ((state.view === 'characters') ? 'character_all' : 'all'));
    showToast('已移动 ' + result.moved + ' 个标签的二级分组');
  } catch(error) { setBatchError('batchCategoryError',error.message); }
  finally { button.disabled = false; }
}
document.getElementById('batchOperationsBtn').addEventListener('click',openBatchOperations);
['batchOperationsClose','batchOperationsCancel'].forEach(function(id) { document.getElementById(id).addEventListener('click',closeBatchOperations); });
document.getElementById('batchMoveCategoryBtn').addEventListener('click',openBatchCategoryModal);
['batchCategoryClose','batchCategoryCancel'].forEach(function(id) { document.getElementById(id).addEventListener('click',closeBatchCategoryModal); });
document.getElementById('batchCategoryGroup').addEventListener('change',refreshBatchCategoryTargets);
document.getElementById('batchCategorySubmit').addEventListener('click',submitBatchCategoryMove);

function closeBatchGroupModal() {
  document.getElementById('batchGroupModalOverlay').classList.remove('show');
}

function openBatchGroupModal() {
  var names = Array.from(state.selectedTagNames);
  if (!names.length) return;
  document.getElementById('batchGroupSelectionHint').textContent = '已选择 ' + names.length + ' 条提示词。可一次加入一个或多个分组。';
  setBatchError('batchGroupError', '');
  renderGroupCheckboxes('batchGroupCheckboxes', []);
  document.getElementById('batchGroupModalOverlay').classList.add('show');
}

async function submitBatchAddGroups() {
  var selectedGroups = Array.prototype.slice.call(document.querySelectorAll('#batchGroupCheckboxes input:checked')).map(function(input) {
    var item = input.closest('.group-checkbox-item');
    return { id: item.dataset.groupId, name_cn: item.dataset.groupCn };
  });
  if (!selectedGroups.length) {
    setBatchError('batchGroupError', '请至少选择一个分组。');
    return;
  }
  var names = Array.from(state.selectedTagNames);
  var submitButton = document.getElementById('batchGroupSubmit');
  var originalText = submitButton.textContent;
  submitButton.disabled = true;
  submitButton.textContent = '添加中…';
  setBatchError('batchGroupError', '');
  try {
    for (var i = 0; i < selectedGroups.length; i++) {
      var group = selectedGroups[i];
      var response = await fetch('/api/add-tags-to-group', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({tag_names: names, group_id: group.id, group_cn: group.name_cn})
      });
      var result = await response.json();
      if (!result.success) throw new Error(result.error || '未知错误');
    }
    await reloadTagCatalogue();
    // 角色卡的增删发生在分组内容文件里，聚合视图与分组计数缓存都要失效。
    if ((state.view === 'characters')) { characterAllTagsCache = null; groupCountCache.clear(); }
    state.selectedTagNames.clear();
    closeBatchGroupModal();
    if (state.currentGroup) await selectGroup(state.currentGroup);
    else applyFilters();
    loadGroupCounts();
    showToast('已将 ' + names.length + ' 条提示词加入 ' + selectedGroups.length + ' 个分组');
  } catch (e) {
    setBatchError('batchGroupError', '添加失败：' + e.message);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = originalText;
  }
}

function closeBatchMoveModal() {
  document.getElementById('batchMoveModalOverlay').classList.remove('show');
}

function openBatchMoveModal() {
  var names = Array.from(state.selectedTagNames);
  if (!names.length) return;
  document.getElementById('batchMoveSelectionHint').textContent =
    '已选择 ' + names.length + ' 条提示词。移动后它们将只属于勾选的分组，并从其他分组移除。';
  setBatchError('batchMoveError', '');
  renderGroupCheckboxes('batchMoveCheckboxes', []);
  document.getElementById('batchMoveModalOverlay').classList.add('show');
}

async function submitBatchMoveGroups() {
  var selectedGroups = Array.prototype.slice.call(document.querySelectorAll('#batchMoveCheckboxes input:checked')).map(function(input) {
    var item = input.closest('.group-checkbox-item');
    return { id: item.dataset.groupId, name_cn: item.dataset.groupCn };
  });
  if (!selectedGroups.length) {
    setBatchError('batchMoveError', '请至少选择一个目标分组。');
    return;
  }
  var names = Array.from(state.selectedTagNames);
  var submitButton = document.getElementById('batchMoveSubmit');
  var originalText = submitButton.textContent;
  submitButton.disabled = true;
  submitButton.textContent = '移动中…';
  setBatchError('batchMoveError', '');
  try {
    var response = await fetch('/api/move-tags-to-group', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({tag_names: names, groups: selectedGroups})
    });
    var result = await response.json();
    if (!result.success) throw new Error(result.error || '未知错误');
    await reloadTagCatalogue();
    if ((state.view === 'characters')) { characterAllTagsCache = null; groupCountCache.clear(); }
    state.selectedTagNames.clear();
    closeBatchMoveModal();
    if (state.currentGroup) await selectGroup(state.currentGroup);
    loadGroupCounts();
    showToast('已将 ' + names.length + ' 条提示词移动到 ' + selectedGroups.length + ' 个分组');
  } catch (e) {
    setBatchError('batchMoveError', '移动失败：' + e.message);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = originalText;
  }
}

async function removeTagFromGroup(tagName, groupId, groupCn, itemEl) {
  try {
    var resp = await fetch('/api/remove-tag-from-group', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({tag_name: tagName, group_id: groupId, group_cn: groupCn})
    });
    var result = await resp.json();
    if (result.success) {
      showToast('已从 ' + groupCn + ' 移除');
      if (itemEl) itemEl.classList.remove('in-group');
      await reloadTagCatalogue();
      if (state.currentGroup === groupId) {
        selectGroup(groupId);
      }
      loadGroupCounts();
    } else {
      showToast('错误: ' + (result.error || 'unknown'));
    }
  } catch(e) {
    showToast('请求失败: ' + e.message);
  }
}

// New group modal
function openNewGroupModal() {
  document.getElementById('newGroupName').value = '';
  document.getElementById('newGroupError').textContent = '';
  document.getElementById('newGroupModalOverlay').classList.add('show');
  document.getElementById('newGroupName').focus();
}

async function submitNewGroup() {
  var name = document.getElementById('newGroupName').value.trim();
  if (!name) { document.getElementById('newGroupError').textContent = '请输入分组名称'; return; }
  var button = document.getElementById('newGroupSave');
  button.disabled = true;
  try {
    if (await createGroup(name)) document.getElementById('newGroupModalOverlay').classList.remove('show');
  } finally { button.disabled = false; }
}

document.getElementById('newGroupSave').addEventListener('click', submitNewGroup);
document.getElementById('newGroupName').addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); submitNewGroup(); } });
['newGroupCancel', 'newGroupClose'].forEach(function(id) {
  document.getElementById(id).addEventListener('click', function() { document.getElementById('newGroupModalOverlay').classList.remove('show'); });
});

async function createGroup(nameCn) {
  try {
    var resp = await fetch('/api/create-group', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name_cn: nameCn, library:(state.view === 'characters') ? 'character' : 'general'})
    });
    var result = await resp.json();
    if (result.success) {
      await reloadTagCatalogue();
      showToast('分组已创建: ' + nameCn);
      return true;
    } else {
      showToast('创建失败: ' + (result.error || 'unknown'));
      document.getElementById('newGroupError').textContent = result.error || '创建失败';
    }
  } catch(e) {
    showToast('请求失败: ' + e.message);
    document.getElementById('newGroupError').textContent = '创建失败：' + e.message;
  }
  return false;
}

function toggleGroupSearch(groupId) {
  var group = state.groups.find(function(item) { return item.id === groupId; });
  if (!group) return;
  var nextEnabled = group.search_enabled === false;
  fetch('/api/toggle-group-search', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({id: groupId, search_enabled: nextEnabled})
  }).then(function(resp) { return resp.json(); }).then(async function(result) {
    if (!result.success) throw new Error(result.error || '保存失败');
    await reloadTagCatalogue();
    if (state.currentGroup) await selectGroup(state.currentGroup);
    showToast('“' + group.name_cn + '”' + (result.search_enabled ? '已取消归档，组内提示词恢复可见' : '已归档，组内提示词已对外隐藏'));
  }).catch(function(error) {
    showToast('搜索设置保存失败: ' + error.message);
  });
}

// Group names and bilingual category labels are edited together.
var groupEditDraft = null;
function collectGroupCategoryRows() {
  if (!groupEditDraft) return;
  document.querySelectorAll('#groupCategoryRows .group-category-row').forEach(function(row) {
    var item = groupEditDraft.rows[Number(row.dataset.index)];
    item.name_cn = row.querySelector('[data-field="name_cn"]').value;
    item.name_en = row.querySelector('[data-field="name_en"]').value;
  });
}
function renderGroupCategoryRows() {
  document.getElementById('groupCategoryRows').innerHTML = groupEditDraft.rows.map(function(row, index) {
    return '<div class="group-category-row" data-index="' + index + '">' +
      '<label>二级分组中文名<input class="form-input" data-field="name_cn" aria-label="二级分组中文名 ' + (index + 1) + '" value="' + escapeHtml(row.name_cn) + '"></label>' +
      '<label>二级分组英文名<input class="form-input" data-field="name_en" aria-label="二级分组英文名 ' + (index + 1) + '" value="' + escapeHtml(row.name_en) + '"></label>' +
      '<button class="btn-danger" data-remove="' + index + '">删除</button></div>';
  }).join('');
}
async function openRenameGroupModal(groupId) {
  try {
    var group = state.groups.find(function(g) { return g.id === groupId; });
    if (!group) return;
    var data = await loadGroupData(group);
    groupEditDraft = {
      id:group.id, expected_categories:JSON.parse(JSON.stringify(group.categories || [])),
      expected_name_cn:group.name_cn, expected_name_en:group.name_en || '',
      rows:(data.categories || []).map(function(c) { return {path:c.path, name_cn:c.name_cn || c.h5 || c.h4 || c.path, name_en:c.name_en || c.h5 || c.h4 || c.path}; })
    };
    document.getElementById('groupEditCn').value = group.name_cn;
    document.getElementById('groupEditEn').value = group.name_en || '';
    document.getElementById('groupEditError').classList.remove('show');
    renderGroupCategoryRows();
    document.getElementById('groupEditModalOverlay').classList.add('show');
  } catch (error) { showToast('分组加载失败: ' + error.message); }
}
async function saveGroupEditor() {
  if (!groupEditDraft) return;
  collectGroupCategoryRows();
  var button = document.getElementById('groupEditSave');
  var error = document.getElementById('groupEditError');
  error.classList.remove('show');
  button.disabled = true;
  try {
    var resp = await fetch('/api/update-group', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({id:groupEditDraft.id, name_cn:document.getElementById('groupEditCn').value.trim(), name_en:document.getElementById('groupEditEn').value.trim(), categories:groupEditDraft.rows,
        expected_categories:groupEditDraft.expected_categories, expected_name_cn:groupEditDraft.expected_name_cn, expected_name_en:groupEditDraft.expected_name_en})
    });
    var result = await resp.json();
    if (!resp.ok || !result.success) throw new Error(result.error || '保存失败');
    document.getElementById('groupEditModalOverlay').classList.remove('show');
    await reloadTagCatalogue();
    if (state.currentGroup) await selectGroup(state.currentGroup);
    showToast('分组已保存');
  } catch(e) { error.textContent = e.message; error.classList.add('show'); }
  finally { button.disabled = false; }
}
document.getElementById('groupCategoryAdd').addEventListener('click', function() {
  collectGroupCategoryRows();
  groupEditDraft.rows.push({path:null, name_cn:'', name_en:''});
  renderGroupCategoryRows();
  var inputs = document.querySelectorAll('#groupCategoryRows [data-field="name_cn"]');
  inputs[inputs.length - 1].focus();
});
document.getElementById('groupCategoryRows').addEventListener('click', function(event) {
  var button = event.target.closest('[data-remove]');
  if (!button) return;
  collectGroupCategoryRows();
  groupEditDraft.rows.splice(Number(button.dataset.remove), 1);
  renderGroupCategoryRows();
});
['groupEditClose','groupEditCancel'].forEach(function(id) { document.getElementById(id).addEventListener('click', function() { document.getElementById('groupEditModalOverlay').classList.remove('show'); }); });
document.getElementById('groupEditSave').addEventListener('click', saveGroupEditor);
document.getElementById('addPresetGroup').addEventListener('change', function() { populateCategoryOptions('addPresetCategory', this.value, ''); });
document.getElementById('addGroupCheckboxes').addEventListener('change', function() {
  var checked = Array.from(this.querySelectorAll('input:checked')).map(function(input) { return input.value; });
  var gid = checked.includes(_editingCategoryGroupId) ? _editingCategoryGroupId : checked[0] || '';
  if (gid !== _editingCategoryGroupId) {
    _editingCategoryGroupId = gid;
    populateCategoryOptions('addTagCategory', gid, '');
    var group = state.groups.find(function(g) { return g.id === gid; });
    document.getElementById('addTagCategoryLabel').textContent = group ? '分类（' + groupDisplayName(group) + '）' : '分类（保存到首个勾选分组）';
  }
});

// Delete group
function deleteGroup(groupId, groupCn) {
  if (!confirm('确定删除分组"' + groupCn + '"吗？该分组下的标签不会被删除，只是从分组中移除。')) return;

  fetch('/api/delete-group', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({id: groupId})
  }).then(function(resp) { return resp.json(); }).then(async function(result) {
    if (result.success) {
      var deletedCurrent = state.currentGroup === groupId;
      await reloadTagCatalogue();
      await selectGroup(deletedCurrent ? ((state.view === 'characters') ? 'character_all' : 'all') : (state.currentGroup || 'all'));
      showToast('分组已删除: ' + groupCn);
    } else {
      showToast('删除失败: ' + (result.error || 'unknown'));
    }
  }).catch(function(e) {
    showToast('请求失败: ' + e.message);
  });
}

applyTagTablePreferences();

document.getElementById('tagRowHeightInput').addEventListener('input', function() {
  tagTablePreferences.rowHeight = Number(this.value);
  applyTagTablePreferences();
  saveTagTablePreferences();
  if (state.currentGroup && state.filteredTags.length) applyFilters();
});
document.getElementById('toggleCategoryColumnBtn').addEventListener('click', function() {
  tagTablePreferences.hideCategory = !tagTablePreferences.hideCategory;
  applyTagTablePreferences();
  saveTagTablePreferences();
});
// 合并后的置信度开关：一次切换筛选行与列。
document.getElementById('toggleConfidenceFilterBtn').addEventListener('click', function() {
  tagTablePreferences.hideConfidence = !tagTablePreferences.hideConfidence;
  applyTagTablePreferences();
  saveTagTablePreferences();
});
document.getElementById('toggleLongDescriptionSearchBtn').addEventListener('click', function() {
  tagTablePreferences.matchLongDescription = !tagTablePreferences.matchLongDescription;
  applyTagTablePreferences();
  saveTagTablePreferences();
  // The button sits in the header now, so re-run the active view's filter
  // explicitly instead of relying on the old toolbar-click bubbling.
  if (state.currentGroup) {
    state.page = 1;
    applyFilters();
  }
});
document.getElementById('tableContainer').addEventListener('click', function(event) {
  var button = event.target.closest('button[data-action]');
  if (!button) return;
  event.stopPropagation();
  var tagName = button.dataset.tag;
  if (button.dataset.action === 'copy-tag') {
    copyText(tagName || '');
  } else if (button.dataset.action === 'edit-tag') {
    openEditModal(tagName);
  } else if (button.dataset.action === 'toggle-pin') {
    toggleTagPin(tagName, button.dataset.pinned === 'true');
  } else if (button.dataset.action === 'group-picker') {
    toggleGroupPicker(button);
  }
});
document.getElementById('selectPageTagsBtn').addEventListener('click', function() {
  var rows = getRenderedTagRows();
  var selectAll = rows.some(function(row) { return !state.selectedTagNames.has(row.dataset.tagName); });
  rows.forEach(function(row) {
    if (selectAll) state.selectedTagNames.add(row.dataset.tagName);
    else state.selectedTagNames.delete(row.dataset.tagName);
  });
  renderTable();
});
document.getElementById('selectAllTagsBtn').addEventListener('click', function() {
  var tags = getGroupSelectionTags();
  var selectAll = tags.some(function(tag) { return !state.selectedTagNames.has(tag.name); });
  tags.forEach(function(tag) {
    if (selectAll) state.selectedTagNames.add(tag.name);
    else state.selectedTagNames.delete(tag.name);
  });
  renderTable();
  showToast(selectAll ? '已选择当前分组全部 ' + tags.length + ' 条标签（包含所有页）' : '已取消当前分组全部选择');
});
document.querySelectorAll('.select-page-checkbox').forEach(function(checkbox) {
  checkbox.addEventListener('change', function() {
    document.getElementById('selectPageTagsBtn').click();
  });
});
document.getElementById('batchAddGroupBtn').addEventListener('click', function() { closeBatchOperations(); openBatchGroupModal(); });
document.getElementById('batchGroupModalClose').addEventListener('click', closeBatchGroupModal);
document.getElementById('batchGroupCancel').addEventListener('click', closeBatchGroupModal);
document.getElementById('batchGroupSubmit').addEventListener('click', submitBatchAddGroups);
document.getElementById('batchGroupModalOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeBatchGroupModal();
});
document.getElementById('batchMoveGroupBtn').addEventListener('click', function() { closeBatchOperations(); openBatchMoveModal(); });
document.getElementById('deleteSelectedTagsBtn').addEventListener('click', deleteSelectedTags);
document.getElementById('batchMoveModalClose').addEventListener('click', closeBatchMoveModal);
document.getElementById('batchMoveCancel').addEventListener('click', closeBatchMoveModal);
document.getElementById('batchMoveSubmit').addEventListener('click', submitBatchMoveGroups);
document.getElementById('batchMoveModalOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeBatchMoveModal();
});
bindTagDragSelection();

/* ========== Settings & external links ========== */

var CUSTOM_BROWSER_VALUE = '__custom__';

function currentBrowserChoice() {
  var select = document.getElementById('settingsBrowserSelect');
  if (select.value !== CUSTOM_BROWSER_VALUE) return select.value;
  return document.getElementById('settingsCustomBrowser').value.trim();
}

function syncSettingsCustomRow() {
  var select = document.getElementById('settingsBrowserSelect');
  var custom = document.getElementById('settingsCustomBrowser');
  var row = document.getElementById('settingsCustomBrowserRow');
  var isCustom = select.value === CUSTOM_BROWSER_VALUE;
  row.style.display = isCustom ? 'block' : 'none';
  custom.disabled = !isCustom;
  if (isCustom) custom.focus();
}

async function openSettingsModal() {
  document.getElementById('settingsError').classList.remove('show');
  try {
    var resp = await fetch('/api/settings', { cache: 'no-store' });
    var data = await resp.json();
    var saved = data.open_url_browser || '';
    document.getElementById('settingsGroupLanguage').value = data.group_language || 'zh';
    document.getElementById('settingsCategoryLanguage').value = data.category_language || 'zh';
    document.getElementById('settingsUnratedConfidence').value = data.unrated_confidence || 'D';
    var select = document.getElementById('settingsBrowserSelect');
    var html = '<option value="">系统默认浏览器</option>';
    var matched = !saved;
    (data.browsers || []).forEach(function(b) {
      var selected = saved && b.path.toLowerCase() === saved.toLowerCase();
      if (selected) matched = true;
      html += '<option value="' + escapeHtml(b.path) + '"' + (selected ? ' selected' : '') + '>' +
        escapeHtml(b.name) + '</option>';
    });
    html += '<option value="' + CUSTOM_BROWSER_VALUE + '"' + (matched ? '' : ' selected') + '>自定义路径…</option>';
    select.innerHTML = html;
    document.getElementById('settingsCustomBrowser').value = matched ? '' : saved;
    syncSettingsCustomRow();
    document.getElementById('settingsModalOverlay').classList.add('show');
  } catch (e) {
    showToast('设置加载失败: ' + e.message);
  }
}

async function saveSettings() {
  var error = document.getElementById('settingsError');
  error.classList.remove('show');
  try {
    var resp = await fetch('/api/save-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ open_url_browser: currentBrowserChoice(), group_language:document.getElementById('settingsGroupLanguage').value, category_language:document.getElementById('settingsCategoryLanguage').value, unrated_confidence:document.getElementById('settingsUnratedConfidence').value })
    });
    var result = await resp.json();
    if (!resp.ok || !result.success) throw new Error(result.error || '保存失败');
    displaySettings.group_language = result.group_language;
    displaySettings.category_language = result.category_language;
    displaySettings.unrated_confidence = result.unrated_confidence || 'D';
    renderGroups();
    if (state.currentGroup) await selectGroup(state.currentGroup);
    document.getElementById('settingsModalOverlay').classList.remove('show');
    showToast('设置已保存');
  } catch (e) {
    error.textContent = e.message;
    error.classList.add('show');
  }
}

async function testBrowserOpen() {
  var error = document.getElementById('settingsError');
  error.classList.remove('show');
  try {
    var resp = await fetch('/api/open-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.bing.com', browser: currentBrowserChoice() })
    });
    var result = await resp.json();
    if (!resp.ok || !result.success) throw new Error(result.error || '打开失败');
    showToast('已调用所选浏览器打开测试网页');
  } catch (e) {
    error.textContent = '测试失败：' + e.message;
    error.classList.add('show');
  }
}

document.getElementById('settingsBtn').addEventListener('click', openSettingsModal);
document.getElementById('settingsClose').addEventListener('click', function() {
  document.getElementById('settingsModalOverlay').classList.remove('show');
});
document.getElementById('settingsCancel').addEventListener('click', function() {
  document.getElementById('settingsModalOverlay').classList.remove('show');
});
document.getElementById('settingsSave').addEventListener('click', saveSettings);
document.getElementById('settingsTestBtn').addEventListener('click', testBrowserOpen);
document.getElementById('settingsBrowserSelect').addEventListener('change', syncSettingsCustomRow);
document.getElementById('settingsModalOverlay').addEventListener('click', function(e) {
  if (e.target === this) this.classList.remove('show');
});

// 外部链接（模型来源、Wiki 等）统一交给后端，用“设置”里指定的浏览器打开。
document.addEventListener('click', function(event) {
  var link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
  if (!link) return;
  var href = link.getAttribute('href') || '';
  if (!/^https?:\/\//i.test(href)) return;
  if (href.indexOf(location.origin) === 0) return;
  event.preventDefault();
  fetch('/api/open-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: href })
  }).then(function(resp) { return resp.json(); }).then(function(result) {
    if (!result.success) showToast('打开链接失败: ' + (result.error || ''));
  }).catch(function() { showToast('打开链接失败'); });
}, true);



// Sidebar group search
document.getElementById('groupSearch').addEventListener('input', function() {
  renderGroups();
});

// Sidebar toggle (header button, so it never covers the tag table)
document.getElementById('sidebarToggle').addEventListener('click', function() {
  var sidebar = document.getElementById('sidebar');
  var collapsed = sidebar.classList.toggle('collapsed');
  this.innerHTML = collapsed ? '&#155;' : '&#139;';
  this.title = collapsed ? '展开侧边栏' : '收起侧边栏';
  // Re-render after transition
  setTimeout(function() {
    if (state.currentGroup && state.filteredTags.length > 0) {
      var ps = getPageSize();
      var maxPage = Math.max(1, Math.ceil(state.filteredTags.length / ps));
      if (state.page > maxPage) state.page = maxPage;
      renderTable();
      renderPagination();
    }
  }, 280);
});

// Re-render on resize so page size stays correct
var resizeTimer;
window.addEventListener('resize', function() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(function() {
    if (state.currentGroup && state.filteredTags.length > 0) {
      var ps = getPageSize();
      var maxPage = Math.max(1, Math.ceil(state.filteredTags.length / ps));
      if (state.page > maxPage) state.page = maxPage;
      renderTable();
      renderPagination();
    }
  }, 150);
});
