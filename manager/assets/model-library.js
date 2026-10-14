/* Danbooru 标签管理器 — model library view (inventory, categories, covers,
   hash export). Depends on the shared helpers defined in app.js. */

/* ========== Model Library ========== */
var modelRecords = [];
var editingModelId = null;
var draggedModelId = null;
var modelCategoryFilter = 'all';
// Missing entries use the default (top-level folders open, nested folders
// closed); explicit entries remember a user's expand/collapse choice.
var modelCategoryExpansion = new Map();
var modelSearchQuery = '';
var modelScanSummary = null;
var editingModelPromptSets = [];
var editingModelPromptSetIndex = 0;
var modelEditorSession = 0;
var modelImageImports = 0;
var modelSaving = false;

function getModelPromptSets(model) {
  var sets = model && Array.isArray(model.prompt_sets) && model.prompt_sets.length
    ? model.prompt_sets : [{name: '', prompt: model ? model.prompt || '' : '', image_url: model ? model.image_url || '' : ''}];
  return sets.map(function(item) { return {name: item.name || '', prompt: item.prompt || '', image_url: item.image_url || ''}; });
}

function captureModelPromptSet() {
  var item = editingModelPromptSets[editingModelPromptSetIndex];
  if (!item) return;
  item.prompt = document.getElementById('modelPrompt').value;
}

function createModelPromptSetTab(index) {
  var item = editingModelPromptSets[index];
  var button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn-secondary model-prompt-set-tab' + (index === editingModelPromptSetIndex ? ' active' : '');
  button.dataset.setIndex = index;
  button.setAttribute('aria-pressed', String(index === editingModelPromptSetIndex));
  button.title = '选中后再次点击可修改小名称';
  button.textContent = (index + 1) + '. ' + (item.name.trim() || '未命名') + (index === 0 ? ' · 卡片展示' : '');
  button.addEventListener('click', function() {
    if (index === editingModelPromptSetIndex) { renameModelPromptSet(button, index); return; }
    captureModelPromptSet(); editingModelPromptSetIndex = index; showModelPromptSet();
  });
  return button;
}

function renameModelPromptSet(button, index) {
  var item = editingModelPromptSets[index];
  var originalName = item.name;
  var editor = document.createElement('span');
  editor.className = 'model-prompt-set-rename active';
  var prefix = document.createElement('span');
  prefix.textContent = (index + 1) + '. ';
  var input = document.createElement('input');
  input.type = 'text'; input.className = 'model-prompt-set-name-input';
  input.setAttribute('aria-label', '套组小名称');
  input.placeholder = '未命名'; input.value = item.name;
  editor.append(prefix, input);
  if (index === 0) {
    var suffix = document.createElement('span'); suffix.textContent = ' · 卡片展示'; editor.append(suffix);
  }
  button.replaceWith(editor);
  input.addEventListener('input', function() { item.name = input.value; });
  var finished = false;
  function finish(focusTab) {
    if (finished || !editor.isConnected) return;
    finished = true;
    var tab = createModelPromptSetTab(index);
    editor.replaceWith(tab);
    if (focusTab) tab.focus();
  }
  input.addEventListener('blur', function() { finish(false); });
  input.addEventListener('keydown', function(event) {
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Escape') item.name = originalName;
    finish(true);
  });
  input.focus(); input.select();
}

function renderModelPromptSetTabs() {
  document.getElementById('modelPromptSetTabs').replaceChildren.apply(document.getElementById('modelPromptSetTabs'), editingModelPromptSets.map(function(item, index) { return createModelPromptSetTab(index); }));
  document.getElementById('modelPromptSetUpBtn').disabled = editingModelPromptSetIndex === 0;
  document.getElementById('modelPromptSetDownBtn').disabled = editingModelPromptSetIndex === editingModelPromptSets.length - 1;
  document.getElementById('modelRemovePromptSetBtn').disabled = editingModelPromptSets.length === 1;
}

function showModelPromptSet() {
  var item = editingModelPromptSets[editingModelPromptSetIndex];
  document.getElementById('modelPrompt').value = item.prompt;
  setModelImageSelected(false);
  renderModelPromptSetTabs();
  updateModelImagePreview();
}

function moveModelPromptSet(offset) {
  captureModelPromptSet();
  var next = editingModelPromptSetIndex + offset;
  if (next < 0 || next >= editingModelPromptSets.length) return;
  var item = editingModelPromptSets.splice(editingModelPromptSetIndex, 1)[0];
  editingModelPromptSets.splice(next, 0, item);
  editingModelPromptSetIndex = next;
  showModelPromptSet();
}

function formatModelSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) return (bytes || 0) + ' B';
  var units = ['KB', 'MB', 'GB', 'TB'];
  var index = -1;
  do { bytes /= 1024; index += 1; } while (bytes >= 1024 && index < units.length - 1);
  return bytes.toFixed(bytes >= 10 || index === 0 ? 0 : 1) + ' ' + units[index];
}

