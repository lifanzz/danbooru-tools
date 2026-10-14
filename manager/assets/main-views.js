/* Main library controller: one active view, URL history and per-view snapshots. */
(function () {
  const host = document.getElementById('appNavigation');
function setMainView(mode) {
  var tagViews = mode !== 'models';
  var viewName = mode === 'characters' ? '角色提示词库' : mode === 'models' ? '模型管理' : '通用标签库';
  document.querySelector('.header-title').textContent = viewName;
  document.title = 'Danbooru 标签管理器 · ' + viewName;
  var addLabel = mode === 'characters' ? '新建角色提示词卡' : '新建通用标签';
  var addButton = document.getElementById('addTagHeaderBtn');
  addButton.title = addLabel;
  addButton.querySelector('.btn-text').textContent = addLabel;
  document.getElementById('sidebar').style.display = tagViews ? '' : 'none';
  document.getElementById('tableContainer').style.display = tagViews ? '' : 'none';
  document.getElementById('modelManagerView').style.display = mode === 'models' ? 'block' : 'none';
  document.querySelector('.header-stats').style.display = mode === 'tags' ? '' : 'none';
  if (mode === 'models') {
    document.getElementById('toolbar').style.display = 'none';
    document.getElementById('categoryTree').style.display = 'none';
    document.getElementById('pagination').style.display = 'none';
  } else if (state.currentGroup) {
    // Leaving the model manager must bring the tag toolbar back with the view.
    document.getElementById('toolbar').style.display = 'flex';
  }
  updateHeaderSearchSpace();
}

  var snapshots = {}, queue = Promise.resolve();
  try { snapshots = JSON.parse(sessionStorage.getItem('danbooruViews') || '{}'); } catch (_) {}
  var fields = ['currentGroup', 'currentCategory', 'confidenceFilter', 'searchQuery', 'sortKey', 'sortDir', 'page'];
  function scrollIds(mode) { return mode === 'models' ? ['modelManagerView','modelCategoryFilters'] : ['tableContainer','presetGrid','groupList']; }
  function persist() {
    if (!state.view) return;
    var saved = {scroll: {}};
    if (state.view !== 'models') {
      fields.forEach(function (key) { saved[key] = state[key]; });
      saved.groupSearch = document.getElementById('groupSearch').value;
      saved.sidebarCollapsed = document.getElementById('sidebar').classList.contains('collapsed');
    } else {
      saved.modelSearch = modelSearchQuery;
      saved.modelCategory = modelCategoryFilter;
      saved.expansion = Array.from(modelCategoryExpansion.entries());
    }
    scrollIds(state.view).forEach(function (id) { saved.scroll[id] = document.getElementById(id).scrollTop; });
    snapshots[state.view] = saved;
    try { sessionStorage.setItem('danbooruViews', JSON.stringify(snapshots)); } catch (_) {}
  }
  window.addEventListener('pagehide', persist);
  async function render(mode) {
    if (mode === state.view) return;
    persist();
    state.view = mode;
    var saved = snapshots[mode] || {};
    setMainView(mode);
    markNavigation(mode);
    document.getElementById('modelHeaderActions').hidden = mode !== 'models';
    document.getElementById('tagHeaderActions').hidden = mode === 'models';
    if (mode === 'models') {
      modelSearchQuery = saved.modelSearch || '';
      modelCategoryFilter = saved.modelCategory || 'all';
      modelCategoryExpansion = new Map(saved.expansion || []);
      document.getElementById('modelSearch').value = modelSearchQuery;
      await loadModels();
    } else {
      state.searchQuery = saved.searchQuery || '';
      state.confidenceFilter = saved.confidenceFilter || 'all';
      state.sortKey = saved.sortKey || 'name';
      state.sortDir = saved.sortDir || 'asc';
      document.getElementById('globalSearch').value = state.searchQuery;
      document.getElementById('globalSearch').placeholder = mode === 'characters' ? '搜索角色名称或完整提示词...' : '搜索通用标签...';
      document.getElementById('groupSearch').value = saved.groupSearch || '';
      document.getElementById('sidebar').classList.toggle('collapsed', !!saved.sidebarCollapsed);
      document.getElementById('sidebarToggle').textContent = saved.sidebarCollapsed ? '›' : '‹';
      renderGroups();
      var group = saved.currentGroup;
      var record = state.groups.find(function (g) { return g.id === group; });
      var valid = mode === 'characters' ? group === 'character_all' || record && isCharacterGroup(record) : group === 'all' || group === 'ungrouped' || record && !isCharacterGroup(record);
      await selectGroup(valid ? group : mode === 'characters' ? 'character_all' : 'all');
      state.currentCategory = saved.currentCategory || null;
      applyFilters();
      state.page = Math.min(Math.max(1, saved.page || 1), Math.max(1, Math.ceil(state.filteredTags.length / getPageSize())));
      document.querySelectorAll('[data-filter="confidence"]').forEach(function (button) { button.classList.toggle('active', button.dataset.value === state.confidenceFilter); });
      document.querySelectorAll('#categoryTree [data-cat]').forEach(function (chip) { chip.classList.toggle('active', (chip.dataset.cat || null) === state.currentCategory); });
      renderTable();
    }
    await new Promise(requestAnimationFrame);
    scrollIds(mode).forEach(function (id) { document.getElementById(id).scrollTop = (saved.scroll || {})[id] || 0; });
  }
  function requestedMode() {
    var mode = location.hash.slice(1);
    return ['tags', 'characters', 'models'].includes(mode) ? mode : 'tags';
  }
  function dispatch(mode) {
    queue = queue.then(function () { return render(mode); }).catch(function (error) { console.error('Navigation failed:', error); showToast('页面切换失败，请刷新重试。'); });
    return queue;
  }
  host.addEventListener('click', function (event) {
    var link = event.target.closest('a');
    if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    if (link.dataset.view === 'illustrated') {
      event.preventDefault();
      queue.then(function () { persist(); location.href = link.href; });
      return;
    }
    event.preventDefault();
    if (link.dataset.view === requestedMode()) return;
    history.pushState(null, '', link.href);
    dispatch(link.dataset.view);
  });
  window.addEventListener('popstate', function () { dispatch(requestedMode()); });
  window.addEventListener('hashchange', function () { dispatch(requestedMode()); });
  window.startMainViews = async function () {
    var params = new URLSearchParams(location.search);
    var mode = location.hash ? requestedMode() : params.has('model_id') ? 'models' : params.get('character_library') === '1' ? 'characters' : 'tags';
    history.replaceState(null, '', location.pathname + location.search + '#' + mode);
    await dispatch(mode);
    var search = params.get('search');
    if (search && mode !== 'models') {
      document.getElementById('globalSearch').value = search;
      state.searchQuery = search; applyFilters();
    }
    var modelId = params.get('model_id');
    if (modelId && mode === 'models') {
      if (modelRecords.some(function(model) { return model.id === modelId; })) openModelModal(modelId);
      else showToast('未找到此 LoRA 的模型库卡片；请先在模型库中刷新模型。');
      refreshModels(false);
    }
  };
})();
