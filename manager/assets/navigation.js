/* Navigation shared by the main library and illustrated notes. */
(function () {
  const pages = [
    {id:'tags',label:'通用标签库',href:'index.html#tags'},
    {id:'characters',label:'角色提示词库',href:'index.html#characters'},
    {id:'models',label:'模型管理',href:'index.html#models'},
    {id:'illustrated',label:'图文笔记',href:'illustrated.html'}
  ];
  const host = document.getElementById('appNavigation');
  for (const page of pages) {
    const link = document.createElement('a');
    link.className='app-nav-link'; link.dataset.view=page.id; link.href=page.href; link.textContent=page.label;
    host.appendChild(link);
  }
  window.markNavigation = function (mode) {
    host.querySelectorAll('a').forEach(function(link) {
      const active=link.dataset.view===mode;
      link.classList.toggle('active',active);
      if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
    });
  };
  if(document.body.dataset.page==='illustrated') {
    markNavigation('illustrated');
    host.addEventListener('click',function(event) {
      const link=event.target.closest('a');
      if(link&&link.dataset.view==='illustrated'&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey)event.preventDefault();
    });
  }
})();