function renderModelScanScope() {
  var element = document.getElementById('modelScanScope');
  if (!modelScanSummary || !Array.isArray(modelScanSummary.folders)) {
    element.innerHTML = '扫描范围：<strong>LoRA、UNet、Checkpoints</strong> 三个文件夹及其子文件夹。点击“刷新模型”读取实际文件。';
    return;
  }
  var detail = modelScanSummary.folders.map(function(folder) { return folder.label + ' ' + folder.count + ' 个'; }).join(' · ');
  element.innerHTML = '扫描范围：<strong>LoRA、UNet、Checkpoints</strong>（含子文件夹） · ' + detail + ' · 合计 <strong>' + modelScanSummary.total + ' 个模型文件</strong>（' + formatModelSize(modelScanSummary.bytes) + '）';
}

function safeExternalUrl(value) {
  try {
    var url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') ? url.href : '';
  } catch (e) { return ''; }
}

function safeImageUrl(value) {
  var externalUrl = safeExternalUrl(value);
  if (externalUrl) return externalUrl;
  var localPath = (value || '').replace(/\\/g, '/');
  return /^\/?data\/model_images\/[a-f0-9]{32}\.(png|jpe?g|webp|gif)$/i.test(localPath) ? '/' + localPath.replace(/^\//, '') : '';
}

function renderModels() {
  var grid = document.getElementById('modelGrid');
  var empty = document.getElementById('modelEmpty');
  renderModelCategoryFilters();
  updateModelCategoryDatalist();
  var visibleModels = modelRecords.filter(function(model) {
    var categoryMatches = matchesModelCategory(model, modelCategoryFilter);
    if (!categoryMatches) return false;
    if (!modelSearchQuery) return true;
    return DanbooruSearch.matchesModel(model,modelSearchQuery);
  });
  document.getElementById('modelSearchResult').textContent = modelSearchQuery ? ('找到 ' + visibleModels.length + ' / ' + modelRecords.length + ' 个模型') : ('显示 ' + visibleModels.length + ' / ' + modelRecords.length + ' 个模型');
  if (!visibleModels.length) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    empty.textContent = modelRecords.length ? (modelSearchQuery ? '没有符合搜索条件的模型。' : '此分类下还没有模型记录。') : '还没有模型记录。点击“添加模型”建立第一条记录。';
    return;
  }
  empty.style.display = 'none';
  grid.innerHTML = visibleModels.map(function(model) {
    var firstSet = getModelPromptSets(model)[0];
    var imageUrl = safeImageUrl(firstSet.image_url);
    var sourceUrl = safeExternalUrl(model.url || '');
    var cover = imageUrl
      ? '<img class="model-cover" src="' + escapeHtml(imageUrl) + '" alt="' + escapeHtml(model.name) + ' 封面" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">' +
        '<div class="model-cover" style="display:none;align-items:center;justify-content:center;">图片不可用</div>'
      : '<div class="model-cover" style="display:flex;align-items:center;justify-content:center;">暂无图片</div>';
    var link = sourceUrl ? '<a class="model-link" href="' + escapeHtml(sourceUrl) + '" target="_blank" rel="noopener noreferrer">打开来源网址</a>' : '<span class="model-link" style="color:var(--text-muted);">无有效网址</span>';
    return '<article class="model-card" data-model-id="' + escapeHtml(model.id) + '">' +
      '<div class="model-drag-handle" draggable="true" data-model-id="' + escapeHtml(model.id) + '" title="拖动此左上角把手调整顺序">&#8942;&#8942; 拖动</div>' + cover + '<div class="model-card-body">' +
      '<div class="model-card-title" title="' + escapeHtml(model.name) + '">' + escapeHtml(model.name) + '</div>' +
      '<div class="model-category-badge">' + escapeHtml(model.category || '未分类') + '</div>' +
      '<div class="model-card-path" title="' + escapeHtml(model.file_path) + '">' + escapeHtml(model.file_path) + '</div>' +
      (firstSet.name ? '<div class="model-card-set-name">' + escapeHtml(firstSet.name) + '</div>' : '') +
      (firstSet.prompt
        ? '<div class="model-card-prompt copyable" data-prompt-model-id="' + escapeHtml(model.id) + '" title="点击复制提示词：' + escapeHtml(firstSet.prompt) + '"><span class="model-prompt-copy-glyph" aria-hidden="true">&#128203;</span>' + escapeHtml(firstSet.prompt) + '</div>'
        : '<div class="model-card-prompt"></div>') +
      '<div class="model-card-actions">' + link + '<button class="model-edit-btn" data-model-id="' + escapeHtml(model.id) + '">编辑</button></div>' +
      '</div></article>';
  }).join('');
  grid.querySelectorAll('.model-edit-btn').forEach(function(button) {
    button.addEventListener('click', function() { openModelModal(button.dataset.modelId); });
  });
  grid.querySelectorAll('.model-card-prompt.copyable').forEach(function(row) {
    row.addEventListener('click', function() {
      var model = modelRecords.find(function(item) { return item.id === row.dataset.promptModelId; });
      if (model && getModelPromptSets(model)[0].prompt) copyText(getModelPromptSets(model)[0].prompt);
    });
  });
  setupModelDragAndDrop(grid);
}

