/* Illustrated-note library: independent data, large cards and a two-column editor. */
(function () {
  const $ = id => document.getElementById(id);
  let catalogue = {groups:[], notes:[]}, currentGroup = 'all', query = '', activeNote = null;
  let images = [], baseline = '', saving = false, editingGroup = null;
  let collapsedFolders = new Set(), manualExpandedFolders = new Set(), dragFolderId = null;
  let draggedImageIndex = null, imageDragUntil = 0, lightboxEditing = false;
  let imageQueue = Promise.resolve(), imageJobs = 0, lightboxImages = [], lightboxIndex = 0;
  let imageSession = 0;
  const viewKey = 'danbooruIllustratedView';
  const draftKey = sessionStorage.getItem('danbooruIllustratedDraftKey') || crypto.randomUUID();
  sessionStorage.setItem('danbooruIllustratedDraftKey', draftKey);
  const db = new Promise((resolve, reject) => {
    const request = indexedDB.open('danbooruIllustratedDrafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  async function draftStore(value) {
    const database = await db;
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('drafts', 'readwrite');
      const store = transaction.objectStore('drafts');
      if (value) store.put(value, draftKey); else store.delete(draftKey);
      transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
    });
  }
  async function draftRead() {
    const database = await db;
    return new Promise((resolve, reject) => {
      const request = database.transaction('drafts').objectStore('drafts').get(draftKey);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
  }
  function fields() {
    return {title:$('pictureTitle').value, body:$('pictureBody').value, group_id:$('pictureGroup').value, images:images.map(image=>({...image}))};
  }
  function dirty() { return $('pictureEditor').open && ((imageJobs > 0) || JSON.stringify(fields()) !== baseline); }
  function editorStatus(message, error=false) { $('pictureEditorStatus').textContent=message; $('pictureEditorStatus').classList.toggle('error',error); }
  function rememberDraft() {
    if (!dirty()) { if($('pictureEditor').open)draftStore(null).catch(()=>{});editorStatus('');return; }
    draftStore({fields:fields(), baseline:baseline, note:activeNote}).catch(() => editorStatus('浏览器未能保留草稿，请先保存笔记。',true));
    editorStatus('有未保存修改');
  }
  function rememberView() {
    try { sessionStorage.setItem(viewKey,JSON.stringify({group:currentGroup,query:query,groupQuery:$('pictureGroupSearch').value,scroll:$('pictureMain').scrollTop,groupScroll:$('pictureGroups').scrollTop,collapsed:$('pictureSidebar').classList.contains('collapsed'),collapsedFolders:Array.from(collapsedFolders),manualExpandedFolders:Array.from(manualExpandedFolders)})); } catch (_) {}
  }
  async function api(path,data={}) {
    const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    const result=await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || '操作失败');
    return result;
  }
  function element(tag,className,text) { const el=document.createElement(tag); if(className)el.className=className; if(text!==undefined)el.textContent=text; return el; }
  function groupName(id) { return (catalogue.groups.find(group=>group.id===id) || {}).name || '未分类'; }
  function folderPath(id) {
    const parts=[],seen=new Set();let folder=catalogue.groups.find(group=>group.id===id);
    while(folder&&!seen.has(folder.id)){seen.add(folder.id);parts.unshift(folder.name);folder=catalogue.groups.find(group=>group.id===folder.parent_id);}
    return parts.join(' / ');
  }
  function folderIds(id) {
    const ids=new Set([id]);let changed=true;
    while(changed){changed=false;catalogue.groups.forEach(group=>{if(ids.has(group.parent_id)&&!ids.has(group.id)){ids.add(group.id);changed=true;}});}
    return ids;
  }
  function folderOrder(parent=null,depth=0) {
    return catalogue.groups.filter(group=>group.id!=='ungrouped'&&(group.parent_id||null)===parent).flatMap(group=>[{group,depth},...folderOrder(group.id,depth+1)]);
  }
  function folderAncestors(id) {
    const ids=new Set();let folder=catalogue.groups.find(group=>group.id===id);
    while(folder&&!ids.has(folder.id)){ids.add(folder.id);folder=catalogue.groups.find(group=>group.id===folder.parent_id);}
    return ids;
  }
  function selectFolder(id) {
    currentGroup=id;folderAncestors(id).forEach(folderId=>collapsedFolders.delete(folderId));
    renderGroups();renderCards();$('pictureMain').scrollTop=0;rememberView();
  }
  function renderGroups() {
    const root=$('pictureGroups');root.replaceChildren();
    root.setAttribute('role','tree');
    const filter=$('pictureGroupSearch').value.trim().toLocaleLowerCase();
    const autoExpanded=folderAncestors(currentGroup),manualPaths=new Set();
    manualExpandedFolders.forEach(id=>folderAncestors(id).forEach(ancestor=>manualPaths.add(ancestor)));
    const visible=new Set();
    if(filter)catalogue.groups.filter(group=>group.id!=='ungrouped'&&group.name.toLocaleLowerCase().includes(filter)).forEach(group=>{
      let folder=group;while(folder&&!visible.has(folder.id)){visible.add(folder.id);folder=catalogue.groups.find(g=>g.id===folder.parent_id);}
    });
    function rowFor(group,depth=0,fixed=false) {
      const row=element('div','picture-group-row'+(group.id===currentGroup?' active':''));row.dataset.folderId=group.id;
      row.style.setProperty('--folder-depth',Math.min(depth,12));
      row.setAttribute('role','treeitem');row.setAttribute('aria-level',String(depth+1));row.setAttribute('aria-selected',String(group.id===currentGroup));
      const children=catalogue.groups.some(g=>g.parent_id===group.id);
      const expanded=!!filter||manualExpandedFolders.has(group.id)||!collapsedFolders.has(group.id)&&(autoExpanded.has(group.id)||manualPaths.has(group.id));
      const toggle=element('button','picture-folder-toggle',children?(expanded?'⌄':'›'):'');toggle.type='button';toggle.disabled=!children;toggle.setAttribute('aria-label',(expanded?'收起':'展开')+group.name);
      if(children)row.setAttribute('aria-expanded',String(expanded));
      toggle.onclick=()=>{if(expanded){manualExpandedFolders.delete(group.id);collapsedFolders.add(group.id);}else{manualExpandedFolders.add(group.id);collapsedFolders.delete(group.id);}renderGroups();rememberView();};
      const link=element('button','picture-group-link');link.dataset.group=group.id;
      const ids=folderIds(group.id),count=catalogue.notes.filter(note=>group.id==='all'||ids.has(note.group_id)).length;
      const icon=element('span','picture-folder-icon',group.id==='all'?'▦':group.id==='ungrouped'?'▤':expanded&&children?'📂':'📁');icon.setAttribute('aria-hidden','true');
      link.append(icon,element('span','picture-folder-name',group.name),element('span','picture-group-number',String(count)));link.onclick=()=>selectFolder(group.id);row.append(toggle,link);
      if(!fixed) {
        row.draggable=true;
        const actions=element('span','picture-folder-actions');
        [['+','新建子文件夹',()=>openGroup(null,group.id)],['✎','重命名',()=>openGroup(group)],['×','删除文件夹',()=>deleteFolder(group)]].forEach(([label,title,action])=>{
          const button=element('button','picture-icon-btn picture-folder-action'+(label==='✎'?' picture-group-rename':''),label);button.type='button';button.title=title;button.setAttribute('aria-label',title+group.name);button.onclick=action;actions.append(button);
        });row.append(actions);
      }
      root.append(row);
      if(!fixed&&children&&expanded)renderChildren(group.id,depth+1);
    }
    function renderChildren(parent=null,depth=0) {
      catalogue.groups.filter(group=>group.id!=='ungrouped'&&(group.parent_id||null)===parent).forEach(group=>{if(!filter||visible.has(group.id))rowFor(group,depth);});
    }
    rowFor({id:'all',name:'全部图文笔记'},0,true);
    rowFor({id:'ungrouped',name:'未分类'},0,true);
    const top=element('div','picture-root-drop','顶层文件夹');top.dataset.folderRoot='true';root.append(top);
    renderChildren();
  }
  function clearDropHints() { $('pictureGroups').querySelectorAll('.drop-before,.drop-after,.drop-inside').forEach(row=>row.classList.remove('drop-before','drop-after','drop-inside')); }
  function dropTarget(event) {
    const top=event.target.closest('[data-folder-root]');if(top)return {element:top,parent:null,before:'',mode:'inside'};
    const row=event.target.closest('[data-folder-id]');if(!row||['all','ungrouped'].includes(row.dataset.folderId))return null;
    const folder=catalogue.groups.find(group=>group.id===row.dataset.folderId),rect=row.getBoundingClientRect(),position=(event.clientY-rect.top)/rect.height;
    if(position<.25)return {element:row,parent:folder.parent_id||null,before:folder.id,mode:'before'};
    if(position>.75){const siblings=catalogue.groups.filter(group=>group.id!=='ungrouped'&&(group.parent_id||null)===(folder.parent_id||null)),index=siblings.findIndex(group=>group.id===folder.id);return {element:row,parent:folder.parent_id||null,before:siblings[index+1]?.id||'',mode:'after'};}
    return {element:row,parent:folder.id,before:'',mode:'inside'};
  }
  $('pictureGroups').addEventListener('dragstart',event=>{
    const row=event.target.closest('[data-folder-id]');if(!row||!row.draggable)return;
    dragFolderId=row.dataset.folderId;event.dataTransfer.setData('application/x-danbooru-folder',dragFolderId);event.dataTransfer.effectAllowed='move';row.classList.add('dragging');
  });
  $('pictureGroups').addEventListener('dragover',event=>{
    if(!dragFolderId)return;const target=dropTarget(event);clearDropHints();if(!target)return;
    const blocked=target.before===dragFolderId||target.parent&&folderIds(dragFolderId).has(target.parent);if(blocked){event.dataTransfer.dropEffect='none';return;}
    event.preventDefault();event.dataTransfer.dropEffect='move';target.element.classList.add('drop-'+target.mode);
  });
  $('pictureGroups').addEventListener('drop',async event=>{
    if(!dragFolderId)return;event.preventDefault();const id=dragFolderId,target=dropTarget(event);dragFolderId=null;clearDropHints();
    if(!target||target.before===id||target.parent&&folderIds(id).has(target.parent))return;
    const folder=catalogue.groups.find(group=>group.id===id);
    await mutateFolder('/api/move-illustrated-group',{id,revision:folder.revision,parent_id:target.parent||'',before_id:target.before},target.parent);
  });
  $('pictureGroups').addEventListener('dragend',()=>{dragFolderId=null;clearDropHints();$('pictureGroups').querySelectorAll('.dragging').forEach(row=>row.classList.remove('dragging'));});
  function applyFolders(result) { catalogue=result;if(currentGroup!=='all'&&!catalogue.groups.some(group=>group.id===currentGroup))currentGroup='ungrouped';renderGroups();renderCards();rememberView(); }
  async function mutateFolder(path,data,expand=null) {
    if(!Number.isInteger(catalogue.folders_revision)){$('pictureStatus').textContent='请重新启动标签管理器，以启用文件夹管理。';return false;}
    try {
      const result=await api(path,{...data,folders_revision:catalogue.folders_revision});
      if(expand)collapsedFolders.delete(expand);applyFolders(result);$('pictureStatus').textContent='文件夹已更新';return true;
    } catch(error) { $('pictureStatus').textContent=error.message;if(!dirty())await loadCatalogue().catch(()=>{});$('pictureStatus').textContent=error.message;return false; }
  }
  async function deleteFolder(folder) {
    const ids=folderIds(folder.id),notes=catalogue.notes.filter(note=>ids.has(note.group_id)).length;
    if(!confirm('删除文件夹“'+folder.name+'”'+(ids.size>1?'及其 '+(ids.size-1)+' 个子文件夹':'')+'？'+(notes?'其中 '+notes+' 篇笔记将移到“未分类”，内容和图片保留。':'文件夹中的笔记内容和图片会保留。')))return;
    await mutateFolder('/api/delete-illustrated-group',{id:folder.id,revision:folder.revision});
  }
  function renderCards() {
    $('pictureGroupTitle').textContent=currentGroup==='all'?'全部图文笔记':folderPath(currentGroup);
    const terms=query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const notes=catalogue.notes.filter(note=>(currentGroup==='all'||folderIds(currentGroup).has(note.group_id))&&terms.every(term=>(note.title+'\n'+note.body).toLocaleLowerCase().includes(term)));
    $('pictureCount').textContent=notes.length+' 张笔记';
    $('pictureEmpty').hidden=notes.length>0;
    $('pictureEmpty').querySelector('h2').textContent=query?'没有找到匹配的笔记':'把图片和想法放在一起';
    $('pictureEmpty').querySelector('p').textContent=query?'试试其他搜索词，或切换到全部图文笔记。':'新建一张图文笔记，左边放图片，右边记录灵感、观察或创作过程。';
    const root=$('pictureCards');root.replaceChildren();
    notes.forEach(note=>{
      const urls=note.image_urls;
      const card=element('article','picture-card'+(!urls.length?' no-image':''));card.dataset.noteId=note.id;
      if(urls.length) {
        const gallery=element('div','picture-card-gallery'),button=element('button','picture-card-image');
        const image=element('img');image.alt=note.title;image.loading='lazy';
        button.append(image);gallery.append(button);
        let selected=0;const failed=new Set();
        const thumbnails=element('div','picture-card-thumbnails');
        function select(index) {
          selected=index;button.hidden=false;image.src=urls[index];
          button.setAttribute('aria-label','查看“'+note.title+'”第 '+(index+1)+' 张图片');
          thumbnails.querySelectorAll('button').forEach((thumb,i)=>{thumb.classList.toggle('active',i===index);thumb.setAttribute('aria-pressed',String(i===index));});
        }
        function failedImage(index) {
          failed.add(index);
          if(failed.size===urls.length){gallery.remove();card.classList.add('no-image');return;}
          if(selected===index)select(urls.findIndex((_,i)=>!failed.has(i)));
        }
        image.onerror=()=>failedImage(selected);
        button.onclick=()=>openLightbox(urls,selected,note.title);
        if(urls.length>1) {
          urls.forEach((url,index)=>{
            const thumb=element('button','picture-card-thumbnail');thumb.title='第 '+(index+1)+' 张图片';thumb.setAttribute('aria-label',thumb.title);
            const small=element('img');small.src=url;small.alt='';small.loading='lazy';small.onerror=()=>{thumb.hidden=true;failedImage(index);};thumb.append(small);thumb.onclick=()=>select(index);thumbnails.append(thumb);
          });
          gallery.append(element('div','picture-image-count',urls.length+' 张图片'),thumbnails);
        }
        select(0);card.append(gallery);
      }
      const content=element('div','picture-card-content'),top=element('div','picture-card-top');
      const edit=element('button','btn-secondary','编辑笔记');edit.onclick=()=>openEditor(note);
      top.append(element('h2','',note.title),edit);content.append(top);
      const date=new Date(note.updated_at);content.append(element('div','picture-card-meta',folderPath(note.group_id)+' · '+(Number.isNaN(date.getTime())?'':date.toLocaleString('zh-CN',{hour12:false}))));
      if(note.body) {
        const long=note.body.length>600||note.body.split('\n').length>12;
        const body=element('div','picture-card-note'+(long?' long-note':''),note.body);content.append(body);
        if(long) { const expand=element('button','picture-expand','展开全文');expand.onclick=()=>{const collapsed=body.classList.toggle('long-note');expand.textContent=collapsed?'展开全文':'收起';expand.setAttribute('aria-expanded',String(!collapsed));};expand.setAttribute('aria-expanded','false');content.append(expand); }
      }
      card.append(content);root.append(card);
    });
  }
  async function loadCatalogue() { catalogue=await api('/api/illustrated-notes'); if(currentGroup!=='all'&&!catalogue.groups.some(g=>g.id===currentGroup))currentGroup='all';renderGroups();renderCards();$('pictureStatus').textContent=''; }
  function editorImageUrls() { return images.map(entry=>entry.pending?entry.pending.data_url:entry.url); }
  function showImages() {
    const list=$('pictureImageList');list.replaceChildren();
    $('pictureDrop').classList.toggle('has-images',images.length>0);
    images.forEach((entry,index)=>{
      const item=element('div','picture-editor-image');item.draggable=true;item.dataset.imageIndex=index;
      const button=element('button','picture-image-preview');button.type='button';button.setAttribute('aria-label','查看第 '+(index+1)+' 张图片原图');
      const preview=element('img');preview.src=entry.pending?entry.pending.data_url:entry.url;preview.alt='第 '+(index+1)+' 张图片';preview.draggable=false;
      button.append(preview);button.onclick=()=>{if(Date.now()<imageDragUntil||saving)return;openLightbox(editorImageUrls(),index,'第 '+(index+1)+' 张图片',true);};
      item.append(button,element('span','picture-image-index',String(index+1)));list.append(item);
    });
  }
  $('pictureImageList').addEventListener('dragstart',event=>{
    const item=event.target.closest('[data-image-index]');if(!item)return;
    if(saving||imageJobs>0){event.preventDefault();return;}
    draggedImageIndex=Number(item.dataset.imageIndex);event.dataTransfer.setData('application/x-danbooru-note-image',String(draggedImageIndex));event.dataTransfer.effectAllowed='move';item.classList.add('dragging');
  });
  function clearImageDrop(){ $('pictureImageList').querySelectorAll('.image-drop-target,.dragging').forEach(item=>item.classList.remove('image-drop-target','dragging')); }
  $('pictureImageList').addEventListener('dragover',event=>{
    if(draggedImageIndex===null&&!Array.from(event.dataTransfer.types).includes('Files'))return;
    event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect=draggedImageIndex===null?'copy':'move';
    clearImageDrop();const target=event.target.closest('[data-image-index]');if(target&&Number(target.dataset.imageIndex)!==draggedImageIndex)target.classList.add('image-drop-target');
  });
  $('pictureImageList').addEventListener('drop',event=>{
    event.preventDefault();event.stopPropagation();const from=draggedImageIndex,target=event.target.closest('[data-image-index]');draggedImageIndex=null;clearImageDrop();
    if(from===null){selectImages(event.dataTransfer.files);return;}
    imageDragUntil=Date.now()+350;
    if(!target||saving||imageJobs>0)return;
    const to=Number(target.dataset.imageIndex);if(from===to)return;
    const entry=images.splice(from,1)[0];images.splice(to,0,entry);showImages();rememberDraft();
  });
  $('pictureImageList').addEventListener('dragend',()=>{draggedImageIndex=null;imageDragUntil=Date.now()+350;clearImageDrop();});
  function openLightbox(urls,index,title,editing=false) { lightboxEditing=editing;lightboxImages=urls;lightboxIndex=index;$('pictureLightboxImage').alt=title;renderLightbox();$('pictureLightbox').showModal(); }
  function renderLightbox() { $('pictureLightboxImage').src=lightboxImages[lightboxIndex];$('pictureLightboxCount').textContent=(lightboxIndex+1)+' / '+lightboxImages.length;$('pictureLightboxNavigation').hidden=lightboxImages.length<2;$('pictureLightboxEdit').hidden=!lightboxEditing; }
  function stepLightbox(step) { lightboxIndex=(lightboxIndex+step+lightboxImages.length)%lightboxImages.length;renderLightbox(); }
  $('previousPictureImage').onclick=()=>stepLightbox(-1);$('nextPictureImage').onclick=()=>stepLightbox(1);
  $('deletePreviewImage').onclick=()=>{
    if(!lightboxEditing||saving||imageJobs>0)return;
    images.splice(lightboxIndex,1);showImages();rememberDraft();lightboxImages=editorImageUrls();
    if(!lightboxImages.length){$('pictureLightbox').close();return;}
    lightboxIndex=Math.min(lightboxIndex,lightboxImages.length-1);renderLightbox();
  };
  $('pictureLightbox').addEventListener('keydown',event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();stepLightbox(event.key==='ArrowLeft'?-1:1);}});
  function setCardSize(value) {
    const size=Math.max(70,Math.min(140,Math.round((Number(value)||100)/5)*5));
    $('pictureCardSize').value=size;$('pictureCardSizeValue').textContent=size+'%';document.documentElement.style.setProperty('--picture-card-scale',size/100);
    try {localStorage.setItem('danbooruIllustratedCardSize',String(size));}catch(_){}
  }
  let savedSize=100;try{savedSize=localStorage.getItem('danbooruIllustratedCardSize')||100;}catch(_){}setCardSize(savedSize);
  $('pictureCardSize').oninput=event=>setCardSize(event.target.value);
  function populateGroups(value) {
    $('pictureGroup').replaceChildren(...[{group:catalogue.groups.find(g=>g.id==='ungrouped'),depth:0},...folderOrder()].map(({group})=>{const option=element('option','',folderPath(group.id));option.value=group.id;return option;}));
    $('pictureGroup').value=catalogue.groups.some(group=>group.id===value)?value:'ungrouped';
  }
  function openEditor(note=null) {
    imageSession++; imageJobs=0;
    activeNote=note?{...note}:null;images=note?note.image_urls.map(url=>({url})):[];
    $('pictureTitle').value=note?note.title:'';$('pictureBody').value=note?note.body:'';
    populateGroups(note?note.group_id:currentGroup==='all'?'ungrouped':currentGroup);
    $('pictureEditorHeading').textContent=note?'编辑图文笔记':'新建图文笔记';showImages();baseline=JSON.stringify(fields());editorStatus('');
    $('pictureEditor').showModal();$('pictureTitle').focus();
  }
  async function closeEditor() { imageSession++;imageJobs=0;await draftStore(null).catch(()=>{});$('pictureEditor').close();activeNote=null;images=[];baseline=''; }
  function selectImages(files) {
    const selected=Array.from(files||[]);if(saving||!selected.length)return;
    const session=imageSession;imageJobs++;editorStatus('正在读取图片…');
    imageQueue=imageQueue.then(async()=>{
      const errors=[];
      for(const file of selected) {
        if(session!==imageSession)return;
        try {
          if(images.length>=100)throw new Error('每张笔记最多关联 100 张图片。');
          if(!['image/png','image/jpeg','image/gif','image/webp'].includes(file.type)||file.size>15*1024*1024)throw new Error(file.name+'：请选择不超过 15 MB 的 PNG、JPG、GIF 或 WEBP 图片。');
          const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('图片读取失败'));reader.readAsDataURL(file);});
          const preview=new Image();preview.src=dataUrl;await preview.decode();
          if(session!==imageSession)return;
          images.push({url:'',pending:{filename:file.name,data_url:dataUrl}});showImages();rememberDraft();
        }catch(error){errors.push(error.message||'图片无法打开');}
      }
      if(session===imageSession&&errors.length)editorStatus(errors.join('；'),true);
    }).finally(()=>{if(session===imageSession){imageJobs--;}});
    return imageQueue;
  }
  async function save() {
    if(saving)return false;
    if((imageJobs > 0)){editorStatus('图片还在读取，请稍候再保存。');return false;}
    if(!$('pictureTitle').value.trim()){editorStatus('请填写标题。',true);$('pictureTitle').focus();return false;}
    saving=true;editorStatus('正在保存…');
    const controls=Array.from($('pictureForm').elements),previous=controls.map(control=>control.disabled);controls.forEach(control=>control.disabled=true);
    try {
      for(const entry of images) {if(entry.pending){const out=await api('/api/upload-illustrated-image',entry.pending);entry.url=out.url;delete entry.pending;}}
      const payload={title:$('pictureTitle').value,body:$('pictureBody').value,group_id:$('pictureGroup').value,image_urls:images.map(entry=>entry.url),id:activeNote?activeNote.id:'',revision:activeNote?activeNote.revision:0};
      const out=await api('/api/save-illustrated-note',payload);
      const index=catalogue.notes.findIndex(note=>note.id===out.note.id);
      if(index<0)catalogue.notes.unshift(out.note);else catalogue.notes[index]=out.note;
      activeNote=out.note;baseline=JSON.stringify(fields());await closeEditor();renderGroups();renderCards();$('pictureStatus').textContent='已保存：'+out.note.title;return true;
    } catch(error) {rememberDraft();editorStatus(error.message,true);return false;}
    finally {saving=false;controls.forEach((control,index)=>control.disabled=previous[index]);}
  }
  function requestClose() {
    if(saving){editorStatus('正在保存，请稍候。');return;}
    if(!dirty()){closeEditor();return;}
    $('pictureUnsaved').showModal();
  }
  $('newPictureNote').onclick=$('newPictureNoteEmpty').onclick=()=>openEditor();
  $('pictureForm').onsubmit=event=>{event.preventDefault();save();};
  $('pictureForm').addEventListener('input',rememberDraft);$('pictureGroup').onchange=rememberDraft;
  $('closePictureEditor').onclick=$('cancelPictureEditor').onclick=requestClose;
  $('pictureEditor').addEventListener('cancel',event=>{event.preventDefault();requestClose();});
  $('continuePictureDraft').onclick=()=>{$('pictureUnsaved').close();};
  $('discardPictureDraft').onclick=async()=>{$('pictureUnsaved').close();await closeEditor();};
  $('savePictureDraft').onclick=async()=>{$('savePictureDraft').disabled=true;const success=await save();$('savePictureDraft').disabled=false;if(success)$('pictureUnsaved').close();};
  $('pictureDrop').onclick=()=>$('pictureFile').click();
  $('pictureFile').onchange=async event=>{await selectImages(event.target.files);event.target.value='';};
  $('pictureDrop').ondragover=event=>{event.preventDefault();$('pictureDrop').classList.add('dragging');};
  $('pictureDrop').ondragleave=()=>$('pictureDrop').classList.remove('dragging');
  $('pictureDrop').ondrop=event=>{event.preventDefault();$('pictureDrop').classList.remove('dragging');selectImages(event.dataTransfer.files);};
  $('pictureEditor').addEventListener('paste',event=>{const files=Array.from(event.clipboardData.items).filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);if(files.length){event.preventDefault();selectImages(files);}});
  $('pictureEditor').addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();save();}});
  $('pictureSearch').oninput=()=>{query=$('pictureSearch').value;renderCards();rememberView();};
  $('pictureGroupSearch').oninput=()=>{renderGroups();rememberView();};
  $('pictureSidebarToggle').onclick=()=>{const collapsed=$('pictureSidebar').classList.toggle('collapsed');$('pictureSidebarToggle').textContent=collapsed?'›':'‹';$('pictureSidebarToggle').setAttribute('aria-label',collapsed?'展开分组栏':'收起分组栏');rememberView();};
  $('closePictureLightbox').onclick=()=>$('pictureLightbox').close();
  function openGroup(group=null,parent='') {
    editingGroup=group;$('pictureGroupHeading').textContent=group?'重命名文件夹':'新建文件夹';$('pictureGroupName').value=group?group.name:'';$('pictureGroupError').textContent='';
    const top=element('option','','顶层文件夹');top.value='';
    $('pictureGroupParent').replaceChildren(top,...folderOrder().map(({group})=>{const option=element('option','',folderPath(group.id));option.value=group.id;return option;}));
    $('pictureGroupParent').value=parent;$('pictureGroupParentLabel').hidden=!!group;$('pictureGroupDialog').showModal();$('pictureGroupName').focus();
  }
  $('newPictureGroup').onclick=()=>openGroup(null,currentGroup!=='all'&&currentGroup!=='ungrouped'?currentGroup:'');
  $('newPictureGroup').title='新建文件夹';$('newPictureGroup').setAttribute('aria-label','新建文件夹');$('pictureGroupSearch').placeholder='搜索文件夹…';
  $('cancelPictureGroup').onclick=()=>$('pictureGroupDialog').close();
  $('pictureGroupForm').onsubmit=async event=>{
    event.preventDefault();if(!Number.isInteger(catalogue.folders_revision)){$('pictureGroupError').textContent='请重新启动标签管理器后再保存文件夹。';return;}const button=event.submitter;button.disabled=true;
    try {
      const parent=editingGroup?editingGroup.parent_id||'':$('pictureGroupParent').value;
      const result=await api('/api/save-illustrated-group',{name:$('pictureGroupName').value,id:editingGroup?editingGroup.id:'',revision:editingGroup?editingGroup.revision:0,parent_id:parent,folders_revision:catalogue.folders_revision});
      currentGroup=result.group_id;if(parent)collapsedFolders.delete(parent);applyFolders(result);$('pictureGroupDialog').close();
    }catch(error){$('pictureGroupError').textContent=error.message;}finally{button.disabled=false;}
  };
  window.addEventListener('pagehide',rememberView);
  window.addEventListener('beforeunload',event=>{rememberView();if(dirty()||saving){event.preventDefault();event.returnValue='';}});
  async function init() {
    let view={};try{view=JSON.parse(sessionStorage.getItem(viewKey)||'{}');}catch(_){}
    collapsedFolders=new Set(view.collapsedFolders||[]);manualExpandedFolders=new Set(view.manualExpandedFolders||[]);currentGroup=view.group||'all';query=view.query||'';$('pictureSearch').value=query;$('pictureGroupSearch').value=view.groupQuery||'';
    $('pictureSidebar').classList.toggle('collapsed',!!view.collapsed);$('pictureSidebarToggle').textContent=view.collapsed?'›':'‹';
    await loadCatalogue();requestAnimationFrame(()=>{$('pictureMain').scrollTop=view.scroll||0;$('pictureGroups').scrollTop=view.groupScroll||0;});
    ['newPictureNote','newPictureNoteEmpty','newPictureGroup'].forEach(id=>$(id).disabled=false);
    const draft=await draftRead().catch(()=>null);
    if(draft){openEditor(draft.note);const data=draft.fields;$('pictureTitle').value=data.title;$('pictureBody').value=data.body;populateGroups(data.group_id);images=data.images;baseline=draft.baseline;showImages();editorStatus('已恢复未保存草稿');}
  }
  ['newPictureNote','newPictureNoteEmpty','newPictureGroup'].forEach(id=>$(id).disabled=true);
  init().catch(error=>{$('pictureStatus').textContent=error.message;});
})();
