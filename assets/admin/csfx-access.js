(function(){
  if (typeof window === 'undefined' || !window.document) return;
  var ajaxurl = typeof window.ajaxurl === 'string' ? window.ajaxurl : '';
  var search = document.querySelector('[data-csfx-access-user-search]');
  var resultsBox = document.querySelector('[data-csfx-access-user-results]');
  var userField = document.querySelector('[data-csfx-access-user-field]');

  if (ajaxurl && search && resultsBox && userField) {
    var pending = null;
    var lastTerm = '';

    function clearResults(){
      resultsBox.innerHTML = '';
      resultsBox.classList.remove('is-open');
    }

    function renderResults(items){
      clearResults();
      if (!items || !items.length) return;
      var ul = document.createElement('ul');
      ul.className = 'csfx-access-user-suggestions';
      items.forEach(function(item){
        var li = document.createElement('li');
        li.textContent = item.label;
        li.dataset.userId = item.id;
        li.tabIndex = 0;
        function select(){
          userField.value = item.id;
          search.value = item.label;
          clearResults();
        }
        li.addEventListener('click', select);
        li.addEventListener('keydown', function(ev){
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            select();
          }
        });
        ul.appendChild(li);
      });
      resultsBox.appendChild(ul);
      resultsBox.classList.add('is-open');
    }

    function fetchUsers(term){
      if (pending) {
        pending.abort();
        pending = null;
      }
      if (!term || term.length < 2) {
        clearResults();
        return;
      }
      if (term === lastTerm) return;
      lastTerm = term;
      var controller = 'AbortController' in window ? new AbortController() : null;
      if (controller) pending = controller;
      var params = new URLSearchParams({
        action: 'csfx_access_search_users',
        term: term,
        _ajax_nonce: search.getAttribute('data-nonce') || ''
      });
      fetch(ajaxurl + '?' + params.toString(), {
        method: 'GET',
        signal: controller ? controller.signal : undefined,
        credentials: 'same-origin'
      }).then(function(res){
        if (!res.ok) throw new Error('Network response was not ok');
        return res.json();
      }).then(function(json){
        if (!json || !Array.isArray(json.items)) {
          clearResults();
          return;
        }
        renderResults(json.items);
      }).catch(function(err){
        if (err.name === 'AbortError') return;
        clearResults();
        if (window.console && console.error) console.error('CSFX user search error', err);
      }).finally(function(){
        pending = null;
      });
    }

    search.addEventListener('input', function(){
      userField.value = '';
      fetchUsers(search.value.trim());
    });

    document.addEventListener('click', function(ev){
      if (!resultsBox.contains(ev.target) && ev.target !== search) {
        clearResults();
      }
    });
  }

  var modal = document.querySelector('[data-csfx-modal]');
  if (!modal) return;

  var body = document.body;
  var nameEl = modal.querySelector('[data-csfx-modal-name]');
  var emailEl = modal.querySelector('[data-csfx-modal-email]');
  var statusBadge = modal.querySelector('[data-csfx-modal-status]');
  var manualNote = modal.querySelector('[data-csfx-modal-manual-note]');
  var expiresNote = modal.querySelector('[data-csfx-modal-expires-display]');
  var updatedEl = modal.querySelector('[data-csfx-modal-updated]');
  var secureCodeEl = modal.querySelector('[data-csfx-modal-secure]');
  var copySecureBtn = modal.querySelector('[data-csfx-copy="secure"]');
  var manualInput = modal.querySelector('[data-csfx-modal-input="manual"]');
  var expiresInput = modal.querySelector('[data-csfx-modal-input="expires"]');
  var downloadBtn = modal.querySelector('[data-csfx-modal-download]');
  var qrImg = modal.querySelector('[data-csfx-modal-qr]');
  var manualForm = modal.querySelector('[data-csfx-modal-form="manual"]');
  var expiresForm = modal.querySelector('[data-csfx-modal-form="expires"]');
  var regenForm = modal.querySelector('[data-csfx-modal-form="regenerate"]');
  var manualIdField = modal.querySelector('[data-csfx-modal-field="id-manual"]');
  var expiresIdField = modal.querySelector('[data-csfx-modal-field="id-expires"]');
  var regenIdField = modal.querySelector('[data-csfx-modal-field="id-regenerate"]');
  var manualNonceField = modal.querySelector('[data-csfx-modal-field="nonce-update"]');
  var expiresNonceField = modal.querySelector('[data-csfx-modal-field="nonce-update-2"]');
  var regenNonceField = modal.querySelector('[data-csfx-modal-field="nonce-regenerate"]');
  var clearManualBtn = modal.querySelector('[data-csfx-clear-manual]');
  var clearExpiryBtn = modal.querySelector('[data-csfx-clear-expiry]');
  var closeTargets = modal.querySelectorAll('[data-csfx-modal-close]');
  var updatedLabel = modal.querySelector('.csfx-access-modal__meta');
  var updatedPrefix = updatedLabel ? updatedLabel.getAttribute('data-csfx-modal-updated-label') || '' : '';

  function sanitizeClass(base, modifier){
    modifier = (modifier || '').toString().trim();
    if (!modifier) return base;
    return base + ' ' + base + '--' + modifier.replace(/[^a-z0-9_-]/gi, '');
  }

  function openModal(){
    modal.removeAttribute('hidden');
    modal.setAttribute('data-open', '1');
    body.classList.add('csfx-modal-open');
  }

  function closeModal(){
    modal.setAttribute('hidden', '');
    modal.removeAttribute('data-open');
    body.classList.remove('csfx-modal-open');
  }

  closeTargets.forEach(function(el){
    el.addEventListener('click', function(ev){
      ev.preventDefault();
      closeModal();
    });
  });

  document.addEventListener('keydown', function(ev){
    if (ev.key === 'Escape' && modal.getAttribute('data-open') === '1') {
      closeModal();
    }
  });

  function formatUpdated(text){
    if (!text) return '';
    return updatedPrefix ? updatedPrefix + ' ' + text : text;
  }

  function populateModal(data){
    if (!data) return;
    nameEl.textContent = data.user && data.user.name ? data.user.name : '';
    emailEl.textContent = data.user && data.user.email ? data.user.email : '';
    var statusClass = data.status && data.status.class ? data.status.class : 'inactive';
    statusBadge.textContent = data.status && data.status.label ? data.status.label : '';
    statusBadge.className = sanitizeClass('csfx-access-status', statusClass);
    manualNote.textContent = data.manual_hint || '';
    expiresNote.textContent = data.expires && data.expires.display ? data.expires.display : '';
    updatedEl.textContent = formatUpdated(data.updated || '');
    secureCodeEl.textContent = data.secure_key || '';
    if (manualInput) manualInput.value = data.manual_key || '';
    if (expiresInput) expiresInput.value = data.expires && data.expires.date ? data.expires.date : '';
    if (manualIdField) manualIdField.value = data.id || '';
    if (expiresIdField) expiresIdField.value = data.id || '';
    if (regenIdField) regenIdField.value = data.id || '';
    if (manualNonceField) manualNonceField.value = data.nonce && data.nonce.update ? data.nonce.update : '';
    if (expiresNonceField) expiresNonceField.value = data.nonce && data.nonce.update ? data.nonce.update : '';
    if (regenNonceField) regenNonceField.value = data.nonce && data.nonce.regenerate ? data.nonce.regenerate : '';

    if (qrImg) {
      if (data.qr) {
        qrImg.src = data.qr;
        qrImg.alt = data.user && data.user.name ? data.user.name : 'QR';
        qrImg.removeAttribute('hidden');
        if (downloadBtn) {
          downloadBtn.href = data.qr;
          var slug = (data.user && data.user.name ? data.user.name : 'qr').toLowerCase().replace(/[^a-z0-9]+/g, '-');
          downloadBtn.setAttribute('download', 'csfx-supervisor-' + slug + '.png');
          downloadBtn.removeAttribute('hidden');
        }
      } else {
        qrImg.src = '';
        qrImg.alt = '';
        qrImg.setAttribute('hidden', '');
        if (downloadBtn) {
          downloadBtn.href = '#';
          downloadBtn.setAttribute('hidden', '');
        }
      }
    }
  }

  var openButtons = document.querySelectorAll('[data-csfx-open-modal]');
  openButtons.forEach(function(btn){
    btn.addEventListener('click', function(){
      var payload = btn.getAttribute('data-csfx-auth');
      if (!payload) return;
      var data = null;
      try {
        data = JSON.parse(payload);
      } catch (err) {
        if (window.console && console.error) console.error('CSFX modal payload error', err);
        return;
      }
      populateModal(data);
      openModal();
    });
  });

  if (copySecureBtn) {
    copySecureBtn.addEventListener('click', function(ev){
      ev.preventDefault();
      var value = secureCodeEl.textContent || '';
      if (!value) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).catch(function(){});
      } else {
        var temp = document.createElement('textarea');
        temp.value = value;
        temp.setAttribute('readonly', '');
        temp.style.position = 'absolute';
        temp.style.left = '-9999px';
        document.body.appendChild(temp);
        temp.select();
        try { document.execCommand('copy'); } catch (err) {}
        document.body.removeChild(temp);
      }
      copySecureBtn.classList.add('is-copied');
      setTimeout(function(){ copySecureBtn.classList.remove('is-copied'); }, 1200);
    });
  }

  if (clearManualBtn) {
    clearManualBtn.addEventListener('click', function(ev){
      ev.preventDefault();
      manualInput.value = '';
      manualInput.focus();
    });
  }

  if (clearExpiryBtn) {
    clearExpiryBtn.addEventListener('click', function(ev){
      ev.preventDefault();
      expiresInput.value = '';
      expiresInput.focus();
    });
  }
})();