function getModelCategories() {
  return Array.from(new Set(modelRecords.map(function(model) { return (model.category || '').trim(); }).filter(Boolean))).sort(function(a, b) { return a.localeCompare(b); });
}

function matchesModelCategory(model, filter) {
  var category = (model.category || '').trim();
  if (filter === 'all') return true;
  if (filter === '__uncategorized__') return !category;
  return category === filter || category.indexOf(filter + ' / ') === 0;
}

function buildModelCategoryTree() {
  var root = {children: {}, count: 0};
  modelRecords.forEach(function(model) {
    var category = (model.category || '').trim();
    if (!category) return;
    var node = root;
    category.split('/').map(function(part) { return part.trim(); }).filter(Boolean).forEach(function(part) {
      node.children[part] = node.children[part] || {children: {}, count: 0};
      node = node.children[part];
      node.count += 1;
    });
  });
  return root;
}

function categoryLabel(filter) {
  if (filter === 'all') return '全部模型';
  if (filter === '__uncategorized__') return '未分类';
  return filter;
}

var modelCategoryMenuCategory = 'all';
function closeModelCategoryMenu() {
  document.getElementById('modelCategoryMenu').hidden = true;
}
function openModelCategoryMenu(event, category) {
  event.preventDefault();
  modelCategoryMenuCategory = category;
  var menu = document.getElementById('modelCategoryMenu');
  menu.querySelector('[data-action="open"]').disabled = category === 'all' || category === '__uncategorized__';
  menu.hidden = false;
  var width = menu.offsetWidth, height = menu.offsetHeight;
  menu.style.left = Math.max(0, Math.min(event.clientX, window.innerWidth - width - 4)) + 'px';
  menu.style.top = Math.max(0, Math.min(event.clientY, window.innerHeight - height - 4)) + 'px';
}
var modelExportRunning = false;
async function exportModelCategory(category) {
  if (modelExportRunning) { showToast('模型配置表正在导出，请稍候'); return; }
  var models = modelRecords.filter(function(model) { return matchesModelCategory(model, category); });
  if (!models.length) { showToast('此分类没有可导出的模型'); return; }
  modelExportRunning = true;
  var status = document.getElementById('modelSearchResult');
  var previousStatus = status.textContent;
  try {
    for (var i = 0; i < models.length; i++) {
      var model = models[i];
      status.textContent = '正在核对 SHA-256：' + (i + 1) + ' / ' + models.length;
      var response = await fetch('/api/model-hash', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path: model.file_path})
      });
      var result = await response.json();
      if (!response.ok || !result.success || !/^[a-f0-9]{64}$/i.test(result.sha256 || '')) {
        throw new Error(model.name + '：' + (result.error || '未取得有效的 SHA-256'));
      }
      model.sha256 = result.sha256;
    }
  var columns = [
    ['模型名称', 'name'], ['分类目录', 'category'], ['模型文件名', 'file_name'],
    ['模型文件路径', 'file_path'], ['来源网址', 'url'], ['提示词', 'prompt'],
    ['推荐参数', 'recommended_params'], ['封面图片', 'image_url'], ['全部提示词图片组', 'prompt_sets'],
    ['文件大小（字节）', 'file_size'], ['文件修改时间', 'modified_at'], ['SHA-256', 'sha256']
  ];
  function cell(value) {
    var text = String(value == null ? '' : value);
    // Keep downloaded CSV data from becoming spreadsheet formulas.
    if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }
  var lines = [columns.map(function(column) { return cell(column[0]); }).join(',')];
  models.forEach(function(model) {
    lines.push(columns.map(function(column) {
      var value = column[1] === 'file_name' ? String(model.file_path || '').split(/[\\/]/).pop() : model[column[1]];
      if (column[1] === 'prompt_sets') value = JSON.stringify(getModelPromptSets(model));
      if (column[1] === 'modified_at' && Number(value)) value = new Date(Number(value) * 1000).toLocaleString('zh-CN');
      return cell(value);
    }).join(','));
  });
  var filename = categoryLabel(category).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  var url = URL.createObjectURL(new Blob(['\ufeff' + lines.join('\r\n')], {type: 'text/csv;charset=utf-8'}));
  var link = document.createElement('a');
  link.href = url;
  link.download = '模型配置表_' + filename + '_' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
  showToast('已导出 ' + models.length + ' 个模型的配置表');
  } catch (error) {
    showToast('导出失败，未下载不完整的配置表：' + error.message);
  } finally {
    status.textContent = previousStatus;
    modelExportRunning = false;
  }
}
async function openModelCategoryFolder(category) {
  try {
    var response = await fetch('/api/open-model-category-folder', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({category: category})
    });
    var result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || '打开失败');
    showToast('已打开：' + result.path);
  } catch (error) { showToast('打开分类目录失败：' + error.message); }
}

