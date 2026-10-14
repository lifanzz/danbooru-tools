/* Shared unsaved-change guard for general tags, character cards and models. */
var CardEditors = (function() {
  var editors = new Map();
  var pending = null;
  var saving = false;
  var overlay = document.getElementById('unsavedCardOverlay');

  function register(key, editor) { editors.set(key, editor); }
  function begin(key) { var editor = editors.get(key); editor.baseline = JSON.stringify(editor.snapshot()); }
  function changed(key) {
    var editor = editors.get(key);
    return !!editor && editor.baseline !== null && editor.overlay.classList.contains('show') && JSON.stringify(editor.snapshot()) !== editor.baseline;
  }
  function finishClose(key) {
    var editor = editors.get(key);
    editor.baseline = null;
    editor.close();
  }
  function dismiss() {
    if (saving) return;
    overlay.classList.remove('show');
    overlay.setAttribute('aria-hidden', 'true');
    var editor = pending && editors.get(pending);
    pending = null;
    if (editor && editor.overlay.classList.contains('show')) editor.overlay.querySelector('input:not([type="hidden"]), textarea, button').focus();
  }
  function requestClose(key) {
    var editor = editors.get(key);
    if (!editor || !editor.overlay.classList.contains('show') || pending) return;
    if (editor.busy && editor.busy()) { showToast('正在保存或上传图片，请稍候再关闭。'); return; }
    if (!changed(key)) { finishClose(key); return; }
    pending = key;
    document.getElementById('unsavedCardMessage').textContent = editor.title() + '有尚未保存的修改，是否保存后关闭？';
    overlay.classList.add('show');
    overlay.setAttribute('aria-hidden', 'false');
    document.getElementById('unsavedCardContinue').focus();
  }
  document.getElementById('unsavedCardContinue').addEventListener('click', dismiss);
  document.getElementById('unsavedCardDiscard').addEventListener('click', function() {
    if (saving || !pending) return;
    var key = pending;
    pending = null;
    overlay.classList.remove('show');
    overlay.setAttribute('aria-hidden', 'true');
    finishClose(key);
  });
  document.getElementById('unsavedCardSave').addEventListener('click', async function() {
    if (saving || !pending) return;
    var editor = editors.get(pending);
    saving = true;
    overlay.querySelectorAll('button').forEach(function(button) { button.disabled = true; });
    try { await editor.save(); }
    finally {
      saving = false;
      overlay.querySelectorAll('button').forEach(function(button) { button.disabled = false; });
      // Validation/network errors keep the editor open with its error message.
      dismiss();
    }
  });
  document.addEventListener('keydown', function(event) {
    if (!pending) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); dismiss(); }
    if (event.key === 'Tab') {
      var buttons = Array.from(overlay.querySelectorAll('button:not(:disabled)'));
      var index = buttons.indexOf(document.activeElement);
      event.preventDefault();
      if (buttons.length) buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
    }
  }, true);
  return {register: register, begin: begin, changed: changed, requestClose: requestClose, finishClose: finishClose};
})();