document.getElementById('modelCategoryFilters').addEventListener('contextmenu', function(event) {
  var button = event.target.closest('.model-category-row')?.querySelector('.model-category-filter');
  if (button && this.contains(button)) openModelCategoryMenu(event, button.dataset.category);
});
document.getElementById('modelCategoryMenu').addEventListener('click', function(event) {
  var button = event.target.closest('button[data-action]');
  if (!button || button.disabled) return;
  var category = modelCategoryMenuCategory;
  closeModelCategoryMenu();
  if (button.dataset.action === 'open') openModelCategoryFolder(category);
  if (button.dataset.action === 'export') exportModelCategory(category);
});
document.addEventListener('click', function(event) {
  if (!event.target.closest('#modelCategoryMenu')) closeModelCategoryMenu();
});
document.addEventListener('keydown', function(event) { if (event.key === 'Escape') closeModelCategoryMenu(); });
window.addEventListener('scroll', closeModelCategoryMenu, true);

function renderModelCategoryFilters() {
  var container = document.getElementById('modelCategoryFilters');
  var categories = getModelCategories();
  if (modelCategoryFilter !== 'all' && modelCategoryFilter !== '__uncategorized__' && !categories.some(function(category) { return category === modelCategoryFilter || category.indexOf(modelCategoryFilter + ' / ') === 0; })) modelCategoryFilter = 'all';
  var uncategorized = modelRecords.filter(function(model) { return !model.category; }).length;
  var tree = buildModelCategoryTree();
  function renderRow(label, path, node, depth) {
    var children = Object.keys(node.children).sort(function(a, b) { return a.localeCompare(b, 'zh-CN'); });
    var hasChildren = children.length > 0;
    var expanded = modelCategoryExpansion.has(path) ? modelCategoryExpansion.get(path) : depth === 0;
    var toggle = hasChildren
      ? '<button class="model-category-toggle" data-toggle-category="' + escapeHtml(path) + '" data-expanded="' + expanded + '" aria-label="展开或收起 ' + escapeHtml(path) + '">' + (expanded ? '&#9662;' : '&#9656;') + '</button>'
      : '<span class="model-category-toggle placeholder"></span>';
    var html = '<div class="model-category-row">' + toggle +
      '<button class="model-category-filter' + (path === modelCategoryFilter ? ' active' : '') + '" data-category="' + escapeHtml(path) + '" title="筛选 ' + escapeHtml(path) + '">' +
      '<span class="model-category-filter-name">' + escapeHtml(label) + '</span><span class="model-category-filter-count">' + node.count + '</span></button></div>';
    if (hasChildren && expanded) {
      html += '<div class="model-category-children">' + children.map(function(child) {
        var childPath = path ? path + ' / ' + child : child;
        return renderRow(child, childPath, node.children[child], depth + 1);
      }).join('') + '</div>';
    }
    return html;
  }
  var html = '<div class="model-category-row"><span class="model-category-toggle placeholder"></span><button class="model-category-filter' + (modelCategoryFilter === 'all' ? ' active' : '') + '" data-category="all"><span class="model-category-filter-name">全部模型</span><span class="model-category-filter-count">' + modelRecords.length + '</span></button></div>';
  html += Object.keys(tree.children).sort(function(a, b) { return a.localeCompare(b, 'zh-CN'); }).map(function(name) { return renderRow(name, name, tree.children[name], 0); }).join('');
  if (uncategorized) html += '<div class="model-category-row"><span class="model-category-toggle placeholder"></span><button class="model-category-filter' + (modelCategoryFilter === '__uncategorized__' ? ' active' : '') + '" data-category="__uncategorized__"><span class="model-category-filter-name">未分类</span><span class="model-category-filter-count">' + uncategorized + '</span></button></div>';
  container.innerHTML = html;
  container.querySelectorAll('.model-category-filter').forEach(function(button) {
    button.addEventListener('click', function() { modelCategoryFilter = button.dataset.category; renderModels(); });
  });
  container.querySelectorAll('.model-category-toggle').forEach(function(button) {
    button.addEventListener('click', function() {
      var category = button.dataset.toggleCategory;
      if (!category) return;
      modelCategoryExpansion.set(category, button.dataset.expanded !== 'true');
      renderModelCategoryFilters();
    });
  });
  document.getElementById('modelCategoryCurrent').innerHTML = '当前分类：<strong>' + escapeHtml(categoryLabel(modelCategoryFilter)) + '</strong> · 包含子目录';
}

function updateModelCategoryDatalist() {
  document.getElementById('modelCategoryList').innerHTML = getModelCategories().map(function(category) { return '<option value="' + escapeHtml(category) + '"></option>'; }).join('');
}

function setupModelDragAndDrop(grid) {
  grid.querySelectorAll('.model-card').forEach(function(card) {
    var handle = card.querySelector('.model-drag-handle');
    handle.addEventListener('dragstart', function(event) {
      draggedModelId = handle.dataset.modelId;
      card.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedModelId);
    });
    card.addEventListener('dragover', function(event) {
      if (!draggedModelId || draggedModelId === card.dataset.modelId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', function() { card.classList.remove('drag-over'); });
    card.addEventListener('drop', function(event) {
      event.preventDefault();
      var targetId = card.dataset.modelId;
      card.classList.remove('drag-over');
      if (!draggedModelId || draggedModelId === targetId) return;
      var moved = modelRecords.find(function(item) { return item.id === draggedModelId; });
      modelRecords = modelRecords.filter(function(item) { return item.id !== draggedModelId; });
      var targetIndex = modelRecords.findIndex(function(item) { return item.id === targetId; });
      modelRecords.splice(targetIndex, 0, moved);
      draggedModelId = null;
      renderModels();
      persistModelOrder();
    });
    handle.addEventListener('dragend', function() {
      draggedModelId = null;
      grid.querySelectorAll('.model-card').forEach(function(item) { item.classList.remove('dragging', 'drag-over'); });
    });
  });
}

async function persistModelOrder() {
  try {
    var response = await fetch('/api/reorder-models', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ids: modelRecords.map(function(item) { return item.id; })})
    });
    var result = await response.json();
    if (!result.success) throw new Error(result.error || '保存排序失败');
    showToast('模型顺序已保存');
  } catch (e) {
    showToast('排序保存失败: ' + e.message);
    loadModels();
  }
}

async function loadModels() {
  try {
    modelRecords = await loadJSON(DATA_DIR + '/models.json');
    if (!Array.isArray(modelRecords)) modelRecords = [];
    renderModelScanScope();
    renderModels();
  } catch (e) {
    modelRecords = [];
    renderModels();
    showToast('模型数据加载失败: ' + e.message);
  }
}

async function refreshModels(lookupUrls) {
  var button = document.getElementById('refreshModelsBtn');
  var lookupButton = document.getElementById('lookupModelUrlsBtn');
  button.disabled = true;
  lookupButton.disabled = true;
  button.textContent = lookupUrls ? '正在补全网址…' : '正在扫描…';
  lookupButton.textContent = lookupUrls ? '正在补全网址…' : '⌕ 补全缺失网址';
  try {
    var response = await fetch('/api/refresh-models', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ lookup_urls: !!lookupUrls })
    });
    var result = await response.json();
    if (!result.success) throw new Error(result.error || '刷新失败');
    while (true) {
      await new Promise(function(resolve) { window.setTimeout(resolve, 800); });
      var statusResponse = await fetch('/api/refresh-models-status', {method: 'POST'});
      var status = await statusResponse.json();
      if (!status.success) throw new Error(status.error || '刷新状态读取失败');
      if (status.running) {
        button.textContent = status.message || (lookupUrls ? '正在补全网址…' : '正在扫描…');
      }
      if (!status.running) {
        if (!Array.isArray(status.models)) throw new Error(status.message || '刷新失败');
        modelRecords = status.models;
        modelScanSummary = status.summary || null;
        renderModelScanScope();
        renderModels();
        showToast(status.message || '模型已刷新');
        break;
      }
    }
  } catch (e) {
    showToast('模型刷新失败: ' + e.message);
  } finally {
    button.disabled = false;
    lookupButton.disabled = false;
    button.textContent = '↻ 刷新模型';
    lookupButton.textContent = '⌕ 补全缺失网址';
  }
}

function updateModelImagePreview() {
  var preview = document.getElementById('modelImagePreview');
  var item = editingModelPromptSets[editingModelPromptSetIndex];
  var url = safeImageUrl(item ? item.image_url.trim() : '');
  var empty = document.getElementById('modelImageEmpty');
  empty.hidden = !!url;
  empty.textContent = '暂无图片 · 点击选中或拖入图片';
  document.getElementById('modelPromptImagePair').classList.remove('portrait');
  if (url) { preview.src = url; preview.classList.add('show'); }
  else { preview.removeAttribute('src'); preview.classList.remove('show'); }
  if (url && preview.complete) updateModelPromptImageLayout();
}

function updateModelPromptImageLayout() {
  var preview = document.getElementById('modelImagePreview');
  document.getElementById('modelPromptImagePair').classList.toggle('portrait',
    preview.classList.contains('show') && preview.naturalWidth > 0 && preview.naturalHeight > preview.naturalWidth);
}

async function importDroppedModelImage(file, targetSet, session) {
  targetSet = targetSet || editingModelPromptSets[editingModelPromptSetIndex];
  session = session === undefined ? modelEditorSession : session;
  if (session !== modelEditorSession || !editingModelPromptSets.includes(targetSet)) return;
  var error = document.getElementById('modelFormError');
  var hint = document.getElementById('modelImageDropHint');
  if (!file || !file.type.startsWith('image/')) {
    error.textContent = '请拖入图片文件。'; error.classList.add('show'); return;
  }
  if (file.size > 15 * 1024 * 1024) {
    error.textContent = '图片必须小于 15 MB。'; error.classList.add('show'); return;
  }
  try {
    modelImageImports++;
    document.getElementById('modelSaveBtn').disabled = true;
    hint.textContent = '正在导入图片...';
    var dataUrl = await new Promise(function(resolve, reject) {
      var reader = new FileReader();
      reader.onload = function() { resolve(reader.result); };
      reader.onerror = function() { reject(new Error('无法读取图片文件')); };
      reader.readAsDataURL(file);
    });
    var response = await fetch('/api/upload-model-image', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({filename: file.name, data_url: dataUrl})
    });
    var result = await response.json();
    if (!result.success) throw new Error(result.error || '导入失败');
    if (session !== modelEditorSession || !editingModelPromptSets.includes(targetSet)) return;
    targetSet.image_url = result.url;
    if (editingModelPromptSets[editingModelPromptSetIndex] === targetSet) {
      updateModelImagePreview();
      hint.textContent = '已导入：' + file.name + '。保存模型后会关联此套图片；选中图片可再次按 Ctrl+V 替换。';
    }
    error.classList.remove('show');
  } catch (e) {
    if (session !== modelEditorSession) return;
    hint.textContent = '将 PNG、JPG、WEBP 或 GIF 图片拖到此处，即可自动导入并预览。';
    error.textContent = '图片导入失败: ' + e.message; error.classList.add('show');
  } finally {
    if (session === modelEditorSession) {
      modelImageImports--;
    document.getElementById('modelSaveBtn').disabled = modelImageImports > 0 || modelSaving;
    }
  }
}

function setModelImageSelected(selected) {
  var zone = document.getElementById('modelImageDropZone');
  zone.classList.toggle('selected', selected);
  zone.setAttribute('aria-pressed', String(selected));
  document.getElementById('modelImageDropHint').textContent = selected
    ? '已选中此套图片 · 按 Ctrl+V 粘贴剪贴板图片，或拖入一张图片替换。'
    : '点击图片区域选中后按 Ctrl+V，或拖入一张图片。';
}

var modelHashRequestSeq = 0;
var currentModelHash = '';

function hideModelHashRow() {
  modelHashRequestSeq++;
  currentModelHash = '';
  document.getElementById('modelHashNote').style.display = 'none';
}

async function loadModelHash(model) {
  var token = ++modelHashRequestSeq;
  var valueEl = document.getElementById('modelHashValue');
  var copyBtn = document.getElementById('modelHashCopyBtn');
  currentModelHash = '';
  copyBtn.style.display = 'none';
  valueEl.textContent = '正在读取' + ((model.file_size || 0) > 512 * 1024 * 1024 ? '（大文件首次计算可能需要十几秒）' : '') + '…';
  document.getElementById('modelHashNote').style.display = 'block';
  try {
    var response = await fetch('/api/model-hash', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({path: model.file_path}) });
    var result = await response.json();
    if (token !== modelHashRequestSeq) return;
    if (!result.success) throw new Error(result.error || '读取失败');
    currentModelHash = result.sha256;
    valueEl.textContent = result.sha256;
    copyBtn.style.display = '';
  } catch (e) {
    if (token !== modelHashRequestSeq) return;
    valueEl.textContent = '读取失败：' + e.message;
  }
}

function openModelModal(modelId) {
  var model = modelId ? modelRecords.find(function(item) { return item.id === modelId; }) : null;
  var filename = model ? String(model.file_path || '').split(/[\\/]/).pop() : '';
  var extensionIndex = filename.lastIndexOf('.');
  editingModelId = model ? model.id : null;
  modelEditorSession++;
  modelImageImports = 0;
  document.getElementById('modelSaveBtn').disabled = false;
  editingModelPromptSets = getModelPromptSets(model);
  editingModelPromptSetIndex = 0;
  document.getElementById('modelModalTitle').textContent = model ? '编辑模型' : '添加模型';
  document.getElementById('modelNameLabel').textContent = model ? '模型名称（文件名不含扩展名）' : '模型名称';
  document.getElementById('modelNameNote').style.display = model ? 'block' : 'none';
  document.getElementById('modelName').value = model ? (extensionIndex > 0 ? filename.slice(0, extensionIndex) : filename) : '';
  document.getElementById('modelName').dataset.originalValue = document.getElementById('modelName').value;
  document.getElementById('modelCategory').value = model ? (model.category || '') : '';
  document.getElementById('modelAddFilePathGroup').style.display = model ? 'none' : 'block';
  document.getElementById('modelFilePath').value = '';
  document.getElementById('modelFileLocationNote').style.display = model ? 'block' : 'none';
  document.getElementById('modelFileLocationNote').textContent = model ? '文件位置：' + model.file_path : '';
  if (model) loadModelHash(model); else hideModelHashRow();
  document.getElementById('modelUrl').value = model ? model.url : '';
  document.getElementById('modelRecommendedParams').value = model ? (model.recommended_params || '') : '';
  document.getElementById('modelDeleteRow').style.display = model ? 'block' : 'none';
  document.getElementById('modelFormError').classList.remove('show');
  showModelPromptSet();
  document.getElementById('modelModalOverlay').classList.add('show');
  document.getElementById('modelName').focus();
  CardEditors.begin('model');
}

function closeModelModal() { CardEditors.requestClose('model'); }

function previewModelFilePath() {
  var model = editingModelId ? modelRecords.find(function(item) { return item.id === editingModelId; }) : null;
  if (!model) return;
  var originalPath = String(model.file_path || '');
  var filename = originalPath.split(/[\\/]/).pop();
  var extensionIndex = filename.lastIndexOf('.');
  var extension = extensionIndex > 0 ? filename.slice(extensionIndex) : '';
  if (document.getElementById('modelName').value === document.getElementById('modelName').dataset.originalValue) {
    document.getElementById('modelFileLocationNote').textContent = '文件位置：' + originalPath;
    return;
  }
  var name = document.getElementById('modelName').value.trim();
  if (extension && name.toLowerCase().endsWith(extension.toLowerCase())) name = name.slice(0, -extension.length).trim();
  document.getElementById('modelFileLocationNote').textContent = '文件位置：' + originalPath.slice(0, -filename.length) + name + extension;
}

async function saveModel() {
  if (modelImageImports > 0 || modelSaving) return;
  captureModelPromptSet();
  var currentModel = editingModelId ? modelRecords.find(function(item) { return item.id === editingModelId; }) : null;
  var originalPath = currentModel ? String(currentModel.file_path || '') : '';
  var originalFilename = originalPath.split(/[\\/]/).pop();
  var extensionIndex = originalFilename.lastIndexOf('.');
  var extension = extensionIndex > 0 ? originalFilename.slice(extensionIndex) : '';
  var modelName = document.getElementById('modelName').value.trim();
  var nameChanged = currentModel && document.getElementById('modelName').value !== document.getElementById('modelName').dataset.originalValue;
  if (currentModel && extension && modelName.toLowerCase().endsWith(extension.toLowerCase())) {
    modelName = modelName.slice(0, -extension.length).trim();
  }
  var payload = {
    id: editingModelId || '',
    name: currentModel && !nameChanged ? currentModel.name : modelName,
    category: document.getElementById('modelCategory').value.trim(),
    file_path: currentModel ? originalPath : document.getElementById('modelFilePath').value.trim(),
    original_file_path: originalPath,
    file_name: currentModel ? (nameChanged ? modelName + extension : originalFilename) : '',
    url: document.getElementById('modelUrl').value.trim(),
    prompt_sets: editingModelPromptSets.map(function(item) { return {name: item.name.trim(), prompt: item.prompt.trim(), image_url: item.image_url.trim()}; }),
    recommended_params: document.getElementById('modelRecommendedParams').value.trim(),
  };
  var error = document.getElementById('modelFormError');
  if (!payload.name || !payload.file_path) {
    error.textContent = '请填写模型名称和文件位置。'; error.classList.add('show'); return;
  }
  try {
    modelSaving = true;
    document.getElementById('modelSaveBtn').disabled = true;
    var response = await fetch('/api/save-model', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) });
    var result = await response.json();
    if (!result.success) throw new Error(result.error || '保存失败');
    CardEditors.finishClose('model'); await loadModels(); showToast((result.renamed_file ? '模型文件已改名并保存: ' : '已保存模型: ') + payload.name);
  } catch (e) { error.textContent = '保存失败: ' + e.message; error.classList.add('show'); }
  finally { modelSaving = false; document.getElementById('modelSaveBtn').disabled = modelImageImports > 0; }
}

async function deleteModel() {
  var model = modelRecords.find(function(item) { return item.id === editingModelId; });
  if (!model || !confirm('确定要删除模型“' + model.name + '”吗？')) return;
  try {
    var response = await fetch('/api/delete-model', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id: editingModelId}) });
    var result = await response.json();
    if (!result.success) throw new Error(result.error || '删除失败');
    CardEditors.finishClose('model'); await loadModels(); showToast('已删除模型: ' + model.name);
  } catch (e) { document.getElementById('modelFormError').textContent = '删除失败: ' + e.message; document.getElementById('modelFormError').classList.add('show'); }
}

document.getElementById('addModelBtn').addEventListener('click', function() { openModelModal(null); });
document.getElementById('refreshModelsBtn').addEventListener('click', function() { refreshModels(false); });
document.getElementById('lookupModelUrlsBtn').addEventListener('click', function() { refreshModels(true); });
document.getElementById('modelSearch').addEventListener('input', function() { modelSearchQuery = this.value.trim().toLowerCase(); renderModels(); });
document.getElementById('modelModalClose').addEventListener('click', closeModelModal);
document.getElementById('modelCancelBtn').addEventListener('click', closeModelModal);
document.getElementById('modelSaveBtn').addEventListener('click', saveModel);
document.getElementById('modelName').addEventListener('input', previewModelFilePath);
document.getElementById('modelDeleteBtn').addEventListener('click', deleteModel);
document.getElementById('modelAddPromptSetBtn').addEventListener('click', function() {
  captureModelPromptSet(); editingModelPromptSets.push({name: '', prompt: '', image_url: ''});
  editingModelPromptSetIndex = editingModelPromptSets.length - 1; showModelPromptSet();
  document.querySelector('#modelPromptSetTabs .active').focus();
});
document.getElementById('modelPromptSetUpBtn').addEventListener('click', function() { moveModelPromptSet(-1); });
document.getElementById('modelPromptSetDownBtn').addEventListener('click', function() { moveModelPromptSet(1); });
document.getElementById('modelRemovePromptSetBtn').addEventListener('click', function() {
  if (editingModelPromptSets.length <= 1) return;
  captureModelPromptSet();
  if (!confirm('删除当前这套提示词和图片？点击“保存”后生效，取消编辑可恢复。')) return;
  editingModelPromptSets.splice(editingModelPromptSetIndex, 1);
  editingModelPromptSetIndex = Math.min(editingModelPromptSetIndex, editingModelPromptSets.length - 1); showModelPromptSet();
});
document.getElementById('modelHashCopyBtn').addEventListener('click', function() { if (currentModelHash) copyText(currentModelHash); });
document.getElementById('modelImagePreview').addEventListener('load', updateModelPromptImageLayout);
document.getElementById('modelImagePreview').addEventListener('error', function() {
  this.classList.remove('show'); document.getElementById('modelImageEmpty').hidden = false;
  updateModelPromptImageLayout();
  document.getElementById('modelImageEmpty').textContent = '图片不可用 · 可粘贴或拖入图片替换';
});
document.getElementById('modelImageDropZone').addEventListener('click', function() { this.focus(); setModelImageSelected(true); });
document.getElementById('modelImageDropZone').addEventListener('focus', function() { setModelImageSelected(true); });
document.getElementById('modelImageDropZone').addEventListener('blur', function() { setModelImageSelected(false); });
document.getElementById('modelImageDropZone').addEventListener('keydown', function(event) {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setModelImageSelected(true); }
});
document.getElementById('modelImageDropZone').addEventListener('dragover', function(e) { e.preventDefault(); this.classList.add('drag-over'); });
document.getElementById('modelImageDropZone').addEventListener('dragleave', function() { this.classList.remove('drag-over'); });
document.getElementById('modelImageDropZone').addEventListener('drop', function(e) {
  e.preventDefault(); this.classList.remove('drag-over');
  if (e.dataTransfer.files.length !== 1) { showToast('请每次拖入一张图片。'); return; }
  this.focus(); setModelImageSelected(true); importDroppedModelImage(e.dataTransfer.files[0]);
});
document.getElementById('modelImageDropZone').addEventListener('paste', function(e) {
  if (document.activeElement !== this) return;
  var items = Array.from((e.clipboardData && e.clipboardData.items) || []);
  var imageItem = items.find(function(item) { return item.type.indexOf('image/') === 0; });
  if (!imageItem) { e.preventDefault(); showToast('剪贴板中没有图片，请复制图片后再粘贴。'); return; }
  e.preventDefault();
  importDroppedModelImage(imageItem.getAsFile());
});
CardEditors.register('model', {
  overlay: document.getElementById('modelModalOverlay'), baseline: null,
  title: function() { return '模型卡片'; }, busy: function() { return modelSaving || modelImageImports > 0; },
  snapshot: function() {
    captureModelPromptSet();
    return {
      fields: ['modelName', 'modelCategory', 'modelFilePath', 'modelUrl', 'modelRecommendedParams'].map(function(id) { return document.getElementById(id).value.trim(); }),
      sets: editingModelPromptSets.map(function(item) { return {name: item.name.trim(), prompt: item.prompt.trim(), image_url: item.image_url.trim()}; })
    };
  },
  save: saveModel,
  close: function() { modelEditorSession++; document.getElementById('modelModalOverlay').classList.remove('show'); setModelImageSelected(false); }
});
// 模型编辑弹窗只允许通过 ×、取消、保存或删除关闭；点击外部遮罩不退出。
