/*!
 * CS – OpenPOS Precio Dual Dinámico (USD + Bs)
 * v2.1.0 – 2025-08-24
 * Muestra Bs en buscador, addons, carrito y totales del POS.
 * Seguro para Angular: idempotente, con throttling y sin mutar contenedores base.
 */
/**
 * Script principal del conversor USD→Bs para OpenPOS.
 *
 * Este archivo se ejecuta siempre que el POS se cargue en el navegador.
 * A diferencia de versiones anteriores, no abandona si no existe un
 * <app-root> inmediatamente. En su lugar, registra observadores que
 * reaccionan cuando Angular crea la interfaz. Esto permite decorar
 * correctamente los componentes incluso si se cargan de forma
 * asíncrona o después del login.
 */
(function () {
  'use strict';

    // Compatibilidad con distintas versiones de OpenPOS
  var OPCompat = window.OpenPOSCompat || {};
  var csfxInitialSources = [];
  var csfxLastGoodRate = null;
  var csfxConnectionStatus = { status: 'unknown', reason: '', lastChange: Date.now() };
  var CSFX_DEFAULT_FETCH_TIMEOUT = 7000;
  var CSFX_HEALTH_INTERVAL_MS = 20000;
  var CSFX_HEALTH_TIMEOUT_MS = 5000;
  var csfxHealthTimer = null;
  var csfxLastHealthProbe = 0;
  var csfxDegradedRetryTimer = null;
  var CSFX_DEGRADED_RETRY_MS = 45000;
  var CSFX_DEGRADED_MODAL_SUPPRESS_MS = 30 * 60 * 1000;
  var CSFX_DEGRADED_MODAL_STORAGE_KEY = 'csfx_degraded_modal_suppress_until';
  var CSFX_DEGRADED_MODAL_BASE_COOLDOWN_MS = 120000;
  var csfxDegradedModalState = null;
  var csfxDegradedModalLastShown = 0;

  // --- Config FX (mezcla BOOT + localStorage) ---
  var FX = window.CSFX = (function () {
    var def = {
      enabled: true,
      base: 'USD',
      quote: 'VES',
         symbolUSD: '$',
      symbolVES: 'Bs.',
      symbol: 'Bs.',
      rate: 0,
      decimals: 2,
      updated: 0,
      ttl: 300,
      ajax: '',
      badge: true,
      hideTax: true,
      searchBs: true,
      payChips: true,
       addonsBs: true,
      debug: false,
           style: {
        bsColor: '#0057b7',
        vipSearch: true,
        vipSearchBg: 'rgba(0,87,183,.10)',
        vipSearchBorder: 'rgba(0,87,183,.28)',
        vipSearchText: '#1e3a8a',
        vipSearchShadow: '0 1px 0 rgba(255,255,255,.4) inset, 0 1px 4px rgba(0,0,0,.12)'
      }
    };
    // Datos inyectados por PHP antes de tener sesión
    if (window.__CS_FX_BOOT && typeof window.__CS_FX_BOOT === 'object') {
      var boot = window.__CS_FX_BOOT;
      var bootRate = Number(boot.rate || 0);
      if (bootRate > 0) {
        csfxInitialSources.push({
          rate: bootRate,
          updated: boot.updated || boot.updated_at || boot.updatedAt || 0,
          source: 'boot'
        });
      }
      if (boot.style && typeof boot.style === 'object') {
        Object.assign(def.style, boot.style);
      }
      Object.keys(boot).forEach(function (k) {
        if (k !== 'style' && boot[k] != null) def[k] = boot[k];
      });
    }
    // Datos persistidos por el POS una vez logueado
    try {
      var s = JSON.parse(localStorage.getItem('op_settings') || '{}');
      var fx = (s.setting && s.setting.cs_fx) || {};
      if (fx && typeof fx === 'object') {
        var fxRate = Number(fx.rate || 0);
        if (fxRate > 0) {
          csfxInitialSources.push({
            rate: fxRate,
            updated: fx.updated || fx.updated_at || fx.updatedAt || 0,
            source: 'pos-settings'
          });
        }
      }
      var fxUpdatedHint = fx.updated || fx.updated_at || fx.updatedAt || 0;
      var fxUpdatedTs = csfxParseUpdated(fxUpdatedHint);
      Object.keys(fx).forEach(function (k) {
        if (fx[k] == null) return;
        if (k === 'style' && typeof fx[k] === 'object') {
          Object.assign(def.style, fx[k]);
          return;
        }
        if (k === 'rate') {
          var incomingRate = Number(fx[k]);
          if (!isFinite(incomingRate) || incomingRate <= 0) return;
          var currentRate = Number(def.rate || 0);
          var currentUpdatedTs = csfxParseUpdated(def.updated);
          if (!currentRate || currentRate <= 0) {
            def.rate = incomingRate;
            if (fxUpdatedTs) def.updated = fxUpdatedTs;
            return;
          }
          if (!currentUpdatedTs && fxUpdatedTs) {
            def.rate = incomingRate;
            def.updated = fxUpdatedTs;
            return;
          }
          if (fxUpdatedTs && fxUpdatedTs > currentUpdatedTs) {
            def.rate = incomingRate;
            def.updated = fxUpdatedTs;
          }
          return;
        }
        if (k === 'updated' || k === 'updated_at' || k === 'updatedAt') {
          // la manejamos junto con rate para comparar timestamps
          return;
        }
        def[k] = fx[k];
      });
    } catch (e) {}
    def.rate = Number(def.rate) || 0;
    if (typeof def.updated === 'undefined' || def.updated === null) def.updated = 0;
    def.decimals = Number(def.decimals) || 2;

    // AJAX: si no viene, lo armamos desde action_url global del POS
    if (!def.ajax && typeof window !== 'undefined' && window.action_url) {
      var a = window.action_url;
      def.ajax = a + (a.indexOf('?') > -1 ? '&' : '?') + 'action=cs_fx_rate';
    }
      if (!def.symbol && def.symbolVES) def.symbol = def.symbolVES;
    window.__CS_FX = def; // legado
    window.csfx = def; // para debug externo
    return def;
  })();
  FX.hideTax = true;
  var initialDisc = (FX && FX.disc && typeof FX.disc === 'object') ? FX.disc : null;
  var initialPct = initialDisc && initialDisc.percent != null ? Number(initialDisc.percent) : 0;
  if (!isFinite(initialPct) || initialPct < 0) initialPct = 0;
  // Estado inicial para el descuento; parte de boot/localStorage cuando existan datos.
  FX.disc = {
    active: initialDisc && typeof initialDisc.active !== 'undefined' ? !!initialDisc.active : false,
    percent: initialPct
  };
  // si vienen opciones desde PHP, las respetamos; si no, default true
  if (window.CSFX_OPTS && typeof window.CSFX_OPTS.hideTax !== 'undefined') FX.hideTax = !!window.CSFX_OPTS.hideTax;

  var csfxCustomModalUI = null;
  var csfxExplainModalUI = null;
  var csfxFullConfirmUI = null;
  var csfxAuthWidget = null;
  var csfxUpdatingReference = false;
  var csfxCustomModalState = {
    open: false,
    authorized: false,
    pin: '',
    countdown: 0,
    countdownInterval: null,
    countdownTimeout: null
  };

  var CSFX_SUPERVISOR_STORAGE_KEY = 'csfx_last_supervisor';
var CSFX_SUPERVISOR_META_KEYS = [
  'csfx_auth_supervisor_id',
  'csfx_auth_supervisor_name',
  'csfx_auth_supervisor_email',
  'csfx_auth_supervisor_source',
  'csfx_auth_supervisor_method',
  'csfx_auth_supervisor_ref',
  'csfx_auth_supervisor_time',
  'csfx_auth_supervisor_expires',
  'csfx_auth_session_id'
];
  var CSFX_SUPERVISOR_INFO_LABEL = 'Supervisor';
  var csfxSupervisorCache = null;
  var csfxLastLoggedSupervisorMessage = '';
  var csfxQrScannerState = {
    active: false,
    detector: null,
    usesDetector: false,
    panel: null,
    video: null,
    stream: null,
    raf: 0,
    ui: null,
    canvas: null,
    ctx: null
  };

  function csfxReadSupervisorStorage() {
    try {
      var raw = null;
      if (typeof sessionStorage !== 'undefined') {
        raw = sessionStorage.getItem(CSFX_SUPERVISOR_STORAGE_KEY);
      }
      if (!raw && typeof localStorage !== 'undefined') {
        raw = localStorage.getItem(CSFX_SUPERVISOR_STORAGE_KEY);
      }
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch (_errReadSupervisor) {
      return null;
    }
  }

  function csfxRememberSupervisor(info) {
    if (info && typeof info === 'object') {
      csfxSupervisorCache = Object.assign({}, info);
      var payload = null;
      try { payload = JSON.stringify(csfxSupervisorCache); } catch (_errStringify) { payload = null; }
      if (payload) {
        try { if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(CSFX_SUPERVISOR_STORAGE_KEY, payload); } catch (_errSessionStore) {}
        try { if (typeof localStorage !== 'undefined') localStorage.setItem(CSFX_SUPERVISOR_STORAGE_KEY, payload); } catch (_errLocalStore) {}
      }
    } else {
      csfxSupervisorCache = null;
      try { if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(CSFX_SUPERVISOR_STORAGE_KEY); } catch (_errSessionRemove) {}
      try { if (typeof localStorage !== 'undefined') localStorage.removeItem(CSFX_SUPERVISOR_STORAGE_KEY); } catch (_errLocalRemove) {}
    }
  }

  function csfxGetLastSupervisor(forceReload) {
    if (!forceReload && csfxSupervisorCache) return csfxSupervisorCache;
    var stored = csfxReadSupervisorStorage();
    if (stored && typeof stored === 'object') {
      if (!stored.reference) {
        try { stored.reference = csfxAuthorizationReference(); } catch (_errRefFetch) {}
      }
      csfxSupervisorCache = stored;
      return csfxSupervisorCache;
    }
    csfxSupervisorCache = null;
    return null;
  }

  try {
    var csfxInitialSupervisor = csfxReadSupervisorStorage();
    if (csfxInitialSupervisor) {
      csfxRememberSupervisor(csfxInitialSupervisor);
    }
  } catch (_errInitRemember) {}

  try {
    document.addEventListener('csfx:supervisor-authorized', function (ev) {
      if (!ev || !ev.detail || !ev.detail.supervisor) return;
      var supervisor = Object.assign({}, ev.detail.supervisor);
      if (!supervisor.reference) {
        try { supervisor.reference = csfxAuthorizationReference(); } catch (_errRefAssign) {}
      }
      var label = supervisor.name ? supervisor.name : 'Supervisor sin nombre';
      if (supervisor.id) {
        label += ' (ID ' + supervisor.id + ')';
      }
      var preview = 'CSFX · Supervisor ' + label + ' autorizó descuentos personalizados.';
      if (csfxLastLoggedSupervisorMessage !== preview) {
        csfxLastLoggedSupervisorMessage = preview;
        try {
          console.info('[CSFX] Nota esperada: ' + preview, {
            reference: supervisor.reference || null,
            method: supervisor.method || supervisor.via || null,
            time: supervisor.authorized_at || supervisor.authorizedAt || null
          });
        } catch (_errConsole) {}
      }
      csfxRememberSupervisor(supervisor);
    });
  } catch (_errBindSupervisor) {}

  function csfxAccessDebugLog() {
    if (typeof console === 'undefined' || !console.log) return;
    var enabled = false;
    try {
      if (typeof window.CSFX_ACCESS_DEBUG !== 'undefined') {
        enabled = !!window.CSFX_ACCESS_DEBUG;
      } else if (typeof window.CSFX_DEBUG !== 'undefined') {
        enabled = !!window.CSFX_DEBUG;
      } else if (typeof FX !== 'undefined' && FX && typeof FX.debug !== 'undefined') {
        enabled = !!FX.debug;
      }
    } catch (_errEnabled) {}
    if (!enabled) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[CSFX Access]');
    try {
      console.log.apply(console, args);
    } catch (_errLog) {
      try { console.log(args.join(' ')); } catch (_errLog2) {}
    }
  }

  var CSFX_AUTH_DURATION_SECONDS = 120;
  var CSFX_AUTH_INFO_DEFAULT = 'Los descuentos nativos se habilitarán por 2 minutos tras autorizar.';
  var CSFX_AUTH_INFO_ACTIVE = 'Los descuentos nativos están habilitados temporalmente.';
  var CSFX_AUTH_INFO_DISABLED = 'Los descuentos nativos permanecen ocultos. Solicita autorización para habilitarlos.';

  var CSFX_NATIVE_STYLE_ID = 'csfx-hide-discounts';
  var CSFX_DISCOUNT_REMOVE_ATTR = 'data-csfx-allow-discount-remove';
  var CSFX_DISCOUNT_REMOVE_BYPASS_SELECTORS = [
    '[' + CSFX_DISCOUNT_REMOVE_ATTR + ']',
    '[data-action="remove"]',
    '[data-role="remove"]',
    '.remove',
    '.op-remove-discount',
    '[class*="delete"]',
    '[class*="Delete"]',
    '[class*="trash"]',
    '[class*="Trash"]',
    '[aria-label*="eliminar"]',
    '[aria-label*="Eliminar"]',
    '[aria-label*="remove"]',
    '[aria-label*="Remove"]',
    '[aria-label*="delete"]',
    '[aria-label*="Delete"]',
    '[aria-label*="trash"]',
    '[aria-label*="Trash"]',
    '.mat-icon[fonticon*="delete"]',
    '.mat-icon[fonticon*="Delete"]',
    '.mat-icon[fonticon*="trash"]',
    '.mat-icon[fonticon*="Trash"]',
    '.csfx-dual-adjust button'
  ];
  var CSFX_DISCOUNT_REMOVE_BYPASS_SELECTOR = CSFX_DISCOUNT_REMOVE_BYPASS_SELECTORS.join(', ');
  var CSFX_NATIVE_GUARD_SELECTORS = [
    'button[mat-icon-button][aria-label*="Descu"]',
    '.cart-discount button:not([' + CSFX_DISCOUNT_REMOVE_ATTR + ']):not([data-action="remove"]):not([data-role="remove"]):not(.remove):not(.op-remove-discount):not([class*="delete"]):not([class*="Delete"]):not([class*="trash"]):not([class*="Trash"]):not([aria-label*="eliminar"]):not([aria-label*="Eliminar"]):not([aria-label*="remove"]):not([aria-label*="Remove"]):not([aria-label*="delete"]):not([aria-label*="Delete"]):not([aria-label*="trash"]):not([aria-label*="Trash"])',
    '.mat-menu-panel button[aria-label*="Descu"]',
    '.product-discount-dialog button',
    '.mat-dialog-container button[aria-label*="Descuento"]',
    '.mat-dialog-container .discount-details-trigger',
    '.mat-dialog-container .discount-details-sidenav',
    '.csfx-guarded'
  ];
  var CSFX_NATIVE_STYLE_SELECTORS = [
    '.mat-dialog-container .discount-details-trigger',
    '.mat-dialog-container .discount-details-sidenav'
  ];
  var CSFX_NATIVE_GUARD_SELECTOR = CSFX_NATIVE_GUARD_SELECTORS.join(', ');
  var CSFX_NATIVE_STYLE_RULES = CSFX_NATIVE_STYLE_SELECTORS.join(', ') + ' { display: none !important; pointer-events: none !important; }' +
    '\n.cart-discount button:not([' + CSFX_DISCOUNT_REMOVE_ATTR + ']):not([data-action="remove"]):not([data-role="remove"]):not(.remove):not(.op-remove-discount):not([class*="delete"]):not([class*="Delete"]):not([class*="trash"]):not([class*="Trash"]):not([aria-label*="eliminar"]):not([aria-label*="Eliminar"]):not([aria-label*="remove"]):not([aria-label*="Remove"]):not([aria-label*="delete"]):not([aria-label*="Delete"]):not([aria-label*="trash"]):not([aria-label*="Trash"]), button[mat-icon-button][aria-label*="Descu"] { pointer-events: none !important; opacity: 0.35 !important; }';
  var csfxDiscountObserver = null;
  var csfxDiscountObserverPending = false;
  var csfxManualDiscountBypassUntil = 0;

  function csfxInsertStyle(id, cssText) {
    if (typeof document === 'undefined') return null;
    var existing = document.getElementById(id);
    if (existing) return existing;
    var style = document.createElement('style');
    style.id = id;
    style.textContent = cssText;
    var head = document.head || document.getElementsByTagName('head')[0] || document.documentElement;
    if (head) {
      head.appendChild(style);
      return style;
    }
    document.addEventListener('DOMContentLoaded', function handleDomReady() {
      document.removeEventListener('DOMContentLoaded', handleDomReady);
      var readyHead = document.head || document.getElementsByTagName('head')[0] || document.documentElement;
      if (readyHead && !document.getElementById(id)) {
        readyHead.appendChild(style);
      }
    });
    return style;
  }

  function csfxHideNativeDiscountButtons() {
    csfxInsertStyle(CSFX_NATIVE_STYLE_ID, CSFX_NATIVE_STYLE_RULES);
    csfxApplyDiscountRowGuard(document, true);
    csfxStartDiscountObserver();
    csfxManualDiscountBypassUntil = 0;
  }

  function csfxShowNativeDiscountButtons() {
  if (typeof document === 'undefined') return;
  var style = document.getElementById(CSFX_NATIVE_STYLE_ID);
  if (style && style.parentNode) {
    style.parentNode.removeChild(style);
  }
  csfxApplyDiscountRowGuard(document, false);
  csfxStopDiscountObserver();
  }

  function csfxMatchesDiscountTarget(node) {
    if (!node || typeof node !== 'object') return false;
    if (typeof node.closest === 'function') {
      try {
        var hit = node.closest(CSFX_NATIVE_GUARD_SELECTOR);
        if (hit) return true;
      } catch (_errClosest) {}
    }
    var current = node;
    while (current && current !== document && current !== window) {
      if (current.matches && current.matches(CSFX_NATIVE_GUARD_SELECTOR)) return true;
      current = current.parentNode || current.host || null;
    }
    return false;
  }

  var csfxDiscountGuard = { handler: null };

  function csfxBlockNativeDiscountActions() {
    if (typeof document === 'undefined') return;
    if (csfxDiscountGuard.handler) return;
    csfxDiscountGuard.handler = function (ev) {
      var target = ev && ev.target;
      if (!target) return;
      if (csfxManualDiscountBypassUntil && Date.now() < csfxManualDiscountBypassUntil) {
        return;
      }
      try {
        var removalParent = target.closest(CSFX_DISCOUNT_REMOVE_BYPASS_SELECTOR);
        if (removalParent) return;
      } catch (_errRemovalClosest) {}
      if (csfxMatchesDiscountTarget(target)) {
        try {
          var remover = target.closest(CSFX_DISCOUNT_REMOVE_BYPASS_SELECTOR);
          if (remover) return;
        } catch (_errClosestRemove) {}
        ev.stopPropagation();
        ev.preventDefault();
      }
    };
    document.addEventListener('click', csfxDiscountGuard.handler, true);
  }

  function csfxAllowNativeDiscountActions() {
    if (typeof document === 'undefined') return;
    if (!csfxDiscountGuard.handler) return;
    document.removeEventListener('click', csfxDiscountGuard.handler, true);
    csfxDiscountGuard.handler = null;
    csfxManualDiscountBypassUntil = 0;
  }

  function csfxCollapseDualPanel(panel) {
    if (typeof document === 'undefined') return;
    var targets = [];
    if (panel && typeof panel.closest === 'function') {
      var badge = panel.closest('.csfx-badge');
      if (badge) targets.push(badge);
    }
    if (!targets.length) {
      document.querySelectorAll('.csfx-badge.open').forEach(function (node) {
        if (targets.indexOf(node) === -1) targets.push(node);
      });
    }
    targets.forEach(function (node) {
      if (node && node.classList) {
        node.classList.remove('open');
      }
    });
  }

  function csfxEnsureAuthWidget() {
    if (typeof document === 'undefined') return null;
    if (csfxAuthWidget && csfxAuthWidget.root && document.body && document.body.contains(csfxAuthWidget.root)) {
      return csfxAuthWidget;
    }
    if (!document.body) return null;
    var root = document.createElement('div');
    root.className = 'csfx-auth-widget';
    var icon = document.createElement('span');
    icon.className = 'csfx-auth-widget__icon';
    icon.textContent = '⏳';
    var info = document.createElement('div');
    info.className = 'csfx-auth-widget__info';
    var ref = document.createElement('span');
    ref.className = 'csfx-auth-widget__ref';
    ref.textContent = 'Ref. POS';
    var timer = document.createElement('span');
    timer.className = 'csfx-auth-widget__timer';
    timer.textContent = 'Autorización expira en 0:00';
    info.appendChild(ref);
    info.appendChild(timer);
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'csfx-auth-widget__close';
    closeBtn.textContent = 'Cerrar';
    root.appendChild(icon);
    root.appendChild(info);
    root.appendChild(closeBtn);
    document.body.appendChild(root);
    closeBtn.addEventListener('click', function () {
      csfxHideAuthWidget();
      csfxDeactivateNativeDiscountControls();
    });
    csfxAuthWidget = { root: root, timer: timer, closeBtn: closeBtn, ref: ref, icon: icon };
    csfxUpdateAuthorizationReferenceText();
    return csfxAuthWidget;
  }

  function csfxShowAuthWidget() {
    var widget = csfxEnsureAuthWidget();
    if (!widget || !widget.root) return;
    widget.root.setAttribute('data-open', 'true');
    csfxUpdateAuthorizationReferenceText();
    csfxUpdateAuthWidgetCountdown();
  }

  function csfxHideAuthWidget() {
    if (!csfxAuthWidget || !csfxAuthWidget.root) return;
    csfxAuthWidget.root.removeAttribute('data-open');
    csfxAuthWidget.root.removeAttribute('data-active');
    csfxAuthWidget.root.removeAttribute('data-tone');
  }

  function csfxUpdateAuthWidgetCountdown() {
    if (!csfxAuthWidget || !csfxAuthWidget.timer) return;
    var tone = '';
    if (csfxCustomModalState.authorized && csfxCustomModalState.countdown > 0) {
      csfxAuthWidget.timer.textContent = 'Autorización expira en ' + csfxFormatCountdown(csfxCustomModalState.countdown);
      if (csfxAuthWidget.root) {
        csfxAuthWidget.root.setAttribute('data-active', '1');
      }
      if (csfxCustomModalState.countdown <= 30) {
        tone = 'danger';
      } else if (csfxCustomModalState.countdown <= 60) {
        tone = 'warn';
      } else {
        tone = 'safe';
      }
    } else {
      csfxAuthWidget.timer.textContent = 'Autorización inactiva';
      if (csfxAuthWidget.root) {
        csfxAuthWidget.root.removeAttribute('data-active');
      }
    }
    if (csfxAuthWidget.root) {
      if (tone) {
        csfxAuthWidget.root.setAttribute('data-tone', tone);
      } else {
        csfxAuthWidget.root.removeAttribute('data-tone');
      }
    }
  }

  function csfxApplyDiscountRowGuard(root, enable) {
    if (typeof document === 'undefined') return;
    if (!root) root = document;
    if (!root.querySelectorAll) return;
    if (!enable) {
      root.querySelectorAll('.csfx-guarded').forEach(function (node) {
        node.classList.remove('csfx-guarded');
      });
      return;
    }
    if (csfxCustomModalState && csfxCustomModalState.authorized) return;
    var selectors = '.item-row, .mat-list-item, .discount-details-trigger, .discount-details-sidenav, .mat-dialog-container div, .mat-dialog-container span, .mat-dialog-container button';
    var nodes = root.querySelectorAll(selectors);
    nodes.forEach(function (node) {
      if (!node || !node.textContent) return;
      if (node.classList && node.classList.contains('csfx-guarded')) return;
      var text = node.textContent.trim().toLowerCase();
      if (!text) return;
      if (text === 'descuento' || text.indexOf('descuento ') === 0 || text.indexOf(' descuento') !== -1) {
        var target = null;
        if (node.matches && node.matches('.item-row, .mat-list-item, .discount-details-trigger, .discount-details-sidenav')) {
          target = node;
        }
        if (!target && typeof node.closest === 'function') {
          target = node.closest('.item-row, .mat-list-item, .discount-details-trigger, .discount-details-sidenav');
        }
        if (!target || !target.classList) return;
        target.classList.add('csfx-guarded');
      }
    });
  }

  function csfxStartDiscountObserver() {
    if (csfxDiscountObserver || typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
    if (!document.body) {
      if (csfxDiscountObserverPending) return;
      csfxDiscountObserverPending = true;
      document.addEventListener('DOMContentLoaded', function handleCsfxGuard() {
        document.removeEventListener('DOMContentLoaded', handleCsfxGuard);
        csfxDiscountObserverPending = false;
        csfxStartDiscountObserver();
      });
      return;
    }
    csfxDiscountObserverPending = false;
    csfxDiscountObserver = new MutationObserver(function (mutations) {
      if (csfxCustomModalState && csfxCustomModalState.authorized) return;
      mutations.forEach(function (mutation) {
        if (!mutation.addedNodes) return;
        mutation.addedNodes.forEach(function (node) {
          if (!node || node.nodeType !== 1) return;
          csfxApplyDiscountRowGuard(node, true);
        });
      });
    });
    csfxDiscountObserver.observe(document.body, { childList: true, subtree: true });
  }

  function csfxStopDiscountObserver() {
    if (!csfxDiscountObserver) {
      csfxDiscountObserverPending = false;
      return;
    }
    try { csfxDiscountObserver.disconnect(); } catch (_err) {}
    csfxDiscountObserver = null;
    csfxDiscountObserverPending = false;
  }

  function csfxFormatCountdown(seconds) {
    var total = Math.max(0, Math.floor(Number(seconds) || 0));
    var minutes = Math.floor(total / 60);
    var sec = total % 60;
    return minutes + ':' + String(sec).padStart(2, '0');
  }

  csfxHideNativeDiscountButtons();
  csfxBlockNativeDiscountActions();

  function csfxClearDiscountCountdown() {
    if (csfxCustomModalState.countdownInterval) {
      clearInterval(csfxCustomModalState.countdownInterval);
      csfxCustomModalState.countdownInterval = null;
    }
    if (csfxCustomModalState.countdownTimeout) {
      clearTimeout(csfxCustomModalState.countdownTimeout);
      csfxCustomModalState.countdownTimeout = null;
    }
    csfxHideAuthWidget();
    csfxUpdateAuthWidgetCountdown();
  }

  function csfxDeactivateNativeDiscountControls(options) {
    options = options || {};
    csfxCustomModalState.authorized = false;
    csfxCustomModalState.pin = '';
    csfxClearDiscountCountdown();
    csfxCustomModalState.countdown = 0;
    csfxHideNativeDiscountButtons();
    csfxBlockNativeDiscountActions();
    var ui = options.ui || csfxCustomModalUI;
    if (ui) {
      if (ui.countdown) {
        ui.countdown.textContent = options.countdownMessage || '';
        ui.countdown.removeAttribute('data-active');
      }
      if (ui.infoMessage && !options.silent) {
        ui.infoMessage.textContent = options.infoMessage || CSFX_AUTH_INFO_DISABLED;
      }
      if (ui.pinInput) {
        ui.pinInput.disabled = false;
        ui.pinInput.value = '';
      }
      if (ui.validateBtn) ui.validateBtn.disabled = false;
      if (ui.scanBtn) ui.scanBtn.disabled = false;
    if (ui.authStatus && !options.silent) {
      csfxShowCustomFeedback(ui.authStatus, 'Los descuentos nativos fueron deshabilitados.', null);
    }
  }
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.removeItem(CSFX_SUPERVISOR_STORAGE_KEY);
      }
    } catch (_errClearStore) {}
    csfxSupervisorCache = null;
    csfxLastLoggedSupervisorMessage = '';
    try { window.CSFX_LAST_SUPERVISOR = null; } catch (_errWin) {}
    csfxUpdateAuthWidgetCountdown();
  }

  function csfxBeginNativeDiscountWindow(ui, pin) {
    if (!ui) return;
    csfxClearDiscountCountdown();
    csfxCustomModalState.authorized = true;
    csfxCustomModalState.pin = pin;
    csfxCustomModalState.countdown = CSFX_AUTH_DURATION_SECONDS;
    csfxShowNativeDiscountButtons();
    csfxAllowNativeDiscountActions();
    csfxCollapseDualPanel();
    csfxShowAuthWidget();
    if (ui.pinInput) {
      ui.pinInput.value = '';
      ui.pinInput.disabled = true;
    }
    if (ui.validateBtn) ui.validateBtn.disabled = true;
    if (ui.scanBtn) ui.scanBtn.disabled = true;
    if (ui.infoMessage) {
      ui.infoMessage.textContent = CSFX_AUTH_INFO_ACTIVE;
    }
    if (ui.authStatus) {
      csfxShowCustomFeedback(ui.authStatus, 'Autorización confirmada. Puedes asignar descuentos por producto durante ' + csfxFormatCountdown(CSFX_AUTH_DURATION_SECONDS) + '.', true);
    }
    var updateCountdown = function () {
      if (ui && ui.countdown) {
        ui.countdown.setAttribute('data-active', '1');
        ui.countdown.textContent = 'Tiempo restante: ' + csfxFormatCountdown(csfxCustomModalState.countdown);
      }
      csfxUpdateAuthWidgetCountdown();
    };
    updateCountdown();
    csfxCloseCustomDiscountModal({ keepAuthorized: true, silent: true });
    csfxCustomModalState.countdownInterval = setInterval(function () {
      if (!csfxCustomModalState.authorized) {
        csfxClearDiscountCountdown();
        return;
      }
      csfxCustomModalState.countdown = Math.max(0, csfxCustomModalState.countdown - 1);
      updateCountdown();
      if (csfxCustomModalState.countdown <= 0) {
        csfxClearDiscountCountdown();
        csfxDeactivateNativeDiscountControls({ ui: ui });
        csfxCloseCustomDiscountModal();
      }
    }, 1000);
    csfxCustomModalState.countdownTimeout = setTimeout(function () {
      csfxDeactivateNativeDiscountControls({ ui: ui });
      csfxCloseCustomDiscountModal();
    }, CSFX_AUTH_DURATION_SECONDS * 1000);
  }

  function decodeSymbol(sym, fallback) {
    if (!sym) return fallback || '';
    if (typeof sym !== 'string') return sym;
    if (sym.indexOf('&') === -1) return sym;
    return sym
      .replace(/&amp;/gi, '&')
      .replace(/&#(\d+);/g, function (_, code) {
        var n = parseInt(code, 10);
        return isFinite(n) ? String.fromCharCode(n) : _;
      })
      .replace(/&(#x[0-9a-f]+);/gi, function (_, hex) {
        var n = parseInt(hex.slice(2), 16);
        return isFinite(n) ? String.fromCharCode(n) : _;
      })
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, '\'')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>');
  }

  FX.symbolUSD = decodeSymbol(FX.symbolUSD, '$');
  FX.symbol = decodeSymbol(FX.symbol, 'Bs.');
  FX.symbolVES = decodeSymbol(FX.symbolVES, 'Bs.');
  var CSFX_BASE_CODE = (FX.base || 'USD').toUpperCase();
  var CSFX_BASE_LABEL = CSFX_BASE_CODE;
  var CSFX_BASE_SYMBOL = FX.symbolUSD || '$';

  var FX_STATE_STORAGE_KEY = 'csfx_state_v1';
  var fxOfflineState = (function(){
    try {
      var raw = localStorage.getItem(FX_STATE_STORAGE_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (_err) {
      return {};
    }
  })();
  if (fxOfflineState && typeof fxOfflineState === 'object') {
    var cachedRate = Number(fxOfflineState.rate || 0);
    if (cachedRate > 0) {
      csfxInitialSources.push({
        rate: cachedRate,
        updated: fxOfflineState.updated || 0,
        source: fxOfflineState.source || 'offline-cache'
      });
    }
  }

  function persistFxOfflineState(partial){
    if (!partial || typeof partial !== 'object') return;
    fxOfflineState = fxOfflineState && typeof fxOfflineState === 'object' ? fxOfflineState : {};
    var hasRate = typeof partial.rate !== 'undefined';
    if (hasRate) {
      var incomingRate = Number(partial.rate);
      var incomingValid = isFinite(incomingRate) && incomingRate > 0;
      if (incomingValid) {
        var incomingTs = 0;
        if (partial.updated !== undefined && partial.updated !== null) {
          incomingTs = Number(partial.updated);
        }
        if (!incomingTs && partial.updatedRaw !== undefined && partial.updatedRaw !== null) {
          incomingTs = csfxParseUpdated(partial.updatedRaw);
        }
        if (!incomingTs || !isFinite(incomingTs)) {
          incomingTs = Date.now();
        }
        var currentTs = Number(fxOfflineState.updated) || 0;
        if (!currentTs || incomingTs >= currentTs) {
          fxOfflineState.rate = incomingRate;
          fxOfflineState.updated = incomingTs;
          if (partial.updatedRaw !== undefined) fxOfflineState.updatedRaw = partial.updatedRaw;
          if (partial.source !== undefined) fxOfflineState.source = partial.source;
        }
      }
    }
    Object.keys(partial).forEach(function(k){
      if (k === 'rate' || k === 'updated' || k === 'updatedRaw' || k === 'source') return;
      fxOfflineState[k] = partial[k];
    });
    try {
      localStorage.setItem(FX_STATE_STORAGE_KEY, JSON.stringify(fxOfflineState));
    } catch (_err) { /* storage lleno/offline */ }
  }
  function csfxParseUpdated(u){
    if (u === undefined || u === null) return 0;
    if (typeof u === 'number') {
      if (!isFinite(u)) return 0;
      return u < 1e12 ? u * 1000 : u;
    }
    if (typeof u === 'string') {
      var trimmed = u.trim();
      if (!trimmed) return 0;
      var numeric = Number(trimmed);
      if (!isNaN(numeric)) {
        return numeric < 1e12 ? numeric * 1000 : numeric;
      }
      var parsed = Date.parse(trimmed);
      return isNaN(parsed) ? 0 : parsed;
    }
    return 0;
  }
  function csfxSourcePriority(source){
    var norm = String(source || '').toLowerCase();
    if (!norm) return 0;
    if (norm === 'api' || norm === 'fox') return 6;
    if (norm === 'currencies' || norm === 'boot') return 5;
    if (norm === 'pos-settings' || norm === 'session' || norm === 'op_settings') return 4;
    if (norm === 'offline-cache' || norm === 'fallback') return 3;
    if (norm === 'last') return 2;
    return 1;
  }
  function csfxPickBestCandidate(list){
    if (!Array.isArray(list)) return null;
    var best = null;
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item) continue;
      var rate = Number(item.rate || 0);
      if (!isFinite(rate) || rate <= 0) continue;
      var candidate = {
        rate: rate,
        updated: item.updated,
        source: item.source || '',
        ts: csfxParseUpdated(item.updated)
      };
      candidate.priority = csfxSourcePriority(candidate.source);
      if (!best) {
        best = candidate;
        continue;
      }
      if (candidate.priority > best.priority) {
        best = candidate;
        continue;
      }
      if (candidate.priority === best.priority) {
        if ((candidate.ts || 0) > (best.ts || 0)) {
          best = candidate;
          continue;
        }
        if ((!candidate.ts && !best.ts) && candidate.rate > best.rate) {
          best = candidate;
          continue;
        }
      }
    }
    return best;
  }
  function csfxRememberLastGood(rate, updated, source, opts){
    opts = opts || {};
    var numRate = Number(rate || 0);
    if (!isFinite(numRate) || numRate <= 0) return;
    var key = source || 'fallback';
    var ts = csfxParseUpdated(updated);
    if (!ts) {
      ts = Date.now();
    }
    if (csfxLastGoodRate && csfxLastGoodRate.ts && ts && ts < csfxLastGoodRate.ts) {
      if (!opts.force) return;
    }
    var status = (csfxConnectionStatus && csfxConnectionStatus.status) ? csfxConnectionStatus.status : 'unknown';
    if (!opts.force && status !== 'online' && status !== 'unknown') {
      if (csfxLastGoodRate && csfxLastGoodRate.rate > 0) {
        return;
      }
    }
    csfxLastGoodRate = {
      rate: numRate,
      updated: (updated !== undefined && updated !== null) ? updated : ts,
      source: key,
      ts: ts
    };
    var stored = { rate: numRate, updated: ts, source: key };
    if (updated !== undefined && updated !== null) stored.updatedRaw = updated;
    persistFxOfflineState(stored);
    // refrescar arreglo de fuentes iniciales
    var replaced = false;
    for (var i = 0; i < csfxInitialSources.length; i++) {
      var src = csfxInitialSources[i];
      if (src && src.source === key) {
        var existingTs = csfxParseUpdated(src.updated);
        if (existingTs && existingTs > ts) {
          replaced = true;
          break;
        }
        csfxInitialSources[i] = { rate: numRate, updated: updated, source: key };
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      csfxInitialSources.push({ rate: numRate, updated: updated, source: key });
    }
    if (FX) {
      FX.rateSource = key;
    }
  }
  function csfxEnsureBestInitialRate(){
    var candidate = csfxPickBestCandidate(csfxInitialSources);
    var current = null;
    if (FX.rate && FX.rate > 0) {
      current = {
        rate: FX.rate,
        updated: FX.updated,
        source: FX.rateSource || 'initial',
        ts: csfxParseUpdated(FX.updated),
        priority: csfxSourcePriority(FX.rateSource || 'initial')
      };
    }
    if (current) {
      if (!candidate) {
        candidate = current;
      } else if (current.priority > candidate.priority) {
        candidate = current;
      } else if (current.priority === candidate.priority && (current.ts || 0) > (candidate.ts || 0)) {
        candidate = current;
      }
    }
    if (!candidate && current) candidate = current;
    if (!candidate && csfxLastGoodRate) candidate = csfxLastGoodRate;
    if (candidate) {
      FX.rate = candidate.rate;
      if (candidate.updated !== undefined) FX.updated = candidate.updated;
      FX.rateSource = candidate.source || FX.rateSource || 'initial';
      csfxRememberLastGood(candidate.rate, candidate.updated, candidate.source || 'initial', { force: true });
    }
  }
  function csfxApplyFallbackRate(context){
    if (FX.rate && FX.rate > 0) return false;
    var pool = csfxInitialSources.slice();
    if (csfxLastGoodRate && csfxLastGoodRate.rate > 0) {
      pool.push(csfxLastGoodRate);
    }
    if (fxOfflineState && Number(fxOfflineState.rate || 0) > 0) {
      pool.push({
        rate: Number(fxOfflineState.rate),
        updated: fxOfflineState.updated,
        source: 'offline-cache'
      });
    }
    var candidate = null;
    if (csfxLastGoodRate && csfxLastGoodRate.rate > 0) {
      candidate = csfxLastGoodRate;
    }
    var best = csfxPickBestCandidate(pool);
    if (best) {
      if (!candidate) {
        candidate = best;
      } else {
        var status = (csfxConnectionStatus && csfxConnectionStatus.status) ? csfxConnectionStatus.status : 'unknown';
        var preferStored = (status === 'degraded' || status === 'offline');
        if (!preferStored && (!candidate.ts || (best.ts || 0) > (candidate.ts || 0))) {
          candidate = best;
        } else if (preferStored && candidate !== csfxLastGoodRate && (!candidate.ts || (best.ts || 0) > (candidate.ts || 0))) {
          candidate = best;
        }
      }
    }
    if (candidate) {
      FX.rate = candidate.rate;
      if (candidate.updated !== undefined) {
        FX.updated = candidate.updated;
      } else if (candidate.ts) {
        FX.updated = candidate.ts;
      }
      FX.rateSource = candidate.source || FX.rateSource || 'fallback';
      csfxRememberLastGood(candidate.rate, candidate.updated, candidate.source || context || 'fallback');
      return true;
    }
    return false;
  }
  function csfxCurrentBadgeIcon(){
    if (csfxConnectionStatus.status === 'offline') return '🚫';
    if (csfxConnectionStatus.status === 'degraded') return '⚠️';
    return '🏷️';
  }
  function csfxSetConnectionStatus(status, reason){
    var normalized = status || 'unknown';
    var motive = reason || '';
    var previous = csfxConnectionStatus.status || 'unknown';
    if (csfxConnectionStatus.status === normalized && (csfxConnectionStatus.reason || '') === motive) {
      return;
    }
    csfxConnectionStatus = {
      status: normalized,
      reason: motive,
      lastChange: Date.now()
    };
    if (FX) {
      FX.connectionStatus = normalized;
    }
    var badge = document.querySelector('.csfx-badge');
    if (badge) {
      badge.dataset.csfxStatus = normalized;
      if (motive) badge.dataset.csfxStatusReason = motive; else delete badge.dataset.csfxStatusReason;
      csfxUpdateBadgeHandle(badge);
    }
    if (normalized === 'degraded') {
      csfxScheduleDegradedRetry();
      if (previous !== 'degraded') {
        csfxMaybeShowDegradedAlert();
        setTimeout(function () {
          if (csfxConnectionStatus.status === 'degraded') {
            try {
              refreshRate(function(){});
            } catch (_errImmediateRetry) {
              /* ignore */
            }
          }
        }, 5000);
      } else if (!csfxIsDegradedAlertVisible()) {
        csfxMaybeShowDegradedAlert();
      }
    } else {
      csfxStopDegradedRetry();
      if (previous === 'degraded' || normalized === 'online') {
        csfxCloseDegradedAlert();
      }
      if (normalized === 'online') {
        csfxRememberDegradedSuppressUntil(0);
      }
    }
  }

  function csfxStopDegradedRetry(){
    if (csfxDegradedRetryTimer) {
      clearInterval(csfxDegradedRetryTimer);
      csfxDegradedRetryTimer = null;
    }
  }

  function csfxScheduleDegradedRetry(){
    if (csfxDegradedRetryTimer) return;
    csfxDegradedRetryTimer = setInterval(function(){
      if (csfxConnectionStatus.status !== 'degraded') {
        csfxStopDegradedRetry();
        return;
      }
      csfxMaybeShowDegradedAlert();
      try {
        refreshRate(function(){});
      } catch (_errDegradedRetry) {
        /* sin efecto */
      }
    }, CSFX_DEGRADED_RETRY_MS);
  }

  function csfxReadDegradedSuppressUntil(){
    try {
      var raw = localStorage.getItem(CSFX_DEGRADED_MODAL_STORAGE_KEY);
      if (!raw) return 0;
      var num = Number(raw);
      return isFinite(num) ? num : 0;
    } catch (_errReadSuppress) {
      return 0;
    }
  }

  function csfxRememberDegradedSuppressUntil(untilTs){
    try {
      if (!untilTs) {
        localStorage.removeItem(CSFX_DEGRADED_MODAL_STORAGE_KEY);
      } else {
        localStorage.setItem(CSFX_DEGRADED_MODAL_STORAGE_KEY, String(untilTs));
      }
    } catch (_errRememberSuppress) {
      /* almacenamiento no disponible */
    }
  }

  function csfxIsDegradedAlertVisible(){
    return !!(csfxDegradedModalState && csfxDegradedModalState.open);
  }

  function csfxEnsureDegradedAlert(){
    if (csfxDegradedModalState && csfxDegradedModalState.element) {
      return csfxDegradedModalState;
    }
    var overlay = document.createElement('div');
    overlay.className = 'csfx-alert-overlay';
    var modal = document.createElement('div');
    modal.className = 'csfx-alert-modal';
    var title = document.createElement('h3');
    title.className = 'csfx-alert-title';
    title.innerHTML = 'No se pudo actualizar la tasa';
    var body = document.createElement('p');
    body.className = 'csfx-alert-body';
    var rateInfo = document.createElement('p');
    rateInfo.className = 'csfx-alert-rate';
    var actions = document.createElement('div');
    actions.className = 'csfx-alert-actions';
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'csfx-btn csfx-btn--primary';
    closeBtn.textContent = 'Entendido';
    var snoozeBtn = document.createElement('button');
    snoozeBtn.type = 'button';
    snoozeBtn.className = 'csfx-btn csfx-btn--ghost';
    snoozeBtn.textContent = 'No volver a mostrar por 30 minutos';

    actions.appendChild(closeBtn);
    actions.appendChild(snoozeBtn);
    modal.appendChild(title);
    modal.appendChild(body);
    modal.appendChild(rateInfo);
    modal.appendChild(actions);
    overlay.appendChild(modal);

    closeBtn.addEventListener('click', function(ev){
      ev.preventDefault();
      csfxCloseDegradedAlert();
    });
    snoozeBtn.addEventListener('click', function(ev){
      ev.preventDefault();
      var until = Date.now() + CSFX_DEGRADED_MODAL_SUPPRESS_MS;
      csfxRememberDegradedSuppressUntil(until);
      csfxCloseDegradedAlert();
    });
    overlay.addEventListener('click', function(ev){
      if (ev.target === overlay) {
        csfxCloseDegradedAlert();
      }
    });
    csfxDegradedModalState = {
      element: overlay,
      modal: modal,
      title: title,
      body: body,
      rate: rateInfo,
      closeBtn: closeBtn,
      snoozeBtn: snoozeBtn,
      open: false
    };
    return csfxDegradedModalState;
  }

  function csfxUpdateDegradedAlertCopy(){
    if (!csfxDegradedModalState) return;
    var rateDisplay = '';
    if (FX && FX.rate > 0) {
      var decimals = isFinite(Number(FX.decimals)) ? Number(FX.decimals) : 2;
      rateDisplay = (FX.symbolVES || 'Bs.') + ' ' + FX.rate.toFixed(decimals);
    } else {
      rateDisplay = 'sin dato';
    }
    var body = 'Seguimos usando la última tasa disponible para continuar cobrando. Verifica con un supervisor si el problema persiste.';
    csfxDegradedModalState.body.textContent = body;
    csfxDegradedModalState.rate.textContent = 'Tasa aplicada actualmente: ' + rateDisplay;
  }

  function csfxOpenDegradedAlert(){
    var state = csfxEnsureDegradedAlert();
    if (!state) return;
    if (!state.open) {
      csfxUpdateDegradedAlertCopy();
      if (document.body && !state.element.parentNode) {
        document.body.appendChild(state.element);
      }
      state.open = true;
      csfxDegradedModalLastShown = Date.now();
    } else {
      csfxUpdateDegradedAlertCopy();
    }
  }

  function csfxCloseDegradedAlert(){
    if (csfxDegradedModalState && csfxDegradedModalState.element && csfxDegradedModalState.element.parentNode) {
      csfxDegradedModalState.element.parentNode.removeChild(csfxDegradedModalState.element);
    }
    if (csfxDegradedModalState) {
      csfxDegradedModalState.open = false;
    }
  }

  function csfxMaybeShowDegradedAlert(){
    if (csfxConnectionStatus.status !== 'degraded') return;
    var suppressUntil = csfxReadDegradedSuppressUntil();
    if (suppressUntil && Date.now() < suppressUntil) {
      return;
    }
    if (csfxDegradedModalLastShown && (Date.now() - csfxDegradedModalLastShown) < CSFX_DEGRADED_MODAL_BASE_COOLDOWN_MS) {
      return;
    }
    csfxOpenDegradedAlert();
  }

  function csfxProbeBackend(force){
    var endpoint = window.CSFX_RATE_ENDPOINT || '/wp-json/csfx/v1/rate';
    if (!endpoint) return;
    var now = Date.now();
    if (!force && now - csfxLastHealthProbe < 5000) return;
    csfxLastHealthProbe = now;
    var url = endpoint + (endpoint.indexOf('?') === -1 ? '?' : '&') + 'health=1&_ts=' + now;
    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timeoutMs = Math.max(2000, Math.min(8000, Number(FX.healthTimeout || CSFX_HEALTH_TIMEOUT_MS)));
    var timedOut = false;
    var timeoutId = null;
    var opts = { method: 'GET', cache: 'no-store', credentials: 'same-origin', headers: { 'Accept': 'application/json' } };
    if (controller) {
      opts.signal = controller.signal;
      timeoutId = setTimeout(function(){
        timedOut = true;
        try { controller.abort(); } catch (_abortErr) {}
      }, timeoutMs);
    }
    fetch(url, opts)
      .then(function (r) {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (r && r.ok) {
          if (csfxConnectionStatus.status !== 'degraded') {
            csfxSetConnectionStatus('online', '');
          } else {
            var badge = document.querySelector('.csfx-badge');
            if (badge) csfxUpdateBadgeHandle(badge);
          }
        } else {
          throw new Error('health_http_' + (r ? r.status : '0'));
        }
      })
      .catch(function (err) {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        var reason = timedOut ? 'health-timeout' : ((err && err.message) || 'health-error');
        csfxSetConnectionStatus('offline', reason);
      });
  }

  function csfxStartHealthMonitor(){
    if (csfxHealthTimer) return;
    var interval = Number(FX.healthInterval || 0);
    if (!interval || !isFinite(interval) || interval < 10000) interval = CSFX_HEALTH_INTERVAL_MS;
    interval = Math.min(Math.max(interval, 10000), 90000);
    csfxHealthTimer = setInterval(function(){ csfxProbeBackend(false); }, interval);
  }

  function hydrateFxRateFromOffline(){
    if (!fxOfflineState || typeof fxOfflineState !== 'object') return;
    var rate = Number(fxOfflineState.rate || 0);
    if (rate > 0 && (!FX.rate || FX.rate <= 0)) {
      FX.rate = rate;
      if (fxOfflineState.updated) FX.updated = fxOfflineState.updated;
      csfxRememberLastGood(rate, FX.updated, 'offline-cache', { force: true });
    }
  }

  function hydrateFxDiscountFromOffline(){
    if (!fxOfflineState || typeof fxOfflineState !== 'object' || !fxOfflineState.disc) return;
    var storedDisc = fxOfflineState.disc;
    var raw = (typeof storedDisc.percent !== 'undefined') ? storedDisc.percent : storedDisc.percentDecimal;
    var pct = Number(raw || 0);
    if (!isFinite(pct) || pct <= 0) return;
    var normalized = pct > 1 ? pct : pct * 100;
    if (!FX.disc || typeof FX.disc !== 'object') {
      FX.disc = {
        active: !!storedDisc.active,
        percent: normalized
      };
      return;
    }
    if (!FX.disc.percent || FX.disc.percent <= 0) {
      FX.disc.percent = normalized;
    }
    if (typeof FX.disc.active === 'undefined') {
      FX.disc.active = !!storedDisc.active;
    }
  }

  hydrateFxRateFromOffline();
  hydrateFxDiscountFromOffline();
  csfxEnsureBestInitialRate();
  schedule(runAll);
  csfxProbeBackend(true);
  csfxStartHealthMonitor();

  if (typeof window !== 'undefined') {
    try {
      window.addEventListener('offline', function () {
        csfxSetConnectionStatus('offline', 'browser-offline');
      });
      window.addEventListener('online', function () {
        csfxProbeBackend(true);
        refreshRate(function(){});
      });
    } catch (_errNetEvents) {}
  }

    function csfxClearLegacyStores(){
    try { localStorage.removeItem('YU_BCV_RATE'); } catch(_){ }
    try { localStorage.removeItem('CSFX_RATE'); } catch(_){ }
    try { if (window.YuPrecio) delete window.YuPrecio; } catch(_){ }
  }

  csfxClearLegacyStores();

  var csfxCachedRegisterId = null;
  var csfxRegisterIdSource = '';
  var csfxRegisterScanAt = 0;
  var csfxCartKeyCache = null;
  var csfxCartKeyCacheAt = 0;
  var csfxAsyncCartCache = null;
  var csfxAsyncCartFetchedAt = 0;
  var csfxAsyncCartDebug = null;
  var csfxSessionCartKeyCache = null;
  var csfxSessionCartKeyCacheAt = 0;
  var csfxIndexedDbCartsCache = null;
  var csfxIndexedDbScanAt = 0;
  var csfxIndexedDbScanPromise = null;
  var CSFX_SESSION_KEY_CACHE_TTL = 5000;
  var CSFX_REGISTER_SCAN_COOLDOWN = 2500;
  var CSFX_LS_KEY_CACHE_TTL = 5000;
  var CSFX_ASYNC_CART_TTL_MS = 4000;
  var CSFX_DEEP_CART_MAX_DEPTH = 6;
  var CSFX_DEEP_CART_MAX_BRANCH = 120;
  var CSFX_INDEXEDDB_TTL_MS = 10000;

  function csfxRememberRegisterId(candidate, source) {
    if (candidate === null || candidate === undefined) return null;
    var str = String(candidate).trim();
    if (!str) return null;
    csfxCachedRegisterId = str;
    if (source) csfxRegisterIdSource = source;
    return str;
  }

  function csfxExtractRegisterId(obj, source) {
    if (!obj || typeof obj !== 'object') return null;
    var directKeys = ['register_id', 'registerId', 'registerID', 'registerid', 'pos_register_id'];
    for (var i = 0; i < directKeys.length; i++) {
      var key = directKeys[i];
      if (obj[key] !== undefined && obj[key] !== null) {
        return csfxRememberRegisterId(obj[key], (source || '') + '.' + key);
      }
    }
    if (typeof obj.id !== 'undefined' && (obj.type === 'register' || obj.entity === 'register')) {
      return csfxRememberRegisterId(obj.id, (source || '') + '.id');
    }
    var relatedKeys = ['register', 'current_register', 'cashdrawer', 'drawer', 'session', 'meta', 'data'];
    for (var j = 0; j < relatedKeys.length; j++) {
      var nestedKey = relatedKeys[j];
      if (obj[nestedKey] && typeof obj[nestedKey] === 'object') {
        var nested = csfxExtractRegisterId(obj[nestedKey], (source || '') + '.' + nestedKey);
        if (nested) return nested;
      }
    }
    var keys = Object.keys(obj);
    for (var k = 0; k < keys.length; k++) {
      var name = keys[k];
      if (!name || name.length > 40) continue;
      if (!/register/i.test(name)) continue;
      var value = obj[name];
      if (!value) continue;
      if (typeof value === 'string' || typeof value === 'number') {
        return csfxRememberRegisterId(value, (source || '') + '.' + name);
      }
      if (typeof value === 'object') {
        var nestedVal = csfxExtractRegisterId(value, (source || '') + '.' + name);
        if (nestedVal) return nestedVal;
      }
    }
    return null;
  }

  function csfxScanForRegisterId() {
    var now = Date.now();
    if (csfxCachedRegisterId && csfxCachedRegisterId.trim()) {
      csfxUpdateAuthorizationReferenceText();
      return { id: csfxCachedRegisterId, source: csfxRegisterIdSource || 'cache' };
    }
    if (now - csfxRegisterScanAt < CSFX_REGISTER_SCAN_COOLDOWN) {
      if (csfxCachedRegisterId) {
        csfxUpdateAuthorizationReferenceText();
        return { id: csfxCachedRegisterId, source: csfxRegisterIdSource || 'cache' };
      }
      return null;
    }
    csfxRegisterScanAt = now;
    var sources = [];
    try {
      if (typeof FX === 'object' && FX) {
        if (FX.register_id != null) sources.push({ value: FX.register_id, source: 'FX.register_id' });
        if (FX.registerId != null) sources.push({ value: FX.registerId, source: 'FX.registerId' });
        if (FX.session && typeof FX.session === 'object') {
          var viaSession = csfxExtractRegisterId(FX.session, 'FX.session');
          if (viaSession) sources.push({ value: viaSession, source: csfxRegisterIdSource || 'FX.session' });
        }
      }
    } catch (_errFxReg) {}
    try {
      if (typeof window !== 'undefined') {
        var globals = [
          { value: window.CSFX_REGISTER_ID, source: 'window.CSFX_REGISTER_ID' },
          { value: window.CSFX_REGISTER, source: 'window.CSFX_REGISTER' },
          { value: window.OP_REGISTER_ID, source: 'window.OP_REGISTER_ID' },
          { value: window.OPRegisterID, source: 'window.OPRegisterID' },
          { value: window.register_id, source: 'window.register_id' },
          { value: window.RegisterID, source: 'window.RegisterID' }
        ];
        for (var g = 0; g < globals.length; g++) {
          var gl = globals[g];
          if (gl.value !== undefined && gl.value !== null) {
            sources.push(gl);
          }
        }
        var appGlobals = [
          { host: window.OpenPOSApp, source: 'window.OpenPOSApp' },
          { host: window.OpenposApp, source: 'window.OpenposApp' },
          { host: window.openposApp, source: 'window.openposApp' },
          { host: window.POSApp, source: 'window.POSApp' },
          { host: window.posApp, source: 'window.posApp' },
          { host: window.OPApp, source: 'window.OPApp' }
        ];
        for (var ag = 0; ag < appGlobals.length; ag++) {
          var app = appGlobals[ag];
          if (!app.host || typeof app.host !== 'object') continue;
          var extracted = csfxExtractRegisterId(app.host, app.source);
          if (extracted) {
            sources.push({ value: extracted, source: csfxRegisterIdSource || app.source });
            break;
          }
        }
      }
    } catch (_errWinReg) {}
    if (typeof csfxCachedCartService === 'object' && csfxCachedCartService) {
      var svcRegister = csfxExtractRegisterId(csfxCachedCartService, 'cartService');
      if (svcRegister) {
        sources.push({ value: svcRegister, source: csfxRegisterIdSource || 'cartService' });
      }
    }
    var fromStorage = null;
    if (typeof localStorage !== 'undefined') {
      try {
        var keys = Object.keys(localStorage);
        for (var i = 0; i < keys.length; i++) {
          var key = keys[i];
          if (!key) continue;
          if (!/register/i.test(key) && !/session/i.test(key) && !/drawer/i.test(key)) continue;
          var raw = localStorage.getItem(key);
          if (!raw || raw.length > 200000) continue;
          try {
            var parsed = JSON.parse(raw);
            var reg = csfxExtractRegisterId(parsed, 'localStorage.' + key);
            if (reg) {
              fromStorage = { value: reg, source: csfxRegisterIdSource || ('localStorage.' + key) };
              break;
            }
          } catch (_errParseLs) {}
        }
      } catch (_errLs) {}
    }
    if (fromStorage) sources.push(fromStorage);
    if (sources.length) {
      for (var s = 0; s < sources.length; s++) {
        var src = sources[s];
        var remembered = csfxRememberRegisterId(src.value, src.source);
        if (remembered) {
          csfxUpdateAuthorizationReferenceText();
          return { id: remembered, source: csfxRegisterIdSource || src.source };
        }
      }
    }
    if (csfxCachedRegisterId) {
      csfxUpdateAuthorizationReferenceText();
      return { id: csfxCachedRegisterId, source: csfxRegisterIdSource || 'cache' };
    }
    csfxUpdateAuthorizationReferenceText();
    return null;
  }

  function csfxGuessRegisterId() {
    var found = csfxScanForRegisterId();
    return found ? found.id : null;
  }

  function csfxAuthorizationReference() {
    var sources = [];
    try {
      var reg = csfxGuessRegisterId();
      if (reg) {
        sources.push('POS #' + reg);
      }
    } catch (_errRegRef) {}
    try {
      if (FX && FX.session && FX.session.cashdrawer && FX.session.cashdrawer.name) {
        var drawerName = String(FX.session.cashdrawer.name || '').trim();
        if (drawerName) sources.push(drawerName);
      }
    } catch (_errDrawerRef) {}
    try {
      if (FX && FX.session && FX.session.register_name) {
        var registerName = String(FX.session.register_name || '').trim();
        if (registerName) sources.push(registerName);
      }
    } catch (_errSessReg) {}
    try {
      if (FX && FX.session && FX.session.staff && FX.session.staff.display_name) {
        var staffName = String(FX.session.staff.display_name || '').trim();
        if (staffName) sources.push('Supervisor ' + staffName);
      }
    } catch (_errStaffRef) {}
    var seen = {};
    for (var i = 0; i < sources.length; i++) {
      var label = sources[i];
      if (!label) continue;
      if (seen[label]) continue;
      seen[label] = true;
      return label;
    }
    return '';
  }

  function csfxUpdateAuthorizationReferenceText() {
    if (csfxUpdatingReference) return;
    csfxUpdatingReference = true;
    try {
      var ref = csfxAuthorizationReference();
      var headerLabel = ref ? 'Ref. ' + ref : 'Referencia POS';
      if (csfxCustomModalUI) {
        if (csfxCustomModalUI.headerRef) {
          csfxCustomModalUI.headerRef.textContent = headerLabel;
          csfxCustomModalUI.headerRef.setAttribute('data-empty', ref ? 'false' : 'true');
        }
        if (csfxCustomModalUI.refText) {
        csfxCustomModalUI.refText.textContent = ref ? 'Ref. ' + ref : 'Escanea el QR del supervisor';
        }
      }
      if (csfxAuthWidget && csfxAuthWidget.ref) {
        csfxAuthWidget.ref.textContent = ref ? 'Ref. ' + ref : 'Ref. POS';
      }
    } finally {
      csfxUpdatingReference = false;
    }
  }

  function csfxCartStorageKeyList() {
    var now = Date.now();
    if (csfxCartKeyCache && now - csfxCartKeyCacheAt < CSFX_LS_KEY_CACHE_TTL) {
      return csfxCartKeyCache.slice();
    }
    var keys = [];
    if (typeof localStorage !== 'undefined') {
      try {
        keys = Object.keys(localStorage);
      } catch (_errKeys) {
        keys = [];
      }
    }
    var preferred = [
      'op_cart', 'op_cache_cart', 'op_local_cart', '_op_cart_data', 'op_cart_data',
      'op_cart_v8', 'op_v5_cart', 'op_cart_backup', 'op_cart_latest', 'op_cart_store',
      'openpos_cart', 'openpos_last_cart', 'op_cart_temp', 'op_current_cart', 'op_cart_memory',
      'op_cart_snapshot', 'op_checkout_cart'
    ];
    var seen = {};
    var list = [];
    var push = function (key) {
      if (!key || typeof key !== 'string') return;
      if (seen[key]) return;
      seen[key] = true;
      list.push(key);
    };
    for (var i = 0; i < preferred.length; i++) push(preferred[i]);
    for (var j = 0; j < keys.length; j++) push(keys[j]);
    csfxCartKeyCache = list.slice();
    csfxCartKeyCacheAt = now;
    return list;
  }

  function csfxSessionCartKeyList() {
    var now = Date.now();
    if (csfxSessionCartKeyCache && now - csfxSessionCartKeyCacheAt < CSFX_SESSION_KEY_CACHE_TTL) {
      return csfxSessionCartKeyCache.slice();
    }
    var keys = [];
    if (typeof sessionStorage !== 'undefined') {
      try {
        keys = Object.keys(sessionStorage);
      } catch (_errSession) {
        keys = [];
      }
    }
    var preferred = [
      'op_cart', 'op_session_cart', 'op_cart_buffer', 'op_cart_temp', 'op_cart_memory',
      'op_cart_snapshot', 'openpos_cart_session', '_op_cart_data', 'op_cart_cache'
    ];
    var seen = {};
    var list = [];
    var push = function (key) {
      if (!key || typeof key !== 'string') return;
      if (seen[key]) return;
      seen[key] = true;
      list.push(key);
    };
    for (var i = 0; i < preferred.length; i++) push(preferred[i]);
    for (var j = 0; j < keys.length; j++) push(keys[j]);
    csfxSessionCartKeyCache = list.slice();
    csfxSessionCartKeyCacheAt = now;
    return list;
  }

  function csfxRememberAsyncCart(cart, source) {
    if (!cart || typeof cart !== 'object') return;
    csfxAsyncCartCache = cart;
    csfxAsyncCartFetchedAt = Date.now();
    csfxAsyncCartDebug = {
      source: source || 'service',
      capturedAt: csfxAsyncCartFetchedAt
    };
    try {
      document.dispatchEvent(new CustomEvent('csfx:cart-updated', {
        detail: {
          source: source || 'service',
          async: true
        }
      }));
    } catch (_errAsyncEvent) {}
  }

  function csfxGetCachedAsyncCart() {
    if (!csfxAsyncCartCache) return null;
    if (Date.now() - csfxAsyncCartFetchedAt > CSFX_ASYNC_CART_TTL_MS) return null;
    return csfxAsyncCartCache;
  }

  function csfxLooksLikeCartSkeleton(candidate) {
    if (!candidate || typeof candidate !== 'object') return false;
    if (Array.isArray(candidate)) return false;
    var keys = Object.keys(candidate);
    if (!keys.length) return false;
    var itemKeys = ['items', 'cart_items', 'cartItems', 'products', 'lines', 'line_items', 'quote_items'];
    for (var i = 0; i < itemKeys.length; i++) {
      var value = candidate[itemKeys[i]];
      if (!value) continue;
      if (Array.isArray(value) && value.length) return true;
      if (value && typeof value === 'object' && Object.keys(value).length) return true;
    }
    if (candidate.totals && typeof candidate.totals === 'object' && Object.keys(candidate.totals).length) return true;
    if (candidate.base_grand_total || candidate.grand_total || candidate.total || candidate.subtotal) return true;
    if (candidate.quote_id || candidate.order_id || candidate.draft_id) return true;
    return false;
  }

  function csfxBranchScoreForKey(key) {
    if (!key) return 0;
    var name = String(key).toLowerCase();
    var score = 0;
    if (name.indexOf('cart') > -1) score += 6;
    if (name.indexOf('current') > -1) score += 3;
    if (name.indexOf('active') > -1) score += 2;
    if (name.indexOf('session') > -1 || name.indexOf('register') > -1) score += 1;
    if (name.indexOf('order') > -1 || name.indexOf('quote') > -1) score += 2;
    if (name.indexOf('items') > -1 || name.indexOf('lines') > -1) score += 2;
    if (name.indexOf('data') > -1 || name.indexOf('response') > -1 || name.indexOf('payload') > -1) score += 1;
    return score;
  }

  function csfxDeepFindCart(value, depth, visited) {
    if (value == null) return null;
    if (depth > CSFX_DEEP_CART_MAX_DEPTH) return null;
    if (typeof value === 'string') {
      try {
        var parsed = JSON.parse(value);
        return csfxDeepFindCart(parsed, depth + 1, visited);
      } catch (_errStr) {
        return null;
      }
    }
    if (typeof value !== 'object') return null;
    if (!visited) {
      visited = typeof WeakSet !== 'undefined' ? new WeakSet() : [];
    }
    if (visited.has && visited.has(value)) return null;
    if (visited.add) {
      visited.add(value);
    } else if (Array.isArray(visited)) {
      if (visited.indexOf(value) > -1) return null;
      visited.push(value);
    }
    if (!Array.isArray(value)) {
      var normalized = csfxNormalizeCartCandidate(value);
      if (normalized && typeof normalized === 'object') {
        if (csfxCountCartItems(normalized) > 0) return normalized;
      }
      if (csfxLooksLikeCartSkeleton(value)) {
        return value;
      }
    }
    var branchCount = 0;
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        if (branchCount++ > CSFX_DEEP_CART_MAX_BRANCH) break;
        var found = csfxDeepFindCart(value[i], depth + 1, visited);
        if (found) return found;
      }
      return null;
    }
    var keys = Object.keys(value);
    keys.sort(function (a, b) {
      return csfxBranchScoreForKey(b) - csfxBranchScoreForKey(a);
    });
    for (var j = 0; j < keys.length; j++) {
      if (branchCount++ > CSFX_DEEP_CART_MAX_BRANCH) break;
      var key = keys[j];
      var child = value[key];
      if (child == null) continue;
      var childFound = csfxDeepFindCart(child, depth + 1, visited);
      if (childFound) return childFound;
    }
    return null;
  }

  function csfxCountCartItems(cart) {
    if (!cart || typeof cart !== 'object') return 0;
    var total = 0;
    var keys = ['items', 'cart_items', 'cartItems', 'products', 'product_items', 'lines', 'line_items'];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var value = cart[key];
      if (!value) continue;
      if (Array.isArray(value)) {
        total += value.length;
      } else if (typeof value === 'object') {
        total += Object.keys(value).length;
      }
      if (total > 0) break;
    }
    if (!total && cart.items && typeof cart.items === 'object' && !Array.isArray(cart.items)) {
      total = Object.keys(cart.items).length;
    }
    return total;
  }

  function csfxInspectCandidate(value, source, svcRef, debug) {
    var type = value == null ? String(value) : typeof value;
    var normalized = null;
    var itemsCount = 0;
    var error = null;
    try {
      normalized = csfxNormalizeCartCandidate(value);
    } catch (errNorm) {
      error = errNorm;
    }
    if (normalized && typeof normalized === 'object') {
      try {
        itemsCount = csfxCountCartItems(normalized);
      } catch (errItems) {
        error = error || errItems;
      }
    }
    if (debug && debug.tried && typeof debug.tried.push === 'function') {
      var logEntry = {
        source: source,
        hit: !!normalized && itemsCount > 0,
        items: itemsCount,
        type: type
      };
      if (normalized) logEntry.normalized = true;
      if (error) logEntry.error = String(error);
      if (!normalized) logEntry.normalized = false;
      debug.tried.push(logEntry);
    }
    if (normalized) {
      return {
        cart: normalized,
        source: source,
        cartService: svcRef || null,
        debug: debug || null,
        itemsCount: itemsCount
      };
    }
    return null;
  }

  function csfxEnumerateStorageCarts(debug) {
    var stores = [];
    if (typeof localStorage !== 'undefined') {
      stores.push({ api: localStorage, label: 'localStorage', keys: csfxCartStorageKeyList() });
    }
    if (typeof sessionStorage !== 'undefined') {
      stores.push({ api: sessionStorage, label: 'sessionStorage', keys: csfxSessionCartKeyList() });
    }
    var map = {};
    var results = [];

    function rememberCandidate(mapKey, candidate, meta) {
      if (!candidate) return;
      var current = map[mapKey];
      if (!current || (candidate.itemsCount || 0) >= (current.itemsCount || 0)) {
        candidate.storageKey = meta.key;
        candidate.storageType = meta.label;
        candidate.storageSource = meta.label + '.' + meta.key;
        map[mapKey] = candidate;
      }
    }

    stores.forEach(function (store) {
      if (!store || !store.api) return;
      var keys = Array.isArray(store.keys) ? store.keys : [];
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (!key || typeof key !== 'string') continue;
        var mapKey = store.label + ':' + key;
        try {
          var raw = store.api.getItem(key);
          if (!raw) {
            if (debug && debug.tried) {
              debug.tried.push({ source: store.label + '.' + key, hit: false, empty: true, type: 'string' });
            }
            continue;
          }
          if (typeof raw === 'string' && raw.length > 2e6) {
            continue;
          }
          var parsed = raw;
          try {
            parsed = JSON.parse(raw);
          } catch (_errParse) {}
          var candidate = csfxInspectCandidate(parsed, store.label + '.' + key, null, debug);
          if (!candidate && parsed !== raw) {
            candidate = csfxInspectCandidate(raw, store.label + '.' + key + '(raw)', null, debug);
          }
          if (!candidate) {
            var deep = csfxDeepFindCart(parsed, 0, null);
            if (!deep && parsed !== raw) {
              deep = csfxDeepFindCart(raw, 0, null);
            }
            if (deep) {
              candidate = csfxInspectCandidate(deep, store.label + '.' + key + '(deep)', null, debug);
            }
          }
          rememberCandidate(mapKey, candidate, { key: key, label: store.label });
        } catch (_errStorage) {
          if (debug && debug.tried) {
            debug.tried.push({
              source: store.label + '.' + key,
              error: String(_errStorage),
              hit: false
            });
          }
        }
      }
    });
    Object.keys(map).forEach(function (k) {
      if (map[k]) results.push(map[k]);
    });
    results.sort(function (a, b) {
      return (b.itemsCount || 0) - (a.itemsCount || 0);
    });
    return results;
  }

  function csfxFindCartKeyInSettings(obj, depth) {
    if (!obj || typeof obj !== 'object') return '';
    if (depth > 6) return '';
    var markers = [
      'current_cart_key', 'active_cart_key', 'currentCartKey', 'activeCartKey',
      'current_cart', 'active_cart', 'selected_cart_key', 'selectedCartKey',
      'current_cart_id', 'currentCartId', 'active_cart_id', 'activeCartId'
    ];
    for (var i = 0; i < markers.length; i++) {
      var key = markers[i];
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        var val = obj[key];
        if (typeof val === 'string' || typeof val === 'number') {
          return String(val);
        }
      }
    }
    var keys = Object.keys(obj);
    for (var j = 0; j < keys.length; j++) {
      var name = keys[j];
      var value = obj[name];
      if (value == null) continue;
      if (typeof value === 'string' || typeof value === 'number') {
        if (/cart.*key/i.test(name) || /key.*cart/i.test(name) || /cart.*id/i.test(name) || /id.*cart/i.test(name)) {
          return String(value);
        }
      }
    }
    for (var k = 0; k < keys.length; k++) {
      var childKey = keys[k];
      var child = obj[childKey];
      if (!child || typeof child !== 'object') continue;
      var nested = csfxFindCartKeyInSettings(child, depth + 1);
      if (nested) return nested;
    }
    return '';
  }

  function csfxReadActiveCartKey(debug) {
    if (typeof localStorage === 'undefined') return '';
    var raw = null;
    try {
      raw = localStorage.getItem('op_settings');
    } catch (_errSettings) {
      raw = null;
    }
    if (!raw) return '';
    var parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (_errParseSettings) {
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object') return '';
    var found = csfxFindCartKeyInSettings(parsed, 0);
    if (debug) {
      debug.activeCartKey = found || '';
    }
    return found || '';
  }

  function csfxSelectActiveCart(localCarts, debug) {
    if (!Array.isArray(localCarts) || !localCarts.length) return null;
    var activeKey = csfxReadActiveCartKey(debug);
    if (activeKey) {
      for (var i = 0; i < localCarts.length; i++) {
        var entry = localCarts[i];
        if (!entry) continue;
        var key = entry.storageKey || entry.source || '';
        if (!key) continue;
        if (String(key).toLowerCase() === String(activeKey).toLowerCase()) {
          return entry;
        }
      }
    }
    var best = null;
    var fallback = null;
    for (var j = 0; j < localCarts.length; j++) {
      var candidate = localCarts[j];
      if (!candidate || !candidate.cart) continue;
      var count = candidate.itemsCount || 0;
      if (count > 0) {
        if (!best || count > (best.itemsCount || 0)) {
          best = candidate;
        }
      } else if (!fallback) {
        fallback = candidate;
      }
    }
    return best || fallback || null;
  }

  function csfxBetterCandidate(primary, candidate) {
    if (!candidate) return primary;
    if (!primary) return candidate;
    var primaryCount = primary.itemsCount || 0;
    var candidateCount = candidate.itemsCount || 0;
    return candidateCount > primaryCount ? candidate : primary;
  }

  function csfxCartDebugEnabled() {
    try {
      if (FX && FX.debug) return true;
      if (typeof window !== 'undefined' && window.CSFX_DEBUG_CART) return !!window.CSFX_DEBUG_CART;
      if (typeof localStorage !== 'undefined') {
        var flag = localStorage.getItem('csfx_debug_cart');
        if (flag === '1' || flag === 'true') return true;
      }
    } catch (_err) {}
    return false;
  }

  function csfxLogCartProbe(source, candidate) {
    if (!csfxCartDebugEnabled()) return;
    try {
      var info = {
        source: source,
        hasCart: !!(candidate && candidate.cart),
        items: candidate && typeof candidate.itemsCount === 'number' ? candidate.itemsCount : null,
        type: candidate && candidate.cart ? typeof candidate.cart : 'null'
      };
      if (candidate && candidate.storageSource) info.storage = candidate.storageSource;
      if (candidate && candidate.dbName) info.db = candidate.dbName;
      if (candidate && candidate.storeName) info.store = candidate.storeName;
      (console && console.log) && console.log('[csfx][cart-detect]', info);
    } catch (_errLog) {}
  }

  function csfxResolveCartServiceCompat(debug) {
    var svc = null;
    var compat = null;
    try {
      if (typeof window !== 'undefined' &&
        window.OpenPOSCompat &&
        typeof window.OpenPOSCompat.resolveCartService === 'function') {
        compat = window.OpenPOSCompat.resolveCartService();
        if (compat && debug) {
          debug.cartService = debug.cartService || {};
          debug.cartService.resolvedVia = 'OpenPOSCompat';
        }
      }
    } catch (errCompat) {
      if (debug) {
        debug.cartService = debug.cartService || {};
        debug.cartService.compatError = String(errCompat);
      }
      compat = null;
    }
    if (compat) return compat;
    return csfxGetCartService(debug);
  }

  // No consultamos el API del servidor: los carritos se buscan solo en storage e IndexedDB locales.
  function csfxEnumerateIndexedDBCarts(debug) {
    var now = Date.now();
    if (csfxIndexedDbCartsCache && now - csfxIndexedDbScanAt < CSFX_INDEXEDDB_TTL_MS) {
      return csfxIndexedDbCartsCache.slice();
    }
    csfxKickoffIndexedDbScan(debug);
    return csfxIndexedDbCartsCache ? csfxIndexedDbCartsCache.slice() : [];
  }

  function csfxKickoffIndexedDbScan(debug) {
    if (!window.indexedDB || typeof indexedDB.databases !== 'function') {
      csfxIndexedDbScanPromise = null;
      if (!csfxIndexedDbCartsCache) csfxIndexedDbCartsCache = [];
      csfxIndexedDbScanAt = Date.now();
      if (debug) debug.indexedDbScan = { supported: false };
      return null;
    }
    if (csfxIndexedDbScanPromise) return csfxIndexedDbScanPromise;
    csfxIndexedDbScanPromise = indexedDB.databases().then(function (dbs) {
      var list = Array.isArray(dbs) ? dbs : [];
      var tasks = list.map(function (meta) { return csfxScanIndexedDbDatabase(meta, debug); });
      return Promise.all(tasks).then(function (chunks) {
        var flat = [];
        chunks.forEach(function (chunk) {
          if (Array.isArray(chunk)) flat = flat.concat(chunk);
        });
        csfxIndexedDbCartsCache = flat;
        csfxIndexedDbScanAt = Date.now();
        if (debug) {
          debug.indexedDbScan = {
            supported: true,
            databases: list.length,
            carts: flat.length
          };
        }
        return flat;
      });
    }).catch(function (err) {
      if (debug) debug.indexedDbError = String(err);
      csfxIndexedDbCartsCache = csfxIndexedDbCartsCache || [];
      csfxIndexedDbScanAt = Date.now();
      return [];
    }).finally(function () {
      csfxIndexedDbScanPromise = null;
    });
    return csfxIndexedDbScanPromise;
  }

  function csfxScanIndexedDbDatabase(info, debug) {
    return new Promise(function (resolve) {
      if (!info || !info.name) return resolve([]);
      var request;
      try {
        request = indexedDB.open(info.name, info.version);
      } catch (_errOpen) {
        return resolve([]);
      }
      var settled = false;
      function finish(result) {
        if (settled) return;
        settled = true;
        try { if (request && request.result) request.result.close(); } catch (_errClose) {}
        resolve(result || []);
      }
      request.onerror = function () { finish([]); };
      request.onupgradeneeded = function () { finish([]); };
      request.onsuccess = function (event) {
        var db = event && event.target ? event.target.result : null;
        if (!db) return finish([]);
        var stores = [];
        try { stores = Array.from(db.objectStoreNames || []); } catch (_errNames) { stores = []; }
        if (!stores.length) {
          try { db.close(); } catch (_errCloseDb) {}
          return finish([]);
        }
        var aggregated = [];
        var pending = stores.length;
        var done = function () {
          pending--;
          if (pending <= 0) {
            try { db.close(); } catch (_errCloseDb2) {}
            finish(aggregated);
          }
        };
        stores.forEach(function (storeName) {
          var tx;
          try {
            tx = db.transaction(storeName, 'readonly');
          } catch (_errTx) {
            done();
            return;
          }
          var store = tx.objectStore(storeName);
          var req;
          try {
            req = store.getAll();
          } catch (_errCursor) {
            done();
            return;
          }
          req.onerror = function () {
            done();
          };
          req.onsuccess = function (ev) {
            var values = (ev && ev.target && ev.target.result) || [];
            for (var i = 0; i < values.length; i++) {
              var candidate = csfxInspectCandidate(values[i], 'indexedDB.' + info.name + '.' + storeName, null, debug);
              if (candidate) {
                candidate.dbName = info.name;
                candidate.storeName = storeName;
                candidate.storageSource = 'indexedDB:' + info.name + '/' + storeName;
                aggregated.push(candidate);
              }
            }
            done();
          };
        });
      };
    });
  }

  // --- Utilidades ---
  function round(n, d) {
    d = (typeof d === 'number') ? d : FX.decimals;
    var p = Math.pow(10, d);
    return Math.round((+n + Number.EPSILON) * p) / p;
  }
  function csfxFormatInputNumber(num, decimals) {
    if (!isFinite(num)) return '';
    var str = Number(num).toFixed(decimals);
    if (decimals > 0) {
      str = str.replace(/\.0+$/, '');
      str = str.replace(/(\.\d*?)0+$/, '$1');
    }
    if (str.endsWith('.')) {
      str = str.slice(0, -1);
    }
    return str;
  }
  function parsePrice(s) {
    /**
     * Extrae un precio decimal de una cadena buscando todos los tokens
     * numéricos y quedándose con el último que no pertenezca a un monto en
     * bolívares. De esta forma ignoramos expresiones como "22,69$ - 46,34$"
     * sin reventar los decimales al concatenar dígitos.
     * @param {string} s
     * @returns {number}
     */
    if (!s) return NaN;
    var text = String(s).replace(/\s+/g, ' ').trim();
    if (!/[0-9]/.test(text)) return NaN;

    var lastValue = NaN;
    var match;
    var re = /(-?\d[\d.,]*)/g;

    while ((match = re.exec(text))) {
      var token = match[1];
      // Ignorar tokens precedidos por Bs/VES/VEF para evitar duplicar montos en Bs.
      var prefix = text.slice(Math.max(0, match.index - 4), match.index).toUpperCase();
      if (/(BS|VES|VEF)/.test(prefix)) continue;

      var parsed = parsePriceToken(token);
      if (!isNaN(parsed)) {
        lastValue = parsed;
      }
    }

    return lastValue;
  }
  function parsePriceAllowBs(s) {
    if (!s) return NaN;
    var text = String(s).replace(/\s+/g, ' ').trim();
    if (!/[0-9]/.test(text)) return NaN;
    var lastValue = NaN;
    var match;
    var re = /(-?\d[\d.,]*)/g;
    while ((match = re.exec(text))) {
      var token = match[1];
      var parsed = parsePriceToken(token);
      if (!isNaN(parsed)) {
        lastValue = parsed;
      }
    }
    return lastValue;
  }

  function parsePriceToken(token) {
    if (!token) return NaN;
    var sign = 1;
    var trimmed = token.trim();
    if (/^-/.test(trimmed)) {
      sign = -1;
    }
    var cleaned = trimmed.replace(/[^0-9,.\-]/g, '');
    cleaned = cleaned.replace(/-/g, '');
    if (!cleaned) return NaN;

    var lastComma = cleaned.lastIndexOf(',');
    var lastDot = cleaned.lastIndexOf('.');
    var sepIndex = Math.max(lastComma, lastDot);
    if (sepIndex === -1) return NaN;

    var integerPart = cleaned.substring(0, sepIndex).replace(/[.,]/g, '');
    var decimalPart = cleaned.substring(sepIndex + 1).replace(/[.,]/g, '');
    if (!decimalPart) return NaN;

    var normalised = (integerPart || '0') + '.' + decimalPart;
    var result = parseFloat(normalised);
    if (!isFinite(result)) return NaN;
    return sign * result;
  }
  function fmtBs(n) {
    try {
       return (FX.symbol || 'Bs.') + ' ' + Number(n).toLocaleString('es-VE', {
        minimumFractionDigits: FX.decimals,
        maximumFractionDigits: FX.decimals
      });
    } catch (e) {
     return (FX.symbol || 'Bs.') + ' ' + round(n, FX.decimals);
    }
  }
  function usd2bs(u) {
    return round((Number(u) || 0) * (FX.rate || 0), FX.decimals);
  }
  function fmtUsd(n) {
    try {
      return (FX.symbolUSD || '$') + ' ' + Number(n).toLocaleString('en-US', {
        minimumFractionDigits: FX.decimals,
        maximumFractionDigits: FX.decimals
      });
    } catch (e) {
      return (FX.symbolUSD || '$') + ' ' + round(n, FX.decimals);
    }
  }
  // --- CSS mínimo/limpio ---
  (function addCss() {
    var id = 'csfx-css';
    if (document.getElementById(id)) return;
    var css = [
      '.csfx-chip{display:inline-block;margin-left:.5rem;padding:.15rem .45rem;border-radius:12px;font-size:11px;line-height:1;background:#eef1f5;color:#2f3437;white-space:nowrap;vertical-align:middle;}',
      '.csfx-chip--under{margin:0;display:block;font-size:12px;font-weight:600}',
          '.csfx-chip--inline{margin-left:.5rem;font-size:13px;font-weight:700}',
        /* Base común para chips estilo "pill" */
        '.csfx-chip-pill{display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;line-height:1;padding:.1rem .45rem;border-radius:12px;vertical-align:middle;white-space:nowrap;}',
      '.csfx-addon-stack{display:flex;flex-direction:column;align-items:flex-end;gap:2px;line-height:1}',
      '.csfx-chip--addon{font-size:12px;font-weight:600}',
      '.csfx-row{display:flex;justify-content:space-between;font-size:12px;opacity:.95;margin-top:2px;}',
      '.csfx-row .csfx-amount{font-weight:600;}',
      // fila del carrito: sólo muestra el importe en Bs, alineado a la derecha
           '.csfx-cart-row{display:block;margin-top:2px;font-size:13px;font-weight:600;text-align:right;padding-right:.6rem;width:100%;}',
          // filas de totales en Bs (Subtotal)
        '.csfx-total-row{display:flex;justify-content:space-between;font-size:14px;font-weight:700;margin-top:8px;padding:0 .4rem;}',
      '.csfx-total-row span{font-weight:700;font-size:14px;}',
      '.csfx-total-row .csfx-amount{color:#1e3a8a;font-weight:700;font-size:14px;}',
      '.csfx-total-row[data-csfx="total-final"]{display:grid;grid-template-columns:auto 1fr;column-gap:8px;row-gap:2px;align-items:center;}',
      '.csfx-total-row[data-csfx="total-final"] .csfx-amount{text-align:right;}',
            '.csfx-sub-bs-inline{display:block;text-align:right;font-weight:700;color:#0d6efd;line-height:1.1;margin-top:2px;font-size:12px;}',

      '.csfx-info{margin-top:6px;font-size:11px;opacity:.8;}',
      '.csfx-pay-header-row{display:flex;gap:.8rem;margin-top:2px;}',
      '.csfx-chip--modal{font-size:16px;font-weight:700;padding:.2rem .6rem}',
      '.csfx-dual-box{margin-top:6px;padding:10px;border-radius:14px;background:linear-gradient(160deg,rgba(0,87,183,.13),rgba(255,255,255,.97));border:1px solid rgba(0,87,183,.22);box-shadow:0 8px 24px rgba(10,30,70,.16);max-width:320px;font-family:inherit;}',
      '.csfx-dual-box h4{margin:0 0 10px;font-size:17px;font-weight:700;color:#0f172a;display:flex;align-items:center;gap:8px;}',
      '.csfx-dual-heading-icon{display:inline-flex;width:30px;height:30px;border-radius:10px;background:#0c4a94;color:#fff;align-items:center;justify-content:center;font-size:18px;box-shadow:0 4px 10px rgba(12,74,148,.3);}',
      '.csfx-dual-grid{display:grid;grid-template-columns:auto auto;column-gap:12px;row-gap:6px;font-size:14px;color:#0f172a;font-weight:600;}',
      '.csfx-dual-grid strong{color:#0b1f3a;font-size:16px;font-weight:700;}',
      '.csfx-dual-input{margin-top:12px;display:flex;flex-direction:column;gap:6px;font-size:13px;width:100%;}',
      '.csfx-dual-input span{font-weight:700;color:#072c59;font-size:14px;}',
      '.csfx-dual-input input{padding:7px 10px;border:1px solid rgba(0,87,183,.26);border-radius:10px;font-size:15px;font-weight:600;color:#0f172a;background:#fff;transition:box-shadow .2s ease,border-color .2s ease;}',
      '.csfx-dual-input input:focus{outline:none;border-color:#0057b7;box-shadow:0 0 0 2px rgba(0,87,183,.18);}',
      '.csfx-dual-tabs{margin-top:14px;display:flex;gap:6px;}',
      '.csfx-dual-tab{flex:1 1 auto;padding:6px 8px;border-radius:10px;border:1px solid rgba(0,87,183,.25);background:#fff;color:#0f172a;font-weight:600;font-size:13px;cursor:pointer;transition:all .18s ease;}',
      '.csfx-dual-tab.is-active{background:#0c4a94;color:#fff;box-shadow:0 6px 14px rgba(12,74,148,.35);border-color:#0c4a94;}',
      '.csfx-dual-tab:focus{outline:none;box-shadow:0 0 0 2px rgba(12,74,148,.25);}',
      '.csfx-dual-modes{position:relative;}',
      '.csfx-dual-mode{margin-top:8px;}',
      '.csfx-dual-mode[data-csfx-mode-form="bs"]{display:flex;flex-direction:column;gap:6px;}',
      '.csfx-dual-mode[data-csfx-mode-form="bs"]>.csfx-dual-input,.csfx-dual-mode[data-csfx-mode-form="bs"]>.csfx-dual-bs-field{margin-top:0;min-width:0;width:100%;}',
      '.csfx-dual-mode[data-active="false"],.csfx-dual-mode[hidden]{display:none!important;}',
      '.csfx-dual-inline-hint{font-size:12px;color:#0b5394;background:rgba(13,76,140,.08);border-radius:8px;padding:4px 8px;font-weight:500;}',
      '.csfx-dual-bs-field{display:flex;flex-direction:column;gap:6px;padding:0;border:none;border-radius:10px;background:transparent;}',
      '.csfx-dual-adjust{margin-top:6px;font-size:12px;color:#92400e;display:none;flex-direction:column;align-items:stretch;gap:6px;}',
      '.csfx-dual-adjust[data-open="true"]{display:flex;}',
      '.csfx-dual-adjust button{background:rgba(12,74,148,.12);border:1px solid rgba(12,74,148,.25);color:#0c4a94;border-radius:8px;padding:4px 12px;font-size:11.5px;font-weight:600;cursor:pointer;transition:all .18s ease;width:100%;text-align:center;white-space:normal;line-height:1.25;}',
      '.csfx-dual-adjust button:hover{background:rgba(12,74,148,.2);}',
      '.csfx-dual-adjust button.is-selected{background:#0c4a94;color:#fff;box-shadow:0 4px 12px rgba(12,74,148,.35);}',
      '.csfx-dual-adjust-text{display:block;line-height:1.35;margin-bottom:2px;font-weight:600;color:#92400e;}',
      '.csfx-dual-metrics{margin-top:12px;border-radius:10px;background:#f8fbff;border:1px solid rgba(7,44,89,.07);overflow:hidden;box-shadow:0 4px 12px rgba(7,44,89,.06);}',
      '.csfx-dual-metrics-row{display:grid;grid-template-columns:1fr auto;padding:9px 12px;font-size:13px;font-weight:600;color:#0f172a;align-items:center;gap:10px;}',
      '.csfx-alert-overlay{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.48);backdrop-filter:blur(4px);z-index:10005;padding:20px;}',
      '.csfx-alert-modal{background:#ffffff;border-radius:18px;max-width:360px;width:min(360px,calc(100vw - 48px));box-shadow:0 20px 48px rgba(15,23,42,.35);padding:22px;display:flex;flex-direction:column;gap:14px;font-family:inherit;}',
      '.csfx-alert-title{margin:0;font-size:18px;font-weight:700;color:#0f172a;}',
      '.csfx-alert-body{margin:0;font-size:15px;color:#1e293b;line-height:1.45;}',
      '.csfx-alert-rate{margin:0;font-size:14px;font-weight:600;color:#0b5394;background:rgba(12,74,148,.1);border-radius:12px;padding:10px 12px;}',
      '.csfx-alert-actions{display:flex;flex-direction:column;gap:8px;}',
      '.csfx-dual-metrics-row:nth-child(odd){background:rgba(227,242,255,.65);}',
      '.csfx-dual-metrics-row.is-highlight{background:rgba(16,185,129,.18)!important;color:#065f46;}',
      '.csfx-dual-metrics-row.is-warning{background:rgba(251,191,36,.22)!important;color:#92400e;}',
      '.csfx-dual-metrics-label{display:flex;align-items:center;gap:6px;}',
      '.csfx-dual-metrics-help{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:#0d5ad6;color:#fff;font-size:11px;box-shadow:0 2px 4px rgba(11,106,212,.25);position:relative;cursor:help;}',
      '.csfx-dual-metrics-help::after{content:attr(data-tooltip);position:absolute;left:50%;top:calc(100% + 8px);transform:translateX(-50%);background:#0f172a;color:#fff;font-size:11px;font-weight:500;line-height:1.35;padding:6px 8px;border-radius:6px;opacity:0;pointer-events:none;white-space:normal;width:180px;box-shadow:0 8px 16px rgba(15,23,42,.25);transition:opacity .15s ease .3s;}',
      '.csfx-dual-metrics-help::before{content:"";position:absolute;left:50%;top:100%;transform:translateX(-50%);border:6px solid transparent;border-top-color:#0f172a;opacity:0;transition:opacity .15s ease .3s;}',
      '.csfx-dual-metrics-help:hover::after,.csfx-dual-metrics-help:focus::after{opacity:1;transition-delay:.25s;}',
      '.csfx-dual-metrics-help:hover::before,.csfx-dual-metrics-help:focus::before{opacity:1;transition-delay:.25s;}',
      '.csfx-dual-metrics-value{font-size:16px;font-weight:700;color:#052c65;}',
      '.csfx-dual-helper{margin-top:8px;display:flex;align-items:center;gap:8px;font-size:12px;color:#0f172a;background:rgba(0,87,183,.08);padding:6px 10px;border-radius:9px;border:1px dashed rgba(0,87,183,.2);cursor:pointer;}',
      '.csfx-dual-helper-icon{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:#0b6ad4;color:#fff;font-size:11px;box-shadow:0 2px 4px rgba(11,106,212,.25);position:relative;cursor:help;}',
      '.csfx-dual-helper-icon::after{content:attr(data-tooltip);position:absolute;left:50%;top:calc(100% + 8px);transform:translateX(-50%);background:#0f172a;color:#fff;font-size:11px;font-weight:500;line-height:1.35;padding:6px 8px;border-radius:6px;opacity:0;pointer-events:none;white-space:normal;width:200px;box-shadow:0 8px 16px rgba(15,23,42,.25);transition:opacity .15s ease .3s;}',
      '.csfx-dual-helper-icon::before{content:"";position:absolute;left:50%;top:100%;transform:translateX(-50%);border:6px solid transparent;border-top-color:#0f172a;opacity:0;transition:opacity .15s ease .3s;}',
      '.csfx-dual-helper-icon:hover::after,.csfx-dual-helper-icon:focus::after{opacity:1;transition-delay:.25s;}',
      '.csfx-dual-helper-icon:hover::before,.csfx-dual-helper-icon:focus::before{opacity:1;transition-delay:.25s;}',
      '.csfx-dual-helper-label{font-size:12px;font-weight:600;color:#0f172a;}',
      '.csfx-dual-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:12px;}',
      '.csfx-dual-actions .csfx-btn{width:100%;min-width:0;text-align:center;line-height:1.2;display:flex;flex-direction:column;justify-content:center;white-space:normal;}',
      '.csfx-dual-extra{margin-top:10px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;}',
      '.csfx-dual-extra .csfx-btn{width:100%;min-width:0;text-align:center;line-height:1.2;display:flex;flex-direction:column;justify-content:center;white-space:normal;}',
      '.csfx-btn{appearance:none;border:0;border-radius:999px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;transition:transform .2s ease,box-shadow .2s ease,background .2s ease,color .2s ease;font-family:inherit;min-width:0;}',
      '.csfx-btn:disabled{opacity:.45;cursor:not-allowed;box-shadow:none;transform:none;}',
      '.csfx-btn--primary{background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff;box-shadow:0 4px 12px rgba(37,99,235,.38);min-width:132px;}',
      '.csfx-btn--primary:hover:not(:disabled){background:linear-gradient(135deg,#1d4ed8,#1e40af);box-shadow:0 6px 18px rgba(30,64,175,.45);}',
      '.csfx-btn--secondary{background:rgba(59,130,246,.12);color:#1e40af;border:1px solid rgba(59,130,246,.35);box-shadow:0 3px 10px rgba(59,130,246,.18);}',
      '.csfx-btn--secondary:hover:not(:disabled){background:rgba(59,130,246,.18);}',
      '.csfx-btn[data-csfx-full-lock=\"1\"]{background:rgba(251,191,36,.16);color:#92400e;border:1px solid rgba(251,191,36,.4);box-shadow:none;}',
      '.csfx-btn[data-csfx-full-lock=\"1\"]:hover:not(:disabled){background:rgba(251,191,36,.22);color:#78350f;}',
      '.csfx-btn--ghost{background:rgba(15,23,42,.04);color:#0f172a;border:1px solid rgba(15,23,42,.12);}',
      '.csfx-btn--ghost:hover:not(:disabled){background:rgba(15,23,42,.08);}',
      '.csfx-btn--accent{background:#10b981;color:#fff;box-shadow:0 3px 12px rgba(16,185,129,.35);}',
      '.csfx-btn--accent:hover:not(:disabled){background:#0d9668;}',
      '.csfx-dual-status{margin-top:10px;font-size:13px;color:#0f172a;font-weight:600;}',
      '.csfx-dual-status--info{color:#0f766e;}',
      '.csfx-dual-status--warn{color:#b45309;}',
      '.csfx-dual-status--error{color:#b91c1c;}',
      '.csfx-dual-status--ok{color:#047857;font-weight:700;}',
      '.csfx-dual-note{margin-top:6px;font-size:11px;color:#4b5563;line-height:1.4;}',
      '.csfx-dual-note strong{font-weight:700;}',
      // compactar el hueco de impuestos si se decide ocultar
       '.csfx-hide-tax{display:none!important;line-height:0!important;height:0!important;overflow:hidden!important;margin:0!important;padding:0!important;border:0!important;}',
      // badge colapsable para mostrar la tasa y hora
      '.csfx-badge{position:fixed;right:12px;bottom:96px;z-index:10000;font-family:inherit;cursor:pointer;display:flex;flex-direction:column;align-items:stretch;width:auto;}', /* bottom se recalcula por JS */
      '.csfx-badge-handle{background:#0057b7;color:#fff;padding:12px 16px;border-radius:12px 12px 0 0;font-size:15px;display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:8px;box-shadow:0 8px 18px rgba(0,87,183,.35);transition:background .2s ease,box-shadow .2s ease,width .2s ease;}',
      '.csfx-badge[data-csfx-status=\"degraded\"] .csfx-badge-handle{background:#b45309;box-shadow:0 8px 18px rgba(180,83,9,.35);}',
      '.csfx-badge[data-csfx-status=\"offline\"] .csfx-badge-handle{background:#b91c1c;box-shadow:0 8px 18px rgba(185,28,28,.35);}',
      '.csfx-badge[data-csfx-status=\"degraded\"] .csfx-badge-handle:hover{background:#92400e;}',
      '.csfx-badge[data-csfx-status=\"offline\"] .csfx-badge-handle:hover{background:#991b1b;}',
      '.csfx-badge-handle:hover{background:#0b6ad4;}',
      '.csfx-badge-handle-main,.csfx-badge-handle-compact{pointer-events:none;}',
      '.csfx-badge-handle-main *,.csfx-badge-handle-compact *{pointer-events:none;}',
      '.csfx-badge-handle-main{display:flex;flex-direction:column;gap:4px;flex:1 1 auto;}',
      '.csfx-badge-handle-row{display:flex;align-items:center;gap:8px;}',
      '.csfx-badge-handle-title{font-size:14px;font-weight:700;color:#fff;}',
      '.csfx-badge-handle-sub{font-size:12px;font-weight:600;color:#e2e8f0;}',
      '.csfx-badge-handle-compact{display:none;align-items:center;gap:8px;font-size:14px;font-weight:700;}',
      '.csfx-badge:not(.open) .csfx-badge-handle-main{display:none;}',
      '.csfx-badge:not(.open) .csfx-badge-handle-compact{display:flex;}',
      '.csfx-badge:not(.open) .csfx-badge-handle{padding:10px 12px;gap:4px;}',
      '.csfx-badge-icon{display:inline-flex;width:24px;height:24px;border-radius:50%;background:rgba(255,255,255,.3);align-items:center;justify-content:center;font-size:15px;box-shadow:0 4px 10px rgba(255,255,255,.2);}',
      '.csfx-badge:not(.open) .csfx-badge-icon{width:20px;height:20px;}',
      '.csfx-badge[data-csfx-status=\"degraded\"] .csfx-badge-icon, .csfx-badge[data-csfx-status=\"offline\"] .csfx-badge-icon{background:rgba(255,255,255,.18);}',
      '.csfx-badge-label{font-size:13px;font-weight:600;}',
      '.csfx-badge-content{background:#ffffff;color:#0f172a;padding:8px 10px;border-radius:0 0 12px 12px;display:none;font-size:13px;white-space:nowrap;box-shadow:0 16px 32px rgba(15,23,42,.25);border:1px solid rgba(15,23,42,.06);min-width:260px;}',
       '.csfx-badge.open .csfx-badge-content{display:block;}',
      '.csfx-modal-backdrop{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(15,23,42,.45);backdrop-filter:blur(3px);padding:20px;z-index:10001;}',
      '.csfx-modal-backdrop[data-open="true"]{display:flex;}',
      '.csfx-modal-backdrop--custom{z-index:10002;background:rgba(15,23,42,.55);backdrop-filter:blur(5px);}',
      '.csfx-modal-backdrop--info{z-index:10003;}',
      '.csfx-modal-backdrop--custom .csfx-modal{pointer-events:auto;max-width:420px;width:clamp(320px,90vw,420px);box-shadow:0 26px 58px rgba(15,23,42,.32);}',
      '.csfx-modal{background:#ffffff;border-radius:20px;width:clamp(320px,90vw,420px);max-height:calc(100vh - 40px);box-shadow:0 18px 48px rgba(15,23,42,.35);overflow:hidden;font-family:inherit;display:flex;flex-direction:column;}',
      '.csfx-modal-header{background:linear-gradient(135deg,#0057b7,#0b6ad4);color:#fff;padding:18px 22px;display:flex;align-items:center;justify-content:space-between;gap:16px;cursor:pointer;}',
      '.csfx-modal-header-title{display:flex;align-items:center;gap:12px;font-size:17px;font-weight:700;}',
      '.csfx-modal-header-icon{display:inline-flex;width:32px;height:32px;border-radius:10px;background:rgba(255,255,255,.22);align-items:center;justify-content:center;font-size:18px;box-shadow:0 4px 12px rgba(0,0,0,.18);}',
      '.csfx-modal-header-ref{font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;background:rgba(15,23,42,.18);padding:4px 10px;border-radius:999px;white-space:nowrap;}',
      '.csfx-modal-header-ref[data-empty="true"]{opacity:.75;background:rgba(255,255,255,.12);}',
      '.csfx-modal-body{padding:22px 24px 24px;display:flex;flex-direction:column;gap:18px;overflow-y:auto;flex:1 1 auto;}',
      '.csfx-auth-card{border:1px solid rgba(15,23,42,.08);background:linear-gradient(135deg,rgba(0,87,183,.08),#fff);border-radius:16px;padding:16px 18px;display:flex;flex-direction:column;gap:12px;box-shadow:0 14px 32px rgba(15,23,42,.12);}',
      '.csfx-auth-title{font-size:14px;font-weight:700;color:#0f172a;}',
      '.csfx-auth-row{display:flex;flex-wrap:wrap;gap:12px;align-items:center;}',
      '.csfx-auth-row input{flex:1 1 180px;padding:10px 14px;border-radius:12px;border:1px solid rgba(15,23,42,.12);font-size:15px;font-weight:600;background:#fff;transition:border-color .2s ease,box-shadow .2s ease;}',
      '.csfx-auth-row input:focus{outline:none;border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.18);}',
      '.csfx-auth-hint{font-size:12px;color:#334155;line-height:1.5;}',
      '.csfx-auth-ref-chip{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:#0f172a;background:rgba(15,23,42,.06);padding:6px 12px;border-radius:999px;border:1px dashed rgba(15,23,42,.12);}',
      '.csfx-auth-ref-icon{font-size:15px;}',
      '.csfx-qr-panel{margin-top:12px;padding:12px;border:1px dashed rgba(15,23,42,.2);border-radius:12px;background:rgba(15,23,42,.04);display:flex;flex-direction:column;gap:8px;}',
      '.csfx-qr-panel video{width:100%;border-radius:10px;background:#000;max-height:220px;object-fit:cover;}',
      '.csfx-qr-panel-note{font-size:12px;color:#0f172a;}',
      '.csfx-qr-panel-actions{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;font-size:11px;color:#0f172a;}',
      '.csfx-qr-panel-actions .csfx-btn{min-width:0;padding:4px 12px;font-size:11px;}',
      '.csfx-auth-status{font-size:12px;font-weight:600;color:#334155;}',
      '.csfx-auth-status--ok{color:#0f766e;}',
      '.csfx-auth-status--error{color:#b91c1c;}',
      '.csfx-auth-info{font-size:12px;color:#475569;line-height:1.5;}',
      '.csfx-countdown{font-size:14px;font-weight:700;color:#0f172a;}',
      '.csfx-countdown[data-active="1"]{color:#b91c1c;}',
      '.csfx-guarded{cursor:not-allowed!important;color:#64748b!important;}',
      '.csfx-modal--info{max-width:420px;width:420px;min-width:320px;}',
      '.csfx-modal--info .csfx-modal-body{gap:14px;}',
      '.csfx-modal--confirm .csfx-modal-body{gap:18px;}',
      '.csfx-confirm-body{padding:22px 24px 26px;display:flex;flex-direction:column;gap:14px;text-align:center;font-size:14px;color:#0f172a;}',
      '.csfx-confirm-icon{font-size:34px;line-height:1;color:#1d4ed8;margin:0 auto;}',
      '.csfx-confirm-note{font-size:12px;color:#475569;}',
      '.csfx-explain-body{display:flex;flex-direction:column;gap:12px;font-size:13px;color:#0f172a;}',
      '.csfx-explain-head{font-weight:700;color:#0b1f3a;}',
      '.csfx-explain-steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;}',
      '.csfx-explain-steps li{display:flex;gap:8px;line-height:1.45;}',
      '.csfx-explain-steps strong{color:#0b6ad4;}',
      '.csfx-explain-inline{font-weight:600;color:#072c59;}',
      '.csfx-explain-foot{font-size:12px;color:#475569;line-height:1.4;}',
      '.csfx-explain-subtitle{font-weight:700;color:#0b1f3a;margin-top:6px;}',
      '.csfx-explain-steps--secondary{margin-top:4px;font-size:12px;color:#0f172a;}',
      '.csfx-explain-steps--secondary li strong{color:#0b1f3a;}',
      '.csfx-modal-footer{display:flex;justify-content:flex-end;gap:10px;margin-top:auto;padding:0 24px 24px;}',
      '.csfx-modal-body::-webkit-scrollbar{width:6px;}',
      '.csfx-modal-body::-webkit-scrollbar-thumb{background:rgba(148,163,184,.45);border-radius:999px;}',
      '@media (min-width: 720px){.csfx-modal [data-csfx=\"dual-panel\"] .csfx-dual-mode[data-csfx-mode-form=\"bs\"],.csfx-badge-content [data-csfx=\"dual-panel\"] .csfx-dual-mode[data-csfx-mode-form=\"bs\"]{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;align-items:flex-start;}.csfx-modal [data-csfx=\"dual-panel\"] .csfx-dual-mode[data-csfx-mode-form=\"bs\"]>.csfx-dual-input,.csfx-badge-content [data-csfx=\"dual-panel\"] .csfx-dual-mode[data-csfx-mode-form=\"bs\"]>.csfx-dual-input{margin:0;}.csfx-modal [data-csfx=\"dual-panel\"] .csfx-dual-mode[data-csfx-mode-form=\"bs\"]>.csfx-dual-bs-field,.csfx-badge-content [data-csfx=\"dual-panel\"] .csfx-dual-mode[data-csfx-mode-form=\"bs\"]>.csfx-dual-bs-field{margin:0;}.csfx-modal [data-csfx=\"dual-panel\"] .csfx-dual-mode[data-csfx-mode-form=\"bs\"]>.csfx-dual-adjust,.csfx-badge-content [data-csfx=\"dual-panel\"] .csfx-dual-mode[data-csfx-mode-form=\"bs\"]>.csfx-dual-adjust{grid-column:1/-1;}.csfx-modal [data-csfx=\"dual-panel\"] .csfx-dual-adjust[data-open=\"true\"],.csfx-badge-content [data-csfx=\"dual-panel\"] .csfx-dual-adjust[data-open=\"true\"]{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 8px;align-items:stretch;}.csfx-modal [data-csfx=\"dual-panel\"] .csfx-dual-adjust-text,.csfx-badge-content [data-csfx=\"dual-panel\"] .csfx-dual-adjust-text{grid-column:1/-1;margin-bottom:0;}.csfx-modal [data-csfx=\"dual-panel\"] .csfx-dual-adjust button,.csfx-badge-content [data-csfx=\"dual-panel\"] .csfx-dual-adjust button{width:100%;}.csfx-modal [data-csfx=\"dual-panel\"] .csfx-dual-actions,.csfx-badge-content [data-csfx=\"dual-panel\"] .csfx-dual-actions{grid-template-columns:repeat(2,minmax(0,1fr));}.csfx-modal [data-csfx=\"dual-panel\"] .csfx-dual-extra,.csfx-badge-content [data-csfx=\"dual-panel\"] .csfx-dual-extra{width:100%;margin-top:10px;grid-template-columns:repeat(2,minmax(0,1fr));}}',
      '@media (max-width: 1024px) and (max-height: 650px){.csfx-modal{width:clamp(540px,96vw,620px);border-radius:16px;font-size:90%;}.csfx-modal-header{padding:10px 14px;gap:8px;}.csfx-modal-header-title{font-size:14px;gap:6px;}.csfx-modal-header-icon{width:26px;height:26px;font-size:16px;border-radius:8px;}.csfx-modal-body{padding:10px 14px 14px;gap:10px;}.csfx-modal-body::-webkit-scrollbar{width:5px;}.csfx-dual-box{padding:8px 10px;border-radius:14px;display:grid;grid-template-columns:minmax(0,0.6fr) minmax(0,0.4fr);grid-template-areas:\"title title\" \"grid grid\" \"tabs tabs\" \"modes modes\" \"btns btns\" \"extra helper\" \"metrics metrics\" \"status status\";grid-column-gap:8px;grid-row-gap:6px;align-items:start;}.csfx-dual-box>*{margin:0;min-width:0;} .csfx-dual-box h4{grid-area:title;font-size:14px;gap:6px;}.csfx-dual-box>.csfx-dual-grid{grid-area:grid;display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:5px;font-size:12px;}.csfx-dual-box>.csfx-dual-grid strong{font-size:13px;}.csfx-dual-box>.csfx-dual-tabs{grid-area:tabs;display:flex;gap:4px;flex-wrap:wrap;}.csfx-dual-box>.csfx-dual-tabs .csfx-dual-tab{flex:1 1 120px;padding:5px 7px;font-size:10.5px;white-space:normal;}.csfx-dual-box>.csfx-dual-modes{grid-area:modes;display:flex;flex-direction:column;gap:5px;}.csfx-dual-box>.csfx-dual-modes .csfx-dual-mode{margin-top:0;padding:6px 8px;border-radius:9px;background:rgba(12,74,148,.05);border:1px solid rgba(12,74,148,.16);}.csfx-dual-box>.csfx-dual-modes .csfx-dual-input{gap:4px;}.csfx-dual-box>.csfx-dual-modes .csfx-dual-input span{font-size:11.5px;white-space:normal;}.csfx-dual-box>.csfx-dual-modes .csfx-dual-input input{padding:6px 8px;font-size:12.5px;border-radius:8px;width:100%;box-sizing:border-box;}.csfx-dual-box>.csfx-dual-modes .csfx-dual-inline-hint{font-size:10px;padding:4px 6px;white-space:normal;}.csfx-dual-box>.csfx-dual-modes .csfx-dual-adjust{display:flex;flex-wrap:wrap;gap:4px;}.csfx-dual-box>.csfx-dual-modes .csfx-dual-adjust button{flex:1 1 110px;font-size:10px;padding:5px 6px;white-space:normal;}.csfx-dual-box>.csfx-dual-metrics{grid-area:metrics;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:5px;align-content:start;}.csfx-dual-box>.csfx-dual-metrics .csfx-dual-metrics-row{display:flex;justify-content:space-between;align-items:center;padding:5px 8px;border-radius:8px;font-size:11.5px;gap:5px;white-space:normal;}.csfx-dual-box>.csfx-dual-metrics .csfx-dual-metrics-value{font-size:12.5px;}.csfx-dual-box>.csfx-dual-actions{grid-area:btns;}.csfx-dual-box>.csfx-dual-actions .csfx-btn{padding:6px 8px;font-size:11px;white-space:normal;line-height:1.2;min-width:0;}.csfx-dual-box>.csfx-dual-extra{grid-area:extra;}.csfx-dual-box>.csfx-dual-extra .csfx-btn{flex:1 1 150px;padding:6px 8px;font-size:11px;min-width:0;}.csfx-dual-box>.csfx-dual-helper{grid-area:helper;display:flex;align-items:center;justify-content:space-between;gap:5px;padding:7px 9px;border-radius:9px;background:rgba(12,74,148,.08);font-size:10.5px;}.csfx-dual-box>.csfx-dual-helper .csfx-dual-helper-icon{flex-shrink:0;font-size:11px;width:17px;height:17px;}.csfx-dual-box>.csfx-dual-helper .csfx-dual-helper-label{font-size:10.5px;white-space:normal;}.csfx-dual-box>.csfx-dual-status{grid-area:status;font-size:10px;text-align:right;margin-top:2px;}.csfx-modal-footer{display:none;}}',
      '@media (max-width: 900px){.csfx-modal-backdrop{padding:16px;}.csfx-modal{border-radius:16px;width:clamp(300px,96vw,380px);}.csfx-modal-body{padding:18px 20px;}.csfx-modal-footer{padding:0 20px 20px;}}',
      '@media (max-width: 600px){.csfx-modal{width:96vw;border-radius:14px;}.csfx-modal-header{padding:16px 18px;}.csfx-modal-body{padding:16px 18px 18px;gap:14px;}.csfx-modal-footer{padding:0 18px 18px;}}',
      '@media (max-height: 720px){.csfx-modal{max-height:calc(100vh - 16px);}.csfx-modal-body{padding-bottom:18px;}}',
      '.csfx-btn--wide{padding:11px 20px;font-size:13px;font-weight:700;min-width:148px;}',
      '.csfx-btn--link{background:rgba(37,99,235,.08);color:#0b6ad4;border:1px dashed rgba(37,99,235,.35);}',
      '.csfx-btn--link:hover:not(:disabled){background:rgba(37,99,235,.14);}',
      '.csfx-btn--primary{background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff;box-shadow:0 10px 24px rgba(37,99,235,.28);}',
      '.csfx-btn--primary:hover:not(:disabled){background:linear-gradient(135deg,#1d4ed8,#1e40af);box-shadow:0 12px 28px rgba(30,64,175,.32);}',
      '.csfx-btn--ghost{background:rgba(15,23,42,.04);color:#0f172a;border:1px solid rgba(15,23,42,.12);}',
      '.csfx-btn--ghost:hover:not(:disabled){background:rgba(15,23,42,.08);}',
      '.csfx-auth-widget{position:fixed;top:20px;right:20px;z-index:10003;background:rgba(15,23,42,.94);color:#f8fafc;padding:12px 16px;border-radius:16px;box-shadow:0 22px 48px rgba(15,23,42,.35);display:none;align-items:center;gap:14px;font-size:13px;font-family:inherit;pointer-events:auto;min-width:220px;}',
      '.csfx-auth-widget[data-open=\"true\"]{display:flex;}',
      '.csfx-auth-widget[data-tone=\"safe\"]{background:rgba(15,23,42,.94);}',
      '.csfx-auth-widget[data-tone=\"warn\"]{background:rgba(251,191,36,.18);color:#1f2937;}',
      '.csfx-auth-widget[data-tone=\"danger\"]{background:rgba(239,68,68,.22);color:#1f2937;}',
      '.csfx-auth-widget__icon{font-size:18px;opacity:.9;}',
      '.csfx-auth-widget__info{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.csfx-auth-widget__ref{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#cbd5f5;font-weight:600;}',
      '.csfx-auth-widget__timer{font-weight:700;font-size:14px;color:#38bdf8;}',
      '.csfx-auth-widget[data-tone=\"safe\"] .csfx-auth-widget__timer{color:#34d399;}',
      '.csfx-auth-widget[data-tone=\"warn\"] .csfx-auth-widget__timer{color:#f97316;}',
      '.csfx-auth-widget[data-tone=\"danger\"] .csfx-auth-widget__timer{color:#ef4444;}',
      '.csfx-auth-widget__close{background:rgba(248,250,252,.08);border:1px solid rgba(148,163,184,.45);color:#e2e8f0;border-radius:999px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;transition:all .2s ease;white-space:nowrap;}',
      '.csfx-auth-widget__close:hover{background:rgba(248,250,252,.18);color:#f8fafc;border-color:rgba(255,255,255,.55);}',
      // especificidad para evitar conflictos con CSS del POS
        /* Reglas específicas para el buscador (sin romper layout nativo) */
      '.csfx-chip.csfx-chip--search{display:inline-flex;align-items:center;justify-content:center;margin:0;padding:1px 4px;border-radius:999px;font-size:10.5px;font-weight:600;line-height:1;white-space:nowrap;min-width:0;gap:2px;pointer-events:none;box-shadow:none;position:static!important;top:auto!important;right:auto!important;bottom:auto!important;left:auto!important;transform:none!important;flex-shrink:0;float:none!important;}',
      '.csfx-chip-cluster{position:absolute;right:6px;bottom:3px;transform:none;display:flex;align-items:center;gap:2px;pointer-events:none;padding:1px 3px;border-radius:10px;background:rgba(248,250,252,.93);border:1px solid rgba(148,163,184,.16);box-shadow:0 2px 6px rgba(15,23,42,.08);flex-wrap:nowrap;backdrop-filter:blur(1px);min-width:0;}',
      '.csfx-chip-cluster.vip{box-shadow:0 4px 10px rgba(15,118,110,.16);}',
      '.csfx-chip-cluster .csfx-chip{background:rgba(255,255,255,.9);border-radius:8px;margin:0;}',
      '.csfx-usd-chip{color:#0f5132;background:rgba(25,135,84,.12);border:1px solid rgba(25,135,84,.2);}',
      '.csfx-bs-chip{color:#1d2951;background:rgba(59,130,246,.07);border:1px solid rgba(37,99,235,.12);}',
      '.csfx-usd-disc{color:#1f2a44;background:rgba(6,95,212,.09);border:1px solid rgba(6,95,212,.12);}',
      '.mat-autocomplete-panel .mat-option .mat-option-text{position:relative;overflow:visible;padding-right:10rem;display:flex;flex-direction:column;gap:3px;align-items:flex-start;}',
      '.mat-autocomplete-panel .mat-option .suggest-product-sku{font-size:11px;color:rgba(15,23,42,.72);opacity:.78;display:block;margin-top:2px;letter-spacing:.01em;line-height:1.1;order:2;white-space:nowrap;position:relative!important;top:auto!important;left:auto!important;right:auto!important;bottom:auto!important;}',
      '.mat-autocomplete-panel .mat-option{padding:6px 0!important;min-height:60px;line-height:1.3;display:block;}',
      '@media (max-width: 1280px) and (orientation: landscape){.mat-autocomplete-panel .mat-option .mat-option-text{padding-right:8rem;gap:2px;}.csfx-chip-cluster{right:4px;bottom:4px;padding:1px 2px;gap:1.5px;border-radius:9px;}.csfx-chip-cluster .csfx-chip{border-radius:7px;padding:1px 3px!important;font-size:9.5px!important;}.csfx-chip.csfx-chip--search{font-size:9.5px;padding:1px 3px;gap:2px;}.mat-autocomplete-panel .mat-option{min-height:56px;}}',
      '.mat-dialog-container .mat-radio-button .mat-radio-label-content, .mat-dialog-container .mat-checkbox .mat-checkbox-label{display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%}',
      '.mat-dialog-container .csfx-addon-stack{display:flex;flex-direction:column;align-items:flex-end;gap:2px}',
      '.csfx-usd-disc{display:inline-flex;align-items:center;}'

    ].join('');
    var el = document.createElement('style');
    el.id = id;
    el.textContent = css;
    document.head.appendChild(el);
  })();

  // --- Throttling seguro para Angular ---
  var scheduled = false;
  function schedule(fn) {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () {
      scheduled = false;
      try { fn(); } catch (e) { /* silencioso */ }
    });
  }

  // --- Helpers DOM ---
  function findPriceElement(root) {
    if (!root) return null;
    // targets típicos
    var e = root.querySelector('.md-chip,.mat-chip,.chip,.price,[class*="price"],[class*="amount"]');
    if (e && !isNaN(parsePrice(e.textContent))) return e;
    // fallback: último número con 2 decimales a la derecha
    var cand = Array.prototype.filter.call(root.querySelectorAll('span,div,strong,b,i,em'), function (n) {
      var t = (n.textContent || '').trim();
      return /-?\d+[.,]\d{2}\s*$/.test(t) && !n.classList.contains('csfx-chip') && !/\(Bs\)/i.test(t);
    });
    if (cand.length) {
      cand.sort(function (a, b) {
        return b.getBoundingClientRect().right - a.getBoundingClientRect().right;
      });
      return cand[0];
    }
    return null;
  }
  function hideHard(el) {
    if (!el) return;
    el.classList.add('csfx-hide-tax');
    el.style.display = 'none';
    el.style.lineHeight = '0';
    el.style.height = '0';
    el.style.overflow = 'hidden';
    el.style.margin = '0';
    el.style.padding = '0';
    el.style.border = '0';
  }
  // ----- Lectura robusta de valores en USD desde una fila de totales -----
  function pickValueElement(row) {
    if (!row) return null;
    // 1) patrones típicos de OpenPOS / Angular Material
    var el = row.querySelector('.total-value, [class*="total-value"], [class*="value"]');
    if (el) return el;
    // 2) tablas: última celda
    el = row.querySelector('td:last-child');
    if (el) return el;
    // 3) mat-list: la segunda columna dentro de .mat-list-text
    var listText = row.querySelector('.mat-list-text');
    if (listText) {
      // suele tener 2 hijos: título y valor; intentamos el último
      var kids = Array.from(listText.children).filter(Boolean);
      if (kids.length) return kids[kids.length - 1];
    }
    // 4) último hijo directo con texto
    var children = Array.from(row.children).filter(Boolean);
    for (var i = children.length - 1; i >= 0; i--) {
      if ((children[i].textContent || '').trim()) {
        return children[i];
      }
    }
    return row;
  }
  function readUsdFromRow(row) {
    if (!row) return NaN;
    var valEl = pickValueElement(row);
   if (!valEl) return NaN;
    // Evitar contaminación por nuestros hijos inline (data-csfx)
    var txt;
    if (valEl.querySelector && valEl.querySelector('[data-csfx]')) {
      var clone = valEl.cloneNode(true);
      Array.prototype.slice.call(clone.querySelectorAll('[data-csfx]')).forEach(function (n) { n.remove(); });
      txt = clone.textContent || '';
    } else {
      txt = valEl.textContent || '';
    }    return parsePrice(txt);
  }
  // --- Decoradores ---
    // bandera para evitar actualizaciones repetidas que generan parpadeo
  var updateApplied = false;

  function decorateSearch() {
    if (!FX.rate) {
      document.querySelectorAll('[data-csfx="search-cluster"]').forEach(function (cluster) {
        var parent = cluster.parentNode;
        if (!parent) return;
        Array.prototype.slice.call(cluster.children).forEach(function (child) {
          if (!(child && child.nodeType === 1)) return;
          var role = child.dataset ? child.dataset.csfx : '';
          if (role === 'bs-search' || role === 'usd-disc') {
            child.remove();
            return;
          }
          child.classList.remove('csfx-chip', 'csfx-chip--search', 'csfx-usd-chip', 'csfx-usd-disc');
          if (child.dataset) {
            delete child.dataset.csfx;
            delete child.dataset.csfxUsdRole;
          }
          child.style.fontFamily = '';
          child.style.fontSize = '';
          child.style.fontWeight = '';
          child.style.letterSpacing = '';
          child.style.fontFeatureSettings = '';
          child.style.fontVariantNumeric = '';
          child.style.lineHeight = '';
          child.style.borderRadius = '';
          child.style.display = '';
          child.style.alignItems = '';
          child.style.justifyContent = '';
          child.style.margin = '';
          child.style.padding = '';
          child.style.boxShadow = '';
          child.style.background = '';
          child.style.color = '';
          child.style.borderColor = '';
          child.style.position = '';
          child.style.top = '';
          child.style.right = '';
          child.style.bottom = '';
          child.style.left = '';
          child.style.transform = '';
          parent.insertBefore(child, cluster);
        });
        cluster.remove();
      });
      document.querySelectorAll('[data-csfx="bs-search"], [data-csfx="usd-disc"], .csfx-search-bs').forEach(function (n) {
        if (n.parentNode) n.remove();
      });
      return;
    }
    if (!FX.searchBs || updateApplied) return;    updateApplied = true;
    var items = document.querySelectorAll('.mat-autocomplete-panel .mat-option');
    items.forEach(function (it) {
     var textRoot = it.querySelector('.mat-option-text') || it;
      // Limpieza de versiones previas que usaban csfx-price-stack
      var oldStack = textRoot.querySelector('.csfx-price-stack');
      if (oldStack) {
        while (oldStack.firstChild) {
          oldStack.parentNode.insertBefore(oldStack.firstChild, oldStack);
        }
        oldStack.remove();
      }
      var priceEl = textRoot.querySelector('.product-price, .variation-price, [class*="price"]');
      if (!priceEl) priceEl = findPriceElement(textRoot);
      if (!priceEl) return; // sin USD confiable, no insertes Bs
      var usdVal = parsePrice(priceEl.textContent);
      if (isNaN(usdVal) || usdVal <= 0) return;

      const anchor = priceEl.closest('.mat-option-text') || priceEl.parentNode;
      if (!anchor) return;
      Array.prototype.slice.call(anchor.querySelectorAll('.csfx-usd-disc-inside')).forEach(function (n) { n.remove(); });

      function looksLikeUsdChip(node) {
        if (!node || node.nodeType !== 1) return false;
        if (node.dataset && node.dataset.csfx) return false;
        var tx = (node.textContent || '').trim();
        if (!tx) return false;
        if (!/\$/.test(tx)) return false;
        if (/(Bs|VES|VEF)/i.test(tx)) return false;
        if (!/\d/.test(tx)) return false;
        return true;
      }

      var cluster = anchor.querySelector('[data-csfx="search-cluster"]');
      if (!cluster) {
        cluster = document.createElement('span');
        cluster.dataset.csfx = 'search-cluster';
        anchor.appendChild(cluster);
      }
      var compactMode = false;
      try {
        compactMode = window.matchMedia && window.matchMedia('(max-width: 1280px) and (orientation: landscape)').matches;
      } catch (_errMatchMedia) {}
      cluster.className = 'csfx-chip-cluster' + (FX.style && FX.style.vipSearch ? ' vip' : '');
      if (FX.style && FX.style.vipSearch) {
        cluster.style.background = FX.style.vipSearchBg || '';
        cluster.style.borderColor = FX.style.vipSearchBorder || '';
        cluster.style.boxShadow = FX.style.vipSearchShadow || '';
        cluster.style.color = FX.style.vipSearchText || '';
      } else {
        cluster.style.background = '';
        cluster.style.borderColor = '';
        cluster.style.boxShadow = '';
        cluster.style.color = '';
      }
      cluster.style.top = '';
      cluster.style.bottom = '';
      cluster.style.right = '';
      cluster.style.left = '';
      cluster.style.transform = '';
      cluster.style.padding = compactMode ? '1px 2px' : '1px 3px';
      cluster.style.gap = compactMode ? '1.5px' : '2px';

      if (!cluster.contains(priceEl)) {
        cluster.insertBefore(priceEl, cluster.firstChild);
      }

      var usdNodes = [];
      function pushUsdNode(node) {
        if (!node) return;
        if (usdNodes.indexOf(node) !== -1) return;
        usdNodes.push(node);
      }

      pushUsdNode(priceEl);

      Array.prototype.slice.call(anchor.querySelectorAll(':scope > *')).forEach(function (node) {
        if (node === cluster) return;
        if (cluster.contains(node)) return;
        if (!looksLikeUsdChip(node)) return;
        cluster.appendChild(node);
        pushUsdNode(node);
      });

      var fxDiscChip = cluster.querySelector('[data-csfx="usd-disc"]');
      if (FX.disc && FX.disc.active && FX.disc.percent > 0) {
        var usdDisc = usdVal * (1 - FX.disc.percent / 100);
        if (!fxDiscChip) {
          fxDiscChip = document.createElement('span');
          fxDiscChip.dataset.csfx = 'usd-disc';
          cluster.appendChild(fxDiscChip);
        }
        fxDiscChip.textContent = (new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(usdDisc)) + '$';
        fxDiscChip.title = CSFX_BASE_CODE + ' con descuento (' + FX.disc.percent + '%)';
        pushUsdNode(fxDiscChip);
      } else if (fxDiscChip) {
        fxDiscChip.remove();
        fxDiscChip = null;
      }

      var usdMeta = usdNodes.map(function (node) {
        return {
          node: node,
          value: parsePrice(node.textContent || '')
        };
      }).filter(function (meta) {
        return isFinite(meta.value) && meta.value > 0;
      });

      if (!usdMeta.length) return;

      usdMeta.sort(function (a, b) {
        return b.value - a.value;
      });

      var primaryUsd = usdMeta[0].node;
      var discountUsdNodes = usdMeta.slice(1).map(function (meta) { return meta.node; });

      function prepareUsdNode(node, isPrimary) {
        node.classList.add('csfx-chip', 'csfx-chip--search');
        node.classList.remove('csfx-usd-disc', 'csfx-usd-chip');
        if (isPrimary) {
          node.classList.add('csfx-usd-chip');
          node.dataset.csfxUsdRole = 'primary';
        } else {
          node.classList.add('csfx-usd-disc');
          node.dataset.csfxUsdRole = 'discount';
        }
        if (node.style && node.style.setProperty) {
          node.style.setProperty('position', 'static', 'important');
          node.style.setProperty('top', 'auto', 'important');
          node.style.setProperty('right', 'auto', 'important');
          node.style.setProperty('bottom', 'auto', 'important');
          node.style.setProperty('left', 'auto', 'important');
          node.style.setProperty('transform', 'none', 'important');
          node.style.setProperty('box-shadow', 'none', 'important');
        } else if (node.style) {
          node.style.position = 'static';
          node.style.top = 'auto';
          node.style.right = 'auto';
          node.style.bottom = 'auto';
          node.style.left = 'auto';
          node.style.transform = 'none';
          node.style.boxShadow = 'none';
        }
      }

      prepareUsdNode(primaryUsd, true);
      discountUsdNodes.forEach(function (node) {
        prepareUsdNode(node, false);
      });

      var bsChip = cluster.querySelector('[data-csfx="bs-search"]');
      if (!bsChip) {
        bsChip = document.createElement('span');
        bsChip.dataset.csfx = 'bs-search';
        cluster.appendChild(bsChip);
      }
      bsChip.className = 'csfx-chip csfx-chip--search csfx-bs-chip';
      var bsText = fmtBs(usd2bs(usdVal));
      bsChip.textContent = bsText;
      if (FX.style && FX.style.vipSearch) {
        bsChip.style.background = FX.style.vipSearchBg || '';
        bsChip.style.borderColor = FX.style.vipSearchBorder || '';
        bsChip.style.color = FX.style.vipSearchText || '';
        bsChip.style.boxShadow = FX.style.vipSearchShadow || '';
      } else {
        bsChip.style.background = '';
        bsChip.style.borderColor = '';
        bsChip.style.color = '';
        bsChip.style.boxShadow = '';
      }

      cluster.insertBefore(primaryUsd, cluster.firstChild);
      cluster.insertBefore(bsChip, primaryUsd.nextSibling);
      discountUsdNodes.forEach(function (node) {
        cluster.appendChild(node);
      });

      var syncChips = [primaryUsd, bsChip].concat(discountUsdNodes);
      const cs = getComputedStyle(primaryUsd);
      var baseFamily = cs.fontFamily || 'inherit';
      var baseLetterSpacing = cs.letterSpacing;
      var baseFeatures = cs.fontFeatureSettings || 'normal';
      var chipFontSize = compactMode ? '9.5px' : '10.5px';
      var chipPadding = compactMode ? '1px 3px' : '1px 4px';
      syncChips.forEach(function (node) {
        node.style.fontFamily = baseFamily;
        node.style.fontSize = chipFontSize;
        node.style.fontWeight = '600';
        node.style.letterSpacing = baseLetterSpacing;
        node.style.fontFeatureSettings = baseFeatures;
        node.style.fontVariantNumeric = 'tabular-nums lining-nums';
        node.style.lineHeight = '1';
        node.style.borderRadius = '999px';
        node.style.display = 'inline-flex';
        node.style.alignItems = 'center';
        node.style.justifyContent = 'center';
        node.style.margin = '0';
        node.style.padding = chipPadding;
      });


    });
  }

    function resetUpdates() {
    updateApplied = false;
  }

  function decorateAddons() {
    if (!FX.rate || !FX.addonsBs) {
      document.querySelectorAll('[data-csfx="addon-bs"]').forEach(function(n){ n.remove(); });
      document.querySelectorAll('[data-csfx="addon-stack"]').forEach(function(stack){
        var child = Array.prototype.find.call(stack.childNodes, function(n){ return n.nodeType === 1 && !n.dataset.csfx; });
        if (child) stack.replaceWith(child); else stack.remove();
      });
      return;
    }    var modals = document.querySelectorAll('.mat-dialog-container');
    modals.forEach(function (modal) {
      var opts = modal.querySelectorAll('mat-radio-button, mat-checkbox, .mat-option, li');
      opts.forEach(function (opt) {
        var content = opt.querySelector('.mat-radio-label-content') || opt.querySelector('.mat-checkbox-label') || opt.querySelector('label') || opt;
        var stack = content.querySelector('[data-csfx="addon-stack"]');
        if (stack && stack.parentNode !== content) content.appendChild(stack);
        var priceEl;
        if (stack) {
          priceEl = Array.prototype.find.call(stack.childNodes, function (n) {
            return n.nodeType === 1 && !n.dataset.csfx;
          });
        } else {
        priceEl = content.querySelector('.price, [class*="amount"]');
          if (!priceEl) priceEl = findPriceElement(content);
          if (!priceEl) return;
          stack = document.createElement('span');
          stack.className = 'csfx-addon-stack';
          stack.dataset.csfx = 'addon-stack';
          priceEl.parentNode.insertBefore(stack, priceEl);
          stack.appendChild(priceEl);
               content.appendChild(stack);
        }
        var usdVal = parsePrice(priceEl.textContent);
        if (isNaN(usdVal) || usdVal <= 0) return;
        var chip = stack.querySelector('[data-csfx="addon-bs"]');
        if (!chip) {
     chip = Array.prototype.find.call(content.childNodes, function (n) {
            if (n.nodeType !== 1) return false;
            if (stack.contains(n)) return false;
            var tx = (n.textContent || '').trim();
          return /^(Bs|VES|VEF)\s*[\d\.,]+$/i.test(tx);
          });
          if (chip) {
            stack.appendChild(chip);
          } else {
            chip = document.createElement('span');
            stack.appendChild(chip);
          }
          chip.className = 'csfx-chip csfx-chip--under csfx-chip--addon';
          chip.dataset.csfx = 'addon-bs';
        }
         chip.textContent = fmtBs(usd2bs(usdVal));
      });
    });
  
  }

  function getLineUSD(row) {
    if (!row) return NaN;
    var candidates = [];
    var bsVisible = NaN;
    Array.prototype.slice.call(row.querySelectorAll('span,div,strong,b')).forEach(function (n) {
      if (n.closest('.csfx-cart-row')) return;
      if ((n.classList && Array.prototype.some.call(n.classList, function (c) { return c.indexOf('csfx-') === 0; })) || n.dataset && n.dataset.csfx) return;
      var tx = (n.textContent || '').trim();
     if (/^(Bs|VES|VEF)\s*[\d\.,]+$/i.test(tx) && isNaN(bsVisible)) bsVisible = parsePrice(tx);
    });
    function pushCandidate(val, prio) {
      if (isNaN(val) || val <= 0) return;
            var bsVal = usd2bs(val);
      if (bsVal < 1 || bsVal > 1e6) return;
      if (!isNaN(bsVisible)) {
             var diff = Math.abs(bsVal - bsVisible) / bsVisible;
        if (diff > 0.25) return;
      }
      candidates.push({ usd: val, prio: prio });
    }
    var totalEl = row.querySelector('.total-value');
    if (totalEl) pushCandidate(parsePrice(totalEl.textContent), 1);
    if (candidates.length === 0) {
      var nodes = Array.prototype.filter.call(row.querySelectorAll('span,div,strong,b'), function (n) {
        if (n.closest('.csfx-cart-row')) return false;
        if ((n.classList && Array.prototype.some.call(n.classList, function (c) { return c.indexOf('csfx-') === 0; })) || n.dataset && n.dataset.csfx) return false;
        if (n.querySelector('svg')) return false;
        var t = (n.textContent || '').trim();
        if (/bs|ves|vef/i.test(t)) return false;
     if (/^[+-]/.test(t)) return false;
        return /\d+[.,]\d{1,2}$/.test(t);
      });
      if (nodes.length) {
        nodes.sort(function (a, b) { return b.getBoundingClientRect().right - a.getBoundingClientRect().right; });
        pushCandidate(parsePrice(nodes[0].textContent), 2);
      }
    }
    if (candidates.length === 0) {
      var clone = row.cloneNode(true);
      Array.prototype.slice.call(clone.querySelectorAll('.csfx-cart-row,[class^="csfx-"],[data-csfx]')).forEach(function (x) { x.remove(); });
      var text = clone.textContent || '';
      var qty = 1;
      var qm = text.match(/^\s*(\d+)\s*[x×]/i);
      if (qm) {
        qty = parseInt(qm[1], 10);
      } else {
     var dq = row.getAttribute('data-qty');
        if (dq && !isNaN(parseInt(dq, 10))) qty = parseInt(dq, 10);
      var inp = row.querySelector('input[type="number"]');
        if (inp && !isNaN(parseInt(inp.value, 10))) qty = parseInt(inp.value, 10);
      }
      var unitUSD = NaN;
      var unitEl = row.querySelector('.variation-price, .product-price, [class*="price"]');
      if (unitEl) {
        var txu = (unitEl.textContent || '').trim();
        if (!/bs|ves|vef/i.test(txu)) unitUSD = parsePrice(txu);
      }
    if (isNaN(unitUSD)) {
        var rx = /-?\d+[\.,]\d{1,2}/g, m;
        while ((m = rx.exec(text)) !== null) {
          var seg = text.slice(Math.max(0, m.index - 4), m.index + m[0].length + 3).toLowerCase();
         if (/bs|ves|vef/.test(seg)) continue;
        var before = text[m.index - 1];
        if (before === '+' || before === '-') continue;
        unitUSD = parsePrice(m[0]);
          if (!isNaN(unitUSD)) break;
        }
      }
         var addonUSD = 0;
      var rxAdd = /\+\s*(\d+[\.,]\d{1,2})/g, ma;
      while ((ma = rxAdd.exec(text)) !== null) {
        var seg2 = text.slice(Math.max(0, ma.index - 4), ma.index + ma[0].length + 3).toLowerCase();
        if (/bs|ves|vef/.test(seg2)) continue;
        var v = parsePrice(ma[1]);
        if (!isNaN(v)) addonUSD += v;
      }
      if (!isNaN(unitUSD)) pushCandidate(unitUSD * qty + addonUSD, 3);
    }
    if (!candidates.length) return NaN;
    candidates.sort(function (a, b) { return a.prio - b.prio; });
     return candidates[0].usd;
  }

  function decorateCart() {
    if (!FX.rate) {
      var c = findTotalsContainer();
      if (c) c.querySelectorAll('.csfx-total-row, .csfx-cart-row, [data-csfx]').forEach(function(n){ n.remove(); });
      document.querySelectorAll('.mat-list-item > .csfx-cart-row[data-csfx="cart-bs"], app-cart .mat-list-item > .csfx-cart-row[data-csfx="cart-bs"]').forEach(function (n) { n.remove(); });
      return;
    }    var cartRows = document.querySelectorAll('app-cart .mat-list-item');
    var rows = cartRows.length ? cartRows : document.querySelectorAll('.mat-list-item');
    rows.forEach(function (r) {
      if (r.closest('app-pos-order-total, .total-sub')) {
        var leak = r.querySelector(':scope > .csfx-cart-row');
        if (leak) leak.remove();
        return;
      }
      var mark = r.querySelector(':scope > .csfx-cart-row[data-csfx="cart-bs"]');
      // Saltar únicamente la FILA de descuento global, no las líneas de producto con texto “de Descuento”
      if (r.classList && r.classList.contains('cart-discount')) {
        if (mark) mark.remove();
        return;
      }
      var usd = getLineUSD(r);
           var discounts = OPCompat.normalizeItemDiscounts ? OPCompat.normalizeItemDiscounts(r.dataset || {}) : [];
      if (discounts.length) {
        r.dataset.csfxDiscounts = discounts.join(',');
      }
      if (isNaN(usd)) {
        if (mark) mark.remove();
        return;
      }
     var bs = usd2bs(usd);
      if (!mark) {
           mark = document.createElement('span');
        mark.className = 'csfx-cart-row mat-line';
        mark.dataset.csfx = 'cart-bs';
        var sp = document.createElement('span');
        sp.className = 'csfx-amount';
     
        mark.appendChild(sp);
        r.appendChild(mark);

      }
        var sp2 = mark.querySelector('.csfx-amount');
      if (sp2) sp2.textContent = fmtBs(bs);
    });
        positionBadge();

  }

  function findTotalsContainer() {
    // footer/totales (suele vivir al final del panel derecho)
    // Intenta localizar el contenedor de totales. Abarcamos varios casos: componentes
    // Angular específicos, clases con "total" o "summary" y variantes de OpenPOS.
    return document.querySelector('app-pos-order-total, app-pos-order-summary, app-pos-summary, .total-sub, .op-total, .order-total, [class*="totals"], [class*="summary"], [class*="checkout-footer"], .openpos-summary');
  }
  function findTotalsRow(container, rx) {
    if (!container) return null;
    // incluir Angular Material y filas de tabla
    var rows = Array.prototype.slice.call(container.querySelectorAll('div,li,tr,mat-list-item,mat-row'));

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
       // Ignora cualquier fila/nodo inyectado por nosotros
      if (
        (row.dataset && row.dataset.csfx) ||
        (row.classList && (row.classList.contains('csfx-total-row') || row.classList.contains('csfx-cart-row'))) ||
        (row.closest && (row.closest('[data-csfx]') || row.closest('.csfx-total-row')))
      ) {
        continue;
      }
      // Preferir el elemento de título si existe
      var labelEl = row.querySelector('.total-title, [class*="total-title"], [class*="title"]');
      var label = labelEl || row.querySelector('span,div,b,strong,td') || row;
      var t = (label.textContent || '').trim().toLowerCase();
      if (!t) continue;
      if (rx.test(t)) return row;
    }
    return null;
  }
   // --- Helpers de anclaje y fallback ---
  function anchorRow(row) {
    if (!row) return null;

    var top = row.closest('li, .mat-list-item, tr, mat-list-item, mat-row');
    return top || row;
  }
  function readCheckoutUSD() {
    var btn = document.querySelector(
      '.op-cart-footer .btn.btn-success, .op-cart-footer .op-button-checkout,' +
      ' .op-footer button.btn-success, .op-footer .op-checkout'
    );
    if (!btn) return NaN;
    return parsePrice(btn.textContent);
  }
  function readVisibleSubtotalBs() {
    var selectors = [
      '.bottom-cart-total-container',
      '.cart-subtotal',
      '.op-cart-footer',
      '.op-footer',
      '.cart-totals',
      '.op-cart-totals',
      'footer[class*=\"cart\"]'
    ];
    var nodes = Array.prototype.slice.call(document.querySelectorAll(selectors.join(', ')));
    var text = nodes.map(function (n) { return (n && n.innerText) || ''; }).filter(Boolean).join(' | ');
    if (!/Bs|VES|VEF/i.test(text)) return NaN;
    var val = parsePriceAllowBs(text);
    return isFinite(val) ? val : NaN;
  }
  // === Anclaje al checkout ===
  var ANCHOR_BTN_SELECTORS = [
    '.op-cart-footer .btn.btn-success',
    '.op-cart-footer .op-button-checkout',
    '.op-footer button.btn-success',
    '.op-footer .op-checkout',
    '.bottom-cart-total-container button',
    '.bottom-cart-total-container .btn-success',
    '.bottom-cart-total-container [role="button"]',
    'button[class*="success"]'
  ];
  var FOOTER_SELECTORS = [
    '.bottom-cart-total-container',
    '.op-cart-footer',
    '.op-footer',
    'footer[class*="cart"]'
  ];

  function pickVisibleRects(selectors){
    var nodes = Array.prototype.slice.call(document.querySelectorAll(selectors.join(', ')));
    return nodes.map(function(n){
      try{
        var cs = window.getComputedStyle(n);
        if (!cs || cs.display==='none' || cs.visibility==='hidden') return null;
        var r = n.getBoundingClientRect();
         if (r.width<=0 || r.height<=0) return null;
        return {n:n, r:r};
      }catch(_){ return null; }
    }).filter(Boolean);
   }

  function getCheckoutAnchorRect(){
    var btns = pickVisibleRects(ANCHOR_BTN_SELECTORS);
    var footers = pickVisibleRects(FOOTER_SELECTORS);
    var candidates = btns.concat(footers);
    if (!candidates.length) return null;
    candidates.sort(function(a,b){ return b.r.top - a.r.top; });
    return candidates[0].r;
  }

  function getCheckoutAreaHeight(){
    var areas = pickVisibleRects(FOOTER_SELECTORS);
    if (!areas.length) return 0;
    areas.sort(function(a,b){ return b.r.top - a.r.top; });
    return Math.round(areas[0].r.height);
  }

  // registrar scroll en contenedores típicos del layout (además de window)
  function attachScrollListeners(cb){
    var containers = document.querySelectorAll([
      'body','html',
      '.mat-sidenav-content','.mat-drawer-content','.mat-mdc-sidenav-content','.mat-mdc-drawer-content',
      '.pos-content','.op-container','.cdk-virtual-scroll-viewport'
    ].join(','));
    containers.forEach(function(c){
      try { c.addEventListener('scroll', cb, { passive:true }); } catch(_){ }
    });
  }

  // --- Posicionar badge pegado al botón (o footer) ---
  function positionBadge() {
    var badge = document.querySelector('.csfx-badge');
    if (!badge) return;
    var bottom = 96; // fallback
   try{
      var r = getCheckoutAnchorRect();
      var h = getCheckoutAreaHeight();
      var gap = r ? Math.max(0, Math.round(window.innerHeight - r.top)) : 0;
      bottom = Math.max(12, Math.max(gap, h) + 12);
    }catch(_){ }
    if (badge.style.bottom !== (bottom + 'px')) {
      badge.style.bottom = bottom + 'px';
    }
  }
  // exposed para reusar tras renders
  window.__csfx_positionBadge = positionBadge;
  // enganchar el posicionamiento del badge a eventos relevantes
  function initBadgePositioning() {
    positionBadge();
    window.addEventListener('load', positionBadge, { passive: true });
    window.addEventListener('resize', positionBadge, { passive: true });
    // reposicionar al desplazarse y cambio de orientación
    window.addEventListener('scroll', positionBadge, { passive: true });
    window.addEventListener('orientationchange', positionBadge, { passive: true });
        // scroll en contenedores internos (Angular/Material)
    attachScrollListeners(positionBadge);
    // observar cambios de DOM que puedan mover el botón
    var mo = new MutationObserver(function(){ positionBadge(); });
    mo.observe(document.body, { subtree:true, childList:true, attributes:true });
    // respaldo defensivo
    setInterval(positionBadge, 2000);
  }
  
  function decorateTotals() {



    var container = findTotalsContainer();
   // 1) Ocultar impuestos SIEMPRE si la opción está activa, aunque no haya tasa
    if (FX.hideTax && container) {
      var tax0 = findTotalsRow(container, /impuesto|tax/i);
      if (tax0) hideHard(anchorRow(tax0));
    }
    if (!FX.rate) {
      if (container) container.querySelectorAll('.csfx-total-row,[data-csfx]').forEach(function (n) { n.remove(); });
      return;
    }
    if (!container) return;
    if (!container.dataset.csfxPad) { container.style.paddingBottom = '64px'; container.dataset.csfxPad = '1'; }

    // 2) Con tasa válida, pintar Subtotal (Bs.) inline + Total Final (Bs.)

    container.querySelectorAll('.csfx-cart-row, .csfx-total-row[data-csfx="total-final"]').forEach(function (n) { n.remove(); });
    var subRow = findTotalsRow(container, /(^|\s)subtotal(\s|$)/i);

    var discRow = findTotalsRow(container, /descuento|discount/i);
    if (discRow) {
      if (!discRow.dataset.csfxDiscGuard) {
        discRow.dataset.csfxDiscGuard = '1';
        var guardHandler = function (ev) {
          if (csfxCustomModalState && csfxCustomModalState.authorized) return;
          if (ev && ev.target && typeof ev.target.closest === 'function') {
            var bypassRemove = ev.target.closest(CSFX_DISCOUNT_REMOVE_BYPASS_SELECTOR);
            if (bypassRemove) return;
          }
          if (ev && ev.type === 'pointerdown') return;
          ev.preventDefault();
          ev.stopPropagation();
          try { csfxShowAuthWidget(); } catch (_errShowAuth) {}
        };
        ['click', 'mousedown', 'touchstart'].forEach(function (evt) {
          discRow.addEventListener(evt, guardHandler, true);
        });
      }
      try {
        var removeSelectors = CSFX_DISCOUNT_REMOVE_BYPASS_SELECTOR;
        var removeNodes = discRow.querySelectorAll(removeSelectors);
        var marked = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
        var markNode = function (btn) {
          if (!btn) return;
          if (marked && marked.has(btn)) return;
          if (marked) marked.add(btn);
          btn.setAttribute(CSFX_DISCOUNT_REMOVE_ATTR, '1');
          var parent = btn.parentElement;
          while (parent && parent !== discRow && parent !== document) {
            if (parent.hasAttribute && parent.hasAttribute(CSFX_DISCOUNT_REMOVE_ATTR)) break;
            var shouldMarkParent = false;
            if (parent.matches) {
              try {
                shouldMarkParent = parent.matches('[mat-icon-button], .mat-icon-button, [data-action="remove"], [data-role="remove"], .remove, .op-remove-discount, [class*="delete"], [class*="Delete"], [class*="trash"], [class*="Trash"]');
              } catch (_errMatchParent) {
                shouldMarkParent = false;
              }
            }
            if (!shouldMarkParent) break;
            parent.setAttribute(CSFX_DISCOUNT_REMOVE_ATTR, '1');
            parent = parent.parentElement;
          }
          var inner = btn.querySelectorAll('*');
          for (var k = 0; k < inner.length; k++) {
            inner[k].setAttribute(CSFX_DISCOUNT_REMOVE_ATTR, '1');
          }
        };
        removeNodes.forEach(function (btn) {
          markNode(btn);
        });
        var fallbackNodes = discRow.querySelectorAll('button, [role="button"], [mat-icon-button], .mat-icon');
        fallbackNodes.forEach(function (node) {
          if (!node || node.hasAttribute(CSFX_DISCOUNT_REMOVE_ATTR)) return;
          var label = '';
          try {
            label = (node.getAttribute('aria-label') || '').toLowerCase();
          } catch (_errLabel) {}
          var text = '';
          try {
            text = (node.textContent || '').toLowerCase();
          } catch (_errText) {}
          if (!label && !text) return;
          if (label.indexOf('eliminar') !== -1 || label.indexOf('remove') !== -1 || label.indexOf('delete') !== -1 || label.indexOf('trash') !== -1 ||
            text.indexOf('eliminar') !== -1 || text.indexOf('remove') !== -1 || text.indexOf('delete') !== -1 || text.indexOf('trash') !== -1 ||
            text === 'delete' || text === 'remove' || text === 'delete_forever' || text === 'delete_outline') {
            markNode(node);
          }
        });
      } catch (_errMarkRemove) {}
      if (csfxCustomModalState && csfxCustomModalState.authorized) {
        discRow.classList.remove('csfx-guarded');
      } else {
        discRow.classList.add('csfx-guarded');
      }
    }
  var taxRow = findTotalsRow(container, /impuesto|tax/i);
    var totRow = findTotalsRow(container, /^total(?!.*\(bs\))/i);


    var usdS = readUsdFromRow(subRow);
    var readDiscount = readUsdFromRow(discRow);
    var usdD = Math.abs(readDiscount || 0);
    if (!discRow) {
      window.__CSFX_LAST_DISCOUNT_USD = 0;
    } else if (!isNaN(readDiscount)) {
      if (usdD > 0.0001) {
        window.__CSFX_LAST_DISCOUNT_USD = usdD;
      } else {
        window.__CSFX_LAST_DISCOUNT_USD = 0;
      }
    }
    var usdI = readUsdFromRow(taxRow);
    var usdT = readUsdFromRow(totRow);

    
    if (isNaN(usdT) && !isNaN(usdS)) usdT = usdS - usdD + (isNaN(usdI) ? 0 : usdI);
    if (isNaN(usdT)) {
      var btnUsd = readCheckoutUSD();
      if (!isNaN(btnUsd)) usdT = btnUsd;
    }
  
    if (isNaN(usdS) && !isNaN(usdT)) usdS = usdT + usdD - (isNaN(usdI) ? 0 : usdI);
    if (isNaN(usdS)) {
      var btnUsd2 = readCheckoutUSD();
      if (!isNaN(btnUsd2)) usdS = btnUsd2 + usdD - usdI;
    }
   


    var legacy = container.querySelector('[data-csfx="summary-bs"]');
    if (legacy) legacy.remove();
    var subValEl = pickValueElement(subRow);
    if (subValEl) {
      var inline = subValEl.querySelector('[data-csfx="sub-bs-inline"]');
      if (!inline) {
        inline = document.createElement('div');
        inline.dataset.csfx = 'sub-bs-inline';
        inline.className = 'csfx-sub-bs-inline';
        subValEl.appendChild(inline);
      }
      if (!isNaN(usdS)) inline.textContent = fmtBs(usd2bs(usdS));
    }



    if (discRow) {
  
      var totA = anchorRow(totRow);
      if (totA) totA.remove();
      var after = anchorRow(discRow);
      var rowFinal = document.createElement('div');
      rowFinal.className = 'csfx-total-row';
      rowFinal.dataset.csfx = 'total-final';
      rowFinal.innerHTML = '<span>Total Final (Bs.)</span><span class="csfx-amount" data-csfx="tot-bs"></span>';
      if (after) after.insertAdjacentElement('afterend', rowFinal);
      var totSp = rowFinal.querySelector('[data-csfx="tot-bs"]');
 
      var usdFinal = !isNaN(usdS) ? (usdS - usdD + (isNaN(usdI) ? 0 : usdI)) : NaN;
      if (isNaN(usdFinal) && !isNaN(usdT)) usdFinal = usdT;

      if (isNaN(usdFinal)) {
        var b = readCheckoutUSD();
        if (!isNaN(b)) usdFinal = b;
      }
      if (!isNaN(usdFinal) && usdFinal < 0) usdFinal = 0;
             if (totSp && !isNaN(usdFinal)) totSp.textContent = fmtBs(usd2bs(usdFinal));

    }
    if (!isNaN(usdS)) window.__CSFX_SUBTOTAL_USD = usdS;
    if (!isNaN(usdT)) window.__CSFX_TOTAL_USD = usdT;
    if (!isNaN(usdS) && isNaN(usdT)) window.__CSFX_TOTAL_USD = usdS - usdD + (isNaN(usdI) ? 0 : usdI);
    if (typeof window.__CSFX_TOTAL_USD === 'undefined' && !isNaN(readCheckoutUSD())) {
      window.__CSFX_TOTAL_USD = readCheckoutUSD();
    }
    positionBadge();

  }
  // --- Conversor de timestamps a Date robusto ---
  function parseUpdated(u){
    if (!u) return null;
    if (typeof u === 'number') {
      // epoch en segundos → milisegundos; si ya viene en ms, no multiplicar
      return new Date(u < 1e12 ? u * 1000 : u);
    }
    if (typeof u === 'string') {
      var d1 = new Date(u);
      if (!isNaN(d1.getTime())) return d1;
      var n = parseFloat(u);
      if (!isNaN(n)) return new Date(n < 1e12 ? n * 1000 : n);
    }
    return null;
  }

  function buildInfoText() {
    var t = '<strong>BCV:</strong> ' + (FX.rate ? FX.rate.toFixed(FX.decimals) : '(sin datos)');
    var d = parseUpdated(FX.updated);
    if (d) {
      var hh;
      try {
        hh = d.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', hour12: true });
      } catch (e) {
        hh = d.getHours() + ':' + ('' + d.getMinutes()).padStart(2, '0');
      }
      t += ' · <strong>Act.:</strong> ' + hh;
    }
    if (FX.disc && FX.disc.active && FX.disc.percent > 0) {
      t += ' · <strong>Desc:</strong> ' + FX.disc.percent + '%';
    }
    return t;
  }

  function csfxUpdateBadgeHandle(badge) {
    if (!badge) return;
    var handle = badge.querySelector('.csfx-badge-handle');
    if (!handle) return;
    var status = csfxConnectionStatus.status || 'unknown';
    badge.dataset.csfxStatus = status;
    var infoHtml = buildInfoText();
    var rateText = '--';
    try { if (FX.rate) rateText = Number(FX.rate).toFixed(FX.decimals); } catch (_errRate) {}
    var icon = csfxCurrentBadgeIcon();
    handle.innerHTML = ''
      + '<div class="csfx-badge-handle-main">'
      +   '<div class="csfx-badge-handle-row"><span class="csfx-badge-icon">' + icon + '</span><span class="csfx-badge-handle-title">Referencia de tasa y descuento</span></div>'
      +   '<div class="csfx-badge-handle-sub">' + infoHtml + '</div>'
      + '</div>'
      + '<div class="csfx-badge-handle-compact"><span class="csfx-badge-icon">' + icon + '</span><span class="csfx-badge-label">' + rateText + '</span></div>';
  }

  /**
   * Crea o actualiza la insignia (badge) colapsable que muestra la tasa y hora.
   * Si FX.badge es false, elimina cualquier badge existente.
   */
  function ensureBadge() {
    if (!FX.badge) {
      var old = document.querySelector('.csfx-badge');
      if (old) old.remove();
      return;
    }
    var badge = document.querySelector('.csfx-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'csfx-badge';
      badge.dataset.csfxStatus = csfxConnectionStatus.status || 'unknown';
      var handle = document.createElement('div');
      handle.className = 'csfx-badge-handle';
      handle.innerHTML = '';
      var content = document.createElement('div');
      content.className = 'csfx-badge-content';
      badge.appendChild(handle);
      badge.appendChild(content);
      document.body.appendChild(badge);
    } else {
      badge.dataset.csfxStatus = csfxConnectionStatus.status || 'unknown';
    }
    var handle = badge.querySelector('.csfx-badge-handle');
    if (handle && !handle.dataset.csfxBound) {
      handle.dataset.csfxBound = '1';
      handle.addEventListener('click', function (e) {
        e.stopPropagation();
        badge.classList.toggle('open');
        if (badge.classList.contains('open')) {
          csfxRenderBadgeContent(badge);
        }
      });
    }
    if (!badge.dataset.csfxBadgeBound) {
      badge.dataset.csfxBadgeBound = '1';
      badge.addEventListener('click', function (ev) {
        if (ev.target.closest('.csfx-badge-content')) return;
        if (!badge.classList.contains('open')) {
          badge.classList.add('open');
          csfxRenderBadgeContent(badge);
        }
        ev.stopPropagation();
      });
    }
    csfxUpdateBadgeHandle(badge);
    csfxRenderBadgeContent(badge);
  }

  if (typeof window !== 'undefined' && !window.__CSFX_BADGE_OUTSIDE__) {
    window.__CSFX_BADGE_OUTSIDE__ = true;
    document.addEventListener('click', function (ev) {
      var badge = document.querySelector('.csfx-badge');
      if (!badge || !badge.classList.contains('open')) return;
      if (badge.contains(ev.target)) return;
      if (csfxCustomModalState && csfxCustomModalState.open) return;
      badge.classList.remove('open');
    });
  }


  /**
   * Decora el modal de método de pago, añadiendo chips Bs en el encabezado de pagado/total,
   * el campo de importe a pagar y los botones de sugerencia de importes. Se basa en la
   * presencia de role="dialog" o clases de Angular Material.
   */

  // csfx: inicio descuento dual
  function csfxDiscountDecimal() {
    var pct = Number(FX && FX.disc && FX.disc.percent ? FX.disc.percent : 0);
    if (!isFinite(pct)) pct = 0;
    if (pct > 1) pct = pct / 100;
    if (pct < 0) pct = 0;
    if (pct >= 0.995) pct = 0.995;
    return pct;
  }

  function csfxToNumber(val) {
    if (val === null || val === undefined || val === '') return NaN;
    if (typeof val === 'number') return val;
    if (typeof val === 'string') {
      var parsed = parsePrice(val);
      if (!isNaN(parsed)) return parsed;
      var sanitized = parseFloat(val.replace(/[^0-9\-\.,]/g, '').replace(/,/g, '.'));
      return isNaN(sanitized) ? NaN : sanitized;
    }
    if (typeof val === 'object' && val) {
      if (typeof val.value !== 'undefined') return csfxToNumber(val.value);
    }
    return NaN;
  }

  function csfxReadCurrentDiscountUSD() {
    var container = findTotalsContainer();
    var amount = NaN;
    if (container) {
      var row = findTotalsRow(container, /descuento|discount/i);
      amount = Math.abs(readUsdFromRow(row));
    }
    if (!isNaN(amount) && amount > 0.0001) {
      window.__CSFX_LAST_DISCOUNT_USD = amount;
      return amount;
    }
    var cached = Number(window.__CSFX_LAST_DISCOUNT_USD || 0);
    return isFinite(cached) ? cached : 0;
  }

  function csfxHasGlobalDiscount(snapshot) {
    if (snapshot && typeof snapshot === 'object') {
      if (snapshot.applied && snapshot.discountAmount > 0.0001) return true;
      var metaDisc = snapshot.meta ? csfxToNumber(snapshot.meta.csfx_discount_value) : NaN;
      if (!isNaN(metaDisc) && metaDisc > 0.0001) return true;
    }
    var domDisc = csfxReadCurrentDiscountUSD();
    return domDisc > 0.0001;
  }

  function csfxNormalizeCartCandidate(candidate) {
    if (!candidate) return null;
    if (typeof candidate === 'string') {
      try {
        var parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object') return csfxNormalizeCartCandidate(parsed);
      } catch (_err) {}
      return null;
    }
    if (typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    if (candidate.cart && typeof candidate.cart === 'object') return candidate.cart;
    if (candidate.cart_data && typeof candidate.cart_data === 'object') return candidate.cart_data;
    if (candidate.data && typeof candidate.data === 'object') return candidate.data;
    return candidate;
  }

  function csfxLocateCartDetailed() {
    var debug = { tried: [] };
    var svc = csfxResolveCartServiceCompat(debug);
    var best = null;
    function bruteForceWindowCart() {
      if (typeof window === 'undefined') return null;
      var keys = Object.keys(window).filter(function (k) {
        return /(cart|op_cart|cartService|currentCart|posCart|op_cache_cart)/i.test(k);
      });
      function isItemsArray(arr) {
        if (!Array.isArray(arr) || !arr.length) return false;
        return arr.some(function (it) {
          return it && typeof it === 'object' && (typeof it.price !== 'undefined' || typeof it.base_price !== 'undefined' || typeof it.price_incl_tax !== 'undefined' || typeof it.price_incl !== 'undefined') && (typeof it.qty !== 'undefined' || typeof it.quantity !== 'undefined');
        });
      }
      function buildCandidate(items, sourceLabel) {
        return {
          cart: { items: items },
          source: sourceLabel,
          itemsCount: items.length
        };
      }
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var value = window[k];
        if (!value) continue;
        if (isItemsArray(value)) {
          return buildCandidate(value, 'window.' + k);
        }
        if (value.cart) {
          var cartVal = value.cart.items ? value.cart.items : value.cart;
          if (isItemsArray(cartVal)) {
            return buildCandidate(cartVal, 'window.' + k + '.cart');
          }
        }
        if (value.items && isItemsArray(value.items)) {
          return buildCandidate(value.items, 'window.' + k + '.items');
        }
      }
      return null;
    }

    function noteAsyncPromise(promise, sourceLabel) {
      if (!promise || typeof promise.then !== 'function') return;
      debug.tried.push({ source: sourceLabel, hit: false, async: true });
      promise.then(function (payload) {
        var normalized = csfxNormalizeCartCandidate(payload);
        if (!normalized) return;
        if (csfxCountCartItems(normalized) > 0) {
          csfxRememberAsyncCart(normalized, sourceLabel);
        }
      }).catch(function () {});
    }

    function evaluate(value, source) {
      if (typeof source !== 'string') source = 'cart.unknown';
      if (value === undefined && debug) {
        debug.tried.push({ source: source, hit: false, type: 'undefined' });
        return null;
      }
      var candidate = csfxInspectCandidate(value, source, svc, debug);
      best = csfxBetterCandidate(best, candidate);
      csfxLogCartProbe(source, candidate);
      if (candidate && candidate.cart && candidate.itemsCount > 0) {
        candidate.debug = debug;
        return candidate;
      }
      var deep = csfxDeepFindCart(value, 0, null);
      if (deep && deep !== value) {
        var deepCandidate = csfxInspectCandidate(deep, source + '(deep)', svc, debug);
        best = csfxBetterCandidate(best, deepCandidate);
        csfxLogCartProbe(source + '(deep)', deepCandidate);
        if (deepCandidate && deepCandidate.cart && deepCandidate.itemsCount > 0) {
          deepCandidate.debug = debug;
          return deepCandidate;
        }
      }
      return null;
    }

    if (svc && typeof svc === 'object') {
      try {
        if (typeof svc.getCurrentCart === 'function') {
          var current = svc.getCurrentCart();
          if (current && typeof current.then === 'function') {
            noteAsyncPromise(current, 'cartService.getCurrentCart()');
          } else {
            var currentCandidate = evaluate(current, 'cartService.getCurrentCart()');
            if (currentCandidate) return currentCandidate;
          }
        }
      } catch (errCurrent) {
        debug.tried.push({ source: 'cartService.getCurrentCart()', error: String(errCurrent) });
      }
      try {
        if (typeof svc.getCart === 'function') {
          var legacy = svc.getCart();
          if (legacy && typeof legacy.then === 'function') {
            noteAsyncPromise(legacy, 'cartService.getCart()');
          } else {
            var legacyCandidate = evaluate(legacy, 'cartService.getCart()');
            if (legacyCandidate) return legacyCandidate;
          }
        }
      } catch (errLegacy) {
        debug.tried.push({ source: 'cartService.getCart()', error: String(errLegacy) });
      }
      var svcProps = [
        { key: 'cart', label: 'cartService.cart' },
        { key: '_cart', label: 'cartService._cart' },
        { key: 'cart_data', label: 'cartService.cart_data' },
        { key: 'cartData', label: 'cartService.cartData' },
        { key: 'activeCart', label: 'cartService.activeCart' }
      ];
      for (var p = 0; p < svcProps.length; p++) {
        var prop = svcProps[p];
        if (!prop) continue;
        var value = svc[prop.key];
        if (typeof value === 'undefined') continue;
        var propCandidate = evaluate(value, prop.label);
        if (propCandidate) return propCandidate;
      }
      var svcDeep = csfxDeepFindCart(svc, 0, null);
      if (svcDeep && svcDeep !== svc) {
        var deepSvcCandidate = evaluate(svcDeep, 'cartService(deep)');
        if (deepSvcCandidate) return deepSvcCandidate;
      }
    }

    var asyncCart = csfxGetCachedAsyncCart();
    if (asyncCart) {
      var asyncCandidate = evaluate(asyncCart, 'cart.async-cache');
      if (asyncCandidate) return asyncCandidate;
    }

    var brute = bruteForceWindowCart();
    if (brute) {
      debug.tried.push({ source: brute.source || 'window.scan', hit: true, brute: true });
      brute.debug = debug;
      return brute;
    }

    var localCarts = csfxEnumerateStorageCarts(debug);
    if (Array.isArray(localCarts) && localCarts.length) {
      var selected = csfxSelectActiveCart(localCarts, debug);
      if (selected && selected.cart) {
        selected.debug = debug;
        return selected;
      }
      localCarts.forEach(function (entry) {
        if (!entry) return;
        best = csfxBetterCandidate(best, entry);
      });
    }

    var indexedCarts = csfxEnumerateIndexedDBCarts(debug);
    if (Array.isArray(indexedCarts) && indexedCarts.length) {
      var selectedIndexed = csfxSelectActiveCart(indexedCarts, debug);
      if (selectedIndexed && selectedIndexed.cart) {
        selectedIndexed.debug = debug;
        return selectedIndexed;
      }
      indexedCarts.forEach(function (entry) {
        if (!entry) return;
        best = csfxBetterCandidate(best, entry);
      });
    }

    if (csfxAsyncCartDebug) {
      debug.asyncCart = Object.assign({}, csfxAsyncCartDebug);
    }

    if (best && best.cart) {
      best.debug = debug;
      return best;
    }

    return { cart: null, source: null, debug: debug, cartService: svc || null, itemsCount: 0 };
  }

  function csfxLoadStoredCart() {
    var carts = csfxEnumerateStorageCarts(null) || [];
    var idbCarts = csfxEnumerateIndexedDBCarts(null) || [];
    var combined = carts.concat(idbCarts);
    if (!combined.length) return null;
    var selected = csfxSelectActiveCart(combined, null);
    if (selected && selected.cart) return selected.cart;
    var first = combined[0];
    return first && first.cart ? first.cart : null;
  }

  function csfxLocateCart() {
    return csfxLocateCartDetailed().cart;
  }

  function csfxExtractMetaMap(cart) {
    var meta = {};
    function ingest(list) {
      if (!list || typeof list.forEach !== 'function') return;
      list.forEach(function (item) {
        if (!item) return;
        var key = item.key || item.name || item.code;
        if (!key) return;
        var value = typeof item.value !== 'undefined' ? item.value : (typeof item.val !== 'undefined' ? item.val : null);
        meta[key] = value;
      });
    }
    if (cart) {
      ingest(cart.meta_data);
      ingest(cart.metaData);
      [
        'csfx_usd_paid',
        'csfx_discount_pct',
        'csfx_discount_value',
        'csfx_discount_note',
        'csfx_base_total',
        'csfx_dual_mode',
        'csfx_dual_usd_direct',
        'csfx_dual_usd_bs',
        'csfx_dual_bs_amount',
        'csfx_dual_total_usd',
        'csfx_dual_discountable_gross',
        'csfx_dual_non_discount_gross',
        'csfx_dual_missing_usd',
        'csfx_dual_missing_bs',
        'csfx_dual_change_usd',
        'csfx_dual_change_bs',
        'csfx_dual_rate',
        'csfx_auth_supervisor_id',
        'csfx_auth_supervisor_name',
        'csfx_auth_supervisor_email',
        'csfx_auth_supervisor_source',
        'csfx_auth_supervisor_method',
        'csfx_auth_supervisor_ref',
        'csfx_auth_supervisor_time',
        'csfx_auth_supervisor_expires',
        'csfx_auth_session_id'
      ].forEach(function (k) {
        if (typeof cart[k] !== 'undefined') meta[k] = cart[k];
      });
    }
    return meta;
  }

  function csfxGetCartSnapshot(context) {
    context = context || {};
    var located = csfxLocateCartDetailed();
    var cart = located.cart;
    var cartSource = located.source;
    var cartService = located.cartService;
    var cartDebug = located.debug && typeof located.debug === 'object' ? located.debug : {};

    if (cart && OPCompat && typeof OPCompat.normalizeCart === 'function') {
      try {
        cart = OPCompat.normalizeCart(cart);
        located.cart = cart;
      } catch (errNorm) {
        cartDebug.compatNormalizeError = (errNorm && errNorm.message) || true;
      }
    }

    var compatTotals = null;
    if (cart && OPCompat && typeof OPCompat.readTotals === 'function') {
      try {
        compatTotals = OPCompat.readTotals(cart) || null;
      } catch (errTotals) {
        cartDebug.compatTotalsError = (errTotals && errTotals.message) || true;
        compatTotals = null;
      }
    }
    cartDebug.compatTotals = compatTotals;
    cartDebug.cartSource = cartSource;
    cartDebug.totalsSource = compatTotals ? 'compat' : 'legacy';

    if (cart) {
      csfxEnrichCartWithSupervisor(cart);
    }
    var meta = csfxExtractMetaMap(cart);

    var subtotalCandidates = [];
    var discountCandidates = [];
    var taxCandidates = [];
    var totalCandidates = [];

    if (compatTotals && typeof compatTotals === 'object') {
      subtotalCandidates.push(compatTotals.baseSubtotal, compatTotals.subtotal);
      discountCandidates.push(compatTotals.discount);
      taxCandidates.push(compatTotals.tax);
      totalCandidates.push(compatTotals.grand, compatTotals.total);
    }

    if (meta && typeof meta.csfx_discount_value !== 'undefined') {
      discountCandidates.unshift(meta.csfx_discount_value);
    }

    if (cart) {
      subtotalCandidates.push(cart.base_subtotal, cart.subtotal, cart.totals && cart.totals.base_subtotal, cart.totals && cart.totals.subtotal);
      discountCandidates.push(
        cart.final_discount_amount,
        cart.discount_final_amount,
        cart.discount_amount,
        cart.discount
      );
      taxCandidates.push(
        cart.totals && cart.totals.tax,
        cart.totals && cart.totals.tax_amount,
        cart.tax_amount,
        cart.total_tax
      );
      totalCandidates.push(
        cart.base_grand_total,
        cart.baseGrandTotal,
        cart.grand_total,
        cart.grandTotal,
        cart.total_due,
        cart.totalDue,
        cart.total
      );
    }

    if (typeof context.totalUSD !== 'undefined') {
      totalCandidates.push(context.totalUSD);
    }

    function pickCandidate(values, allowNegative) {
      for (var i = 0; i < values.length; i++) {
        var candidate = csfxToNumber(values[i]);
        if (isNaN(candidate)) continue;
        if (!allowNegative && candidate < 0) continue;
        return candidate;
      }
      return NaN;
    }

    var total = pickCandidate(totalCandidates, false);
    if (isNaN(total) && typeof window.__CSFX_TOTAL_USD !== 'undefined') {
      var gTotal = csfxToNumber(window.__CSFX_TOTAL_USD);
      if (!isNaN(gTotal)) total = gTotal;
    }

    var discountAmount = pickCandidate(discountCandidates, true);
    if (isNaN(discountAmount)) {
      discountAmount = 0;
    } else {
      discountAmount = Math.abs(discountAmount);
    }
    var discountValueMeta = csfxToNumber(meta.csfx_discount_value);
    if (!isNaN(discountValueMeta) && discountValueMeta > 0) {
      discountAmount = round(Math.abs(discountValueMeta), FX.decimals);
    }

    var liveTotal = typeof context.totalUSD !== 'undefined' ? context.totalUSD : null;
    var baseTotal = pickCandidate([
      liveTotal,
      cart && cart.base_subtotal,
      cart && cart.subtotal,
      cart && cart.totals && cart.totals.base_subtotal,
      compatTotals && compatTotals.baseSubtotal,
      compatTotals && compatTotals.subtotal,
      cart && cart.csfx_base_total,
      meta && meta.csfx_base_total
    ], false);

    if (isNaN(baseTotal) || baseTotal <= 0) {
      var metaBase = csfxToNumber(meta.csfx_base_total);
      if (!isNaN(metaBase) && metaBase > 0) {
        baseTotal = metaBase;
      }
    }

    var totalHint = !isNaN(total) ? total : csfxToNumber(liveTotal);
    var totalTolerance = Math.max(0.01, Math.pow(10, -(((FX && FX.decimals) || 2))));
    if (isFinite(totalHint) && totalHint > 0) {
      var diffRatio = (!isFinite(baseTotal) || baseTotal <= 0)
        ? Infinity
        : Math.abs(baseTotal - totalHint) / Math.max(totalHint, 1);
      if (diffRatio > 0.02 || !isFinite(baseTotal) || baseTotal <= 0) {
        baseTotal = totalHint;
      }
    }

    if ((isNaN(baseTotal) || baseTotal <= 0) && !isNaN(total)) {
      var taxAmount = pickCandidate(taxCandidates, true);
      var taxCalc = isNaN(taxAmount) ? 0 : taxAmount;
      baseTotal = total + discountAmount - taxCalc;
    }

    if ((isNaN(baseTotal) || baseTotal <= 0) && typeof window.__CSFX_SUBTOTAL_USD !== 'undefined') {
      var gBase = csfxToNumber(window.__CSFX_SUBTOTAL_USD);
      if (!isNaN(gBase) && gBase > 0) baseTotal = gBase;
    }
    if ((isNaN(baseTotal) || baseTotal <= 0) && !isNaN(total)) {
      baseTotal = total;
    }
    if ((isNaN(baseTotal) || baseTotal <= 0) && FX && FX.rate) {
      var bsSub = readVisibleSubtotalBs();
      if (isFinite(bsSub) && bsSub > 0) {
        baseTotal = bsSub / FX.rate;
      }
    }

    // Recalcular base desde los ítems si detectamos que el snapshot trae un subtotal obsoleto
    var itemsGross = 0;
    if (cart && Array.isArray(cart.items)) {
      cart.items.forEach(function (it) {
        var qty = csfxToNumber(it.qty || it.quantity || 1);
        if (!isFinite(qty) || qty <= 0) qty = 1;
        var price = [
          it.price_incl_tax,
          it.price_incl,
          it.base_price,
          it.price,
          it.base_price_incl_tax,
          it.final_price
        ].map(csfxToNumber).find(function (v) { return isFinite(v) && v > 0; });
        if (!isFinite(price) || price <= 0) price = 0;
        itemsGross += price * qty;
      });
    }
    if (itemsGross > 0) {
      var delta = Math.abs(itemsGross - baseTotal);
      var drift = Math.max(1, itemsGross);
      if (!isFinite(baseTotal) || baseTotal <= 0 || (delta / drift) > 0.02) {
        baseTotal = itemsGross;
        // Al detectar deriva (cambio de carrito), reiniciamos la caché previa.
        window.__CSFX_LAST_BASE_USD = baseTotal;
      }
    } else if (itemsGross === 0 && (!cart || (cart.items || []).length === 0)) {
      window.__CSFX_LAST_BASE_USD = 0;
    }

    var usdPaid = csfxToNumber(meta.csfx_usd_paid);
    var discountPctMeta = meta.csfx_discount_pct != null ? Number(meta.csfx_discount_pct) : null;
    var applied = Math.abs(discountAmount) > 0.0001;
    var dualModeMeta = typeof meta.csfx_dual_mode === 'string' ? meta.csfx_dual_mode : '';
    var dualUsdDirectMeta = csfxToNumber(meta.csfx_dual_usd_direct);
    var dualUsdBsMeta = csfxToNumber(meta.csfx_dual_usd_bs);
    var dualBsAmountMeta = csfxToNumber(meta.csfx_dual_bs_amount);
    var dualTotalUsdMeta = csfxToNumber(meta.csfx_dual_total_usd);
    var dualDiscountableMeta = csfxToNumber(meta.csfx_dual_discountable_gross);
    var dualNonDiscountMeta = csfxToNumber(meta.csfx_dual_non_discount_gross);
    var dualMissingUsdMeta = csfxToNumber(meta.csfx_dual_missing_usd);
    var dualMissingBsMeta = csfxToNumber(meta.csfx_dual_missing_bs);
    var dualChangeUsdMeta = csfxToNumber(meta.csfx_dual_change_usd);
    var dualChangeBsMeta = csfxToNumber(meta.csfx_dual_change_bs);
    var dualRateMeta = csfxToNumber(meta.csfx_dual_rate);

    var snapshotResult = {
      cart: cart,
      cartService: cartService,
      cartSource: cartSource,
      cartDebug: cartDebug,
      meta: meta,
      totalUSD: isNaN(total) ? NaN : total,
      baseTotalUSD: isNaN(baseTotal) ? NaN : baseTotal,
      discountAmount: discountAmount,
      usdPaid: isNaN(usdPaid) ? 0 : usdPaid,
      dual: {
        mode: dualModeMeta || '',
        usdDirect: isNaN(dualUsdDirectMeta) ? 0 : dualUsdDirectMeta,
        usdFromBs: isNaN(dualUsdBsMeta) ? 0 : dualUsdBsMeta,
        bsAmount: isNaN(dualBsAmountMeta) ? 0 : dualBsAmountMeta,
        totalUsd: isNaN(dualTotalUsdMeta) ? 0 : dualTotalUsdMeta,
        discountableGross: isNaN(dualDiscountableMeta) ? 0 : dualDiscountableMeta,
        nonDiscountGross: isNaN(dualNonDiscountMeta) ? 0 : dualNonDiscountMeta,
        missingUsd: isNaN(dualMissingUsdMeta) ? 0 : dualMissingUsdMeta,
        missingBs: isNaN(dualMissingBsMeta) ? 0 : dualMissingBsMeta,
        changeUsd: isNaN(dualChangeUsdMeta) ? 0 : dualChangeUsdMeta,
        changeBs: isNaN(dualChangeBsMeta) ? 0 : dualChangeBsMeta,
        rate: isNaN(dualRateMeta) ? 0 : dualRateMeta
      },
      discountPct: discountPctMeta,
      applied: applied
    };
    if (!snapshotResult.applied && csfxHasGlobalDiscount(snapshotResult)) {
      snapshotResult.applied = true;
      if (snapshotResult.discountAmount <= 0.0001) {
        snapshotResult.discountAmount = csfxReadCurrentDiscountUSD();
      }
    }
    return snapshotResult;
  }

  function csfxComputeDual(baseTotal, usdNet, pct) {
    pct = pct || 0;
    if (!isFinite(baseTotal) || baseTotal <= 0) {
      return {
        netRequested: usdNet,
        netEffective: 0,
        grossCovered: 0,
        discount: 0,
        remainderUsd: 0,
        remainderBs: 0,
        trimmed: false,
        finalTotal: 0
      };
    }
    if (!isFinite(usdNet) || usdNet < 0) usdNet = 0;
    if (pct < 0) pct = 0;
    if (pct >= 0.995) pct = 0.995;
    var maxNet = baseTotal * (1 - pct);
    if (!isFinite(maxNet) || maxNet < 0) maxNet = 0;
    var effectiveNet = usdNet;
    if (effectiveNet > maxNet) effectiveNet = maxNet;
    var grossCovered = pct >= 0.999 ? effectiveNet : (effectiveNet === 0 ? 0 : effectiveNet / (1 - pct));
    if (!isFinite(grossCovered)) grossCovered = 0;
    if (grossCovered > baseTotal) grossCovered = baseTotal;
    var discount = grossCovered - effectiveNet;
    if (!isFinite(discount) || discount < 0) discount = 0;
    var remainderUsd = baseTotal - grossCovered;
    if (!isFinite(remainderUsd) || remainderUsd < 0) remainderUsd = 0;
    var finalTotal = baseTotal - discount;
    if (!isFinite(finalTotal) || finalTotal < 0) finalTotal = 0;
    return {
      netRequested: usdNet,
      netEffective: effectiveNet,
      grossCovered: grossCovered,
      discount: discount,
      remainderUsd: remainderUsd,
      remainderBs: usd2bs(remainderUsd),
      trimmed: usdNet > effectiveNet + 0.009,
      finalTotal: finalTotal
    };
  }

  function csfxDualState(panel) {
    if (!panel) {
      return { inputs: {}, ui: {} };
    }
    if (!panel.__csfxDual || typeof panel.__csfxDual !== 'object') {
      panel.__csfxDual = { inputs: {}, ui: {} };
    } else {
      if (!panel.__csfxDual.inputs) panel.__csfxDual.inputs = {};
      if (!panel.__csfxDual.ui) panel.__csfxDual.ui = {};
    }
    return panel.__csfxDual;
  }

  function csfxDualNormalizeValue(raw) {
    if (raw === undefined || raw === null) return NaN;
    var str = String(raw);
    if (!str) return NaN;
    str = str.replace(/,/g, '.');
    str = str.replace(/[^0-9\-\.]/g, '');
    if (!str) return NaN;
    var num = parseFloat(str);
    return isFinite(num) ? num : NaN;
  }

  function csfxDualParseInput(input) {
    if (!input) {
      return { value: 0, hasValue: false, raw: '' };
    }
    var raw = typeof input.value === 'string' ? input.value : '';
    if (raw && raw.indexOf(',') > -1) {
      var pos = input.selectionStart;
      raw = raw.replace(/,/g, '.');
      input.value = raw;
      if (typeof pos === 'number') {
        try { input.setSelectionRange(pos, pos); } catch (_errSel) {}
      }
    }
    var parsed = csfxDualNormalizeValue(raw);
    if (!isFinite(parsed) || parsed < 0) parsed = 0;
    return {
      value: parsed,
      hasValue: raw !== '',
      raw: raw
    };
  }

  function csfxDualMarkDirty(panel, input) {
    if (!panel || !panel.dataset) return;
    panel.dataset.csfxDirty = '1';
    if (input && input.dataset) input.dataset.csfxTouched = '1';
  }

  function csfxDualResetModeInputs(panel, targetMode, state){
    if (!panel) return;
    state = state || csfxDualState(panel);
    var inputs = state.inputs || {};
    function clearInput(input){
      if (!input) return;
      input.value = '';
      if (input.dataset) {
        if (input.dataset.csfxTouched !== undefined) {
          delete input.dataset.csfxTouched;
        }
        if (input.dataset.csfxManualBs !== undefined) {
          delete input.dataset.csfxManualBs;
        }
      }
    }
    if (targetMode === 'usd') {
      clearInput(inputs.bsUsd);
      clearInput(inputs.bsRaw);
    } else if (targetMode === 'bs') {
      clearInput(inputs.usd);
    }
    if (panel.dataset) {
      var resetKeys = [
        'csfxEntryMode',
        'csfxEntryUsd',
        'csfxEntryUsdFromBs',
        'csfxEntryBs',
        'csfxEntryTotal',
        'csfxEntryMissing',
        'csfxEntryChange',
        'csfxEntryRate',
        'csfxEntryDiscountable',
        'csfxEntryNonDiscount',
        'csfxCalcNet',
        'csfxCalcDiscount',
        'csfxCalcGross',
        'csfxCalcRemainder',
        'csfxSelectedSuggest'
      ];
      resetKeys.forEach(function(key){
        if (panel.dataset[key] !== undefined) delete panel.dataset[key];
      });
      if (panel.dataset.csfxDirty !== undefined) delete panel.dataset.csfxDirty;
      if (panel.dataset.csfxBsManualMode !== undefined) delete panel.dataset.csfxBsManualMode;
    }
  }

  function csfxDualSetMode(panel, mode, options) {
    if (!panel) return;
    var prevMode = panel.dataset ? panel.dataset.csfxMode : '';
    mode = mode || 'usd';
    panel.dataset.csfxMode = mode;
    if (prevMode && prevMode !== mode) {
      csfxDualResetModeInputs(panel, mode, csfxDualState(panel));
    }
    var tabs = panel.querySelectorAll('[data-csfx-mode-tab]');
    tabs.forEach(function (tab) {
      if (!tab) return;
      if (tab.dataset && tab.dataset.csfxModeTab === mode) {
        tab.classList.add('is-active');
        tab.setAttribute('aria-selected', 'true');
      } else {
        tab.classList.remove('is-active');
        tab.setAttribute('aria-selected', 'false');
      }
    });
    var forms = panel.querySelectorAll('[data-csfx-mode-form]');
    forms.forEach(function (form) {
      if (!form || !form.dataset) return;
      var isMatch = form.dataset.csfxModeForm === mode;
      form.setAttribute('data-active', isMatch ? 'true' : 'false');
      if (isMatch) {
        form.removeAttribute('hidden');
      } else {
        form.setAttribute('hidden', 'hidden');
      }
    });
    if (options && options.focus) {
      setTimeout(function () {
        try {
          var active = panel.querySelector('[data-csfx-mode-form="' + mode + '"] input');
          if (active) active.focus();
        } catch (_errFocusMode) {}
      }, 40);
    }
    if (!options || !options.silent) {
      csfxUpdateDualPanel(panel);
    }
  }

  function csfxDualReadEntry(panel, context) {
    context = context || {};
    var state = csfxDualState(panel);
    var mode = panel && panel.dataset ? panel.dataset.csfxMode : 'usd';
    if (!mode) mode = 'usd';
    var decimals = (FX && FX.decimals) || 2;
    var rate = Number(FX && FX.rate ? FX.rate : 0);
    if (!isFinite(rate)) rate = 0;
    var baseTotal = context && isFinite(context.baseTotal) ? context.baseTotal : NaN;
    var pct = context && isFinite(context.pct) ? context.pct : 0;
    if (pct < 0) pct = 0;
    if (pct >= 0.995) pct = 0.995;
    var entry = {
      mode: mode,
      rate: rate,
      decimals: decimals,
      usdDirect: 0,
      usdFromBs: 0,
      bsAmount: 0,
      totalUsd: 0,
      netRequested: 0,
      netForDiscount: 0,
      discountableGross: isFinite(baseTotal) ? Math.max(0, baseTotal) : 0,
      nonDiscountGross: 0,
      autoUsdDirect: false,
      errors: [],
      warnings: [],
      hasValue: false
    };
    var epsilonUsd = Math.pow(10, -(decimals + 1));
    var epsilonBs = Math.pow(10, -(((FX && FX.decimals) || 2) + 1));
    var inputs = state.inputs || {};

    function collectBsValue() {
      var info = { usd: 0, bs: 0, hasValue: false, rateMissing: false };
      var usdInput = inputs.bsUsd;
      var bsInput = inputs.bsRaw;
      if (!usdInput && !bsInput) return info;
      var usdParsed = csfxDualParseInput(usdInput);
      var bsParsed = csfxDualParseInput(bsInput);
      if (usdParsed.hasValue || bsParsed.hasValue) info.hasValue = true;
      var manualBs = NaN;
      if (usdInput && usdInput.dataset && typeof usdInput.dataset.csfxManualBs !== 'undefined') {
        manualBs = csfxToNumber(usdInput.dataset.csfxManualBs);
      }
      if (bsParsed.hasValue && bsParsed.value > 0) {
        if (rate > 0) {
          info.bs = round(bsParsed.value, FX.decimals);
          info.usd = round(info.bs / rate, decimals);
          if (usdInput) {
            try { usdInput.value = csfxFormatInputNumber(info.usd, decimals); } catch (_errUsdSet) {}
          }
          if (usdInput && usdInput.dataset) {
            usdInput.dataset.csfxManualBs = String(info.bs);
          }
        } else {
          info.rateMissing = true;
        }
      } else {
        info.usd = round(usdParsed.value, decimals);
        if (!isNaN(manualBs) && manualBs > 0) {
          info.bs = round(manualBs, FX.decimals);
          if (info.usd <= 0 && rate > 0) {
            info.usd = round(info.bs / rate, decimals);
            if (usdInput) {
              try { usdInput.value = csfxFormatInputNumber(info.usd, decimals); } catch (_errUsdMan) {}
            }
          }
        } else if (usdParsed.hasValue && usdParsed.raw && /[.,]/.test(usdParsed.raw)) {
          info.usd = usdParsed.value;
          if (rate > 0 && info.usd > 0) {
            info.bs = round(info.usd * rate, FX.decimals);
          }
        } else if (info.usd > 0 && rate > 0) {
          info.bs = round(info.usd * rate, FX.decimals);
          if (usdInput) {
            try { usdInput.value = csfxFormatInputNumber(info.usd, decimals); } catch (_errUsdCalc) {}
          }
        }
      }
      return info;
    }

    if (mode === 'usd') {
      var usdParsed = csfxDualParseInput(inputs.usd);
      if (usdParsed.hasValue) entry.hasValue = true;
      entry.usdDirect = round(usdParsed.value, decimals);
    } else {
      var bsInfo = collectBsValue();
      entry.usdFromBs = bsInfo.usd;
      entry.bsAmount = bsInfo.bs;
      var hasBsValue = (Math.abs(entry.usdFromBs) > epsilonUsd) || (Math.abs(entry.bsAmount) > epsilonBs);
      if (hasBsValue) entry.hasValue = true;
      if (bsInfo.rateMissing && entry.usdFromBs > epsilonUsd) {
        entry.errors.push('No hay tasa vigente para convertir los bolívares.');
      }
      mode = 'bs';
      panel.dataset.csfxMode = 'bs';
      entry.mode = 'bs';
    }

    var discountFactor = (pct > 0 && pct < 1) ? (1 - pct) : (pct >= 1 ? 0 : 1);
    var nonDiscountGross = 0;
    if (!isFinite(baseTotal) || baseTotal <= 0) {
      entry.discountableGross = 0;
      entry.nonDiscountGross = 0;
    } else {
      if (discountFactor > 0) {
        nonDiscountGross = entry.usdFromBs / discountFactor;
      } else {
        nonDiscountGross = entry.usdFromBs;
      }
      if (!isFinite(nonDiscountGross) || nonDiscountGross < 0) nonDiscountGross = 0;
      if (nonDiscountGross > baseTotal) nonDiscountGross = baseTotal;
      entry.nonDiscountGross = round(nonDiscountGross, decimals);
      entry.discountableGross = Math.max(0, baseTotal - entry.nonDiscountGross);
    }

    if (mode === 'bs') {
      var hasBsValue = (Math.abs(entry.usdFromBs) > epsilonUsd) || (Math.abs(entry.bsAmount) > epsilonBs);
      entry.autoUsdDirect = hasBsValue && entry.discountableGross > epsilonUsd;
      if (hasBsValue) {
        if (!isFinite(baseTotal) || baseTotal <= 0) {
          if (!entry.errors.length) entry.errors.push('Sin total disponible para calcular el resto.');
        }
        if (entry.autoUsdDirect && discountFactor > 0) {
          entry.usdDirect = round(entry.discountableGross * discountFactor, decimals);
        } else {
          entry.usdDirect = 0;
        }
        entry.hasValue = true;
      } else {
        entry.autoUsdDirect = false;
        entry.usdDirect = 0;
      }
    }

    entry.totalUsd = round(entry.usdDirect + entry.usdFromBs, decimals);
    entry.netForDiscount = entry.usdDirect;
    entry.netRequested = entry.netForDiscount;
    return entry;
  }

  function csfxSanitizeMetaList(list) {
    if (!list || typeof list.filter !== 'function') return [];
    return list.filter(function (item) {
      if (!item) return false;
      var key = item.key || item.name || item.code;
      return !!key;
    });
  }

  function csfxNormalizeAdditionInfoItem(entry) {
    if (!entry || typeof entry !== 'object') return null;
    var label = entry.label;
    if (typeof label !== 'string' || label.trim() === '') return null;
    var value = entry.value;
    if (value === null || typeof value === 'undefined') {
      value = '';
    } else if (typeof value !== 'string') {
      value = String(value);
    }
    return { label: label, value: value };
  }

  function csfxApplySupervisorAdditionInfo(targetCart, noteMessage) {
    if (!targetCart || typeof targetCart !== 'object') return;
    var sourceList = [];
    if (Array.isArray(targetCart.addition_information)) {
      sourceList = targetCart.addition_information;
    } else if (Array.isArray(targetCart.additionInformation)) {
      sourceList = targetCart.additionInformation;
    }
    var preserved = [];
    for (var i = 0; i < sourceList.length; i++) {
      var normalized = csfxNormalizeAdditionInfoItem(sourceList[i]);
      if (!normalized) continue;
      if (normalized.label === CSFX_SUPERVISOR_INFO_LABEL) continue;
      preserved.push(normalized);
    }
    if (noteMessage) {
      preserved.push({ label: CSFX_SUPERVISOR_INFO_LABEL, value: noteMessage });
    }
    if (preserved.length) {
      targetCart.addition_information = preserved;
      targetCart.additionInformation = preserved.slice();
    } else {
      delete targetCart.addition_information;
      delete targetCart.additionInformation;
    }
  }

  function csfxEnrichCartWithSupervisor(targetCart) {
    if (!targetCart || typeof targetCart !== 'object') return;
    var base = Array.isArray(targetCart.meta_data) ? targetCart.meta_data : (Array.isArray(targetCart.metaData) ? targetCart.metaData : []);
    var meta = [];
    if (Array.isArray(base)) {
      base.forEach(function (item) {
        if (!item) return;
        var key = item.key || item.name || item.code;
        if (!key) {
          meta.push(item);
          return;
        }
        if (CSFX_SUPERVISOR_META_KEYS.indexOf(key) !== -1) return;
        if (key.indexOf('csfx_auth_supervisor_') === 0) return;
        meta.push(item);
      });
    }
    var supervisor = csfxGetLastSupervisor(false);
    var pushMeta = function (key, value) {
      if (value === null || typeof value === 'undefined') return;
      var normalized = value;
      if (typeof normalized === 'number') {
        if (!isFinite(normalized)) return;
        normalized = normalized.toString();
      } else if (typeof normalized === 'boolean') {
        normalized = normalized ? '1' : '0';
      }
      if (typeof normalized === 'string') {
        if (normalized.trim() === '') return;
      }
      meta.push({ key: key, value: normalized });
    };
    var noteMessage = null;
    if (supervisor && typeof supervisor === 'object') {
      pushMeta('csfx_auth_supervisor_id', typeof supervisor.id !== 'undefined' ? supervisor.id : '');
      pushMeta('csfx_auth_supervisor_name', supervisor.name || '');
      pushMeta('csfx_auth_supervisor_email', supervisor.email || '');
      pushMeta('csfx_auth_supervisor_source', supervisor.via || supervisor.source || '');
      pushMeta('csfx_auth_supervisor_method', supervisor.method || '');
      pushMeta('csfx_auth_supervisor_ref', supervisor.reference || '');
      pushMeta('csfx_auth_supervisor_time', supervisor.authorized_at || supervisor.authorizedAt || '');
      if (supervisor.expires_at || supervisor.expiresAt) {
        pushMeta('csfx_auth_supervisor_expires', supervisor.expires_at || supervisor.expiresAt);
      }
      if (supervisor.session_id) {
        pushMeta('csfx_auth_session_id', supervisor.session_id);
      }
      targetCart.csfx_auth_supervisor_id = typeof supervisor.id !== 'undefined' ? supervisor.id : '';
      targetCart.csfx_auth_supervisor_name = supervisor.name || '';
      var label = supervisor.name || supervisor.email || (supervisor.id ? ('ID ' + supervisor.id) : '');
      if (!label) {
        label = 'Supervisor sin nombre';
      }
      noteMessage = 'CSFX · Supervisor ' + label + ' autorizó descuentos personalizados.';
      if (!targetCart.meta || typeof targetCart.meta !== 'object') {
        targetCart.meta = {};
      }
      targetCart.meta.csfx_auth_supervisor_id = typeof supervisor.id !== 'undefined' ? supervisor.id : '';
      targetCart.meta.csfx_auth_supervisor_name = supervisor.name || '';
      if (csfxLastLoggedSupervisorMessage !== noteMessage) {
        csfxLastLoggedSupervisorMessage = noteMessage;
        try {
          console.info('[CSFX] Nota preparada para supervisor: ' + noteMessage);
        } catch (_errNoteConsole) {}
      }
    } else {
      delete targetCart.csfx_auth_supervisor_id;
      delete targetCart.csfx_auth_supervisor_name;
      if (targetCart.meta && typeof targetCart.meta === 'object') {
        delete targetCart.meta.csfx_auth_supervisor_id;
        delete targetCart.meta.csfx_auth_supervisor_name;
      }
      csfxLastLoggedSupervisorMessage = '';
    }
    csfxApplySupervisorAdditionInfo(targetCart, noteMessage);
    targetCart.meta_data = meta;
    targetCart.metaData = meta;
  }

  var csfxCachedCartService = null;

  function csfxLooksLikeCartService(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (obj === window || obj === document) return false;
    var hasStoreName = obj.storeName === 'cart';
    var fnCount = 0;
    ['saveCart', 'updateTotals', 'clearCart', 'getCurrentCart'].forEach(function (fn) {
      if (typeof obj[fn] === 'function') fnCount++;
    });
    return hasStoreName || fnCount >= 2;
  }

  function csfxFindCartServiceViaNg(debugSvc) {
    var selectors = ['app-root', 'pos-root', 'openpos-root', '[ng-version]'];
    var roots = [];
    selectors.forEach(function (sel) {
      var node = document.querySelector(sel);
      if (node && roots.indexOf(node) === -1) roots.push(node);
    });
    document.querySelectorAll('[ng-version]').forEach(function (node) {
      if (roots.indexOf(node) === -1) roots.push(node);
    });

    if (typeof window !== 'undefined' && window.ng && typeof window.ng.getInjector === 'function') {
      for (var s = 0; s < roots.length; s++) {
        var rootEl = roots[s];
        if (!rootEl) continue;
        try {
          var injector = window.ng.getInjector(rootEl);
          if (!injector) continue;
          var svc = null;
          if (typeof injector.get === 'function') {
            try { svc = injector.get('CartService'); } catch (_errToken) {}
            if (!svc && typeof window.CartService !== 'undefined') {
              try { svc = injector.get(window.CartService); } catch (_errClass) {}
            }
          }
          if (svc && csfxLooksLikeCartService(svc)) {
            if (debugSvc) {
              debugSvc.ngHit = {
                via: 'ng.getInjector',
                node: rootEl.tagName,
                className: svc.constructor && svc.constructor.name
              };
            }
            return svc;
          }
        } catch (_errInjector) {}
      }
    }

    var visited = new Set();
    var queue = [];
    roots.forEach(function (node) {
      if (node && node.__ngContext__) {
        queue.push({ ctx: node.__ngContext__, node: node });
      }
    });
    if (queue.length === 0) {
      document.querySelectorAll('*').forEach(function (node) {
        if (node && node.__ngContext__ && !visited.has(node.__ngContext__)) {
          queue.push({ ctx: node.__ngContext__, node: node });
        }
      });
    } else {
      document.querySelectorAll('*').forEach(function (node) {
        if (node && node.__ngContext__ && !visited.has(node.__ngContext__)) {
          queue.push({ ctx: node.__ngContext__, node: node });
        }
      });
    }
    var iterations = 0;
    while (queue.length && iterations < 1200) {
      iterations++;
      var entry = queue.shift();
      var ctx = entry && entry.ctx;
      if (!ctx || visited.has(ctx)) continue;
      visited.add(ctx);
      for (var i = 0; i < ctx.length; i++) {
        var slot = ctx[i];
        if (!slot || typeof slot !== 'object') continue;
        if (typeof Node !== 'undefined' && slot instanceof Node) continue;
        if (csfxLooksLikeCartService(slot)) {
          if (debugSvc) {
            debugSvc.ngHit = {
              via: 'context',
              node: entry.node && entry.node.tagName,
              ctxIndex: i,
              className: slot.constructor && slot.constructor.name
            };
          }
          return slot;
        }
        if (slot.cartService && csfxLooksLikeCartService(slot.cartService)) {
          if (debugSvc) {
            debugSvc.ngHit = {
              via: 'component.cartService',
              node: entry.node && entry.node.tagName,
              ctxIndex: i,
              className: slot.constructor && slot.constructor.name
            };
          }
          return slot.cartService;
        }
        if (slot.__ngContext__ && !visited.has(slot.__ngContext__)) {
          queue.push({ ctx: slot.__ngContext__, node: entry.node });
        }
      }
      var tail = ctx[ctx.length - 1];
      if (Array.isArray(tail) && !visited.has(tail)) {
        queue.push({ ctx: tail, node: entry.node });
      }
      if (ctx.length > 8 && Array.isArray(ctx[8]) && !visited.has(ctx[8])) {
        queue.push({ ctx: ctx[8], node: entry.node });
      }
    }
    if (debugSvc) {
      debugSvc.ngScan = {
        visited: visited.size,
        iterations: iterations,
        queueLength: queue.length
      };
    }
    return null;
  }

  function csfxGetCartService(debug) {
    debug = debug || {};
    var svcDebug = debug.cartService;
    if (!svcDebug || typeof svcDebug !== 'object') {
      svcDebug = { attempts: [] };
      debug.cartService = svcDebug;
    } else if (!Array.isArray(svcDebug.attempts)) {
      svcDebug.attempts = [];
    }
    function record(source, svc, ok) {
      svcDebug.attempts.push({
        source: source,
        ok: !!ok,
        type: svc == null ? String(svc) : typeof svc
      });
    }
    function consider(svc, source) {
      if (!svc) {
        record(source, svc, false);
        return null;
      }
      if (csfxLooksLikeCartService(svc)) {
        csfxCachedCartService = svc;
        try { if (typeof window !== 'undefined') window.__CSFX_CART_SERVICE__ = svc; } catch (_err) {}
        record(source, svc, true);
        return svc;
      }
      record(source, svc, false);
      return null;
    }

    if (csfxCachedCartService && csfxLooksLikeCartService(csfxCachedCartService)) {
      record('cache', csfxCachedCartService, true);
      return csfxCachedCartService;
    }

    try {
      if (typeof window !== 'undefined' && window.__CSFX_CART_SERVICE__) {
        var cached = consider(window.__CSFX_CART_SERVICE__, 'window.__CSFX_CART_SERVICE__');
        if (cached) return cached;
      }
    } catch (_err2) {}

    var globalNames = [
      'OpenPOSApp', 'OpenposApp', 'openposApp', 'OpenPOSAPP',
      'POSApp', 'posApp', 'posapp', 'POSAPP', 'pos_app',
      'OPApp', 'openposapp', 'openposAppService', 'OpenPosApp',
      'posAppService', 'OpenPOSAppService', 'OpenPosAppService'
    ];
    for (var g = 0; g < globalNames.length; g++) {
      var name = globalNames[g];
      var host = null;
      try { host = typeof window !== 'undefined' ? window[name] : null; } catch (_errHost) { host = null; }
      if (!host) continue;
      var svcHost = consider(host, 'window.' + name);
      if (svcHost) return svcHost;
      if (typeof host.cartService !== 'undefined') {
        var svcChild = consider(host.cartService, 'window.' + name + '.cartService');
        if (svcChild) return svcChild;
      }
    }

    try {
      if (typeof window !== 'undefined' && window.global && typeof window.global === 'object') {
        var globalSvc = consider(window.global.cartService, 'global.cartService');
        if (globalSvc) return globalSvc;
      }
    } catch (_err3) {}

    var viaNg = csfxFindCartServiceViaNg(svcDebug);
    if (viaNg) {
      return consider(viaNg, 'ngContext');
    }
    return null;
  }

  function csfxDualLog(stage, detail) {
    var payload = detail && typeof detail === 'object' ? Object.assign({}, detail) : {};
    payload.stage = stage;
    payload.time = new Date().toISOString();
    var shouldConsole = false;
    try {
      if (FX && FX.debug) shouldConsole = true;
      if (!shouldConsole && window && typeof window.CSFX_DEBUG_LOGS !== 'undefined') {
        shouldConsole = !!window.CSFX_DEBUG_LOGS;
      }
      if (!shouldConsole && typeof localStorage !== 'undefined') {
        shouldConsole = localStorage.getItem('csfx_debug_logs') === '1';
      }
    } catch (_errDebugFlag) {}
    try {
      if (shouldConsole && window && window.console) {
        var label = '[csfx][dual] ' + stage;
        if (typeof console.groupCollapsed === 'function') {
          console.groupCollapsed(label);
          if (payload) console.log(payload);
          console.groupEnd();
        } else if (typeof console.info === 'function') {
          console.info(label, payload);
        } else if (typeof console.log === 'function') {
          console.log(label, payload);
        }
      }
    } catch (_err) {}
    try {
      document.dispatchEvent(new CustomEvent('csfx:dual-debug', {
        detail: payload
      }));
    } catch (_err2) {}
  }

  function csfxUpsertMeta(list, key, value) {
    if (!key) return Array.isArray(list) ? list : [];
    var arr = Array.isArray(list) ? list : [];
    var found = false;
    for (var i = 0; i < arr.length; i++) {
      var item = arr[i];
      if (!item) continue;
      var itemKey = item.key || item.name || item.code;
      if (itemKey === key) {
        arr[i] = Object.assign({}, item, { key: key, value: value });
        found = true;
        break;
      }
    }
  if (!found) arr.push({ key: key, value: value });
  return arr;
}

  /**
   * csfx: fallback UI para aplicar descuento manual cuando no hay CartService.
   *
   * Referencia (probado manualmente):
   * // Fallback UI: abre el diálogo de descuento manual y aplica discountValue
   * // function applyDualDiscountViaUI(discountValue) {
   * //   const btn = document.querySelector('button[mat-icon-button][aria-label*="Descu"]') ||
   * //               document.querySelector('.cart-discount button');
   * //   if (!btn) return false;
   * //   btn.click();
   * //   setTimeout(() => {
   * //     const input = document.querySelector('input[formcontrolname="discount_amount"]') ||
   * //                   document.querySelector('input[name="discount_amount"]');
   * //     const typeSelect = document.querySelector('mat-select[formcontrolname="discount_type"]') ||
   * //                        document.querySelector('select[name="discount_type"]');
   * //     const formatted = discountValue.toFixed(2).replace('.', ',');
   * //     if (input) {
   * //       input.value = formatted;
   * //       input.dispatchEvent(new Event('input', { bubbles: true }));
   * //     }
   * //     if (typeSelect) {
   * //       typeSelect.value = 'fixed';
   * //       typeSelect.dispatchEvent(new Event('change', { bubbles: true }));
   * //     } else {
   * //       const fixedBtn = document.querySelector('button[role="radio"][aria-label*="$"]');
   * //       if (fixedBtn) fixedBtn.click();
   * //     }
   * //     const confirmBtn = document.querySelector('button[mat-dialog-confirm]') ||
   * //                        document.querySelector('button[mat-raised-button][color="primary"]');
   * //     if (confirmBtn) confirmBtn.click();
   * //   }, 150);
   * //   return true;
   * // }
   */
  function applyDualDiscountViaUI(discountValue, hooks) {
    var rawNormalized = discountValue;
    if (typeof rawNormalized === 'string') {
      var sanitized = rawNormalized.replace(/\s+/g, '').replace(/[^0-9,.\-]/g, '');
      if (sanitized.indexOf(',') > -1 && sanitized.indexOf('.') > -1) {
        sanitized = sanitized.replace(/\./g, '');
      }
      rawNormalized = sanitized.replace(/,/g, '.');
    }
    var numericDiscount = Number(rawNormalized);
    var amount = round(Math.max(0, numericDiscount || 0), FX.decimals);
    if (!isFinite(amount) || amount <= 0) {
      csfxDualLog('ui-discount:invalid-amount', { amount: discountValue });
      return false;
    }
    var trigger = document.querySelector('button[mat-icon-button][aria-label*="Descu"]') ||
      document.querySelector('.cart-discount button') ||
      document.querySelector('button[aria-label*="Descuento"], button[aria-label*="discount"]');
    if (!trigger) {
      csfxDualLog('ui-discount:no-trigger', { amount: amount });
      return false;
    }
    csfxManualDiscountBypassUntil = Date.now() + 1500;
    try { trigger.click(); } catch (_errClick) {}
    csfxDualLog('ui-discount:open', { amount: amount });
    var formatted = amount.toFixed(2).replace('.', ',');
    var afterFn = hooks && typeof hooks.after === 'function' ? hooks.after : null;
    var doneFn = hooks && typeof hooks.onDone === 'function' ? hooks.onDone : null;

    setTimeout(function () {
      var input = document.querySelector('input[formcontrolname="discount_amount"]') ||
        document.querySelector('input[name="discount_amount"]') ||
        (function () {
          var dialogs = document.querySelectorAll('mat-dialog-container input, .mat-dialog-container input');
          return dialogs.length ? dialogs[0] : null;
        })();
      if (input) {
        try {
          input.focus();
          input.value = formatted;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('blur', { bubbles: true }));
        } catch (_errInput) {}
      } else {
        csfxDualLog('ui-discount:no-input', {});
      }

      var select = document.querySelector('mat-select[formcontrolname="discount_type"]') ||
        document.querySelector('select[name="discount_type"]');

      var ensureFixed = function () {
        var fixedBtn = document.querySelector('button[role="radio"][aria-label*="$"]') ||
          document.querySelector('button[role="radio"][aria-label*="fijo"]') ||
          document.querySelector('button[role="radio"][aria-label*="fixed"]');
        if (fixedBtn) {
          try { fixedBtn.click(); } catch (_errRadio) {}
          return true;
        }
        var fixedOption = Array.prototype.find.call(document.querySelectorAll('mat-option'),
          function (opt) {
            return opt && /fijo|fixed|\$/i.test(opt.textContent || '');
          });
        if (fixedOption) {
          try { fixedOption.click(); } catch (_errOpt) {}
          return true;
        }
        return false;
      };

      var fixedHandled = false;
      if (select) {
        try {
          var tagName = select.tagName ? select.tagName.toLowerCase() : '';
          if (tagName === 'select') {
            select.value = 'fixed';
            select.dispatchEvent(new Event('change', { bubbles: true }));
            fixedHandled = true;
          } else {
            select.dispatchEvent(new Event('click', { bubbles: true }));
            setTimeout(ensureFixed, 160);
            fixedHandled = true;
          }
        } catch (_errSelect) {}
      }
      if (!fixedHandled) {
        ensureFixed();
      }

      setTimeout(function () {
        var confirmBtn = document.querySelector('button[mat-dialog-confirm]') ||
          document.querySelector('button[mat-raised-button][color="primary"]') ||
          document.querySelector('mat-dialog-container button.mat-primary') ||
          document.querySelector('.mat-dialog-container button.mat-primary');
        if (confirmBtn) {
          try { confirmBtn.click(); } catch (_errConfirm) {}
          csfxDualLog('ui-discount:confirm', { amount: amount });
          csfxDualLog('ui-discount:manualVia', { manualVia: 'ui' });
          setTimeout(function () {
            if (afterFn) {
              try {
                var snap = csfxGetCartSnapshot();
                afterFn(snap);
              } catch (afterErr) {
                csfxDualLog('ui-discount:after-error', { error: String(afterErr) });
              }
            }
            if (doneFn) doneFn(true);
          }, 600);
        } else {
          csfxDualLog('ui-discount:no-confirm', {});
          if (doneFn) doneFn(false);
        }
      }, 160);
    }, 180);

    return true;
  }

  // csfx: aplica descuento manual nativo OpenPOS sobre el cart
  function csfxApplyManualCartDiscount(cart, discountValue, svcCandidate) {
    var d = round(Math.max(0, Number(discountValue) || 0), FX.decimals);
    if (!isFinite(d) || d <= 0) return { ok: false };

    cart = cart && typeof cart === 'object' ? cart : {};
    var via = 'fallback';
    var svc = svcCandidate && typeof svcCandidate === 'object' ? svcCandidate : null;
    var nativeError = null;

    if (!svc) {
      try {
        var svcDebugTmp = { cartService: { attempts: [] } };
        svc = csfxGetCartService(svcDebugTmp);
        if (svc && typeof window !== 'undefined') {
          window.__CSFX_CART_SERVICE__ = svc;
        }
      } catch (_svcErr) {
        svc = null;
      }
    }

    if (svc && typeof svc.setDiscount === 'function' && typeof svc._initCartTotal === 'function') {
      try {
        svc.setDiscount(d, 'fixed');
        var activeCart = null;
        if (typeof svc.getCurrentCart === 'function') {
          activeCart = svc.getCurrentCart();
        } else if (svc.cart) {
          activeCart = svc.cart;
        }
        if (activeCart && typeof activeCart === 'object') {
          cart = activeCart;
        }
        if (cart) {
          cart.discount_source = '';
          cart.discountSource = '';
        }
        svc._initCartTotal();
        if (typeof svc.updateTotals === 'function') svc.updateTotals();
        if (typeof svc.saveCart === 'function') svc.saveCart();
        via = 'native';
      } catch (errNative) {
        nativeError = errNative;
        via = 'native-error';
      }
    }

    if (via !== 'native' && OPCompat && typeof OPCompat.applyManualCartDiscount === 'function') {
      try {
        OPCompat.applyManualCartDiscount(cart, d, 'csfx');
        via = via === 'native-error' ? 'compat-after-native-error' : 'compat';
      } catch (_errCompat) {
        via = via === 'native-error' ? 'compat-failed-native-error' : via;
      }
    }

    if (via !== 'native' && via !== 'compat' && via !== 'compat-after-native-error') {
      if (!cart.totals || typeof cart.totals !== 'object') cart.totals = {};
      var codeAmt = round(Math.max(0, Number(cart.discount_code_amount || 0)), FX.decimals);
      var itemsAmt = round(Math.max(0, Number(cart.final_items_discount_amount || 0)), FX.decimals);
      var combined = round(codeAmt + itemsAmt + d, FX.decimals);
      cart.discount_source = '';
      cart.discount_type = 'fixed';
      cart.discount_amount = d;
      cart.discount_final_amount = d;
      cart.discount_tax_amount = 0;
      cart.discount_excl_tax = d;
      cart.cart_discount_amount = d;
      cart.discount_code_amount = codeAmt;
      cart.final_items_discount_amount = itemsAmt;
      cart.final_discount_amount = combined;
      cart.final_discount_amount_incl_tax = cart.final_discount_amount;
      cart.add_discount = true;
      cart.discountSource = '';
      cart.discountType = cart.discount_type;
      cart.discountAmount = cart.discount_amount;
      cart.discountFinalAmount = cart.discount_final_amount;
      cart.discountTaxAmount = cart.discount_tax_amount;
      cart.discountExclTax = cart.discount_excl_tax;
      cart.cartDiscountAmount = cart.cart_discount_amount;
      cart.discountCodeAmount = cart.discount_code_amount;
      cart.finalItemsDiscountAmount = cart.final_items_discount_amount;
      cart.finalDiscountAmount = cart.final_discount_amount;
      cart.finalDiscountAmountInclTax = cart.final_discount_amount_incl_tax;
      cart.addDiscount = true;
      cart.totals.discount = combined;
      cart.totals.discountAmount = combined;
      cart.totals.final_discount_amount = combined;
      cart.totals.finalDiscountAmount = combined;
      via = (via === 'compat-failed-native-error') ? 'fallback-after-errors' : 'fallback';
    }

    if (OPCompat && typeof OPCompat.normalizeCart === 'function') {
      try { OPCompat.normalizeCart(cart); } catch (_errNorm) {}
    }

    if (typeof fmtUsd === 'function') {
      var discAmt = Number(cart.discount_amount || d);
      var finalAmt = Number(cart.final_discount_amount || discAmt);
      cart.discount_amount_currency_formatted = fmtUsd(discAmt);
      cart.discount_final_amount_currency_formatted = fmtUsd(discAmt);
      cart.final_discount_amount_currency_formatted = fmtUsd(finalAmt);
    }

    return { ok: true, amount: d, via: via, cart: cart, service: svc || null, nativeError: nativeError };
  }

  function csfxPersistCart(cart) {
    if (!cart || typeof cart !== 'object') return;
    csfxEnrichCartWithSupervisor(cart);
    var additionInfo = [];
    if (Array.isArray(cart.addition_information)) {
      additionInfo = cart.addition_information.slice();
    } else if (Array.isArray(cart.additionInformation)) {
      additionInfo = cart.additionInformation.slice();
    }
    if (additionInfo.length) {
      cart.addition_information = additionInfo.slice();
      cart.additionInformation = additionInfo.slice();
    } else {
      delete cart.addition_information;
      delete cart.additionInformation;
    }
    var snapshot = {
      discount_amount: cart.discount_amount,
      final_discount_amount: cart.final_discount_amount,
      final_discount_amount_incl_tax: cart.final_discount_amount_incl_tax,
      grand_total: cart.grand_total,
      base_grand_total: cart.base_grand_total,
      total: cart.total,
      total_due: cart.total_due,
      meta_data: cart.meta_data,
      csfx_usd_paid: cart.csfx_usd_paid,
      csfx_discount_pct: cart.csfx_discount_pct,
      csfx_discount_value: cart.csfx_discount_value,
      csfx_base_total: cart.csfx_base_total,
      csfx_dual_mode: cart.csfx_dual_mode,
      csfx_dual_usd_direct: cart.csfx_dual_usd_direct,
      csfx_dual_usd_bs: cart.csfx_dual_usd_bs,
      csfx_dual_bs_amount: cart.csfx_dual_bs_amount,
      csfx_dual_total_usd: cart.csfx_dual_total_usd,
      csfx_dual_discountable_gross: cart.csfx_dual_discountable_gross,
      csfx_dual_non_discount_gross: cart.csfx_dual_non_discount_gross,
      csfx_dual_missing_usd: cart.csfx_dual_missing_usd,
      csfx_dual_missing_bs: cart.csfx_dual_missing_bs,
      csfx_dual_change_usd: cart.csfx_dual_change_usd,
      csfx_dual_change_bs: cart.csfx_dual_change_bs,
      csfx_dual_rate: cart.csfx_dual_rate,
      addition_information: additionInfo.slice(),
      additionInformation: additionInfo.slice()
    };
    var keys = ['op_cart', 'op_cache_cart', 'op_local_cart', '_op_cart_data', 'op_cart_data', 'op_cart_v8', 'op_v5_cart', 'op_cart_backup', 'op_cart_latest', 'op_cart_store'];
    for (var k = 0; k < keys.length; k++) {
      try {
        var raw = localStorage.getItem(keys[k]);
        if (!raw) continue;
        var stored = JSON.parse(raw);
        if (!stored || typeof stored !== 'object') continue;
        Object.keys(snapshot).forEach(function (prop) {
          if (typeof snapshot[prop] !== 'undefined') stored[prop] = snapshot[prop];
        });
        if (additionInfo.length) {
          stored.addition_information = additionInfo.slice();
          stored.additionInformation = additionInfo.slice();
        } else {
          delete stored.addition_information;
          delete stored.additionInformation;
        }
        localStorage.setItem(keys[k], JSON.stringify(stored));
      } catch (_err) {}
    }
    persistFxOfflineState({
      rate: FX.rate,
      updated: FX.updated,
      disc: FX.disc
    });
  }

  function csfxApplyDualDiscount(snapshot, calc, replacingExisting, entry) {
    if (!snapshot || !calc) return false;
    var cart = (snapshot.cart && typeof snapshot.cart === 'object') ? snapshot.cart : {};
    if (!cart.totals || typeof cart.totals !== 'object') cart.totals = {};
    if (!snapshot.cart) {
      csfxDualLog('apply:no-cart', {
        cartSource: snapshot.cartSource,
        cartDebug: snapshot.cartDebug
      });
    }
    var baseTotal = round(snapshot.baseTotalUSD, FX.decimals);
    if ((!isFinite(baseTotal) || baseTotal <= 0) && snapshot.meta && snapshot.meta.csfx_base_total) {
      var metaBase = csfxToNumber(snapshot.meta.csfx_base_total);
      if (isFinite(metaBase) && metaBase > 0) baseTotal = round(metaBase, FX.decimals);
    }
    if ((!isFinite(baseTotal) || baseTotal <= 0) && window.__CSFX_LAST_BASE_USD) {
      var cachedBase = Number(window.__CSFX_LAST_BASE_USD);
      if (isFinite(cachedBase) && cachedBase > 0) baseTotal = round(cachedBase, FX.decimals);
    }
    if (!baseTotal || !isFinite(baseTotal)) {
      csfxDualLog('apply:no-base-total', {
        baseTotal: snapshot.baseTotalUSD,
        totalUSD: snapshot.totalUSD,
        discountAmount: snapshot.discountAmount
      });
      return false;
    }
    var discountValue = round(Math.max(0, calc && calc.discount ? calc.discount : 0), FX.decimals);
    if (!isFinite(discountValue) || discountValue <= 0) {
      csfxDualLog('apply:no-discount', { calc: calc, discountValue: discountValue });
      return false;
    }
    csfxDualLog('apply:start', {
      baseTotal: baseTotal,
      calc: calc,
      snapshotTotal: snapshot.totalUSD,
      existingDiscount: cart.discount_amount,
      existingFinalDiscount: cart.final_discount_amount,
      hasService: !!snapshot.cartService,
      cartSource: snapshot.cartSource,
      replacingExisting: !!replacingExisting,
      manualVia: 'ui',
      entry: entry
    });
    if (snapshot.cartDebug && typeof snapshot.cartDebug === 'object') {
      snapshot.cartDebug.manualVia = 'ui';
    }

    var usdPaidRounded = round(calc.netEffective, FX.decimals);
    var pctStored = Number(FX && FX.disc && FX.disc.percent ? FX.disc.percent : 0);
    var pctDisplay = pctStored;
    if (pctDisplay > 0 && pctDisplay < 1) pctDisplay = pctDisplay * 100;
    var pctRounded = round(pctDisplay, 2);

    entry = entry || {};
    var entryMode = entry.mode || 'usd';
    var usdDirectRounded = round(Number(entry.usdDirect || 0), FX.decimals);
    if (!isFinite(usdDirectRounded)) usdDirectRounded = 0;
    var usdFromBsRounded = round(Number(entry.usdFromBs || 0), FX.decimals);
    if (!isFinite(usdFromBsRounded)) usdFromBsRounded = 0;
    var bsAmountRounded = round(Number(entry.bsAmount || 0), FX.decimals);
    if (!isFinite(bsAmountRounded)) bsAmountRounded = 0;
    var totalUsdRounded = round(Number(entry.totalUsd || entry.netRequested || calc.netEffective || 0), FX.decimals);
    if (!isFinite(totalUsdRounded)) totalUsdRounded = usdPaidRounded;
    var rate = entry.rate > 0 ? entry.rate : (Number(FX && FX.rate) || 0);
    if (!isFinite(rate)) rate = 0;
    var toleranceDiff = Math.max(0.01, Math.pow(10, -(((FX && FX.decimals) || 2) + 1)));
    var diff = round(totalUsdRounded - usdPaidRounded, FX.decimals);
    if (Math.abs(diff) <= toleranceDiff) diff = 0;
    var changeUsdRounded = diff > 0 ? diff : 0;
    var missingUsdRounded = diff < 0 ? Math.abs(diff) : 0;
    var changeBsRounded = rate > 0 ? round(changeUsdRounded * rate, FX.decimals) : 0;
    var missingBsRounded = rate > 0 ? round(missingUsdRounded * rate, FX.decimals) : 0;

    var discountableRounded = round(Number(entry.discountableGross || 0), FX.decimals);
    if (!isFinite(discountableRounded) || discountableRounded < 0) discountableRounded = 0;
    var nonDiscountRounded = round(Number(entry.nonDiscountGross || 0), FX.decimals);
    if (!isFinite(nonDiscountRounded) || nonDiscountRounded < 0) {
      nonDiscountRounded = round(Math.max(0, baseTotal - discountableRounded), FX.decimals);
    }

    var noteParts = [];
    noteParts.push('Descuento dual del ' + pctRounded.toFixed(2) + '% aplicado sobre ' + fmtUsd(calc.grossCovered) + '.');
    if (usdDirectRounded > 0 && bsAmountRounded > 0) {
      noteParts.push('Cliente aportó ' + fmtUsd(usdDirectRounded) + ' en ' + CSFX_BASE_CODE + ' y ' + fmtBs(bsAmountRounded) + ' (≈ ' + fmtUsd(usdFromBsRounded) + ') en Bs.');
    } else if (usdDirectRounded > 0) {
      noteParts.push('Cliente pagó ' + fmtUsd(usdDirectRounded) + ' en ' + CSFX_BASE_CODE + '.');
    } else if (bsAmountRounded > 0) {
      noteParts.push('Cliente pagó ' + fmtBs(bsAmountRounded) + ' (≈ ' + fmtUsd(usdFromBsRounded) + ') en Bs.');
    } else {
      noteParts.push('Cliente pagó ' + fmtUsd(calc.netEffective) + ' en divisas.');
    }
    if (changeUsdRounded > 0.0001) {
      var changeText = 'Cambio entregado: ' + fmtUsd(changeUsdRounded);
      if (rate > 0 && changeBsRounded > 0.0001) changeText += ' (≈ ' + fmtBs(changeBsRounded) + ')';
      noteParts.push(changeText + '.');
    }
    if (missingUsdRounded > 0.0001) {
      var pendingText = 'Saldo pendiente: ' + fmtUsd(missingUsdRounded);
      if (rate > 0 && missingBsRounded > 0.0001) pendingText += ' (≈ ' + fmtBs(missingBsRounded) + ')';
      noteParts.push(pendingText + '.');
    }
    var note = noteParts.join(' ');

    var syncDiscountFields = function (targetCart) {
      if (!targetCart || typeof targetCart !== 'object') return;
      if (!targetCart.totals || typeof targetCart.totals !== 'object') targetCart.totals = {};
      var codeAmt = round(Math.max(0, Number(targetCart.discount_code_amount || 0)), FX.decimals);
      var itemsAmt = round(Math.max(0, Number(targetCart.final_items_discount_amount || 0)), FX.decimals);
      var combined = round(codeAmt + itemsAmt + discountValue, FX.decimals);
      targetCart.discount_source = '';
      targetCart.discountSource = '';
      targetCart.discount_type = 'fixed';
      targetCart.discountType = 'fixed';
      targetCart.discount_amount = discountValue;
      targetCart.discountAmount = discountValue;
      targetCart.discount_final_amount = discountValue;
      targetCart.discountFinalAmount = discountValue;
      targetCart.discount_tax_amount = 0;
      targetCart.discountTaxAmount = 0;
      targetCart.discount_excl_tax = discountValue;
      targetCart.discountExclTax = discountValue;
      targetCart.cart_discount_amount = discountValue;
      targetCart.cartDiscountAmount = discountValue;
      targetCart.discount_code_amount = codeAmt;
      targetCart.discountCodeAmount = codeAmt;
      targetCart.final_items_discount_amount = itemsAmt;
      targetCart.finalItemsDiscountAmount = itemsAmt;
      targetCart.final_discount_amount = combined;
      targetCart.finalDiscountAmount = combined;
      targetCart.final_discount_amount_incl_tax = combined;
      targetCart.finalDiscountAmountInclTax = combined;
      targetCart.add_discount = true;
      targetCart.addDiscount = true;
      targetCart.totals.discount = combined;
      targetCart.totals.discountAmount = combined;
      targetCart.totals.final_discount_amount = combined;
      targetCart.totals.finalDiscountAmount = combined;
    };

    var applyMetaToCart = function (targetCart) {
      if (!targetCart || typeof targetCart !== 'object') return;
      syncDiscountFields(targetCart);
      var targetMetaBase = targetCart.meta_data || targetCart.metaData;
      var targetMeta = csfxSanitizeMetaList(targetMetaBase && targetMetaBase.slice ? targetMetaBase.slice() : targetMetaBase);
      targetMeta = csfxUpsertMeta(targetMeta, 'csfx_usd_paid', usdPaidRounded);
      targetMeta = csfxUpsertMeta(targetMeta, 'csfx_discount_pct', pctStored);
      targetMeta = csfxUpsertMeta(targetMeta, 'csfx_discount_value', discountValue);
      var basePersist = baseTotal;
      var recBase = Number(window.__CSFX_LAST_BASE_USD || 0);
      if (isFinite(recBase) && recBase > 0) basePersist = recBase;
      if (replacingExisting && replacingExisting.base && replacingExisting.base > 0) {
        basePersist = replacingExisting.base;
      }
      targetMeta = csfxUpsertMeta(targetMeta, 'csfx_base_total', basePersist);
      targetMeta = csfxUpsertMeta(targetMeta, 'csfx_discount_note', note);
      targetMeta = csfxUpsertMeta(targetMeta, 'csfx_dual_mode', entryMode);
      targetMeta = csfxUpsertMeta(targetMeta, 'csfx_dual_usd_direct', usdDirectRounded);
      targetMeta = csfxUpsertMeta(targetMeta, 'csfx_dual_usd_bs', usdFromBsRounded);
      targetMeta = csfxUpsertMeta(targetMeta, 'csfx_dual_bs_amount', bsAmountRounded);
      targetMeta = csfxUpsertMeta(targetMeta, 'csfx_dual_total_usd', totalUsdRounded);
      targetMeta = csfxUpsertMeta(targetMeta, 'csfx_dual_discountable_gross', discountableRounded);
      targetMeta = csfxUpsertMeta(targetMeta, 'csfx_dual_non_discount_gross', nonDiscountRounded);
      targetMeta = csfxUpsertMeta(targetMeta, 'csfx_dual_missing_usd', missingUsdRounded);
      targetMeta = csfxUpsertMeta(targetMeta, 'csfx_dual_missing_bs', missingBsRounded);
      targetMeta = csfxUpsertMeta(targetMeta, 'csfx_dual_change_usd', changeUsdRounded);
      targetMeta = csfxUpsertMeta(targetMeta, 'csfx_dual_change_bs', changeBsRounded);
      targetMeta = csfxUpsertMeta(targetMeta, 'csfx_dual_rate', rate);
      targetCart.meta_data = targetMeta;
      targetCart.metaData = targetMeta;
      targetCart.csfx_usd_paid = usdPaidRounded;
      targetCart.csfx_discount_pct = pctStored;
      targetCart.csfx_discount_value = discountValue;
      targetCart.csfx_base_total = basePersist;
      targetCart.csfx_discount_note = note;
      targetCart.csfx_dual_mode = entryMode;
      targetCart.csfx_dual_usd_direct = usdDirectRounded;
      targetCart.csfx_dual_usd_bs = usdFromBsRounded;
      targetCart.csfx_dual_bs_amount = bsAmountRounded;
      targetCart.csfx_dual_total_usd = totalUsdRounded;
      targetCart.csfx_dual_discountable_gross = discountableRounded;
      targetCart.csfx_dual_non_discount_gross = nonDiscountRounded;
      targetCart.csfx_dual_missing_usd = missingUsdRounded;
      targetCart.csfx_dual_missing_bs = missingBsRounded;
      targetCart.csfx_dual_change_usd = changeUsdRounded;
      targetCart.csfx_dual_change_bs = changeBsRounded;
      targetCart.csfx_dual_rate = rate;
      csfxEnrichCartWithSupervisor(targetCart);
    };

    applyMetaToCart(cart);
    csfxPersistCart(cart);
    csfxDualLog('apply:meta', {
      discountValue: discountValue,
      pctStored: pctStored,
      meta: cart.meta_data,
      entry: {
        mode: entryMode,
        usdDirect: usdDirectRounded,
        usdFromBs: usdFromBsRounded,
        bsAmount: bsAmountRounded,
        totalUsd: totalUsdRounded,
        discountableGross: discountableRounded,
        nonDiscountGross: nonDiscountRounded,
        changeUsd: changeUsdRounded,
        missingUsd: missingUsdRounded,
        rate: rate
      },
      cartSummary: {
        discount_amount: cart.discount_amount,
        final_discount_amount: cart.final_discount_amount,
        grand_total: cart.grand_total,
        total: cart.total,
        total_due: cart.total_due,
        add_discount: cart.add_discount
      }
    });

    var uiPersisted = false;
    var uiDoneSuccess = null;

    var uiTriggered = applyDualDiscountViaUI(discountValue, {
      after: function (snapshotAfter) {
        if (!snapshotAfter || !snapshotAfter.cart) return;
        var uiCart = snapshotAfter.cart;
        if (OPCompat && typeof OPCompat.normalizeCart === 'function') {
          try { uiCart = OPCompat.normalizeCart(uiCart) || uiCart; } catch (_errUiNorm) {}
        }
        applyMetaToCart(uiCart);
        csfxPersistCart(uiCart);
        uiPersisted = true;
        csfxDualLog('apply:ui-persist', { success: true });
      },
      onDone: function (success) {
        uiDoneSuccess = !!success;
        csfxDualLog('apply:ui-done', { success: success });
      }
    });

    if (!uiTriggered) {
      csfxDualLog('apply:ui-not-triggered', { amount: discountValue });
      return false;
    }

    if (!uiPersisted) {
      setTimeout(function () {
        if (uiPersisted) return;
        try {
          var snapshotAfter = csfxGetCartSnapshot();
          if (snapshotAfter && snapshotAfter.cart) {
            applyMetaToCart(snapshotAfter.cart);
            csfxPersistCart(snapshotAfter.cart);
            csfxDualLog('apply:ui-persist-fallback', { amount: discountValue });
          } else {
            csfxPersistCart(cart);
          }
        } catch (persistErr) {
          csfxDualLog('apply:ui-persist-error', { error: String(persistErr) });
        }
      }, 800);
    }

    csfxDualLog('apply:ui', {
      manualVia: 'ui',
      cartDiscountAmount: cart.discount_amount,
      cartFinalDiscountAmount: cart.final_discount_amount
    });

    try {
      document.dispatchEvent(new CustomEvent('csfx:dual-discount-applied', {
        detail: {
          usdNet: calc.netEffective,
          discount: discountValue,
          pct: Number(FX.disc.percent),
          remainderUsd: calc.remainderUsd,
          mode: entryMode,
          usdDirect: usdDirectRounded,
          usdFromBs: usdFromBsRounded,
          bsAmount: bsAmountRounded,
          totalUsd: totalUsdRounded,
          discountableGross: discountableRounded,
          nonDiscountGross: nonDiscountRounded,
          changeUsd: changeUsdRounded,
          changeBs: changeBsRounded,
          missingUsd: missingUsdRounded,
          missingBs: missingBsRounded,
          rate: rate
        }
      }));
      document.dispatchEvent(new CustomEvent('csfx:cart-updated'));
    } catch (_err) {}

    csfxDualLog('apply:finished', {
      discountValue: discountValue,
      finalDiscountAmount: cart.final_discount_amount,
      finalDiscountAmountInclTax: cart.final_discount_amount_incl_tax,
      manualVia: 'ui',
      uiTriggered: true,
      uiDoneSuccess: uiDoneSuccess
    });

    if (typeof window !== 'undefined' && isFinite(baseTotal) && baseTotal > 0) {
      window.__CSFX_LAST_BASE_USD = baseTotal;
    }

    return true;
  }

  function csfxRenderBadgeContent(badge) {
    if (!badge) return;
    csfxUpdateBadgeHandle(badge);
    var contentDiv = badge.querySelector('.csfx-badge-content');
    if (!contentDiv) return;
    if (!contentDiv.dataset.csfxBound) {
      contentDiv.dataset.csfxBound = '1';
      ['click', 'pointerdown', 'touchstart'].forEach(function (evt) {
        contentDiv.addEventListener(evt, function (ev) {
          if (ev && typeof ev.stopPropagation === 'function') {
            ev.stopPropagation();
          }
        });
      });
    }
    var legacyTop = contentDiv.querySelector('.csfx-badge-top');
    if (legacyTop && legacyTop.parentNode) {
      legacyTop.parentNode.removeChild(legacyTop);
    }
    var panel = contentDiv.querySelector('[data-csfx="dual-panel"]');
    var justCreated = false;
    if (!panel) {
      panel = csfxRenderDualPanel(contentDiv);
      justCreated = !!panel;
    } else {
      csfxUpdateDualPanel(panel);
    }
    if (justCreated && panel) {
      setTimeout(function(){
        var firstInput = panel.querySelector('input[data-csfx="usd-net"]');
        if (firstInput) {
          try {
            firstInput.focus();
            firstInput.select();
          } catch (_err) {}
        }
      }, 80);
    }
  }

  function csfxRenderDualPanel(container) {
    if (!container) return null;
    var existingPanel = container.querySelector('[data-csfx="dual-panel"]');
    if (existingPanel) {
      csfxUpdateDualPanel(existingPanel);
      return existingPanel;
    }
    container.querySelectorAll('[data-csfx="dual-panel"]').forEach(function (node) {
      if (node && node.parentNode) node.parentNode.removeChild(node);
    });
    container.querySelectorAll('.csfx-dual-note').forEach(function (node) {
      if (node && node.parentNode) node.parentNode.removeChild(node);
    });
    var pct = csfxDiscountDecimal();
    if (!FX.disc || !FX.disc.active || !pct) {
      var note = document.createElement('div');
      note.className = 'csfx-dual-note';
      note.textContent = 'Descuento inactivo. Configura un porcentaje en Conf Tavox.';
      container.appendChild(note);
      return null;
    }
    var panel = document.createElement('div');
    panel.className = 'csfx-dual-box';
    panel.dataset.csfx = 'dual-panel';
    container.appendChild(panel);

    var state = csfxDualState(panel);

    var grid = document.createElement('div');
    grid.className = 'csfx-dual-grid';
    grid.innerHTML = ''
      + '<span>Total sin descuento</span><strong data-csfx="total-base">—</strong>'
      + '<span>Total con descuento</span><strong data-csfx="total-full">—</strong>';
    panel.appendChild(grid);

    var tabs = document.createElement('div');
    tabs.className = 'csfx-dual-tabs';
    var modeDefs = [
      { id: 'usd', label: CSFX_BASE_CODE + ' directo', desc: 'El cliente paga en ' + CSFX_BASE_CODE + ' y el resto se cubre en Bs.' },
      { id: 'bs', label: 'Bs', desc: 'Cobrar un monto ' + CSFX_BASE_CODE + ' pagado íntegramente en bolívares.' }
    ];
    modeDefs.forEach(function (def) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'csfx-dual-tab';
      btn.dataset.csfxModeTab = def.id;
      btn.textContent = def.label;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', 'false');
      if (def.desc) btn.setAttribute('title', def.desc);
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        csfxDualSetMode(panel, def.id, { focus: true });
      });
      tabs.appendChild(btn);
    });
    panel.appendChild(tabs);

    var modesWrap = document.createElement('div');
    modesWrap.className = 'csfx-dual-modes';
    panel.appendChild(modesWrap);

    function setupInput(inputEl, onChange) {
      if (!inputEl) return;
      inputEl.autocomplete = 'off';
      inputEl.inputMode = 'decimal';
      inputEl.pattern = '[0-9]*[.,]?[0-9]*';
      inputEl.disabled = false;
      inputEl.removeAttribute('disabled');
      inputEl.readOnly = false;
      inputEl.removeAttribute('readonly');
      inputEl.tabIndex = 0;
      ['keydown','keypress','keyup','wheel','focus','blur','mousedown','mouseup','click','touchstart'].forEach(function(evt){
        inputEl.addEventListener(evt, function(e){ e.stopPropagation(); }, true);
        inputEl.addEventListener(evt, function(e){ e.stopPropagation(); });
      });
      inputEl.addEventListener('input', function (ev) {
        if (ev && ev.isTrusted && panel) {
          delete panel.dataset.csfxSelectedSuggest;
          panel.querySelectorAll('[data-csfx-adjust]').forEach(function(btn){
            btn.classList.remove('is-selected');
          });
        }
        csfxDualMarkDirty(panel, inputEl);
        if (typeof onChange === 'function') onChange(ev);
        csfxUpdateDualPanel(panel);
        ev.stopPropagation();
      });
    }

    var usdMode = document.createElement('div');
    usdMode.className = 'csfx-dual-mode';
    usdMode.dataset.csfxModeForm = 'usd';
    var usdInputWrap = document.createElement('div');
    usdInputWrap.className = 'csfx-dual-input';
    var usdLabel = document.createElement('span');
    usdLabel.textContent = 'Pago en divisas (' + CSFX_BASE_CODE + ' neto)';
    var usdInput = document.createElement('input');
    usdInput.type = 'text';
    usdInput.placeholder = '0.00';
    usdInput.dataset.csfx = 'usd-net';
    usdInputWrap.appendChild(usdLabel);
    usdInputWrap.appendChild(usdInput);
    usdMode.appendChild(usdInputWrap);
    modesWrap.appendChild(usdMode);
    setupInput(usdInput);

    var bsMode = document.createElement('div');
    bsMode.className = 'csfx-dual-mode';
    bsMode.dataset.csfxModeForm = 'bs';
    var bsInputWrap = document.createElement('div');
    bsInputWrap.className = 'csfx-dual-input';
    var bsLabel = document.createElement('span');
    bsLabel.textContent = 'Monto en ' + CSFX_BASE_CODE;
    var bsInput = document.createElement('input');
    bsInput.type = 'text';
    bsInput.placeholder = '0.00';
    bsInput.dataset.csfx = 'usd-net-bs';
    bsInputWrap.appendChild(bsLabel);
    bsInputWrap.appendChild(bsInput);
    var bsHint = document.createElement('div');
    bsHint.className = 'csfx-dual-inline-hint';
    bsHint.dataset.csfx = 'bs-equivalent';
    bsHint.textContent = 'Ingresa el monto ' + CSFX_BASE_CODE + ' para ver el equivalente a cobrar en Bs.';
    bsInputWrap.appendChild(bsHint);
    bsMode.appendChild(bsInputWrap);

    var bsAltWrap = document.createElement('div');
    bsAltWrap.className = 'csfx-dual-bs-field csfx-dual-input';
    var bsAltLabel = document.createElement('span');
    bsAltLabel.textContent = 'Monto en Bs';
    var bsAltInput = document.createElement('input');
    bsAltInput.type = 'text';
    bsAltInput.placeholder = '0.00';
    bsAltInput.dataset.csfx = 'bs-manual';
    bsAltWrap.appendChild(bsAltLabel);
    bsAltWrap.appendChild(bsAltInput);
    bsMode.appendChild(bsAltWrap);
    var bsAdjust = document.createElement('div');
    bsAdjust.className = 'csfx-dual-adjust';
    bsAdjust.dataset.csfx = 'bs-adjust';
    bsAdjust.setAttribute('hidden', 'hidden');
    bsMode.appendChild(bsAdjust);
    modesWrap.appendChild(bsMode);

    setupInput(bsInput, function () {
      if (bsInput && bsInput.dataset) delete bsInput.dataset.csfxManualBs;
    });
    if (bsInput) {
      ['focus','input'].forEach(function(evt){
        bsInput.addEventListener(evt, function(){
          if (panel && panel.dataset) panel.dataset.csfxBsManualMode = 'usd';
        });
      });
    }
    setupInput(bsAltInput, function () {
      if (!bsAltInput.value && bsInput && bsInput.dataset) {
        delete bsInput.dataset.csfxManualBs;
      }
    });
    if (bsAltInput) {
      ['focus','input'].forEach(function(evt){
        bsAltInput.addEventListener(evt, function(){
          if (panel && panel.dataset) panel.dataset.csfxBsManualMode = 'raw';
        });
      });
    }

    var metrics = document.createElement('div');
    metrics.className = 'csfx-dual-metrics';
    var metricDefs = [
      { key: 'gross', label: 'Parte bruta', tip: 'Monto cubierto por el pago en divisas antes de descuentos.' },
      { key: 'discount', label: 'Descuento', tip: 'Descuento aplicado según la política de precio dual.' },
      { key: 'remaining-usd', label: 'Resta ' + CSFX_BASE_CODE, tip: 'Saldo que queda por pagar en divisas (' + CSFX_BASE_CODE + ') luego del descuento.' },
      { key: 'remaining-bs', label: 'Resta Bs.', tip: 'Saldo restante en bolívares calculado con la tasa vigente.' }
    ];
    metricDefs.forEach(function (def) {
      var row = document.createElement('div');
      row.className = 'csfx-dual-metrics-row';
      row.dataset.csfxMetric = def.key;
      var labelWrap = document.createElement('span');
      labelWrap.className = 'csfx-dual-metrics-label';
      var helpIcon = document.createElement('span');
      helpIcon.className = 'csfx-dual-metrics-help';
      helpIcon.dataset.tooltip = def.tip;
      helpIcon.textContent = 'i';
      labelWrap.appendChild(helpIcon);
      labelWrap.appendChild(document.createTextNode(def.label));
      var value = document.createElement('span');
      value.className = 'csfx-dual-metrics-value';
      value.dataset.csfxMetricValue = def.key;
      value.textContent = '—';
      row.appendChild(labelWrap);
      row.appendChild(value);
      metrics.appendChild(row);
    });
    panel.appendChild(metrics);

    var helper = document.createElement('div');
    helper.className = 'csfx-dual-helper';
    var helperIcon = document.createElement('span');
    helperIcon.className = 'csfx-dual-helper-icon';
    helperIcon.dataset.tooltip = 'Haz clic para ver cómo explicar el descuento al cliente.';
    helperIcon.textContent = 'i';
      var helperLabel = document.createElement('span');
      helperLabel.className = 'csfx-dual-helper-label';
      helperLabel.textContent = 'Cómo explicar el descuento';
      helper.appendChild(helperIcon);
      helper.appendChild(helperLabel);
    helper.setAttribute('role', 'button');
    helper.tabIndex = 0;
    var explainHandler = function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      csfxOpenDualExplainModal(panel);
    };
    helper.addEventListener('click', explainHandler);
    helper.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') {
        explainHandler(ev);
      }
    });
    panel.appendChild(helper);

    var actions = document.createElement('div');
    actions.className = 'csfx-dual-actions';
    var fullBtn = document.createElement('button');
    fullBtn.type = 'button';
    fullBtn.className = 'csfx-btn csfx-btn--primary csfx-btn--wide';
    fullBtn.dataset.csfx = 'full-discount';
    fullBtn.innerHTML = 'Aplicar<br>descuento total';
    actions.appendChild(fullBtn);
    var confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'csfx-btn csfx-btn--secondary csfx-btn--wide';
    confirm.dataset.csfx = 'confirm';
    confirm.innerHTML = 'Aplicar<br>descuento dual';
    actions.appendChild(confirm);
    panel.appendChild(actions);

    var customBtn = document.createElement('button');
    customBtn.type = 'button';
    customBtn.className = 'csfx-btn csfx-btn--ghost csfx-btn--wide';
    customBtn.dataset.csfx = 'custom-discount';
    customBtn.innerHTML = 'Descuento<br>personalizado';
    var copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'csfx-btn csfx-btn--ghost csfx-btn--wide';
    copyBtn.dataset.csfx = 'copy-summary';
    copyBtn.innerHTML = 'Copiar<br>resumen';
    copyBtn.disabled = true;
    var extraRow = document.createElement('div');
    extraRow.className = 'csfx-dual-extra';
    extraRow.appendChild(customBtn);
    extraRow.appendChild(copyBtn);
    panel.appendChild(extraRow);
    copyBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      csfxCopyDualSummary(panel);
    });

    var status = document.createElement('div');
    status.className = 'csfx-dual-status';
    status.dataset.csfx = 'status';
    panel.appendChild(status);

    state.inputs.usd = usdInput;
    state.inputs.bsUsd = bsInput;
    state.inputs.bsRaw = bsAltInput;
    state.ui.bsEquivalent = bsHint;
    state.ui.bsAdjust = bsAdjust;
    state.ui.copyBtn = copyBtn;

    var applyFullDiscount = function () {
      var statusEl = panel.querySelector('[data-csfx="status"]');
      var baseStr = panel.dataset.csfxBase || '';
      var baseTotal = parseFloat(baseStr);
      if (!isFinite(baseTotal) || baseTotal <= 0) {
        if (statusEl) {
          statusEl.textContent = 'No hay total disponible para aplicar el descuento.';
          statusEl.className = 'csfx-dual-status csfx-dual-status--error';
        }
        return;
      }
      var inputEl = panel.querySelector('input[data-csfx="usd-net"]');
      if (!inputEl) return;
      csfxDualSetMode(panel, 'usd', { focus: false, silent: true });
      var rounded = round(baseTotal, FX.decimals);
      inputEl.value = csfxFormatInputNumber(rounded, FX.decimals);
      panel.dataset.csfxDirty = '1';
      inputEl.dataset.csfxTouched = '1';
      csfxUpdateDualPanel(panel);
      csfxHandleDualConfirm(panel);
    };

    fullBtn.addEventListener('click', function () {
      if (fullBtn.disabled) return;
      var inputEl = panel.querySelector('input[data-csfx="usd-net"]');
      var baseStr = panel.dataset.csfxBase || '';
      var baseTotal = parseFloat(baseStr);
      if (!isFinite(baseTotal) && panel.dataset && panel.dataset.csfxTotal) {
        var fallback = parseFloat(panel.dataset.csfxTotal || '');
        if (isFinite(fallback)) baseTotal = fallback;
      }
      var manualValue = NaN;
      if (inputEl && typeof inputEl.value === 'string') {
        manualValue = parseFloat(inputEl.value.replace(',', '.'));
      }
      var epsilon = Math.max(0.01, Math.pow(10, -((FX && FX.decimals) || 2)));
      var hasManualAmount = false;
      if (isFinite(manualValue) && manualValue > 0) {
        if (!isFinite(baseTotal) || Math.abs(manualValue - baseTotal) > epsilon) {
          hasManualAmount = true;
        } else {
          // si coincide con la base, no forzamos confirmación extra
          manualValue = manualValue;
        }
      } else {
        manualValue = NaN;
      }

      var currentMode = panel.dataset && panel.dataset.csfxMode ? panel.dataset.csfxMode : 'usd';
      if (currentMode === 'bs') {
        var stateNow = csfxDualState(panel);
        var bsUsdInput = stateNow.inputs ? stateNow.inputs.bsUsd : null;
        var bsRawInput = stateNow.inputs ? stateNow.inputs.bsRaw : null;
        var usdFromBs = csfxDualNormalizeValue(bsUsdInput ? bsUsdInput.value : '');
        var bsAmount = csfxDualNormalizeValue(bsRawInput ? bsRawInput.value : '');
        var rate = Number(FX && FX.rate ? FX.rate : 0);
        if (!isFinite(rate) || rate <= 0) rate = 0;
        var candidateUsd = NaN;
        if (isFinite(usdFromBs) && usdFromBs > 0) {
          candidateUsd = usdFromBs;
        } else if (isFinite(bsAmount) && bsAmount > 0 && rate > 0) {
          candidateUsd = bsAmount / rate;
        }
        if (isFinite(candidateUsd) && candidateUsd > 0) {
          if (!isFinite(baseTotal) || Math.abs(candidateUsd - baseTotal) > epsilon) {
            hasManualAmount = true;
          }
          manualValue = candidateUsd;
        }
      }

      if (hasManualAmount) {
        csfxPromptFullDiscountOverride({
          panel: panel,
          manualValue: manualValue,
          base: baseTotal,
          onConfirm: applyFullDiscount
        });
        return;
      }
      applyFullDiscount();
    });
    confirm.addEventListener('click', function () {
      if (confirm.disabled) return;
      csfxHandleDualConfirm(panel);
    });
    customBtn.addEventListener('click', function () { csfxOpenCustomDiscountModal({ fromDualPanel: panel }); });

    csfxDualSetMode(panel, 'usd', { silent: true });
    csfxUpdateDualPanel(panel);
    return panel;
  }

  function csfxResetDualChips(panel) {
    panel.querySelectorAll('[data-csfx-metric-value]').forEach(function (node) {
      node.textContent = '—';
    });
    panel.querySelectorAll('.csfx-dual-metrics-row').forEach(function (row) {
      row.classList.remove('is-highlight', 'is-warning');
    });
  }

  function csfxUpdateDualPanel(panel) {
    if (!panel) return;
    var state = csfxDualState(panel);
    var pct = csfxDiscountDecimal();
    var snapshot = csfxGetCartSnapshot({ totalUSD: readCheckoutUSD() });
    var hasGlobalDiscount = csfxHasGlobalDiscount(snapshot);
    var baseTotal = snapshot.baseTotalUSD;
    var currentRate = Number(FX && FX.rate ? FX.rate : 0);
    if (!isFinite(currentRate)) currentRate = 0;
    if ((!isFinite(baseTotal) || baseTotal <= 0) && snapshot.meta && snapshot.meta.csfx_base_total) {
      var metaBase = csfxToNumber(snapshot.meta.csfx_base_total);
      if (isFinite(metaBase) && metaBase > 0) baseTotal = metaBase;
    }
    if ((!isFinite(baseTotal) || baseTotal <= 0) && window.__CSFX_LAST_BASE_USD) {
      var cachedBase = Number(window.__CSFX_LAST_BASE_USD);
      if (isFinite(cachedBase) && cachedBase > 0) baseTotal = cachedBase;
    }
    if (!hasGlobalDiscount && isFinite(baseTotal) && baseTotal > 0) {
      window.__CSFX_LAST_BASE_USD = baseTotal;
    }
    panel.dataset.csfxPct = pct ? String(pct) : '';
    panel.dataset.csfxBase = isFinite(baseTotal) ? String(baseTotal) : '';
    panel.dataset.csfxTotal = isFinite(snapshot.totalUSD) ? String(snapshot.totalUSD) : '';

    var baseEl = panel.querySelector('[data-csfx="total-base"]');
    var fullEl = panel.querySelector('[data-csfx="total-full"]');
    if (baseEl) baseEl.textContent = isFinite(baseTotal) ? fmtUsd(baseTotal) : '—';
    if (fullEl) fullEl.textContent = (isFinite(baseTotal) && pct)
      ? fmtUsd(baseTotal * (1 - pct))
      : '—';

    var uiRefs = state.ui || {};
    var bsHint = uiRefs.bsEquivalent || null;
    var bsAdjust = uiRefs.bsAdjust || null;
    var copyBtn = uiRefs.copyBtn || null;
    state.summary = null;
    if (copyBtn) {
      copyBtn.disabled = true;
    }
    if (bsHint) bsHint.textContent = '—';
    if (bsAdjust) {
      bsAdjust.innerHTML = '';
      bsAdjust.setAttribute('hidden', 'hidden');
      bsAdjust.removeAttribute('data-open');
    }

    var usdInput = state.inputs && state.inputs.usd ? state.inputs.usd : panel.querySelector('input[data-csfx="usd-net"]');
    var status = panel.querySelector('[data-csfx="status"]');
    var applyButtons = Array.prototype.slice.call(panel.querySelectorAll('[data-csfx="full-discount"], [data-csfx="confirm"]'));
    var fullBtn = panel.querySelector('[data-csfx="full-discount"]');
    var confirmBtn = panel.querySelector('[data-csfx="confirm"]');

    function csfxUpdateFullButtonLock(shouldLock, hint) {
      if (shouldLock) {
        panel.dataset.csfxFullLock = '1';
      } else {
        delete panel.dataset.csfxFullLock;
      }
      if (!fullBtn) return;
      if (shouldLock) {
        fullBtn.setAttribute('data-csfx-full-lock', '1');
        if (hint) {
          fullBtn.setAttribute('title', hint);
        } else {
          fullBtn.setAttribute('title', 'Ingresaste un monto manual; confirma antes de aplicar el descuento total.');
        }
      } else {
        fullBtn.removeAttribute('data-csfx-full-lock');
        if (fullBtn.hasAttribute('title')) fullBtn.removeAttribute('title');
      }
    }

    if (usdInput && !panel.dataset.csfxDirty) {
      if (snapshot.usdPaid) {
        usdInput.value = csfxFormatInputNumber(round(snapshot.usdPaid, FX.decimals), FX.decimals);
      } else if (!usdInput.dataset || !usdInput.dataset.csfxTouched) {
        usdInput.value = '';
      }
    }

    var applyLocked = false;
    var discountWarning = '';
    if (hasGlobalDiscount) {
      applyLocked = true;
      csfxUpdateFullButtonLock(false);
      var currentDisc = snapshot.discountAmount;
      if ((!currentDisc || currentDisc <= 0.0001) && window.__CSFX_LAST_DISCOUNT_USD) {
        currentDisc = window.__CSFX_LAST_DISCOUNT_USD;
      }
      if (!isNaN(currentDisc) && currentDisc > 0.0001) {
        discountWarning = 'Ya existe un descuento global (' + fmtUsd(currentDisc) + '). Puedes simular montos, pero elimina el actual para aplicar uno nuevo.';
      } else {
        discountWarning = 'Ya existe un descuento global. Puedes simular montos, pero elimina el actual para aplicar uno nuevo.';
      }
    }

    applyButtons.forEach(function (btn) {
      if (!btn) return;
      btn.disabled = applyLocked;
    });
    if (!applyLocked && confirmBtn) confirmBtn.disabled = false;

    var effectiveBase = baseTotal;
    if ((!isFinite(effectiveBase) || effectiveBase <= 0) && snapshot.meta && snapshot.meta.csfx_base_total) {
      var metaBaseEffective = csfxToNumber(snapshot.meta.csfx_base_total);
      if (isFinite(metaBaseEffective) && metaBaseEffective > 0) effectiveBase = metaBaseEffective;
    }
    if (!isFinite(effectiveBase) || effectiveBase <= 0) {
      effectiveBase = baseTotal;
    }

    var entry = csfxDualReadEntry(panel, { baseTotal: effectiveBase, pct: pct });
    var currentMode = panel.dataset && panel.dataset.csfxMode ? panel.dataset.csfxMode : 'usd';
    if (entry && currentMode === 'usd' && typeof entry.usdDirect === 'number' && usdInput && usdInput.value) {
      var decimalsCount = entry.decimals || ((FX && FX.decimals) || 2);
      var usdCanonical = csfxFormatInputNumber(entry.usdDirect, decimalsCount);
      if (usdCanonical === '') usdCanonical = '0';
      if (usdInput.value !== usdCanonical) {
        usdInput.value = usdCanonical;
      }
    }

    var decimals = entry.decimals || ((FX && FX.decimals) || 2);
    var tolerance = Math.max(0.01, Math.pow(10, -(decimals + 1)));
    var epsilonUsd = Math.pow(10, -(decimals + 1));

    if (bsHint) {
      if (currentMode === 'bs') {
        if (entry.bsAmount > 0 && entry.rate > 0) {
          bsHint.textContent = 'Se cobrará ' + fmtBs(entry.bsAmount);
        } else {
          bsHint.textContent = 'Ingresa el monto ' + CSFX_BASE_CODE + ' para ver el equivalente en Bs.';
        }
      } else {
        bsHint.textContent = '—';
      }
    }
    var baseForLock = parseFloat(panel.dataset.csfxBase || '');
    if (!isFinite(baseForLock)) baseForLock = baseTotal;
    var epsilonLock = Math.max(0.01, Math.pow(10, -(((FX && FX.decimals) || 2) + 1)));
    var shouldLockFull = false;
    var lockHint = '';
    if (currentMode === 'usd' && isFinite(entry.usdDirect) && entry.usdDirect > 0) {
      if (!isFinite(baseForLock) || Math.abs(entry.usdDirect - baseForLock) > epsilonLock) {
        shouldLockFull = true;
        lockHint = 'Ingresaste ' + fmtUsd(entry.usdDirect) + '. Confirma si aún deseas aplicar el descuento total.';
      }
    } else if (currentMode === 'bs') {
      var rate = Number(entry.rate || FX.rate || 0);
      if (!isFinite(rate) || rate <= 0) rate = 0;
      var hasBsManual = false;
      var bsAmountAbs = Math.abs(entry.bsAmount || 0);
      var usdFromBsAbs = Math.abs(entry.usdFromBs || 0);
      if (usdFromBsAbs > epsilonLock) hasBsManual = true;
      if (rate > 0 && bsAmountAbs > epsilonLock * rate) hasBsManual = true;
      if (!hasBsManual && bsAmountAbs > Math.pow(10, -((FX && FX.decimals) || 2))) hasBsManual = true;
      if (hasBsManual) {
        shouldLockFull = true;
        if (bsAmountAbs > 0 && rate > 0) {
          lockHint = 'Ingresaste ' + fmtBs(entry.bsAmount) + ' (≈ ' + fmtUsd(entry.usdFromBs) + '). Confirma si aún deseas aplicar el descuento total.';
        } else if (usdFromBsAbs > 0) {
          lockHint = 'Ingresaste ' + fmtUsd(entry.usdFromBs) + ' en la pestaña Bs. Confirma si aún deseas aplicar el descuento total.';
        } else {
          lockHint = 'Ingresaste un monto en la pestaña Bs. Confirma si aún deseas aplicar el descuento total.';
        }
      }
    }
    if (shouldLockFull) {
      csfxUpdateFullButtonLock(true, lockHint);
    } else {
      csfxUpdateFullButtonLock(false);
    }

    if (!entry.hasValue || (!isFinite(entry.usdDirect) && !isFinite(entry.usdFromBs))) {
      csfxResetDualChips(panel);
      if (status) {
        status.textContent = 'Introduce el monto correspondiente para estimar.';
        status.className = 'csfx-dual-status';
      }
      if (confirmBtn) confirmBtn.disabled = true;
      panel.dataset.csfxCalcNet = panel.dataset.csfxCalcDiscount = panel.dataset.csfxCalcGross = panel.dataset.csfxCalcRemainder = '';
      panel.dataset.csfxEntryMode = currentMode;
      panel.dataset.csfxEntryUsd = entry.usdDirect || '';
      panel.dataset.csfxEntryUsdFromBs = entry.usdFromBs || '';
      panel.dataset.csfxEntryBs = entry.bsAmount || '';
      panel.dataset.csfxEntryTotal = entry.totalUsd || '';
      panel.dataset.csfxEntryMissing = panel.dataset.csfxEntryChange = panel.dataset.csfxEntryRate = '';
      panel.dataset.csfxEntryDiscountable = panel.dataset.csfxEntryNonDiscount = '';
      return;
    }

    if (entry.errors && entry.errors.length) {
      applyButtons.forEach(function (btn) { if (btn) btn.disabled = true; });
      if (confirmBtn) confirmBtn.disabled = true;
      csfxResetDualChips(panel);
      if (status) {
        status.textContent = entry.errors[0];
        status.className = 'csfx-dual-status csfx-dual-status--error';
      }
      panel.dataset.csfxEntryMode = currentMode;
      panel.dataset.csfxEntryUsd = entry.usdDirect || '';
      panel.dataset.csfxEntryUsdFromBs = entry.usdFromBs || '';
      panel.dataset.csfxEntryBs = entry.bsAmount || '';
      panel.dataset.csfxEntryTotal = entry.totalUsd || '';
      panel.dataset.csfxEntryMissing = panel.dataset.csfxEntryChange = panel.dataset.csfxEntryRate = '';
      panel.dataset.csfxEntryDiscountable = panel.dataset.csfxEntryNonDiscount = '';
      return;
    }

    var calc = csfxComputeDual(entry.discountableGross, entry.netForDiscount, pct);
    var appliedBsGross = entry.usdFromBs;
    if (isFinite(effectiveBase) && effectiveBase > 0) {
      appliedBsGross = Math.min(effectiveBase, appliedBsGross);
    }
    var remainderGross = calc.remainderUsd;
    if (isFinite(effectiveBase) && effectiveBase > 0) {
      remainderGross = Math.max(0, effectiveBase - (calc.grossCovered + appliedBsGross));
    }
    var remainderBs = usd2bs(remainderGross);

    var netEffective = round(calc.netEffective, decimals);
    var netUsdDue = netEffective;
    var usdFraction = 0;
    if (currentMode === 'bs') {
      var usdFloor = Math.floor(netUsdDue + epsilonUsd);
      usdFraction = round(netUsdDue - usdFloor, decimals);
      if (usdFraction < epsilonUsd) usdFraction = 0;
    }
    var totalNetPlanned = round(entry.usdDirect + entry.usdFromBs, decimals);
    var effectiveTotalNet = round(netEffective + entry.usdFromBs, decimals);
    var diff = round(totalNetPlanned - effectiveTotalNet, decimals);
    if (Math.abs(diff) <= tolerance) diff = 0;
    var missingUsd = diff < 0 ? Math.abs(diff) : 0;
    var changeUsd = diff > 0 ? diff : 0;
    var rate = entry.rate > 0 ? entry.rate : (Number(FX && FX.rate) || 0);
    if (!isFinite(rate)) rate = 0;
    var missingBs = rate > 0 ? round(missingUsd * rate, FX.decimals) : NaN;
    var changeBs = rate > 0 ? round(changeUsd * rate, FX.decimals) : NaN;

    if (currentMode === 'bs') {
      remainderGross = 0;
      remainderBs = 0;
    }
    var calcNetRounded = round(calc.netEffective, decimals);
    var calcDiscountRounded = round(calc.discount, decimals);
    panel.dataset.csfxEntryMode = currentMode;
    panel.dataset.csfxEntryUsd = entry.usdDirect || '';
    panel.dataset.csfxEntryUsdFromBs = entry.usdFromBs || '';
    panel.dataset.csfxEntryBs = entry.bsAmount || '';
    panel.dataset.csfxEntryTotal = entry.totalUsd || '';
    panel.dataset.csfxEntryMissing = missingUsd || '';
    panel.dataset.csfxEntryChange = changeUsd || '';
    panel.dataset.csfxEntryRate = rate || '';
    panel.dataset.csfxEntryDiscountable = entry.discountableGross || '';
    panel.dataset.csfxEntryNonDiscount = entry.nonDiscountGross || '';

    var summaryData = csfxBuildDualSummaryData({
      mode: currentMode,
      rate: rate > 0 ? rate : currentRate,
      baseUsd: isFinite(baseTotal) ? baseTotal : 0,
      discountUsd: calc.discount,
      discountPct: pct || 0,
      usdDirect: entry.usdDirect,
      usdFromBs: entry.usdFromBs,
      bsAmount: entry.bsAmount,
      remainderUsd: remainderGross,
      remainderBs: remainderBs,
      decimals: decimals,
      bsDecimals: (FX && FX.decimals) || 2,
      finalUsd: calc.finalTotal
    });
    state.summary = summaryData;
    if (copyBtn) {
      copyBtn.disabled = !(summaryData && summaryData.text);
    }

    csfxResetDualChips(panel);
    var displayGross = calc.grossCovered;
    var displayDiscount = calc.discount;
    var displayRemainingUsd = remainderGross;
    var displayRemainingBs = remainderBs;
    if (currentMode === 'bs') {
      displayGross = isFinite(baseTotal) ? baseTotal : calc.grossCovered;
      displayDiscount = calc.discount;
      displayRemainingUsd = netUsdDue;
      displayRemainingBs = 0;
    }

    panel.dataset.csfxCalcNet = String(calcNetRounded || 0);
    panel.dataset.csfxCalcDiscount = String(calcDiscountRounded || 0);
    panel.dataset.csfxCalcGross = String(round(displayGross, decimals) || 0);
    panel.dataset.csfxCalcRemainder = String(round(displayRemainingUsd, decimals) || 0);

    var metricsMap = {
      'gross': fmtUsd(displayGross),
      'discount': fmtUsd(displayDiscount),
      'remaining-usd': fmtUsd(displayRemainingUsd),
      'remaining-bs': fmtBs(displayRemainingBs)
    };
    Object.keys(metricsMap).forEach(function (key) {
      var node = panel.querySelector('[data-csfx-metric-value="' + key + '"]');
      if (node) node.textContent = metricsMap[key];
    });
    var discountRow = panel.querySelector('[data-csfx-metric="discount"]');
    if (discountRow) {
      if (calc.discount > 0.009) {
        discountRow.classList.add('is-highlight');
      } else {
        discountRow.classList.remove('is-highlight');
      }
    }
    var highlightUsd = currentMode === 'bs' ? netUsdDue : remainderGross;
    var highlightBs = currentMode === 'bs' ? displayRemainingBs : remainderBs;
    var remainingUsdRow = panel.querySelector('[data-csfx-metric="remaining-usd"]');
    if (remainingUsdRow) {
      if (highlightUsd > 0.009) {
        remainingUsdRow.classList.add('is-warning');
      } else {
        remainingUsdRow.classList.remove('is-warning');
      }
    }
    var remainingBsRow = panel.querySelector('[data-csfx-metric="remaining-bs"]');
    if (remainingBsRow) {
      if (highlightBs > 0.009) {
        remainingBsRow.classList.add('is-warning');
      } else {
        remainingBsRow.classList.remove('is-warning');
      }
    }

    var statusParts = [];
    var statusClass = 'csfx-dual-status csfx-dual-status--info';
    if (calc.discount > 0.009) {
      statusParts.push('Desc: ' + fmtUsd(calc.discount));
    } else {
      statusParts.push('Sin descuento');
      statusClass = 'csfx-dual-status csfx-dual-status--warn';
    }
    var paymentParts = [];
    if (netUsdDue > 0.0001) paymentParts.push(fmtUsd(netUsdDue));
    if (entry.bsAmount > 0.0001) paymentParts.push(fmtBs(entry.bsAmount));
    if (paymentParts.length) {
      statusParts.push('Pagos ' + paymentParts.join(' + '));
    }
    if (missingUsd > tolerance) {
      var missingText = fmtUsd(missingUsd);
      if (rate > 0 && missingBs > 0.0001) missingText += ' (≈ ' + fmtBs(missingBs) + ')';
      statusParts.push('Falta ' + missingText);
      statusClass = 'csfx-dual-status csfx-dual-status--warn';
      if (currentMode === 'usd' && rate > 0 && missingBs > 0.0001) {
        statusParts.push('Sugerencia: pasa ' + fmtUsd(missingUsd) + ' a Bs (' + fmtBs(missingBs) + ')');
      }
    } else if (changeUsd > tolerance) {
      var changeText = fmtUsd(changeUsd);
      if (rate > 0 && changeBs > 0.0001) changeText += ' (≈ ' + fmtBs(changeBs) + ')';
      statusParts.push('Cambio ' + changeText);
    }
    if (status) {
      var finalStatusClass = statusClass || 'csfx-dual-status';
      status.textContent = statusParts.join(' · ');
      if (discountWarning) {
        status.textContent += (status.textContent ? ' · ' : '') + discountWarning;
        if (finalStatusClass.indexOf('csfx-dual-status--warn') === -1) {
          finalStatusClass += ' csfx-dual-status--warn';
        }
      }
      status.className = finalStatusClass.trim();
    }

    if (bsAdjust) {
      bsAdjust.innerHTML = '';
      bsAdjust.setAttribute('hidden', 'hidden');
      bsAdjust.removeAttribute('data-open');
      var fractionThreshold = Math.pow(10, -decimals);
      var discountFactor = 1 - pct;
      if (currentMode === 'bs' && rate > 0 && entry.discountableGross > epsilonUsd) {
        if (discountFactor <= 0) discountFactor = 1;
        var maxNetShift = entry.discountableGross * discountFactor;
        if (maxNetShift > fractionThreshold) {
          var baseFloor = Math.floor(netUsdDue + epsilonUsd);
          var candidateTargets = [];
          if (baseFloor >= 0) candidateTargets.push(baseFloor);
          if (baseFloor - 1 >= 0) candidateTargets.push(baseFloor - 1);
          var seenTargets = {};
          var suggestionList = [];
          candidateTargets.forEach(function (target) {
            if (seenTargets[target]) return;
            seenTargets[target] = true;
            var netShift = round(netUsdDue - target, decimals);
            if (netShift <= fractionThreshold) return;
            if (netShift > maxNetShift + epsilonUsd) netShift = round(maxNetShift, decimals);
            if (netShift <= fractionThreshold) return;
            var bsEquivalent = round(netShift * rate, FX.decimals);
            suggestionList.push({ net: netShift, target: target, bs: bsEquivalent });
          });
          if (suggestionList.length) {
            bsAdjust.removeAttribute('hidden');
            bsAdjust.setAttribute('data-open', 'true');
            var intro = document.createElement('span');
            intro.className = 'csfx-dual-adjust-text';
            intro.textContent = 'Sugerencias en Bs:';
            bsAdjust.appendChild(intro);
            var compactCurrency = function (text) {
              if (!text) return '';
              return text.replace(/^([^0-9+\-]+)\s+/, '$1').replace(/\s{2,}/g, ' ').trim();
            };
            suggestionList.forEach(function (suggestion) {
              var btn = document.createElement('button');
              btn.type = 'button';
              btn.dataset.csfxAdjustNet = String(suggestion.net);
              btn.dataset.csfxAdjust = '1';
              var label = '+' + compactCurrency(fmtUsd(suggestion.net)) + ' · ' + compactCurrency(fmtBs(suggestion.bs)) + ' ⇒ ' + compactCurrency(fmtUsd(suggestion.target));
              btn.textContent = label;
              btn.setAttribute('title', '+' + fmtUsd(suggestion.net) + ' (≈ ' + fmtBs(suggestion.bs) + ') → ' + fmtUsd(suggestion.target));
              if (panel.dataset.csfxSelectedSuggest && Math.abs(Number(panel.dataset.csfxSelectedSuggest) - suggestion.net) < 1e-6) {
                btn.classList.add('is-selected');
              }
              var handler = function (ev) {
                if (ev) ev.preventDefault();
                panel.dataset.csfxSelectedSuggest = String(suggestion.net);
                panel.querySelectorAll('[data-csfx-adjust]').forEach(function(other){
                  if (other === btn) {
                    other.classList.add('is-selected');
                  } else {
                    other.classList.remove('is-selected');
                  }
                });
                csfxAdjustBs(panel, suggestion.net);
              };
              btn.addEventListener('pointerdown', handler);
              btn.addEventListener('click', handler);
              bsAdjust.appendChild(btn);
            });
          }
        }
      }
    }
    return panel;
  }

  function csfxAdjustBs(panel, remainderUsd) {
    if (!panel || !isFinite(remainderUsd) || remainderUsd <= 0) return;
    var state = csfxDualState(panel);
    var bsUsdInput = panel.querySelector('input[data-csfx=\"usd-net-bs\"]');
    if (!bsUsdInput) return;
    panel.dataset.csfxEntryMode = 'bs';
    panel.dataset.csfxDirty = '1';
    state.inputs.bsUsd = bsUsdInput;
    var bsRawInput = panel.querySelector('input[data-csfx=\"bs-manual\"]');
    if (bsRawInput) state.inputs.bsRaw = bsRawInput;
    var manualMode = panel.dataset ? panel.dataset.csfxBsManualMode : '';
    var usingRaw = !!(bsRawInput && (manualMode === 'raw' || document.activeElement === bsRawInput || csfxDualNormalizeValue(bsRawInput.value) > 0));
    var decimals = (FX && FX.decimals) || 2;
    var rate = Number(FX && FX.rate ? FX.rate : 0);
    if (!isFinite(rate)) rate = 0;
    var prevUsd = csfxToNumber(panel.dataset.csfxEntryUsdFromBs);
    if (!isFinite(prevUsd) || prevUsd < 0) prevUsd = csfxDualNormalizeValue(bsUsdInput.value);
    if (!isFinite(prevUsd)) prevUsd = 0;

    if (usingRaw && rate > 0) {
      var currentBs = csfxDualNormalizeValue(bsRawInput.value);
      if (!isFinite(currentBs)) currentBs = 0;
      var updatedBs = round(currentBs + remainderUsd * rate, FX.decimals);
      bsRawInput.value = updatedBs.toFixed(FX.decimals);
      var updatedUsdFromRaw = round(updatedBs / rate, decimals);
      if (bsUsdInput) {
        bsUsdInput.value = csfxFormatInputNumber(updatedUsdFromRaw, decimals);
      }
      if (bsUsdInput.dataset) {
        bsUsdInput.dataset.csfxManualBs = String(updatedBs);
        bsUsdInput.dataset.csfxTouched = '1';
      }
      panel.dataset.csfxEntryUsdFromBs = String(updatedUsdFromRaw);
      panel.dataset.csfxEntryBs = String(updatedBs);
      csfxDualMarkDirty(panel, bsRawInput);
      try {
        var evtRaw = new Event('input', { bubbles: true });
        bsRawInput.dispatchEvent(evtRaw);
      } catch (_errDispatchRaw) {}
    } else {
      var updatedUsd = round(prevUsd + remainderUsd, decimals);
      bsUsdInput.value = csfxFormatInputNumber(updatedUsd, decimals);
      if (bsUsdInput.dataset) {
        bsUsdInput.dataset.csfxTouched = '1';
        if (rate > 0) {
          var manualBs = round(updatedUsd * rate, FX.decimals);
          bsUsdInput.dataset.csfxManualBs = String(manualBs);
          if (bsRawInput) bsRawInput.value = manualBs.toFixed(FX.decimals);
        }
      }
      panel.dataset.csfxEntryUsdFromBs = String(updatedUsd);
      if (rate > 0) panel.dataset.csfxEntryBs = String(round(updatedUsd * rate, FX.decimals));
      csfxDualMarkDirty(panel, bsUsdInput);
      try {
        var evtUsd = new Event('input', { bubbles: true });
        bsUsdInput.dispatchEvent(evtUsd);
      } catch (_errDispatchUsd) {}
    }
    csfxUpdateDualPanel(panel);
  }

  function csfxBuildDualSummaryData(context) {
    if (!context) return null;
    var mode = context.mode || 'usd';
    var rate = Number(context.rate || 0);
    var baseUsd = Number(context.baseUsd || 0);
    var discountUsd = Number(context.discountUsd || 0);
    var discountPct = Number(context.discountPct || 0);
    var usdDirect = Number(context.usdDirect || 0);
    var usdFromBs = Number(context.usdFromBs || 0);
    var bsAmount = Number(context.bsAmount || 0);
    var remainderUsd = Number(context.remainderUsd || 0);
    var remainderBs = Number(context.remainderBs || 0);
    var decimals = Number(context.decimals || ((FX && FX.decimals) || 2));
    var bsDecimals = Number(context.bsDecimals || ((FX && FX.decimals) || 2));
    var epsilonUsd = Math.pow(10, -(decimals + 1));
    var epsilonBs = Math.pow(10, -(bsDecimals + 1));
    var hasData = false;
    if (mode === 'usd') {
      hasData = (usdDirect > epsilonUsd) || (remainderBs > epsilonBs);
    } else {
      hasData = (bsAmount > epsilonBs) || (remainderUsd > epsilonUsd);
    }
    if (!hasData) return null;

    var finalUsd = Number(context.finalUsd || 0);
    var finalBs = (rate > 0 && finalUsd > 0) ? fmtBs(round(finalUsd * rate, FX.decimals)) : '';

    var lines = [];
    lines.push(mode === 'bs' ? '*Precio dual – Pago en Bs*' : '*Precio dual – ' + CSFX_BASE_CODE + ' directo*');
    if (rate > 0) lines.push('• *Tasa BCV:* ' + fmtBs(rate));
    if (baseUsd > epsilonUsd) lines.push('• *Base sin descuento:* ' + fmtUsd(baseUsd));

    var pctText = discountPct > 0 ? (discountPct * 100).toFixed(2).replace(/\.00$/, '') + '%' : '';
    lines.push('• *Descuento:* ' + (discountUsd > epsilonUsd ? fmtUsd(discountUsd) + (pctText ? ' (' + pctText + ')' : '') : '—'));

    if (finalUsd > epsilonUsd) {
      var totalLine = '• *Total estimado con descuento:* ' + fmtUsd(finalUsd);
      if (finalBs) totalLine += ' (≈ ' + finalBs + ')';
      lines.push(totalLine);
    }

  if (mode === 'usd') {
    if (usdDirect > epsilonUsd) lines.push('• *Debe entregar en ' + CSFX_BASE_CODE + ':* ' + fmtUsd(usdDirect));
    if (remainderBs > epsilonBs) {
      var approxUsd = remainderUsd > epsilonUsd ? fmtUsd(remainderUsd) : null;
      var bsLine = '• *Debe completar en Bs:* ' + fmtBs(remainderBs);
      if (approxUsd) bsLine += ' (≈ ' + approxUsd + ')';
      lines.push(bsLine);
    }
  } else {
    if (bsAmount > epsilonBs) {
      var approxUsd = usdFromBs > epsilonUsd ? fmtUsd(usdFromBs) : null;
      var bsLine = '• *Debe entregar en Bs:* ' + fmtBs(bsAmount);
      if (approxUsd) bsLine += ' (≈ ' + approxUsd + ')';
      lines.push(bsLine);
    }
    if (remainderUsd > epsilonUsd) {
      var approxBs = rate > 0 ? fmtBs(round(remainderUsd * rate, FX.decimals)) : null;
      var remLine = '• *Saldo en ' + CSFX_BASE_CODE + ':* ' + fmtUsd(remainderUsd);
      if (approxBs) remLine += ' (≈ ' + approxBs + ')';
      lines.push(remLine);
    }
  }

    lines.push('_Valores informativos antes de facturar._');

    var payload = {
      mode: mode,
      rate: rate,
      baseUsd: baseUsd,
      discountUsd: discountUsd,
      discountPct: discountPct,
      finalUsd: finalUsd,
      usdDirect: usdDirect,
      usdFromBs: usdFromBs,
      bsAmount: bsAmount,
      remainderUsd: remainderUsd,
      remainderBs: remainderBs
    };

    return { mode: mode, text: lines.join('\n'), data: payload };
  }

  function csfxCopyDualSummary(panel) {
    if (!panel) return;
    var state = csfxDualState(panel);
    var summary = state && state.summary;
    var status = panel.querySelector('[data-csfx="status"]');
    if (!summary || !summary.text) {
      if (status) {
        status.textContent = 'Genera un monto antes de copiar el resumen.';
        status.className = 'csfx-dual-status csfx-dual-status--warn';
      }
      return;
    }
    var text = summary.text;
    var handleSuccess = function () {
      if (status) {
        status.textContent = 'Resumen copiado al portapapeles.';
        status.className = 'csfx-dual-status csfx-dual-status--info';
      }
    };
    var handleFailure = function () {
      if (status) {
        status.textContent = 'No se pudo copiar automáticamente. Selecciona y copia manualmente.';
        status.className = 'csfx-dual-status csfx-dual-status--warn';
      }
    };
    var fallbackCopy = function () {
      try {
        var temp = document.createElement('textarea');
        temp.value = text;
        temp.setAttribute('readonly', '');
        temp.style.position = 'absolute';
        temp.style.left = '-9999px';
        document.body.appendChild(temp);
        temp.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(temp);
        if (ok) {
          handleSuccess();
          return true;
        }
      } catch (_errFallback) {}
      return false;
    };
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text)
        .then(handleSuccess)
        .catch(function () {
          if (!fallbackCopy()) handleFailure();
        });
    } else {
      if (!fallbackCopy()) handleFailure();
    }
  }

  function csfxHandleDualConfirm(panel) {
    if (!panel) return;
    var status = panel.querySelector('[data-csfx="status"]');
    var pct = csfxDiscountDecimal();
    var snapshot = csfxGetCartSnapshot({ totalUSD: readCheckoutUSD() });
    var replacingCurrent = csfxHasGlobalDiscount(snapshot);
    if (replacingCurrent) {
      if (status) {
        var discCurrent = snapshot.discountAmount || window.__CSFX_LAST_DISCOUNT_USD || 0;
        status.textContent = 'Ya existe un descuento global (' + fmtUsd(discCurrent) + '). Elimina el actual antes de aplicar otro.';
        status.className = 'csfx-dual-status csfx-dual-status--error';
      }
      return;
    }
    var baseTotal = snapshot.baseTotalUSD;
    if ((!isFinite(baseTotal) || baseTotal <= 0) && snapshot.meta && snapshot.meta.csfx_base_total) {
      var metaBase = csfxToNumber(snapshot.meta.csfx_base_total);
      if (isFinite(metaBase) && metaBase > 0) baseTotal = metaBase;
    }
    if ((!isFinite(baseTotal) || baseTotal <= 0) && window.__CSFX_LAST_BASE_USD) {
      var cachedBase = Number(window.__CSFX_LAST_BASE_USD);
      if (isFinite(cachedBase) && cachedBase > 0) baseTotal = cachedBase;
    }
    if (!isFinite(baseTotal) || baseTotal <= 0) {
      csfxDualLog('confirm:no-base-total', { snapshot: snapshot, entry: entry });
      if (status) {
        status.textContent = 'No hay total disponible para aplicar el descuento.';
        status.className = 'csfx-dual-status csfx-dual-status--error';
      }
      return;
    }
    var entry = csfxDualReadEntry(panel, { baseTotal: baseTotal, pct: pct });
    if (!entry || (!entry.hasValue && entry.mode !== 'bs')) {
      csfxDualLog('confirm:invalid-entry', { entry: entry });
      if (status) {
        status.textContent = 'Ingresa un monto válido.';
        status.className = 'csfx-dual-status csfx-dual-status--error';
      }
      return;
    }
    if (entry.errors && entry.errors.length) {
      csfxDualLog('confirm:entry-errors', { entry: entry });
      if (status) {
        status.textContent = entry.errors[0];
        status.className = 'csfx-dual-status csfx-dual-status--error';
      }
      return;
    }
    var calc = csfxComputeDual(entry.discountableGross, entry.netForDiscount, pct);
    csfxDualLog('confirm:calc', {
      baseTotal: baseTotal,
      entry: entry,
      pct: pct,
      cartFound: !!snapshot.cart,
      cartSource: snapshot.cartSource,
      hasService: !!snapshot.cartService,
      cartDebug: snapshot.cartDebug,
      calc: calc,
      replacingExisting: replacingCurrent
    });
    if (!calc || calc.discount <= 0) {
      csfxDualLog('confirm:no-discount', { calc: calc, entry: entry });
      if (status) {
        status.textContent = 'Con este monto no se genera descuento.';
        status.className = 'csfx-dual-status csfx-dual-status--warn';
      }
      return;
    }
    var success = csfxApplyDualDiscount(snapshot, calc, null, entry);
    csfxDualLog('confirm:apply-result', {
      success: success,
      discount: calc.discount,
      cartFound: !!snapshot.cart,
      remainderUsd: calc.remainderUsd,
      manualVia: snapshot.cartDebug && snapshot.cartDebug.manualVia ? snapshot.cartDebug.manualVia : null,
      replacingExisting: replacingCurrent,
      entry: entry
    });
    if (status) {
      status.classList.remove('csfx-dual-status--warn', 'csfx-dual-status--info', 'csfx-dual-status--error', 'csfx-dual-status--ok');
      if (success) {
        var message = 'Descuento aplicado: ' + fmtUsd(calc.discount);
        var decimals = (FX && FX.decimals) || 2;
        var diff = round((entry.usdDirect + entry.usdFromBs) - (calc.netEffective + entry.usdFromBs), decimals);
        var tolerance = Math.max(0.01, Math.pow(10, -(decimals + 1)));
        if (Math.abs(diff) <= tolerance) diff = 0;
        if (diff > 0.0001) {
          message += ' · Cambio ' + fmtUsd(diff);
          if (entry.rate > 0) message += ' (≈ ' + fmtBs(round(diff * entry.rate, FX.decimals)) + ')';
        } else if (diff < -0.0001) {
          var missingDiff = Math.abs(diff);
          message += ' · Faltante ' + fmtUsd(missingDiff);
          if (entry.rate > 0) message += ' (≈ ' + fmtBs(round(missingDiff * entry.rate, FX.decimals)) + ')';
        }
        status.textContent = message;
        status.classList.add('csfx-dual-status', 'csfx-dual-status--ok');
      } else {
        status.textContent = 'No se pudo aplicar el descuento.';
        status.classList.add('csfx-dual-status', 'csfx-dual-status--error');
      }
    }
    if (success) {
      window.__CSFX_LAST_DISCOUNT_USD = calc.discount;
      if (isFinite(baseTotal) && baseTotal > 0) {
        window.__CSFX_LAST_BASE_USD = baseTotal;
      }
      panel.dataset.csfxDirty = '';
      var state = csfxDualState(panel);
      var directInput = state.inputs && state.inputs.usd ? state.inputs.usd : panel.querySelector('input[data-csfx="usd-net"]');
      if (directInput && directInput.dataset) directInput.dataset.csfxTouched = '';
      csfxRenderBadgeContent(document.querySelector('.csfx-badge'));
      schedule(decorateCart);
      schedule(decorateTotals);
      schedule(decoratePaymentModal);
      schedule(decorateBill);
      var badge = document.querySelector('.csfx-badge');
      if (badge && badge.classList && badge.classList.contains('open')) {
        badge.classList.remove('open');
      }
      csfxUpdateDualPanel(panel);
    }
  }

  function csfxEnsureExplainModal() {
    if (csfxExplainModalUI && csfxExplainModalUI.backdrop && document.body.contains(csfxExplainModalUI.backdrop)) {
      return csfxExplainModalUI;
    }
    var backdrop = document.createElement('div');
    backdrop.className = 'csfx-modal-backdrop csfx-modal-backdrop--info';
    var modal = document.createElement('div');
    modal.className = 'csfx-modal csfx-modal--info';
    var header = document.createElement('div');
    header.className = 'csfx-modal-header';
    var headerTitle = document.createElement('div');
    headerTitle.className = 'csfx-modal-header-title';
    var icon = document.createElement('span');
    icon.className = 'csfx-modal-header-icon';
    icon.textContent = 'ℹ️';
    var titleText = document.createElement('span');
    titleText.textContent = 'Detalle del descuento';
    headerTitle.appendChild(icon);
    headerTitle.appendChild(titleText);
    var headerRef = document.createElement('span');
    headerRef.className = 'csfx-modal-header-ref';
    headerRef.textContent = 'Explicación';
    header.appendChild(headerTitle);
    header.appendChild(headerRef);
    var body = document.createElement('div');
    body.className = 'csfx-modal-body';
    var footer = document.createElement('div');
    footer.className = 'csfx-modal-footer';
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'csfx-btn csfx-btn--ghost';
    closeBtn.textContent = 'Cerrar';
    footer.appendChild(closeBtn);
    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(footer);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    var close = function () { csfxCloseExplainModal(); };
    closeBtn.addEventListener('click', close);
    header.addEventListener('click', close);
    backdrop.addEventListener('click', function (ev) {
      if (ev.target === backdrop) close();
    });
    modal.addEventListener('click', function (ev) {
      ev.stopPropagation();
    });

    csfxExplainModalUI = {
      backdrop: backdrop,
      modal: modal,
      header: header,
      body: body,
      footer: footer,
      closeBtn: closeBtn,
      open: false
    };
    return csfxExplainModalUI;
  }

  function csfxCloseExplainModal() {
    if (!csfxExplainModalUI || !csfxExplainModalUI.backdrop) return;
    csfxExplainModalUI.backdrop.removeAttribute('data-open');
    csfxExplainModalUI.open = false;
  }

  function csfxOpenDualExplainModal(panel) {
    var ui = csfxEnsureExplainModal();
    if (!ui) return;
    if (typeof document !== 'undefined' && !document.body.contains(ui.backdrop)) {
      document.body.appendChild(ui.backdrop);
    }
    var state = csfxDualState(panel);
    var summary = state && state.summary;
    var payload = summary && summary.data ? summary.data : null;
    var base = payload ? Number(payload.baseUsd || 0) : (Number(panel && panel.dataset ? panel.dataset.csfxBase : 0) || 0);
    var discount = payload ? Number(payload.discountUsd || 0) : (Number(panel && panel.dataset ? panel.dataset.csfxCalcDiscount : 0) || 0);
    var pctStored = payload ? Number(payload.discountPct || 0) : (Number(panel && panel.dataset ? panel.dataset.csfxPct : 0) || 0);
    var pctDisplay = pctStored;
    if (pctDisplay > 0 && pctDisplay < 1) pctDisplay = pctDisplay * 100;
    var netDataset = Number(panel && panel.dataset ? panel.dataset.csfxCalcNet : 0) || 0;
    var net = payload ? (payload.mode === 'bs' ? (Number(payload.usdFromBs || 0) || netDataset) : (Number(payload.usdDirect || 0) || netDataset)) : netDataset;
    var grossCovered = Number(panel && panel.dataset ? panel.dataset.csfxCalcGross : 0) || 0;
    if (!grossCovered && payload) {
      var possibleGross = Number(payload.baseUsd || 0) - Number(payload.remainderUsd || 0);
      if (isFinite(possibleGross) && possibleGross >= 0) grossCovered = possibleGross;
    }
    var remainderUsd = payload ? Number(payload.remainderUsd || 0) : (Number(panel && panel.dataset ? panel.dataset.csfxCalcRemainder : 0) || 0);
    var total = payload ? Number(payload.finalUsd || 0) : (base && discount ? base - discount : 0);

  var mode = payload && payload.mode ? payload.mode : (panel && panel.dataset ? panel.dataset.csfxEntryMode : '');
  var modeLabel = mode === 'bs' ? 'Bs' : (mode === 'usd' ? (CSFX_BASE_CODE + ' directo') : (mode || '—'));
    var usdDirectEntry = payload ? Number(payload.usdDirect || 0) : (Number(panel && panel.dataset ? panel.dataset.csfxEntryUsd : 0) || 0);
    var usdFromBsEntry = payload ? Number(payload.usdFromBs || 0) : (Number(panel && panel.dataset ? panel.dataset.csfxEntryUsdFromBs : 0) || 0);
    var bsEntry = payload ? Number(payload.bsAmount || 0) : (Number(panel && panel.dataset ? panel.dataset.csfxEntryBs : 0) || 0);
    var changeUsdEntry = Number(panel && panel.dataset ? panel.dataset.csfxEntryChange : 0) || 0;
    var missingUsdEntry = Number(panel && panel.dataset ? panel.dataset.csfxEntryMissing : 0) || 0;
    var rateEntry = payload ? Number(payload.rate || 0) : (Number(panel && panel.dataset ? panel.dataset.csfxEntryRate : 0) || 0);
    var changeBsEntry = rateEntry > 0 ? changeUsdEntry * rateEntry : 0;
    var missingBsEntry = rateEntry > 0 ? missingUsdEntry * rateEntry : 0;

    if (!isFinite(base) || base <= 0 || !isFinite(discount) || discount <= 0) {
      ui.body.innerHTML = '<div class="csfx-explain-body"><p>No hay datos suficientes. Introduce el pago en divisas y calcula el descuento primero.</p></div>';
      ui.backdrop.setAttribute('data-open', 'true');
      ui.open = true;
      return;
    }

    var remainderBs = payload ? Number(payload.remainderBs || 0) : usd2bs(remainderUsd);
    if (rateEntry > 0 && (!remainderBs || remainderBs < 0.0001)) {
      remainderBs = remainderUsd * rateEntry;
    }
    var paymentsItems = [];
  paymentsItems.push('<li><strong>Debe entregar en ' + CSFX_BASE_CODE + ':</strong> <span class="csfx-explain-inline">' + fmtUsd(usdDirectEntry) + '</span></li>');
  paymentsItems.push('<li><strong>Debe entregar en Bs:</strong> <span class="csfx-explain-inline">' + fmtBs(bsEntry) + (bsEntry > 0 ? ' (≈ ' + fmtUsd(usdFromBsEntry) + ')' : '') + '</span></li>');
  var totalEntregar = usdDirectEntry + usdFromBsEntry;
  if (totalEntregar > 0.0001) {
    paymentsItems.push('<li><strong>Total referencial (' + CSFX_BASE_CODE + ' + Bs):</strong> <span class="csfx-explain-inline">' + fmtUsd(totalEntregar) + (bsEntry > 0 ? ' + ' + fmtBs(bsEntry) : '') + '</span></li>');
  }
    if (changeUsdEntry > 0.0001) {
      var changeLine = '<li><strong>Se estima cambio:</strong> <span class="csfx-explain-inline">' + fmtUsd(changeUsdEntry);
      if (rateEntry > 0 && changeBsEntry > 0.0001) changeLine += ' (≈ ' + fmtBs(changeBsEntry) + ')';
      changeLine += '</span></li>';
      paymentsItems.push(changeLine);
    }
    if (missingUsdEntry > 0.0001) {
      var pendingLine = '<li><strong>Saldo estimado por cobrar:</strong> <span class="csfx-explain-inline">' + fmtUsd(missingUsdEntry);
      if (rateEntry > 0 && missingBsEntry > 0.0001) pendingLine += ' (≈ ' + fmtBs(missingBsEntry) + ')';
      pendingLine += '</span></li>';
      paymentsItems.push(pendingLine);
    }
    var paymentsHtml = paymentsItems.join('');
    var pctText = isFinite(pctDisplay) ? pctDisplay.toFixed(2) + '%' : '—';
    var explainHtml = '' +
      '<div class="csfx-explain-body">' +
        '<div class="csfx-explain-head">¿Cómo se calcula este descuento?</div>' +
        '<ul class="csfx-explain-steps">' +
          '<li><strong>1.</strong> Base sin descuento (subtotal): <span class="csfx-explain-inline">' + fmtUsd(base) + '</span></li>' +
          '<li><strong>2.</strong> Monto referencial declarado en divisas: <span class="csfx-explain-inline">' + fmtUsd(net) + '</span></li>' +
          '<li><strong>3.</strong> Porción de la base cubierta por esas divisas: <span class="csfx-explain-inline">' + fmtUsd(grossCovered) + '</span></li>' +
          '<li><strong>4.</strong> Porcentaje configurado para este descuento: <span class="csfx-explain-inline">' + pctText + '</span></li>' +
          '<li><strong>5.</strong> Descuento estimado = porción cubierta × % = <span class="csfx-explain-inline">' + fmtUsd(grossCovered) + ' × ' + pctText + ' = ' + fmtUsd(discount) + '</span></li>' +
          '<li><strong>6.</strong> Total estimado con descuento: <span class="csfx-explain-inline">' + fmtUsd(total) + '</span></li>' +
          '<li><strong>7.</strong> Saldo estimado por cobrar: <span class="csfx-explain-inline">' + fmtUsd(remainderUsd) + ' / ' + fmtBs(remainderBs) + '</span></li>' +
        '</ul>' +
        '<div class="csfx-explain-subtitle">Referencia de cobro' + (mode ? ' (' + modeLabel + ')' : '') + '</div>' +
        '<ul class="csfx-explain-steps csfx-explain-steps--secondary">' + paymentsHtml + '</ul>' +
        '<div class="csfx-explain-foot">Comparte este detalle con el cliente para indicar cuánto debe entregar en cada medio al momento del cobro final.</div>' +
      '</div>';

    ui.body.innerHTML = explainHtml;
    ui.backdrop.setAttribute('data-open', 'true');
    ui.open = true;
  }

  function csfxEnsureFullDiscountConfirmModal() {
    if (csfxFullConfirmUI && csfxFullConfirmUI.backdrop && document.body.contains(csfxFullConfirmUI.backdrop)) {
      return csfxFullConfirmUI;
    }
    if (typeof document === 'undefined') return null;
    var backdrop = document.createElement('div');
    backdrop.className = 'csfx-modal-backdrop';
    var modal = document.createElement('div');
    modal.className = 'csfx-modal csfx-modal--confirm';
    var header = document.createElement('div');
    header.className = 'csfx-modal-header';
    var headerTitle = document.createElement('div');
    headerTitle.className = 'csfx-modal-header-title';
    var headerIcon = document.createElement('span');
    headerIcon.className = 'csfx-modal-header-icon';
    headerIcon.textContent = '⚠️';
    var headerText = document.createElement('span');
    headerText.textContent = 'Confirmar descuento total';
    headerTitle.appendChild(headerIcon);
    headerTitle.appendChild(headerText);
    header.appendChild(headerTitle);
    var body = document.createElement('div');
    body.className = 'csfx-modal-body csfx-confirm-body';
    var icon = document.createElement('div');
    icon.className = 'csfx-confirm-icon';
    icon.textContent = '⚠️';
    var message = document.createElement('div');
    message.className = 'csfx-confirm-message';
    message.textContent = '¿Deseas aplicar el descuento total?';
    var note = document.createElement('div');
    note.className = 'csfx-confirm-note';
    var footer = document.createElement('div');
    footer.className = 'csfx-modal-footer';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'csfx-btn csfx-btn--ghost';
    cancelBtn.textContent = 'Cancelar';
    var acceptBtn = document.createElement('button');
    acceptBtn.type = 'button';
    acceptBtn.className = 'csfx-btn csfx-btn--primary';
    acceptBtn.textContent = 'Sí, aplicar descuento total';
    footer.appendChild(cancelBtn);
    footer.appendChild(acceptBtn);
    body.appendChild(icon);
    body.appendChild(message);
    body.appendChild(note);
    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(footer);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    csfxFullConfirmUI = {
      backdrop: backdrop,
      modal: modal,
      header: header,
      message: message,
      note: note,
      acceptBtn: acceptBtn,
      cancelBtn: cancelBtn,
      icon: icon
    };

    var closeHandler = function () { csfxCloseFullDiscountConfirm(); };
    cancelBtn.addEventListener('click', closeHandler);
    header.addEventListener('click', closeHandler);
    backdrop.addEventListener('click', function (ev) {
      if (ev.target === backdrop) csfxCloseFullDiscountConfirm();
    });
    document.addEventListener('keydown', function (ev) {
      if (!csfxFullConfirmUI || !csfxFullConfirmUI.backdrop) return;
      if (csfxFullConfirmUI.backdrop.getAttribute('data-open') !== 'true') return;
      if (ev.key === 'Escape') {
        csfxCloseFullDiscountConfirm();
      }
    });
    return csfxFullConfirmUI;
  }

  function csfxCloseFullDiscountConfirm() {
    if (!csfxFullConfirmUI || !csfxFullConfirmUI.backdrop) return;
    csfxFullConfirmUI.backdrop.removeAttribute('data-open');
    if (csfxFullConfirmUI.acceptBtn) csfxFullConfirmUI.acceptBtn.onclick = null;
    if (csfxFullConfirmUI.cancelBtn) csfxFullConfirmUI.cancelBtn.onclick = null;
  }

  function csfxPromptFullDiscountOverride(options) {
    options = options || {};
    var manualValue = Number(options.manualValue || 0);
    var baseValue = Number(options.base || 0);
    var onConfirm = typeof options.onConfirm === 'function' ? options.onConfirm : null;
    var onCancel = typeof options.onCancel === 'function' ? options.onCancel : null;
    var ui = csfxEnsureFullDiscountConfirmModal();
    if (!ui) {
      if (onConfirm) onConfirm();
      return;
    }
    var manualText = isFinite(manualValue) && manualValue > 0 ? fmtUsd(manualValue) : 'un monto';
    var baseText = isFinite(baseValue) && baseValue > 0 ? fmtUsd(baseValue) : 'el total actual';
    ui.message.innerHTML = 'Ingresaste <strong>' + manualText + '</strong> en el campo de pago en divisas.';
    ui.note.textContent = 'Si aplicas el descuento total, ignoraremos ese monto y usaremos ' + baseText + ' como base.';
    ui.acceptBtn.textContent = 'Sí, aplicar descuento total';
    ui.cancelBtn.textContent = 'Mantener monto';
    ui.acceptBtn.onclick = function () {
      csfxCloseFullDiscountConfirm();
      if (onConfirm) onConfirm();
    };
    ui.cancelBtn.onclick = function () {
      csfxCloseFullDiscountConfirm();
      if (onCancel) onCancel();
    };
    ui.backdrop.setAttribute('data-open', 'true');
    setTimeout(function () {
      try { ui.acceptBtn.focus(); } catch (_errFocusConfirm) {}
    }, 40);
  }

  function csfxEnsureCustomDiscountModal() {
    if (csfxCustomModalUI && csfxCustomModalUI.backdrop && document.body.contains(csfxCustomModalUI.backdrop)) {
      return csfxCustomModalUI;
    }
    var backdrop = document.createElement('div');
    backdrop.className = 'csfx-modal-backdrop csfx-modal-backdrop--custom';
    var modal = document.createElement('div');
    modal.className = 'csfx-modal';
    var header = document.createElement('div');
    header.className = 'csfx-modal-header';
    var headerTitle = document.createElement('div');
    headerTitle.className = 'csfx-modal-header-title';
    var headerIcon = document.createElement('span');
    headerIcon.className = 'csfx-modal-header-icon';
    headerIcon.textContent = '🛡️';
    var headerText = document.createElement('span');
    headerText.textContent = 'Descuentos personalizados';
    headerTitle.appendChild(headerIcon);
    headerTitle.appendChild(headerText);
    var headerRef = document.createElement('span');
    headerRef.className = 'csfx-modal-header-ref';
    headerRef.textContent = 'Referencia POS';
    headerRef.setAttribute('data-empty', 'true');
    header.appendChild(headerTitle);
    header.appendChild(headerRef);
    var body = document.createElement('div');
    body.className = 'csfx-modal-body';

    var authCard = document.createElement('div');
    authCard.className = 'csfx-auth-card';
    var authTitle = document.createElement('div');
    authTitle.className = 'csfx-auth-title';
    authTitle.textContent = 'Autorización requerida';
    var authHint = document.createElement('div');
    authHint.className = 'csfx-auth-hint';
    authHint.textContent = 'El encargado puede escanear su QR o ingresar la contraseña para habilitar descuentos por producto.';
    var refChip = document.createElement('div');
    refChip.className = 'csfx-auth-ref-chip';
    var refIcon = document.createElement('span');
    refIcon.className = 'csfx-auth-ref-icon';
    refIcon.textContent = '🔐';
    var refText = document.createElement('span');
    refText.className = 'csfx-auth-ref-text';
    refText.textContent = 'Escanea el QR del supervisor';
    refChip.appendChild(refIcon);
    refChip.appendChild(refText);
    var authRow = document.createElement('div');
    authRow.className = 'csfx-auth-row';
    var pinInput = document.createElement('input');
    pinInput.type = 'password';
    pinInput.placeholder = 'PIN o código del supervisor';
    pinInput.autocomplete = 'one-time-code';
    pinInput.inputMode = 'numeric';
    pinInput.maxLength = 12;
    var validateBtn = document.createElement('button');
    validateBtn.type = 'button';
    validateBtn.className = 'csfx-btn csfx-btn--primary csfx-btn--wide';
    validateBtn.textContent = 'Validar';
    var scanBtn = document.createElement('button');
    scanBtn.type = 'button';
    scanBtn.className = 'csfx-btn csfx-btn--link';
    scanBtn.textContent = 'Escanear QR';
    authRow.appendChild(pinInput);
    authRow.appendChild(validateBtn);
    authRow.appendChild(scanBtn);
    var authStatus = document.createElement('div');
    authStatus.className = 'csfx-auth-status';
    authStatus.textContent = 'Requiere autorización del encargado.';
    authCard.appendChild(authTitle);
    authCard.appendChild(authHint);
    authCard.appendChild(refChip);
    authCard.appendChild(authRow);
    authCard.appendChild(authStatus);

    var infoMessage = document.createElement('div');
    infoMessage.className = 'csfx-auth-info';
    infoMessage.textContent = CSFX_AUTH_INFO_DEFAULT;
    var countdown = document.createElement('div');
    countdown.className = 'csfx-countdown';
    countdown.textContent = '';
    authCard.appendChild(infoMessage);
    authCard.appendChild(countdown);

    var footer = document.createElement('div');
    footer.className = 'csfx-modal-footer';
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'csfx-btn csfx-btn--ghost csfx-btn--wide';
    closeBtn.textContent = 'Cerrar';
    footer.appendChild(closeBtn);

    body.appendChild(authCard);
    body.appendChild(footer);
    modal.appendChild(header);
    modal.appendChild(body);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    csfxCustomModalUI = {
      backdrop: backdrop,
      modal: modal,
      header: header,
      headerRef: headerRef,
      authCard: authCard,
      qrPanel: null,
      pinInput: pinInput,
      validateBtn: validateBtn,
      scanBtn: scanBtn,
      authStatus: authStatus,
      infoMessage: infoMessage,
      countdown: countdown,
      closeBtn: closeBtn,
      refChip: refChip,
      refText: refText
    };

    backdrop.addEventListener('click', function (ev) {
      if (ev.target === backdrop) csfxCloseCustomDiscountModal();
    });
    modal.addEventListener('click', function (ev) {
      ev.stopPropagation();
    });
    header.addEventListener('click', function () {
      if (csfxCustomModalState.open) csfxCloseCustomDiscountModal();
    });
    closeBtn.addEventListener('click', csfxCloseCustomDiscountModal);
    validateBtn.addEventListener('click', function () {
      csfxAttemptCustomPinValidation(pinInput.value, csfxCustomModalUI);
    });
    pinInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        csfxAttemptCustomPinValidation(pinInput.value, csfxCustomModalUI);
      }
    });
    scanBtn.addEventListener('click', function () {
      if (csfxStartNativeQrScan(csfxCustomModalUI)) return;
      csfxInvokeLegacyPinScan(csfxCustomModalUI);
    });

    csfxUpdateAuthorizationReferenceText();
    return csfxCustomModalUI;
  }

  function csfxCloseCustomDiscountModal(options) {
    options = options || {};
    if (!csfxCustomModalUI || !csfxCustomModalUI.backdrop) return;
    csfxStopNativeQrScan();
    if (!options.keepAuthorized) {
      var silent = typeof options.silent === 'boolean' ? options.silent : true;
      csfxDeactivateNativeDiscountControls({ ui: csfxCustomModalUI, silent: silent });
    }
    csfxCustomModalUI.backdrop.removeAttribute('data-open');
    csfxCustomModalState.open = false;
  }

  function csfxOpenCustomDiscountModal(options) {
    options = options || {};
    csfxHideAuthWidget();
    if (options.fromDualPanel) {
      csfxCollapseDualPanel(options.fromDualPanel);
    } else {
      csfxCollapseDualPanel();
    }
    var ui = csfxEnsureCustomDiscountModal();
    csfxCustomModalState.open = true;
    csfxStopNativeQrScan({ keepButtonDisabled: true });
    csfxDeactivateNativeDiscountControls({ ui: ui, silent: true });
    ui.pinInput.value = '';
    ui.pinInput.disabled = false;
    ui.validateBtn.disabled = false;
    ui.scanBtn.disabled = false;
    csfxShowCustomFeedback(ui.authStatus, 'Requiere autorización del encargado.', null);
    if (ui.infoMessage) {
      ui.infoMessage.textContent = CSFX_AUTH_INFO_DEFAULT;
    }
    if (ui.countdown) {
      ui.countdown.textContent = '';
      ui.countdown.removeAttribute('data-active');
    }
    ui.backdrop.setAttribute('data-open', 'true');
    csfxUpdateAuthorizationReferenceText();
    setTimeout(function () {
      try { ui.pinInput.focus(); } catch (_errFocus) {}
    }, 60);
  }
  function csfxValidateCustomDiscountPin(pin) {
    csfxAccessDebugLog('csfxValidateCustomDiscountPin invoked', { pin: pin });
    return new Promise(function (resolve) {
      var resolved = false;
      var detail = {
        pin: pin,
        handled: false,
        respond: function (result) {
          if (resolved) return;
          resolved = true;
          csfxAccessDebugLog('csfxValidateCustomDiscountPin -> detail.respond', { result: !!result, pin: pin });
          resolve(!!result);
        }
      };
      try {
        document.dispatchEvent(new CustomEvent('csfx:validate-custom-discount-pin', { detail: detail }));
        csfxAccessDebugLog('csfxValidateCustomDiscountPin event dispatched', { handled: detail.handled, hasRespond: typeof detail.respond === 'function' });
      } catch (_errDispatch) {
        csfxAccessDebugLog('csfxValidateCustomDiscountPin dispatch error', { error: _errDispatch && _errDispatch.message });
      }
      (function waitFallback(iterations) {
        if (resolved) return;
        if (detail.handled && iterations < 20) {
          csfxAccessDebugLog('csfxValidateCustomDiscountPin waiting for handler', { iteration: iterations, pin: pin });
          return setTimeout(function () { waitFallback(iterations + 1); }, 100);
        }
        if (resolved) return;
        var configured = '';
        try {
          if (FX && typeof FX.customDiscountPin !== 'undefined' && FX.customDiscountPin !== null) {
            configured = String(FX.customDiscountPin).trim();
          } else if (FX && typeof FX.managerPin !== 'undefined' && FX.managerPin !== null) {
            configured = String(FX.managerPin).trim();
          }
        } catch (_errCfg) {}
        if (!configured) {
          configured = '1234';
        }
        resolved = true;
        csfxAccessDebugLog('csfxValidateCustomDiscountPin fallback comparison', { pin: pin, configured: configured, match: pin === configured });
        resolve(pin === configured);
      })(0);
    });
  }

  function csfxAttemptCustomPinValidation(pin, ui) {
    if (!ui) return;
    csfxStopNativeQrScan({ keepButtonDisabled: true });
    var trimmed = String(pin || '').trim();
    csfxAccessDebugLog('csfxAttemptCustomPinValidation', { raw: pin, trimmed: trimmed });
    if (!trimmed) {
      csfxShowCustomFeedback(ui.authStatus, 'Ingresa la contraseña del encargado para continuar.', false);
      try { ui.pinInput.focus(); } catch (_errFocus) {}
      return;
    }
    ui.validateBtn.disabled = true;
    ui.scanBtn.disabled = true;
    csfxShowCustomFeedback(ui.authStatus, 'Validando autorización…', null);
    csfxValidateCustomDiscountPin(trimmed).then(function (ok) {
      csfxAccessDebugLog('csfxAttemptCustomPinValidation result', { success: !!ok, pin: trimmed });
      if (ok) {
        csfxBeginNativeDiscountWindow(ui, trimmed);
      } else {
        csfxDeactivateNativeDiscountControls({ ui: ui, silent: true });
        csfxShowCustomFeedback(ui.authStatus, 'Contraseña incorrecta. Intenta nuevamente.', false);
        ui.pinInput.disabled = false;
        ui.validateBtn.disabled = false;
        ui.scanBtn.disabled = false;
        if (ui.infoMessage) {
          ui.infoMessage.textContent = CSFX_AUTH_INFO_DEFAULT;
        }
        try { ui.pinInput.focus(); } catch (_errFocus) {}
      }
    }).catch(function (err) {
      csfxAccessDebugLog('csfxAttemptCustomPinValidation error', { error: err && err.message ? err.message : err, pin: trimmed });
      csfxDeactivateNativeDiscountControls({ ui: ui, silent: true });
      csfxShowCustomFeedback(ui.authStatus, 'No se pudo validar la contraseña: ' + (err && err.message ? err.message : 'error desconocido'), false);
      ui.validateBtn.disabled = false;
      ui.scanBtn.disabled = false;
    }).finally(function () {
      if (csfxCustomModalState.authorized) {
        ui.validateBtn.disabled = true;
        ui.scanBtn.disabled = true;
      }
    });
  }

  function csfxShowCustomFeedback(node, message, ok) {
    if (!node) return;
    node.textContent = message;
    if (node.classList.contains('csfx-auth-status')) {
      node.classList.remove('csfx-auth-status--ok', 'csfx-auth-status--error');
      if (ok === true) {
        node.classList.add('csfx-auth-status--ok');
      } else if (ok === false) {
        node.classList.add('csfx-auth-status--error');
      }
    }
  }

  function csfxSupportsNativeQrScan() {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') return false;
    if (typeof window.BarcodeDetector === 'function') return true;
    return typeof window.jsQR === 'function';
  }

  function csfxStopNativeQrScan(options) {
    options = options || {};
    if (csfxQrScannerState.raf) {
      cancelAnimationFrame(csfxQrScannerState.raf);
      csfxQrScannerState.raf = 0;
    }
    if (csfxQrScannerState.stream) {
      try {
        csfxQrScannerState.stream.getTracks().forEach(function (track) {
          try { track.stop(); } catch (_errStopTrack) {}
        });
      } catch (_errStopStream) {}
    }
    if (csfxQrScannerState.panel && csfxQrScannerState.panel.parentNode) {
      csfxQrScannerState.panel.parentNode.removeChild(csfxQrScannerState.panel);
    }
    if (csfxQrScannerState.ui && csfxQrScannerState.ui.qrPanel === csfxQrScannerState.panel) {
      csfxQrScannerState.ui.qrPanel = null;
    }
    if (!options.keepButtonDisabled && csfxQrScannerState.ui && csfxQrScannerState.ui.scanBtn) {
      csfxQrScannerState.ui.scanBtn.disabled = false;
    }
    csfxQrScannerState.active = false;
    csfxQrScannerState.panel = null;
    csfxQrScannerState.video = null;
    csfxQrScannerState.stream = null;
    csfxQrScannerState.ui = null;
    csfxQrScannerState.usesDetector = false;
    csfxQrScannerState.canvas = null;
    csfxQrScannerState.ctx = null;
  }

  function csfxStartNativeQrScan(ui) {
    if (!csfxSupportsNativeQrScan() || !ui || !ui.authCard) {
      return false;
    }
    if (csfxQrScannerState.active) {
      return true;
    }
    csfxStopNativeQrScan({ keepButtonDisabled: true });
    var panel = document.createElement('div');
    panel.className = 'csfx-qr-panel';
    var note = document.createElement('div');
    note.className = 'csfx-qr-panel-note';
    note.textContent = 'Alinea el código QR del supervisor dentro del recuadro.';
    var video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.setAttribute('playsinline', 'true');
    var actions = document.createElement('div');
    actions.className = 'csfx-qr-panel-actions';
    var hint = document.createElement('span');
    hint.textContent = 'La cámara se detendrá automáticamente al detectar el código.';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'csfx-btn csfx-btn--ghost';
    cancelBtn.textContent = 'Cancelar';
    cancelBtn.addEventListener('click', function () {
      csfxStopNativeQrScan();
      if (ui.authStatus) {
        csfxShowCustomFeedback(ui.authStatus, 'Escaneo cancelado.', null);
      }
    });
    actions.appendChild(hint);
    actions.appendChild(cancelBtn);
    panel.appendChild(note);
    panel.appendChild(video);
    panel.appendChild(actions);
    ui.authCard.appendChild(panel);
    ui.qrPanel = panel;
    ui.scanBtn.disabled = true;

    csfxQrScannerState.active = true;
    csfxQrScannerState.panel = panel;
    csfxQrScannerState.video = video;
    csfxQrScannerState.ui = ui;
    csfxQrScannerState.usesDetector = typeof window.BarcodeDetector === 'function';

    if (csfxQrScannerState.usesDetector) {
      try {
        csfxQrScannerState.detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      } catch (_errDetector) {
        try {
          csfxQrScannerState.detector = new window.BarcodeDetector();
        } catch (_errDetector2) {
          csfxQrScannerState.detector = null;
        }
      }
      if (!csfxQrScannerState.detector) {
        csfxQrScannerState.usesDetector = false;
      }
    }
    if (!csfxQrScannerState.usesDetector) {
      csfxQrScannerState.detector = null;
      if (typeof window.jsQR !== 'function') {
        csfxStopNativeQrScan();
        return false;
      }
      csfxQrScannerState.canvas = document.createElement('canvas');
      csfxQrScannerState.ctx = csfxQrScannerState.canvas.getContext('2d');
    }

    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } }).then(function (stream) {
      if (!csfxQrScannerState.active) {
        try { stream.getTracks().forEach(function (track) { track.stop(); }); } catch (_errUnused) {}
        return;
      }
      csfxQrScannerState.stream = stream;
      video.srcObject = stream;
      var startLoop = function () {
        if (!csfxQrScannerState.active) return;
        if (ui.authStatus) csfxShowCustomFeedback(ui.authStatus, 'Escaneando código QR…', null);
        csfxQrScannerState.raf = requestAnimationFrame(scanLoop);
      };
      var startAfterMetadata = function () {
        video.removeEventListener('loadedmetadata', startAfterMetadata);
        video.removeEventListener('loadeddata', startAfterMetadata);
        if (!csfxQrScannerState.active) return;
        startLoop();
      };
      if (video.readyState >= 1) {
        startLoop();
      } else {
        video.addEventListener('loadedmetadata', startAfterMetadata, { once: true });
        video.addEventListener('loadeddata', startAfterMetadata, { once: true });
      }
      video.play().catch(function () {
        setTimeout(function () {
          if (csfxQrScannerState.active) startLoop();
        }, 140);
      });
    }).catch(function (err) {
      csfxStopNativeQrScan();
      csfxShowCustomFeedback(ui.authStatus, 'No se pudo acceder a la cámara: ' + (err && err.message ? err.message : 'permiso denegado'), false);
    });

    function scheduleNext() {
      if (!csfxQrScannerState.active) return;
      csfxQrScannerState.raf = requestAnimationFrame(scanLoop);
    }

    function handleValue(value) {
      if (!value) {
        scheduleNext();
        return;
      }
      csfxShowCustomFeedback(ui.authStatus, 'Código detectado, validando…', true);
      csfxStopNativeQrScan({ keepButtonDisabled: true });
      ui.pinInput.value = value;
      csfxAttemptCustomPinValidation(value, ui);
    }

    function scanLoop() {
      if (!csfxQrScannerState.active) return;
      if (csfxQrScannerState.usesDetector && csfxQrScannerState.detector) {
        csfxQrScannerState.detector.detect(video).then(function (codes) {
          if (codes && codes.length) {
            var value = '';
            if (typeof codes[0].rawValue === 'string') {
              value = codes[0].rawValue;
            } else if (codes[0].value) {
              value = codes[0].value;
            }
            if (typeof value === 'string' && value.trim()) {
              handleValue(value.trim());
              return;
            }
          }
          scheduleNext();
        }).catch(scheduleNext);
      } else {
        var canvas = csfxQrScannerState.canvas;
        var ctx = csfxQrScannerState.ctx;
        if (!canvas || !ctx) {
          scheduleNext();
          return;
        }
        var vw = video.videoWidth || video.width;
        var vh = video.videoHeight || video.height;
        if (!vw || !vh) {
          scheduleNext();
          return;
        }
        if (canvas.width !== vw || canvas.height !== vh) {
          canvas.width = vw;
          canvas.height = vh;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        var imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        var code = window.jsQR ? window.jsQR(imageData.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' }) : null;
        if (code && code.data && String(code.data).trim()) {
          handleValue(String(code.data).trim());
          return;
        }
        scheduleNext();
      }
    }
    return true;
  }

  function csfxInvokeLegacyPinScan(ui) {
    var handled = false;
    try {
      var detail = {
        respond: function (pin) {
          handled = true;
          if (typeof pin === 'string' && pin.trim()) {
            ui.pinInput.value = pin.trim();
            csfxAttemptCustomPinValidation(pin, ui);
          }
        }
      };
      document.dispatchEvent(new CustomEvent('csfx:request-custom-pin-scan', { detail: detail }));
      if (!handled) {
        csfxShowCustomFeedback(ui.authStatus, 'Conecta un escáner para recibir la contraseña.', null);
      }
    } catch (_errScan) {
      csfxShowCustomFeedback(ui.authStatus, 'No se pudo iniciar el escaneo.', false);
    }
  }

  try {
    document.addEventListener('csfx:custom-pin-scanned', function (ev) {
      if (!csfxCustomModalState.open || !csfxCustomModalUI || !csfxCustomModalUI.pinInput) return;
      var pin = ev && ev.detail && typeof ev.detail.pin === 'string' ? ev.detail.pin.trim() : '';
      if (!pin) return;
      csfxCustomModalUI.pinInput.value = pin;
      csfxAttemptCustomPinValidation(pin, csfxCustomModalUI);
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        if (csfxCustomModalState.open) {
          csfxCloseCustomDiscountModal();
        } else if (csfxExplainModalUI && csfxExplainModalUI.open) {
          csfxCloseExplainModal();
        }
      }
    });
  } catch (_errCustomScan) {}

// csfx: fin descuento dual
  // csfx: fin descuento dual

  function decoratePaymentModal() {
   if (!FX.rate || !FX.payChips) {
      document.querySelectorAll('.csfx-pay-header-row,[data-csfxpay],.mat-dialog-container .csfx-chip').forEach(function(n){ n.remove(); });
      return;
    }    var modals = document.querySelectorAll('.mat-dialog-container,[role="dialog"]');
    modals.forEach(function (modal) {
      var headerFound = false;
      // buscar encabezado "pagado/total" dentro del modal
      var headers = modal.querySelectorAll('h1,h2,h3,h4,div,span,p,strong,b');
      for (var idx = 0; idx < headers.length; idx++) {
        var el = headers[idx];
        var txt = (el.textContent || '').trim();
        var mm = txt.match(/([0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,][0-9]{1,2}))\s*\/\s*([0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,][0-9]{1,2}))/);
        if (!mm) continue;
        var u1 = parsePrice(mm[1]);
        var u2 = parsePrice(mm[2]);
        if (isNaN(u1) || isNaN(u2)) continue;
        var chipRow = el.nextElementSibling;
        if (!(chipRow && chipRow.classList && chipRow.classList.contains('csfx-pay-header-row'))) {
          chipRow = document.createElement('div');
          chipRow.className = 'csfx-pay-header-row';
        
          el.insertAdjacentElement('afterend', chipRow);
        }
        var diff = (u2 - u1);
        var vals = [u1, u2];
          var labels = ['Pagado', 'Faltante'];
        for (var k = 0; k < vals.length; k++) {
          var child = chipRow.children[k];
          var bsVal = vals[k];
          // para el segundo valor, mostrar la resta (total - pagado) en lugar del total
          if (k === 1) {
            bsVal = diff;
          }
          if (!isNaN(bsVal) && bsVal < 0) bsVal = 0;
          var bs = usd2bs(bsVal);
          if (!child) {
            child = document.createElement('span');
          
            chipRow.appendChild(child);
          }
     child.className = 'csfx-chip csfx-chip--modal';
          child.dataset.csfxPay = labels[k].toLowerCase();
          child.textContent = labels[k] + ': ' + fmtBs(bs);
        }
        // marca este encabezado como decorado para idempotencia, pero siempre actualiza
        el.dataset.csfxPayHeader = '1';
        headerFound = true;
        break;
      }
      // si no hay encabezado, no procesamos esta caja
      if (!headerFound) return;
      // Importe a pagar: busca inputs y actualiza chips
      var inputs = modal.querySelectorAll('input');
      inputs.forEach(function (inp) {
        var value = inp.value || '';
        var usdVal = parsePrice(value);
        if (isNaN(usdVal) || usdVal === 0) {
          // si el campo está vacío, elimina chip asociado
          var cch = inp.nextElementSibling;
          if (cch && cch.classList && cch.classList.contains('csfx-chip')) {
            cch.textContent = '';
          }
          return;
        }
        var chip = inp.nextElementSibling && inp.nextElementSibling.classList && inp.nextElementSibling.classList.contains('csfx-chip') ? inp.nextElementSibling : null;
        if (!chip) {
          chip = document.createElement('span');
          chip.className = 'csfx-chip';
          chip.style.marginLeft = '.5rem';
          inp.after(chip);
        }
        chip.textContent = fmtBs(usd2bs(usdVal));
      });
      // Botones de sugerencia dentro del modal
      var buttons = modal.querySelectorAll('button');
      buttons.forEach(function (btn) {
        var txtb = (btn.textContent || '').trim();
        var nb = txtb.match(/([0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,][0-9]{1,2}))/);
        if (!nb) return;
        var usdBtn = parsePrice(nb[1]);
        if (isNaN(usdBtn) || usdBtn === 0) {
          var c2 = btn.querySelector('.csfx-chip');
          if (c2) c2.textContent = '';
          return;
        }
        var chip2 = btn.querySelector('.csfx-chip');
        if (!chip2) {
          chip2 = document.createElement('span');
          chip2.className = 'csfx-chip';
          chip2.style.marginLeft = '.4rem';
          btn.appendChild(chip2);
        }
        chip2.textContent = fmtBs(usd2bs(usdBtn));
      });
    });
  }
    function decorateBill() {
   if (!FX.rate) {
      document.querySelectorAll('.csfx-bill-bs').forEach(function(n){ n.remove(); });
      return;
    }    var cont = document.getElementById('bill-products') || document.getElementById('bill_products') || document.querySelector('.bill-products');
    if (!cont) return;
    var rows = cont.querySelectorAll('tr[id^="item-"], tr');
    rows.forEach(function (r) {
      var priceCell = r.querySelector('td:last-child');
      if (!priceCell) return;
      var usd = parsePrice(priceCell.textContent);
      if (isNaN(usd)) return;
      var mark = priceCell.querySelector('.csfx-bill-bs');
      if (!mark) {
        mark = document.createElement('div');
        mark.className = 'csfx-bill-bs';
        mark.style.fontSize = '11px';
        mark.style.color = FX.style.bsColor || '#0057b7';
        priceCell.appendChild(mark);
      }
      mark.textContent = fmtBs(usd2bs(usd));
    });
  }
  var obsTotals = null;
  var obsSearch = null;
  var obsPayment = null;
  var obsBill = null;
  var obsEls = { totals: null, search: null, payment: null, bill: null };

  function ensureObservers() {
    var cont = findTotalsContainer();
    if (cont) {
      if (!obsTotals || obsEls.totals !== cont) {
        if (obsTotals) obsTotals.disconnect();
        obsTotals = new MutationObserver(function () { schedule(decorateTotals); });
         obsTotals.observe(cont, { childList: true, subtree: true });
        obsEls.totals = cont;
      }
    } else if (obsTotals) {
      obsTotals.disconnect();
      obsTotals = null;
      obsEls.totals = null;
    }

    var panel = document.querySelector('.mat-autocomplete-panel');
    if (panel) {
      if (!obsSearch || obsEls.search !== panel) {
        if (obsSearch) obsSearch.disconnect();
 obsSearch = new MutationObserver(function () { resetUpdates(); schedule(decorateSearch); });
        obsSearch.observe(panel, { childList: true, subtree: true });
        obsEls.search = panel;
      }
    } else if (obsSearch) {
      obsSearch.disconnect();
      obsSearch = null;
      obsEls.search = null;
    }

    var modal = document.querySelector('.mat-dialog-container');
    if (modal) {
      if (!obsPayment || obsEls.payment !== modal) {
        if (obsPayment) obsPayment.disconnect();
        obsPayment = new MutationObserver(function () {
          schedule(decoratePaymentModal);
          schedule(decorateAddons);
        });
        obsPayment.observe(modal, { childList: true, subtree: true });
        obsEls.payment = modal;
      }
    } else if (obsPayment) {
      obsPayment.disconnect();
      obsPayment = null;
      obsEls.payment = null;
    }
    
    var bill = document.getElementById('bill-products') || document.getElementById('bill_products') || document.querySelector('.bill-products');
    if (bill) {
      if (!obsBill || obsEls.bill !== bill) {
        if (obsBill) obsBill.disconnect();
        obsBill = new MutationObserver(function () { schedule(decorateBill); });
        obsBill.observe(bill, { childList: true, subtree: true });
        obsEls.bill = bill;
      }
    } else if (obsBill) {
      obsBill.disconnect();
      obsBill = null;
      obsEls.bill = null;
    }
  }
  function runAll() {
   ensureObservers();
    resetUpdates();
    decorateSearch();
    decorateAddons();
    decorateCart();
    decorateTotals();
    decoratePaymentModal();
      decorateBill();
    ensureBadge();
  }

  // --- Refresco de tasa via AJAX ---
  function refreshRate(cb) {
    var url = (window.CSFX_RATE_ENDPOINT || '/wp-json/csfx/v1/rate') + '?ts=' + Date.now();
    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var configuredTimeout = Number(FX.fetchTimeout || 0);
    if (!configuredTimeout || !isFinite(configuredTimeout) || configuredTimeout <= 0) {
      var ttlBased = Number(FX.ttl || 0) * 500;
      configuredTimeout = ttlBased && isFinite(ttlBased) && ttlBased > 0 ? ttlBased : CSFX_DEFAULT_FETCH_TIMEOUT;
    }
    var timeoutMs = Math.min(Math.max(3000, configuredTimeout), 20000);
    var timedOut = false;
    var timeoutId = null;
    var options = { cache: 'no-store', credentials: 'same-origin' };
    if (controller) {
      options.signal = controller.signal;
      timeoutId = setTimeout(function () {
        timedOut = true;
        try { controller.abort(); } catch (_abortErr) {}
      }, timeoutMs);
    }
    fetch(url, options)
      .then(function (r) {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (!r || !r.ok) {
          var statusText = r ? 'http_' + r.status : 'no_response';
          throw new Error(statusText);
        }
        return r.json();
      })
      .then(function (j) {
        var validRate = j && Number(j.rate) > 0;
        if (validRate) {
          FX.rate = Number(j.rate);
          FX.mode = j.mode || '';
          FX.updated = j.updated || '';
          csfxSetConnectionStatus('online', '');
          csfxRememberLastGood(FX.rate, FX.updated, 'api', { force: true });
        } else {
          csfxSetConnectionStatus('degraded', j ? 'invalid_rate' : 'invalid_payload');
        }
        if (!FX.rate || FX.rate <= 0) {
          csfxApplyFallbackRate(validRate ? 'api-rate' : 'api-empty');
        }
      })
      .catch(function (err) {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        var reason = timedOut ? 'timeout' : ((err && err.message) || 'error');
        csfxSetConnectionStatus('offline', reason);
        hydrateFxRateFromOffline();
        csfxApplyFallbackRate('fetch-error');
      })
      .finally(function () {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        ensureBadge();
        cb && cb();
      });
  }

  // --- Refresco del descuento mediante API ---
  function refreshDiscount(cb){
    var url = (window.CSFX_DISCOUNT_ENDPOINT || '/wp-json/csfx/v1/discount') + '?ts=' + Date.now();
    fetch(url, { cache: 'no-store', credentials: 'same-origin' })
      .then(function(r){
        if (!r || !r.ok) throw new Error('discount_fetch_failed');
        return r.json();
      })
      .then(function(j){
        var hasPercent = j && typeof j.percent !== 'undefined';
        var percent = hasPercent ? Number(j.percent) : NaN;
        if (hasPercent && isFinite(percent)) {
          FX.disc = {
            active: !!(j.active && percent > 0),
            percent: percent
          };
          persistFxOfflineState({ disc: FX.disc });
        } else {
          hydrateFxDiscountFromOffline();
        }
        ensureBadge();
        cb && cb();
      })
      .catch(function(){
        hydrateFxDiscountFromOffline();
        ensureBadge();
        cb && cb();
      });
  }

    // Inicializar posicionamiento del badge y carga de tasa al cargar el DOM
  document.addEventListener('DOMContentLoaded', function(){
    try {
      if (typeof initBadgePositioning === 'function') initBadgePositioning();
      csfxClearLegacyStores();
     refreshRate(function(){
        try {
          var badge = document.querySelector('.csfx-badge-content');
          if (badge && !FX.rate) badge.innerHTML = '<strong>Tasa BCV:</strong> (sin datos)';
        } catch(e){}
        // Tras refrescar la tasa, refrescamos el descuento y luego ejecutamos decoradores
        refreshDiscount(function(){ runAll(); });
        // Fallback: si después de la primera carga aún no hay tasa, intenta otra carga
        setTimeout(function(){
          if (!FX.rate) {
            refreshRate(function(){
              refreshDiscount(function(){ schedule(runAll); });
            });
          }
        }, 10000);
      });    } catch(e){}
  });

  // --- Observer de DOM con throttling ---
 var rootObs = new MutationObserver(function () { schedule(runAll); });
  rootObs.observe(document.documentElement, { childList: true, subtree: true });

  // Exponer runner manual para debug
  window.__CS_FX_RUN = function () { schedule(runAll); };

  // Kickstart

  var ttlSeconds = Number(FX.ttl);
  var baseInterval = (isFinite(ttlSeconds) && ttlSeconds > 0) ? ttlSeconds * 1000 : 60000;
  var refreshInterval = Math.max(15000, baseInterval);
  setInterval(function () { refreshRate(function () { schedule(runAll); }); }, refreshInterval);

  // Intervalo para refrescar el descuento periódicamente (p.ej. cada 60 segundos)
  setInterval(function(){
    refreshDiscount(function(){
      // Actualizamos solo el buscador y el badge para evitar recargar todo
      schedule(decorateSearch);
      ensureBadge();
    });
  }, 60 * 1000);
})();

/* jsQR v1.4.0 | MIT License */
/**
 * Minified by jsDelivr using Terser v5.37.0.
 * Original file: /npm/jsqr@1.4.0/dist/jsQR.js
 *
 * Do NOT use SRI with dynamically generated files! More information: https://www.jsdelivr.com/using-sri-with-dynamic-files
 */
!function(o,e){"object"==typeof exports&&"object"==typeof module?module.exports=e():"function"==typeof define&&define.amd?define([],e):"object"==typeof exports?exports.jsQR=e():o.jsQR=e()}("undefined"!=typeof self?self:this,(function(){return function(o){var e={};function r(t){if(e[t])return e[t].exports;var c=e[t]={i:t,l:!1,exports:{}};return o[t].call(c.exports,c,c.exports,r),c.l=!0,c.exports}return r.m=o,r.c=e,r.d=function(o,e,t){r.o(o,e)||Object.defineProperty(o,e,{configurable:!1,enumerable:!0,get:t})},r.n=function(o){var e=o&&o.__esModule?function(){return o.default}:function(){return o};return r.d(e,"a",e),e},r.o=function(o,e){return Object.prototype.hasOwnProperty.call(o,e)},r.p="",r(r.s=3)}([function(o,e,r){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var t=function(){function o(o,e){this.width=e,this.height=o.length/e,this.data=o}return o.createEmpty=function(e,r){return new o(new Uint8ClampedArray(e*r),e)},o.prototype.get=function(o,e){return!(o<0||o>=this.width||e<0||e>=this.height)&&!!this.data[e*this.width+o]},o.prototype.set=function(o,e,r){this.data[e*this.width+o]=r?1:0},o.prototype.setRegion=function(o,e,r,t,c){for(var s=e;s<e+t;s++)for(var a=o;a<o+r;a++)this.set(a,s,!!c)},o}();e.BitMatrix=t},function(o,e,r){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var t=r(2);e.addOrSubtractGF=function(o,e){return o^e};var c=function(){function o(o,e,r){this.primitive=o,this.size=e,this.generatorBase=r,this.expTable=new Array(this.size),this.logTable=new Array(this.size);for(var c=1,s=0;s<this.size;s++)this.expTable[s]=c,(c*=2)>=this.size&&(c=(c^this.primitive)&this.size-1);for(s=0;s<this.size-1;s++)this.logTable[this.expTable[s]]=s;this.zero=new t.default(this,Uint8ClampedArray.from([0])),this.one=new t.default(this,Uint8ClampedArray.from([1]))}return o.prototype.multiply=function(o,e){return 0===o||0===e?0:this.expTable[(this.logTable[o]+this.logTable[e])%(this.size-1)]},o.prototype.inverse=function(o){if(0===o)throw new Error("Can't invert 0");return this.expTable[this.size-this.logTable[o]-1]},o.prototype.buildMonomial=function(o,e){if(o<0)throw new Error("Invalid monomial degree less than 0");if(0===e)return this.zero;var r=new Uint8ClampedArray(o+1);return r[0]=e,new t.default(this,r)},o.prototype.log=function(o){if(0===o)throw new Error("Can't take log(0)");return this.logTable[o]},o.prototype.exp=function(o){return this.expTable[o]},o}();e.default=c},function(o,e,r){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var t=r(1),c=function(){function o(o,e){if(0===e.length)throw new Error("No coefficients.");this.field=o;var r=e.length;if(r>1&&0===e[0]){for(var t=1;t<r&&0===e[t];)t++;if(t===r)this.coefficients=o.zero.coefficients;else{this.coefficients=new Uint8ClampedArray(r-t);for(var c=0;c<this.coefficients.length;c++)this.coefficients[c]=e[t+c]}}else this.coefficients=e}return o.prototype.degree=function(){return this.coefficients.length-1},o.prototype.isZero=function(){return 0===this.coefficients[0]},o.prototype.getCoefficient=function(o){return this.coefficients[this.coefficients.length-1-o]},o.prototype.addOrSubtract=function(e){var r;if(this.isZero())return e;if(e.isZero())return this;var c=this.coefficients,s=e.coefficients;c.length>s.length&&(c=(r=[s,c])[0],s=r[1]);for(var a=new Uint8ClampedArray(s.length),n=s.length-c.length,d=0;d<n;d++)a[d]=s[d];for(d=n;d<s.length;d++)a[d]=t.addOrSubtractGF(c[d-n],s[d]);return new o(this.field,a)},o.prototype.multiply=function(e){if(0===e)return this.field.zero;if(1===e)return this;for(var r=this.coefficients.length,t=new Uint8ClampedArray(r),c=0;c<r;c++)t[c]=this.field.multiply(this.coefficients[c],e);return new o(this.field,t)},o.prototype.multiplyPoly=function(e){if(this.isZero()||e.isZero())return this.field.zero;for(var r=this.coefficients,c=r.length,s=e.coefficients,a=s.length,n=new Uint8ClampedArray(c+a-1),d=0;d<c;d++)for(var l=r[d],i=0;i<a;i++)n[d+i]=t.addOrSubtractGF(n[d+i],this.field.multiply(l,s[i]));return new o(this.field,n)},o.prototype.multiplyByMonomial=function(e,r){if(e<0)throw new Error("Invalid degree less than 0");if(0===r)return this.field.zero;for(var t=this.coefficients.length,c=new Uint8ClampedArray(t+e),s=0;s<t;s++)c[s]=this.field.multiply(this.coefficients[s],r);return new o(this.field,c)},o.prototype.evaluateAt=function(o){var e=0;if(0===o)return this.getCoefficient(0);var r=this.coefficients.length;if(1===o)return this.coefficients.forEach((function(o){e=t.addOrSubtractGF(e,o)})),e;e=this.coefficients[0];for(var c=1;c<r;c++)e=t.addOrSubtractGF(this.field.multiply(o,e),this.coefficients[c]);return e},o}();e.default=c},function(o,e,r){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var t=r(4),c=r(5),s=r(11),a=r(12);function n(o){var e=a.locate(o);if(!e)return null;for(var r=0,t=e;r<t.length;r++){var n=t[r],d=s.extract(o,n),l=c.decode(d.matrix);if(l)return{binaryData:l.bytes,data:l.text,chunks:l.chunks,version:l.version,location:{topRightCorner:d.mappingFunction(n.dimension,0),topLeftCorner:d.mappingFunction(0,0),bottomRightCorner:d.mappingFunction(n.dimension,n.dimension),bottomLeftCorner:d.mappingFunction(0,n.dimension),topRightFinderPattern:n.topRight,topLeftFinderPattern:n.topLeft,bottomLeftFinderPattern:n.bottomLeft,bottomRightAlignmentPattern:n.alignmentPattern}}}return null}var d={inversionAttempts:"attemptBoth"};function l(o,e,r,c){void 0===c&&(c={});var s=d;Object.keys(s||{}).forEach((function(o){s[o]=c[o]||s[o]}));var a="attemptBoth"===s.inversionAttempts||"invertFirst"===s.inversionAttempts,l="onlyInvert"===s.inversionAttempts||"invertFirst"===s.inversionAttempts,i=t.binarize(o,e,r,a),B=i.binarized,k=i.inverted,u=n(l?k:B);return u||"attemptBoth"!==s.inversionAttempts&&"invertFirst"!==s.inversionAttempts||(u=n(l?B:k)),u}l.default=l,e.default=l},function(o,e,r){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var t=r(0);function c(o,e,r){return o<e?e:o>r?r:o}var s=function(){function o(o,e){this.width=o,this.data=new Uint8ClampedArray(o*e)}return o.prototype.get=function(o,e){return this.data[e*this.width+o]},o.prototype.set=function(o,e,r){this.data[e*this.width+o]=r},o}();e.binarize=function(o,e,r,a){if(o.length!==e*r*4)throw new Error("Malformed data passed to binarizer.");for(var n=new s(e,r),d=0;d<e;d++)for(var l=0;l<r;l++){var i=o[4*(l*e+d)+0],B=o[4*(l*e+d)+1],k=o[4*(l*e+d)+2];n.set(d,l,.2126*i+.7152*B+.0722*k)}for(var u=Math.ceil(e/8),C=Math.ceil(r/8),m=new s(u,C),f=0;f<C;f++)for(var w=0;w<u;w++){var P=0,v=1/0,h=0;for(l=0;l<8;l++)for(d=0;d<8;d++){var y=n.get(8*w+d,8*f+l);P+=y,v=Math.min(v,y),h=Math.max(h,y)}var p=P/Math.pow(8,2);if(h-v<=24&&(p=v/2,f>0&&w>0)){var b=(m.get(w,f-1)+2*m.get(w-1,f)+m.get(w-1,f-1))/4;v<b&&(p=b)}m.set(w,f,p)}var g=t.BitMatrix.createEmpty(e,r),x=null;for(a&&(x=t.BitMatrix.createEmpty(e,r)),f=0;f<C;f++)for(w=0;w<u;w++){for(var M=c(w,2,u-3),L=c(f,2,C-3),N=(P=0,-2);N<=2;N++)for(var I=-2;I<=2;I++)P+=m.get(M+N,L+I);var O=P/25;for(N=0;N<8;N++)for(I=0;I<8;I++){d=8*w+N,l=8*f+I;var z=n.get(d,l);g.set(d,l,z<=O),a&&x.set(d,l,!(z<=O))}}return a?{binarized:g,inverted:x}:{binarized:g}}},function(o,e,r){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var t=r(0),c=r(6),s=r(9),a=r(10);function n(o,e){for(var r=o^e,t=0;r;)t++,r&=r-1;return t}function d(o,e){return e<<1|o}var l=[{bits:21522,formatInfo:{errorCorrectionLevel:1,dataMask:0}},{bits:20773,formatInfo:{errorCorrectionLevel:1,dataMask:1}},{bits:24188,formatInfo:{errorCorrectionLevel:1,dataMask:2}},{bits:23371,formatInfo:{errorCorrectionLevel:1,dataMask:3}},{bits:17913,formatInfo:{errorCorrectionLevel:1,dataMask:4}},{bits:16590,formatInfo:{errorCorrectionLevel:1,dataMask:5}},{bits:20375,formatInfo:{errorCorrectionLevel:1,dataMask:6}},{bits:19104,formatInfo:{errorCorrectionLevel:1,dataMask:7}},{bits:30660,formatInfo:{errorCorrectionLevel:0,dataMask:0}},{bits:29427,formatInfo:{errorCorrectionLevel:0,dataMask:1}},{bits:32170,formatInfo:{errorCorrectionLevel:0,dataMask:2}},{bits:30877,formatInfo:{errorCorrectionLevel:0,dataMask:3}},{bits:26159,formatInfo:{errorCorrectionLevel:0,dataMask:4}},{bits:25368,formatInfo:{errorCorrectionLevel:0,dataMask:5}},{bits:27713,formatInfo:{errorCorrectionLevel:0,dataMask:6}},{bits:26998,formatInfo:{errorCorrectionLevel:0,dataMask:7}},{bits:5769,formatInfo:{errorCorrectionLevel:3,dataMask:0}},{bits:5054,formatInfo:{errorCorrectionLevel:3,dataMask:1}},{bits:7399,formatInfo:{errorCorrectionLevel:3,dataMask:2}},{bits:6608,formatInfo:{errorCorrectionLevel:3,dataMask:3}},{bits:1890,formatInfo:{errorCorrectionLevel:3,dataMask:4}},{bits:597,formatInfo:{errorCorrectionLevel:3,dataMask:5}},{bits:3340,formatInfo:{errorCorrectionLevel:3,dataMask:6}},{bits:2107,formatInfo:{errorCorrectionLevel:3,dataMask:7}},{bits:13663,formatInfo:{errorCorrectionLevel:2,dataMask:0}},{bits:12392,formatInfo:{errorCorrectionLevel:2,dataMask:1}},{bits:16177,formatInfo:{errorCorrectionLevel:2,dataMask:2}},{bits:14854,formatInfo:{errorCorrectionLevel:2,dataMask:3}},{bits:9396,formatInfo:{errorCorrectionLevel:2,dataMask:4}},{bits:8579,formatInfo:{errorCorrectionLevel:2,dataMask:5}},{bits:11994,formatInfo:{errorCorrectionLevel:2,dataMask:6}},{bits:11245,formatInfo:{errorCorrectionLevel:2,dataMask:7}}],i=[function(o){return(o.y+o.x)%2==0},function(o){return o.y%2==0},function(o){return o.x%3==0},function(o){return(o.y+o.x)%3==0},function(o){return(Math.floor(o.y/2)+Math.floor(o.x/3))%2==0},function(o){return o.x*o.y%2+o.x*o.y%3==0},function(o){return(o.y*o.x%2+o.y*o.x%3)%2==0},function(o){return((o.y+o.x)%2+o.y*o.x%3)%2==0}];function B(o,e,r){for(var c=i[r.dataMask],s=o.height,a=function(o){var e=17+4*o.versionNumber,r=t.BitMatrix.createEmpty(e,e);r.setRegion(0,0,9,9,!0),r.setRegion(e-8,0,8,9,!0),r.setRegion(0,e-8,9,8,!0);for(var c=0,s=o.alignmentPatternCenters;c<s.length;c++)for(var a=s[c],n=0,d=o.alignmentPatternCenters;n<d.length;n++){var l=d[n];6===a&&6===l||6===a&&l===e-7||a===e-7&&6===l||r.setRegion(a-2,l-2,5,5,!0)}return r.setRegion(6,9,1,e-17,!0),r.setRegion(9,6,e-17,1,!0),o.versionNumber>6&&(r.setRegion(e-11,0,3,6,!0),r.setRegion(0,e-11,6,3,!0)),r}(e),n=[],l=0,B=0,k=!0,u=s-1;u>0;u-=2){6===u&&u--;for(var C=0;C<s;C++)for(var m=k?s-1-C:C,f=0;f<2;f++){var w=u-f;if(!a.get(w,m)){B++;var P=o.get(w,m);c({y:m,x:w})&&(P=!P),l=d(P,l),8===B&&(n.push(l),B=0,l=0)}}k=!k}return n}function k(o){var e=function(o){var e=o.height,r=Math.floor((e-17)/4);if(r<=6)return a.VERSIONS[r-1];for(var t=0,c=5;c>=0;c--)for(var s=e-9;s>=e-11;s--)t=d(o.get(s,c),t);var l=0;for(s=5;s>=0;s--)for(c=e-9;c>=e-11;c--)l=d(o.get(s,c),l);for(var i,B=1/0,k=0,u=a.VERSIONS;k<u.length;k++){var C=u[k];if(C.infoBits===t||C.infoBits===l)return C;var m=n(t,C.infoBits);m<B&&(i=C,B=m),(m=n(l,C.infoBits))<B&&(i=C,B=m)}return B<=3?i:void 0}(o);if(!e)return null;var r=function(o){for(var e=0,r=0;r<=8;r++)6!==r&&(e=d(o.get(r,8),e));for(var t=7;t>=0;t--)6!==t&&(e=d(o.get(8,t),e));var c=o.height,s=0;for(t=c-1;t>=c-7;t--)s=d(o.get(8,t),s);for(r=c-8;r<c;r++)s=d(o.get(r,8),s);for(var a=1/0,i=null,B=0,k=l;B<k.length;B++){var u=k[B],C=u.bits,m=u.formatInfo;if(C===e||C===s)return m;var f=n(e,C);f<a&&(i=m,a=f),e!==s&&(f=n(s,C))<a&&(i=m,a=f)}return a<=3?i:null}(o);if(!r)return null;var t=function(o,e,r){var t=e.errorCorrectionLevels[r],c=[],s=0;if(t.ecBlocks.forEach((function(o){for(var e=0;e<o.numBlocks;e++)c.push({numDataCodewords:o.dataCodewordsPerBlock,codewords:[]}),s+=o.dataCodewordsPerBlock+t.ecCodewordsPerBlock})),o.length<s)return null;o=o.slice(0,s);for(var a=t.ecBlocks[0].dataCodewordsPerBlock,n=0;n<a;n++)for(var d=0,l=c;d<l.length;d++)l[d].codewords.push(o.shift());if(t.ecBlocks.length>1){var i=t.ecBlocks[0].numBlocks,B=t.ecBlocks[1].numBlocks;for(n=0;n<B;n++)c[i+n].codewords.push(o.shift())}for(;o.length>0;)for(var k=0,u=c;k<u.length;k++)u[k].codewords.push(o.shift());return c}(B(o,e,r),e,r.errorCorrectionLevel);if(!t)return null;for(var i=t.reduce((function(o,e){return o+e.numDataCodewords}),0),k=new Uint8ClampedArray(i),u=0,C=0,m=t;C<m.length;C++){var f=m[C],w=s.decode(f.codewords,f.codewords.length-f.numDataCodewords);if(!w)return null;for(var P=0;P<f.numDataCodewords;P++)k[u++]=w[P]}try{return c.decode(k,e.versionNumber)}catch(o){return null}}e.decode=function(o){if(null==o)return null;var e=k(o);if(e)return e;for(var r=0;r<o.width;r++)for(var t=r+1;t<o.height;t++)o.get(r,t)!==o.get(t,r)&&(o.set(r,t,!o.get(r,t)),o.set(t,r,!o.get(t,r)));return k(o)}},function(o,e,r){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var t,c,s=r(7),a=r(8);function n(o,e){for(var r=[],t="",c=[10,12,14][e],s=o.readBits(c);s>=3;){if((l=o.readBits(10))>=1e3)throw new Error("Invalid numeric value above 999");var a=Math.floor(l/100),n=Math.floor(l/10)%10,d=l%10;r.push(48+a,48+n,48+d),t+=a.toString()+n.toString()+d.toString(),s-=3}if(2===s){if((l=o.readBits(7))>=100)throw new Error("Invalid numeric value above 99");a=Math.floor(l/10),n=l%10;r.push(48+a,48+n),t+=a.toString()+n.toString()}else if(1===s){var l;if((l=o.readBits(4))>=10)throw new Error("Invalid numeric value above 9");r.push(48+l),t+=l.toString()}return{bytes:r,text:t}}!function(o){o.Numeric="numeric",o.Alphanumeric="alphanumeric",o.Byte="byte",o.Kanji="kanji",o.ECI="eci"}(t=e.Mode||(e.Mode={})),function(o){o[o.Terminator=0]="Terminator",o[o.Numeric=1]="Numeric",o[o.Alphanumeric=2]="Alphanumeric",o[o.Byte=4]="Byte",o[o.Kanji=8]="Kanji",o[o.ECI=7]="ECI"}(c||(c={}));var d=["0","1","2","3","4","5","6","7","8","9","A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q","R","S","T","U","V","W","X","Y","Z"," ","$","%","*","+","-",".","/",":"];function l(o,e){for(var r=[],t="",c=[9,11,13][e],s=o.readBits(c);s>=2;){var a=o.readBits(11),n=Math.floor(a/45),l=a%45;r.push(d[n].charCodeAt(0),d[l].charCodeAt(0)),t+=d[n]+d[l],s-=2}if(1===s){n=o.readBits(6);r.push(d[n].charCodeAt(0)),t+=d[n]}return{bytes:r,text:t}}function i(o,e){for(var r=[],t="",c=[8,16,16][e],s=o.readBits(c),a=0;a<s;a++){var n=o.readBits(8);r.push(n)}try{t+=decodeURIComponent(r.map((function(o){return"%"+("0"+o.toString(16)).substr(-2)})).join(""))}catch(o){}return{bytes:r,text:t}}function B(o,e){for(var r=[],t="",c=[8,10,12][e],s=o.readBits(c),n=0;n<s;n++){var d=o.readBits(13),l=Math.floor(d/192)<<8|d%192;l+=l<7936?33088:49472,r.push(l>>8,255&l),t+=String.fromCharCode(a.shiftJISTable[l])}return{bytes:r,text:t}}e.decode=function(o,e){for(var r,a,d,k,u=new s.BitStream(o),C=e<=9?0:e<=26?1:2,m={text:"",bytes:[],chunks:[],version:e};u.available()>=4;){var f=u.readBits(4);if(f===c.Terminator)return m;if(f===c.ECI)0===u.readBits(1)?m.chunks.push({type:t.ECI,assignmentNumber:u.readBits(7)}):0===u.readBits(1)?m.chunks.push({type:t.ECI,assignmentNumber:u.readBits(14)}):0===u.readBits(1)?m.chunks.push({type:t.ECI,assignmentNumber:u.readBits(21)}):m.chunks.push({type:t.ECI,assignmentNumber:-1});else if(f===c.Numeric){var w=n(u,C);m.text+=w.text,(r=m.bytes).push.apply(r,w.bytes),m.chunks.push({type:t.Numeric,text:w.text})}else if(f===c.Alphanumeric){var P=l(u,C);m.text+=P.text,(a=m.bytes).push.apply(a,P.bytes),m.chunks.push({type:t.Alphanumeric,text:P.text})}else if(f===c.Byte){var v=i(u,C);m.text+=v.text,(d=m.bytes).push.apply(d,v.bytes),m.chunks.push({type:t.Byte,bytes:v.bytes,text:v.text})}else if(f===c.Kanji){var h=B(u,C);m.text+=h.text,(k=m.bytes).push.apply(k,h.bytes),m.chunks.push({type:t.Kanji,bytes:h.bytes,text:h.text})}}if(0===u.available()||0===u.readBits(u.available()))return m}},function(o,e,r){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var t=function(){function o(o){this.byteOffset=0,this.bitOffset=0,this.bytes=o}return o.prototype.readBits=function(o){if(o<1||o>32||o>this.available())throw new Error("Cannot read "+o.toString()+" bits");var e=0;if(this.bitOffset>0){var r=8-this.bitOffset,t=o<r?o:r,c=255>>8-t<<(s=r-t);e=(this.bytes[this.byteOffset]&c)>>s,o-=t,this.bitOffset+=t,8===this.bitOffset&&(this.bitOffset=0,this.byteOffset++)}if(o>0){for(;o>=8;)e=e<<8|255&this.bytes[this.byteOffset],this.byteOffset++,o-=8;if(o>0){var s;c=255>>(s=8-o)<<s;e=e<<o|(this.bytes[this.byteOffset]&c)>>s,this.bitOffset+=o}}return e},o.prototype.available=function(){return 8*(this.bytes.length-this.byteOffset)-this.bitOffset},o}();e.BitStream=t},function(o,e,r){"use strict";Object.defineProperty(e,"__esModule",{value:!0}),e.shiftJISTable={32:32,33:33,34:34,35:35,36:36,37:37,38:38,39:39,40:40,41:41,42:42,43:43,44:44,45:45,46:46,47:47,48:48,49:49,50:50,51:51,52:52,53:53,54:54,55:55,56:56,57:57,58:58,59:59,60:60,61:61,62:62,63:63,64:64,65:65,66:66,67:67,68:68,69:69,70:70,71:71,72:72,73:73,74:74,75:75,76:76,77:77,78:78,79:79,80:80,81:81,82:82,83:83,84:84,85:85,86:86,87:87,88:88,89:89,90:90,91:91,92:165,93:93,94:94,95:95,96:96,97:97,98:98,99:99,100:100,101:101,102:102,103:103,104:104,105:105,106:106,107:107,108:108,109:109,110:110,111:111,112:112,113:113,114:114,115:115,116:116,117:117,118:118,119:119,120:120,121:121,122:122,123:123,124:124,125:125,126:8254,33088:12288,33089:12289,33090:12290,33091:65292,33092:65294,33093:12539,33094:65306,33095:65307,33096:65311,33097:65281,33098:12443,33099:12444,33100:180,33101:65344,33102:168,33103:65342,33104:65507,33105:65343,33106:12541,33107:12542,33108:12445,33109:12446,33110:12291,33111:20189,33112:12293,33113:12294,33114:12295,33115:12540,33116:8213,33117:8208,33118:65295,33119:92,33120:12316,33121:8214,33122:65372,33123:8230,33124:8229,33125:8216,33126:8217,33127:8220,33128:8221,33129:65288,33130:65289,33131:12308,33132:12309,33133:65339,33134:65341,33135:65371,33136:65373,33137:12296,33138:12297,33139:12298,33140:12299,33141:12300,33142:12301,33143:12302,33144:12303,33145:12304,33146:12305,33147:65291,33148:8722,33149:177,33150:215,33152:247,33153:65309,33154:8800,33155:65308,33156:65310,33157:8806,33158:8807,33159:8734,33160:8756,33161:9794,33162:9792,33163:176,33164:8242,33165:8243,33166:8451,33167:65509,33168:65284,33169:162,33170:163,33171:65285,33172:65283,33173:65286,33174:65290,33175:65312,33176:167,33177:9734,33178:9733,33179:9675,33180:9679,33181:9678,33182:9671,33183:9670,33184:9633,33185:9632,33186:9651,33187:9650,33188:9661,33189:9660,33190:8251,33191:12306,33192:8594,33193:8592,33194:8593,33195:8595,33196:12307,33208:8712,33209:8715,33210:8838,33211:8839,33212:8834,33213:8835,33214:8746,33215:8745,33224:8743,33225:8744,33226:172,33227:8658,33228:8660,33229:8704,33230:8707,33242:8736,33243:8869,33244:8978,33245:8706,33246:8711,33247:8801,33248:8786,33249:8810,33250:8811,33251:8730,33252:8765,33253:8733,33254:8757,33255:8747,33256:8748,33264:8491,33265:8240,33266:9839,33267:9837,33268:9834,33269:8224,33270:8225,33271:182,33276:9711,33359:65296,33360:65297,33361:65298,33362:65299,33363:65300,33364:65301,33365:65302,33366:65303,33367:65304,33368:65305,33376:65313,33377:65314,33378:65315,33379:65316,33380:65317,33381:65318,33382:65319,33383:65320,33384:65321,33385:65322,33386:65323,33387:65324,33388:65325,33389:65326,33390:65327,33391:65328,33392:65329,33393:65330,33394:65331,33395:65332,33396:65333,33397:65334,33398:65335,33399:65336,33400:65337,33401:65338,33409:65345,33410:65346,33411:65347,33412:65348,33413:65349,33414:65350,33415:65351,33416:65352,33417:65353,33418:65354,33419:65355,33420:65356,33421:65357,33422:65358,33423:65359,33424:65360,33425:65361,33426:65362,33427:65363,33428:65364,33429:65365,33430:65366,33431:65367,33432:65368,33433:65369,33434:65370,33439:12353,33440:12354,33441:12355,33442:12356,33443:12357,33444:12358,33445:12359,33446:12360,33447:12361,33448:12362,33449:12363,33450:12364,33451:12365,33452:12366,33453:12367,33454:12368,33455:12369,33456:12370,33457:12371,33458:12372,33459:12373,33460:12374,33461:12375,33462:12376,33463:12377,33464:12378,33465:12379,33466:12380,33467:12381,33468:12382,33469:12383,33470:12384,33471:12385,33472:12386,33473:12387,33474:12388,33475:12389,33476:12390,33477:12391,33478:12392,33479:12393,33480:12394,33481:12395,33482:12396,33483:12397,33484:12398,33485:12399,33486:12400,33487:12401,33488:12402,33489:12403,33490:12404,33491:12405,33492:12406,33493:12407,33494:12408,33495:12409,33496:12410,33497:12411,33498:12412,33499:12413,33500:12414,33501:12415,33502:12416,33503:12417,33504:12418,33505:12419,33506:12420,33507:12421,33508:12422,33509:12423,33510:12424,33511:12425,33512:12426,33513:12427,33514:12428,33515:12429,33516:12430,33517:12431,33518:12432,33519:12433,33520:12434,33521:12435,33600:12449,33601:12450,33602:12451,33603:12452,33604:12453,33605:12454,33606:12455,33607:12456,33608:12457,33609:12458,33610:12459,33611:12460,33612:12461,33613:12462,33614:12463,33615:12464,33616:12465,33617:12466,33618:12467,33619:12468,33620:12469,33621:12470,33622:12471,33623:12472,33624:12473,33625:12474,33626:12475,33627:12476,33628:12477,33629:12478,33630:12479,33631:12480,33632:12481,33633:12482,33634:12483,33635:12484,33636:12485,33637:12486,33638:12487,33639:12488,33640:12489,33641:12490,33642:12491,33643:12492,33644:12493,33645:12494,33646:12495,33647:12496,33648:12497,33649:12498,33650:12499,33651:12500,33652:12501,33653:12502,33654:12503,33655:12504,33656:12505,33657:12506,33658:12507,33659:12508,33660:12509,33661:12510,33662:12511,33664:12512,33665:12513,33666:12514,33667:12515,33668:12516,33669:12517,33670:12518,33671:12519,33672:12520,33673:12521,33674:12522,33675:12523,33676:12524,33677:12525,33678:12526,33679:12527,33680:12528,33681:12529,33682:12530,33683:12531,33684:12532,33685:12533,33686:12534,33695:913,33696:914,33697:915,33698:916,33699:917,33700:918,33701:919,33702:920,33703:921,33704:922,33705:923,33706:924,33707:925,33708:926,33709:927,33710:928,33711:929,33712:931,33713:932,33714:933,33715:934,33716:935,33717:936,33718:937,33727:945,33728:946,33729:947,33730:948,33731:949,33732:950,33733:951,33734:952,33735:953,33736:954,33737:955,33738:956,33739:957,33740:958,33741:959,33742:960,33743:961,33744:963,33745:964,33746:965,33747:966,33748:967,33749:968,33750:969,33856:1040,33857:1041,33858:1042,33859:1043,33860:1044,33861:1045,33862:1025,33863:1046,33864:1047,33865:1048,33866:1049,33867:1050,33868:1051,33869:1052,33870:1053,33871:1054,33872:1055,33873:1056,33874:1057,33875:1058,33876:1059,33877:1060,33878:1061,33879:1062,33880:1063,33881:1064,33882:1065,33883:1066,33884:1067,33885:1068,33886:1069,33887:1070,33888:1071,33904:1072,33905:1073,33906:1074,33907:1075,33908:1076,33909:1077,33910:1105,33911:1078,33912:1079,33913:1080,33914:1081,33915:1082,33916:1083,33917:1084,33918:1085,33920:1086,33921:1087,33922:1088,33923:1089,33924:1090,33925:1091,33926:1092,33927:1093,33928:1094,33929:1095,33930:1096,33931:1097,33932:1098,33933:1099,33934:1100,33935:1101,33936:1102,33937:1103,33951:9472,33952:9474,33953:9484,33954:9488,33955:9496,33956:9492,33957:9500,33958:9516,33959:9508,33960:9524,33961:9532,33962:9473,33963:9475,33964:9487,33965:9491,33966:9499,33967:9495,33968:9507,33969:9523,33970:9515,33971:9531,33972:9547,33973:9504,33974:9519,33975:9512,33976:9527,33977:9535,33978:9501,33979:9520,33980:9509,33981:9528,33982:9538,34975:20124,34976:21782,34977:23043,34978:38463,34979:21696,34980:24859,34981:25384,34982:23030,34983:36898,34984:33909,34985:33564,34986:31312,34987:24746,34988:25569,34989:28197,34990:26093,34991:33894,34992:33446,34993:39925,34994:26771,34995:22311,34996:26017,34997:25201,34998:23451,34999:22992,35e3:34427,35001:39156,35002:32098,35003:32190,35004:39822,35005:25110,35006:31903,35007:34999,35008:23433,35009:24245,35010:25353,35011:26263,35012:26696,35013:38343,35014:38797,35015:26447,35016:20197,35017:20234,35018:20301,35019:20381,35020:20553,35021:22258,35022:22839,35023:22996,35024:23041,35025:23561,35026:24799,35027:24847,35028:24944,35029:26131,35030:26885,35031:28858,35032:30031,35033:30064,35034:31227,35035:32173,35036:32239,35037:32963,35038:33806,35039:34915,35040:35586,35041:36949,35042:36986,35043:21307,35044:20117,35045:20133,35046:22495,35047:32946,35048:37057,35049:30959,35050:19968,35051:22769,35052:28322,35053:36920,35054:31282,35055:33576,35056:33419,35057:39983,35058:20801,35059:21360,35060:21693,35061:21729,35062:22240,35063:23035,35064:24341,35065:39154,35066:28139,35067:32996,35068:34093,35136:38498,35137:38512,35138:38560,35139:38907,35140:21515,35141:21491,35142:23431,35143:28879,35144:32701,35145:36802,35146:38632,35147:21359,35148:40284,35149:31418,35150:19985,35151:30867,35152:33276,35153:28198,35154:22040,35155:21764,35156:27421,35157:34074,35158:39995,35159:23013,35160:21417,35161:28006,35162:29916,35163:38287,35164:22082,35165:20113,35166:36939,35167:38642,35168:33615,35169:39180,35170:21473,35171:21942,35172:23344,35173:24433,35174:26144,35175:26355,35176:26628,35177:27704,35178:27891,35179:27945,35180:29787,35181:30408,35182:31310,35183:38964,35184:33521,35185:34907,35186:35424,35187:37613,35188:28082,35189:30123,35190:30410,35191:39365,35192:24742,35193:35585,35194:36234,35195:38322,35196:27022,35197:21421,35198:20870,35200:22290,35201:22576,35202:22852,35203:23476,35204:24310,35205:24616,35206:25513,35207:25588,35208:27839,35209:28436,35210:28814,35211:28948,35212:29017,35213:29141,35214:29503,35215:32257,35216:33398,35217:33489,35218:34199,35219:36960,35220:37467,35221:40219,35222:22633,35223:26044,35224:27738,35225:29989,35226:20985,35227:22830,35228:22885,35229:24448,35230:24540,35231:25276,35232:26106,35233:27178,35234:27431,35235:27572,35236:29579,35237:32705,35238:35158,35239:40236,35240:40206,35241:40644,35242:23713,35243:27798,35244:33659,35245:20740,35246:23627,35247:25014,35248:33222,35249:26742,35250:29281,35251:20057,35252:20474,35253:21368,35254:24681,35255:28201,35256:31311,35257:38899,35258:19979,35259:21270,35260:20206,35261:20309,35262:20285,35263:20385,35264:20339,35265:21152,35266:21487,35267:22025,35268:22799,35269:23233,35270:23478,35271:23521,35272:31185,35273:26247,35274:26524,35275:26550,35276:27468,35277:27827,35278:28779,35279:29634,35280:31117,35281:31166,35282:31292,35283:31623,35284:33457,35285:33499,35286:33540,35287:33655,35288:33775,35289:33747,35290:34662,35291:35506,35292:22057,35293:36008,35294:36838,35295:36942,35296:38686,35297:34442,35298:20420,35299:23784,35300:25105,35301:29273,35302:30011,35303:33253,35304:33469,35305:34558,35306:36032,35307:38597,35308:39187,35309:39381,35310:20171,35311:20250,35312:35299,35313:22238,35314:22602,35315:22730,35316:24315,35317:24555,35318:24618,35319:24724,35320:24674,35321:25040,35322:25106,35323:25296,35324:25913,35392:39745,35393:26214,35394:26800,35395:28023,35396:28784,35397:30028,35398:30342,35399:32117,35400:33445,35401:34809,35402:38283,35403:38542,35404:35997,35405:20977,35406:21182,35407:22806,35408:21683,35409:23475,35410:23830,35411:24936,35412:27010,35413:28079,35414:30861,35415:33995,35416:34903,35417:35442,35418:37799,35419:39608,35420:28012,35421:39336,35422:34521,35423:22435,35424:26623,35425:34510,35426:37390,35427:21123,35428:22151,35429:21508,35430:24275,35431:25313,35432:25785,35433:26684,35434:26680,35435:27579,35436:29554,35437:30906,35438:31339,35439:35226,35440:35282,35441:36203,35442:36611,35443:37101,35444:38307,35445:38548,35446:38761,35447:23398,35448:23731,35449:27005,35450:38989,35451:38990,35452:25499,35453:31520,35454:27179,35456:27263,35457:26806,35458:39949,35459:28511,35460:21106,35461:21917,35462:24688,35463:25324,35464:27963,35465:28167,35466:28369,35467:33883,35468:35088,35469:36676,35470:19988,35471:39993,35472:21494,35473:26907,35474:27194,35475:38788,35476:26666,35477:20828,35478:31427,35479:33970,35480:37340,35481:37772,35482:22107,35483:40232,35484:26658,35485:33541,35486:33841,35487:31909,35488:21e3,35489:33477,35490:29926,35491:20094,35492:20355,35493:20896,35494:23506,35495:21002,35496:21208,35497:21223,35498:24059,35499:21914,35500:22570,35501:23014,35502:23436,35503:23448,35504:23515,35505:24178,35506:24185,35507:24739,35508:24863,35509:24931,35510:25022,35511:25563,35512:25954,35513:26577,35514:26707,35515:26874,35516:27454,35517:27475,35518:27735,35519:28450,35520:28567,35521:28485,35522:29872,35523:29976,35524:30435,35525:30475,35526:31487,35527:31649,35528:31777,35529:32233,35530:32566,35531:32752,35532:32925,35533:33382,35534:33694,35535:35251,35536:35532,35537:36011,35538:36996,35539:37969,35540:38291,35541:38289,35542:38306,35543:38501,35544:38867,35545:39208,35546:33304,35547:20024,35548:21547,35549:23736,35550:24012,35551:29609,35552:30284,35553:30524,35554:23721,35555:32747,35556:36107,35557:38593,35558:38929,35559:38996,35560:39e3,35561:20225,35562:20238,35563:21361,35564:21916,35565:22120,35566:22522,35567:22855,35568:23305,35569:23492,35570:23696,35571:24076,35572:24190,35573:24524,35574:25582,35575:26426,35576:26071,35577:26082,35578:26399,35579:26827,35580:26820,35648:27231,35649:24112,35650:27589,35651:27671,35652:27773,35653:30079,35654:31048,35655:23395,35656:31232,35657:32e3,35658:24509,35659:35215,35660:35352,35661:36020,35662:36215,35663:36556,35664:36637,35665:39138,35666:39438,35667:39740,35668:20096,35669:20605,35670:20736,35671:22931,35672:23452,35673:25135,35674:25216,35675:25836,35676:27450,35677:29344,35678:30097,35679:31047,35680:32681,35681:34811,35682:35516,35683:35696,35684:25516,35685:33738,35686:38816,35687:21513,35688:21507,35689:21931,35690:26708,35691:27224,35692:35440,35693:30759,35694:26485,35695:40653,35696:21364,35697:23458,35698:33050,35699:34384,35700:36870,35701:19992,35702:20037,35703:20167,35704:20241,35705:21450,35706:21560,35707:23470,35708:24339,35709:24613,35710:25937,35712:26429,35713:27714,35714:27762,35715:27875,35716:28792,35717:29699,35718:31350,35719:31406,35720:31496,35721:32026,35722:31998,35723:32102,35724:26087,35725:29275,35726:21435,35727:23621,35728:24040,35729:25298,35730:25312,35731:25369,35732:28192,35733:34394,35734:35377,35735:36317,35736:37624,35737:28417,35738:31142,35739:39770,35740:20136,35741:20139,35742:20140,35743:20379,35744:20384,35745:20689,35746:20807,35747:31478,35748:20849,35749:20982,35750:21332,35751:21281,35752:21375,35753:21483,35754:21932,35755:22659,35756:23777,35757:24375,35758:24394,35759:24623,35760:24656,35761:24685,35762:25375,35763:25945,35764:27211,35765:27841,35766:29378,35767:29421,35768:30703,35769:33016,35770:33029,35771:33288,35772:34126,35773:37111,35774:37857,35775:38911,35776:39255,35777:39514,35778:20208,35779:20957,35780:23597,35781:26241,35782:26989,35783:23616,35784:26354,35785:26997,35786:29577,35787:26704,35788:31873,35789:20677,35790:21220,35791:22343,35792:24062,35793:37670,35794:26020,35795:27427,35796:27453,35797:29748,35798:31105,35799:31165,35800:31563,35801:32202,35802:33465,35803:33740,35804:34943,35805:35167,35806:35641,35807:36817,35808:37329,35809:21535,35810:37504,35811:20061,35812:20534,35813:21477,35814:21306,35815:29399,35816:29590,35817:30697,35818:33510,35819:36527,35820:39366,35821:39368,35822:39378,35823:20855,35824:24858,35825:34398,35826:21936,35827:31354,35828:20598,35829:23507,35830:36935,35831:38533,35832:20018,35833:27355,35834:37351,35835:23633,35836:23624,35904:25496,35905:31391,35906:27795,35907:38772,35908:36705,35909:31402,35910:29066,35911:38536,35912:31874,35913:26647,35914:32368,35915:26705,35916:37740,35917:21234,35918:21531,35919:34219,35920:35347,35921:32676,35922:36557,35923:37089,35924:21350,35925:34952,35926:31041,35927:20418,35928:20670,35929:21009,35930:20804,35931:21843,35932:22317,35933:29674,35934:22411,35935:22865,35936:24418,35937:24452,35938:24693,35939:24950,35940:24935,35941:25001,35942:25522,35943:25658,35944:25964,35945:26223,35946:26690,35947:28179,35948:30054,35949:31293,35950:31995,35951:32076,35952:32153,35953:32331,35954:32619,35955:33550,35956:33610,35957:34509,35958:35336,35959:35427,35960:35686,35961:36605,35962:38938,35963:40335,35964:33464,35965:36814,35966:39912,35968:21127,35969:25119,35970:25731,35971:28608,35972:38553,35973:26689,35974:20625,35975:27424,35976:27770,35977:28500,35978:31348,35979:32080,35980:34880,35981:35363,35982:26376,35983:20214,35984:20537,35985:20518,35986:20581,35987:20860,35988:21048,35989:21091,35990:21927,35991:22287,35992:22533,35993:23244,35994:24314,35995:25010,35996:25080,35997:25331,35998:25458,35999:26908,36e3:27177,36001:29309,36002:29356,36003:29486,36004:30740,36005:30831,36006:32121,36007:30476,36008:32937,36009:35211,36010:35609,36011:36066,36012:36562,36013:36963,36014:37749,36015:38522,36016:38997,36017:39443,36018:40568,36019:20803,36020:21407,36021:21427,36022:24187,36023:24358,36024:28187,36025:28304,36026:29572,36027:29694,36028:32067,36029:33335,36030:35328,36031:35578,36032:38480,36033:20046,36034:20491,36035:21476,36036:21628,36037:22266,36038:22993,36039:23396,36040:24049,36041:24235,36042:24359,36043:25144,36044:25925,36045:26543,36046:28246,36047:29392,36048:31946,36049:34996,36050:32929,36051:32993,36052:33776,36053:34382,36054:35463,36055:36328,36056:37431,36057:38599,36058:39015,36059:40723,36060:20116,36061:20114,36062:20237,36063:21320,36064:21577,36065:21566,36066:23087,36067:24460,36068:24481,36069:24735,36070:26791,36071:27278,36072:29786,36073:30849,36074:35486,36075:35492,36076:35703,36077:37264,36078:20062,36079:39881,36080:20132,36081:20348,36082:20399,36083:20505,36084:20502,36085:20809,36086:20844,36087:21151,36088:21177,36089:21246,36090:21402,36091:21475,36092:21521,36160:21518,36161:21897,36162:22353,36163:22434,36164:22909,36165:23380,36166:23389,36167:23439,36168:24037,36169:24039,36170:24055,36171:24184,36172:24195,36173:24218,36174:24247,36175:24344,36176:24658,36177:24908,36178:25239,36179:25304,36180:25511,36181:25915,36182:26114,36183:26179,36184:26356,36185:26477,36186:26657,36187:26775,36188:27083,36189:27743,36190:27946,36191:28009,36192:28207,36193:28317,36194:30002,36195:30343,36196:30828,36197:31295,36198:31968,36199:32005,36200:32024,36201:32094,36202:32177,36203:32789,36204:32771,36205:32943,36206:32945,36207:33108,36208:33167,36209:33322,36210:33618,36211:34892,36212:34913,36213:35611,36214:36002,36215:36092,36216:37066,36217:37237,36218:37489,36219:30783,36220:37628,36221:38308,36222:38477,36224:38917,36225:39321,36226:39640,36227:40251,36228:21083,36229:21163,36230:21495,36231:21512,36232:22741,36233:25335,36234:28640,36235:35946,36236:36703,36237:40633,36238:20811,36239:21051,36240:21578,36241:22269,36242:31296,36243:37239,36244:40288,36245:40658,36246:29508,36247:28425,36248:33136,36249:29969,36250:24573,36251:24794,36252:39592,36253:29403,36254:36796,36255:27492,36256:38915,36257:20170,36258:22256,36259:22372,36260:22718,36261:23130,36262:24680,36263:25031,36264:26127,36265:26118,36266:26681,36267:26801,36268:28151,36269:30165,36270:32058,36271:33390,36272:39746,36273:20123,36274:20304,36275:21449,36276:21766,36277:23919,36278:24038,36279:24046,36280:26619,36281:27801,36282:29811,36283:30722,36284:35408,36285:37782,36286:35039,36287:22352,36288:24231,36289:25387,36290:20661,36291:20652,36292:20877,36293:26368,36294:21705,36295:22622,36296:22971,36297:23472,36298:24425,36299:25165,36300:25505,36301:26685,36302:27507,36303:28168,36304:28797,36305:37319,36306:29312,36307:30741,36308:30758,36309:31085,36310:25998,36311:32048,36312:33756,36313:35009,36314:36617,36315:38555,36316:21092,36317:22312,36318:26448,36319:32618,36320:36001,36321:20916,36322:22338,36323:38442,36324:22586,36325:27018,36326:32948,36327:21682,36328:23822,36329:22524,36330:30869,36331:40442,36332:20316,36333:21066,36334:21643,36335:25662,36336:26152,36337:26388,36338:26613,36339:31364,36340:31574,36341:32034,36342:37679,36343:26716,36344:39853,36345:31545,36346:21273,36347:20874,36348:21047,36416:23519,36417:25334,36418:25774,36419:25830,36420:26413,36421:27578,36422:34217,36423:38609,36424:30352,36425:39894,36426:25420,36427:37638,36428:39851,36429:30399,36430:26194,36431:19977,36432:20632,36433:21442,36434:23665,36435:24808,36436:25746,36437:25955,36438:26719,36439:29158,36440:29642,36441:29987,36442:31639,36443:32386,36444:34453,36445:35715,36446:36059,36447:37240,36448:39184,36449:26028,36450:26283,36451:27531,36452:20181,36453:20180,36454:20282,36455:20351,36456:21050,36457:21496,36458:21490,36459:21987,36460:22235,36461:22763,36462:22987,36463:22985,36464:23039,36465:23376,36466:23629,36467:24066,36468:24107,36469:24535,36470:24605,36471:25351,36472:25903,36473:23388,36474:26031,36475:26045,36476:26088,36477:26525,36478:27490,36480:27515,36481:27663,36482:29509,36483:31049,36484:31169,36485:31992,36486:32025,36487:32043,36488:32930,36489:33026,36490:33267,36491:35222,36492:35422,36493:35433,36494:35430,36495:35468,36496:35566,36497:36039,36498:36060,36499:38604,36500:39164,36501:27503,36502:20107,36503:20284,36504:20365,36505:20816,36506:23383,36507:23546,36508:24904,36509:25345,36510:26178,36511:27425,36512:28363,36513:27835,36514:29246,36515:29885,36516:30164,36517:30913,36518:31034,36519:32780,36520:32819,36521:33258,36522:33940,36523:36766,36524:27728,36525:40575,36526:24335,36527:35672,36528:40235,36529:31482,36530:36600,36531:23437,36532:38635,36533:19971,36534:21489,36535:22519,36536:22833,36537:23241,36538:23460,36539:24713,36540:28287,36541:28422,36542:30142,36543:36074,36544:23455,36545:34048,36546:31712,36547:20594,36548:26612,36549:33437,36550:23649,36551:34122,36552:32286,36553:33294,36554:20889,36555:23556,36556:25448,36557:36198,36558:26012,36559:29038,36560:31038,36561:32023,36562:32773,36563:35613,36564:36554,36565:36974,36566:34503,36567:37034,36568:20511,36569:21242,36570:23610,36571:26451,36572:28796,36573:29237,36574:37196,36575:37320,36576:37675,36577:33509,36578:23490,36579:24369,36580:24825,36581:20027,36582:21462,36583:23432,36584:25163,36585:26417,36586:27530,36587:29417,36588:29664,36589:31278,36590:33131,36591:36259,36592:37202,36593:39318,36594:20754,36595:21463,36596:21610,36597:23551,36598:25480,36599:27193,36600:32172,36601:38656,36602:22234,36603:21454,36604:21608,36672:23447,36673:23601,36674:24030,36675:20462,36676:24833,36677:25342,36678:27954,36679:31168,36680:31179,36681:32066,36682:32333,36683:32722,36684:33261,36685:33311,36686:33936,36687:34886,36688:35186,36689:35728,36690:36468,36691:36655,36692:36913,36693:37195,36694:37228,36695:38598,36696:37276,36697:20160,36698:20303,36699:20805,36700:21313,36701:24467,36702:25102,36703:26580,36704:27713,36705:28171,36706:29539,36707:32294,36708:37325,36709:37507,36710:21460,36711:22809,36712:23487,36713:28113,36714:31069,36715:32302,36716:31899,36717:22654,36718:29087,36719:20986,36720:34899,36721:36848,36722:20426,36723:23803,36724:26149,36725:30636,36726:31459,36727:33308,36728:39423,36729:20934,36730:24490,36731:26092,36732:26991,36733:27529,36734:28147,36736:28310,36737:28516,36738:30462,36739:32020,36740:24033,36741:36981,36742:37255,36743:38918,36744:20966,36745:21021,36746:25152,36747:26257,36748:26329,36749:28186,36750:24246,36751:32210,36752:32626,36753:26360,36754:34223,36755:34295,36756:35576,36757:21161,36758:21465,36759:22899,36760:24207,36761:24464,36762:24661,36763:37604,36764:38500,36765:20663,36766:20767,36767:21213,36768:21280,36769:21319,36770:21484,36771:21736,36772:21830,36773:21809,36774:22039,36775:22888,36776:22974,36777:23100,36778:23477,36779:23558,36780:23567,36781:23569,36782:23578,36783:24196,36784:24202,36785:24288,36786:24432,36787:25215,36788:25220,36789:25307,36790:25484,36791:25463,36792:26119,36793:26124,36794:26157,36795:26230,36796:26494,36797:26786,36798:27167,36799:27189,36800:27836,36801:28040,36802:28169,36803:28248,36804:28988,36805:28966,36806:29031,36807:30151,36808:30465,36809:30813,36810:30977,36811:31077,36812:31216,36813:31456,36814:31505,36815:31911,36816:32057,36817:32918,36818:33750,36819:33931,36820:34121,36821:34909,36822:35059,36823:35359,36824:35388,36825:35412,36826:35443,36827:35937,36828:36062,36829:37284,36830:37478,36831:37758,36832:37912,36833:38556,36834:38808,36835:19978,36836:19976,36837:19998,36838:20055,36839:20887,36840:21104,36841:22478,36842:22580,36843:22732,36844:23330,36845:24120,36846:24773,36847:25854,36848:26465,36849:26454,36850:27972,36851:29366,36852:30067,36853:31331,36854:33976,36855:35698,36856:37304,36857:37664,36858:22065,36859:22516,36860:39166,36928:25325,36929:26893,36930:27542,36931:29165,36932:32340,36933:32887,36934:33394,36935:35302,36936:39135,36937:34645,36938:36785,36939:23611,36940:20280,36941:20449,36942:20405,36943:21767,36944:23072,36945:23517,36946:23529,36947:24515,36948:24910,36949:25391,36950:26032,36951:26187,36952:26862,36953:27035,36954:28024,36955:28145,36956:30003,36957:30137,36958:30495,36959:31070,36960:31206,36961:32051,36962:33251,36963:33455,36964:34218,36965:35242,36966:35386,36967:36523,36968:36763,36969:36914,36970:37341,36971:38663,36972:20154,36973:20161,36974:20995,36975:22645,36976:22764,36977:23563,36978:29978,36979:23613,36980:33102,36981:35338,36982:36805,36983:38499,36984:38765,36985:31525,36986:35535,36987:38920,36988:37218,36989:22259,36990:21416,36992:36887,36993:21561,36994:22402,36995:24101,36996:25512,36997:27700,36998:28810,36999:30561,37e3:31883,37001:32736,37002:34928,37003:36930,37004:37204,37005:37648,37006:37656,37007:38543,37008:29790,37009:39620,37010:23815,37011:23913,37012:25968,37013:26530,37014:36264,37015:38619,37016:25454,37017:26441,37018:26905,37019:33733,37020:38935,37021:38592,37022:35070,37023:28548,37024:25722,37025:23544,37026:19990,37027:28716,37028:30045,37029:26159,37030:20932,37031:21046,37032:21218,37033:22995,37034:24449,37035:24615,37036:25104,37037:25919,37038:25972,37039:26143,37040:26228,37041:26866,37042:26646,37043:27491,37044:28165,37045:29298,37046:29983,37047:30427,37048:31934,37049:32854,37050:22768,37051:35069,37052:35199,37053:35488,37054:35475,37055:35531,37056:36893,37057:37266,37058:38738,37059:38745,37060:25993,37061:31246,37062:33030,37063:38587,37064:24109,37065:24796,37066:25114,37067:26021,37068:26132,37069:26512,37070:30707,37071:31309,37072:31821,37073:32318,37074:33034,37075:36012,37076:36196,37077:36321,37078:36447,37079:30889,37080:20999,37081:25305,37082:25509,37083:25666,37084:25240,37085:35373,37086:31363,37087:31680,37088:35500,37089:38634,37090:32118,37091:33292,37092:34633,37093:20185,37094:20808,37095:21315,37096:21344,37097:23459,37098:23554,37099:23574,37100:24029,37101:25126,37102:25159,37103:25776,37104:26643,37105:26676,37106:27849,37107:27973,37108:27927,37109:26579,37110:28508,37111:29006,37112:29053,37113:26059,37114:31359,37115:31661,37116:32218,37184:32330,37185:32680,37186:33146,37187:33307,37188:33337,37189:34214,37190:35438,37191:36046,37192:36341,37193:36984,37194:36983,37195:37549,37196:37521,37197:38275,37198:39854,37199:21069,37200:21892,37201:28472,37202:28982,37203:20840,37204:31109,37205:32341,37206:33203,37207:31950,37208:22092,37209:22609,37210:23720,37211:25514,37212:26366,37213:26365,37214:26970,37215:29401,37216:30095,37217:30094,37218:30990,37219:31062,37220:31199,37221:31895,37222:32032,37223:32068,37224:34311,37225:35380,37226:38459,37227:36961,37228:40736,37229:20711,37230:21109,37231:21452,37232:21474,37233:20489,37234:21930,37235:22766,37236:22863,37237:29245,37238:23435,37239:23652,37240:21277,37241:24803,37242:24819,37243:25436,37244:25475,37245:25407,37246:25531,37248:25805,37249:26089,37250:26361,37251:24035,37252:27085,37253:27133,37254:28437,37255:29157,37256:20105,37257:30185,37258:30456,37259:31379,37260:31967,37261:32207,37262:32156,37263:32865,37264:33609,37265:33624,37266:33900,37267:33980,37268:34299,37269:35013,37270:36208,37271:36865,37272:36973,37273:37783,37274:38684,37275:39442,37276:20687,37277:22679,37278:24974,37279:33235,37280:34101,37281:36104,37282:36896,37283:20419,37284:20596,37285:21063,37286:21363,37287:24687,37288:25417,37289:26463,37290:28204,37291:36275,37292:36895,37293:20439,37294:23646,37295:36042,37296:26063,37297:32154,37298:21330,37299:34966,37300:20854,37301:25539,37302:23384,37303:23403,37304:23562,37305:25613,37306:26449,37307:36956,37308:20182,37309:22810,37310:22826,37311:27760,37312:35409,37313:21822,37314:22549,37315:22949,37316:24816,37317:25171,37318:26561,37319:33333,37320:26965,37321:38464,37322:39364,37323:39464,37324:20307,37325:22534,37326:23550,37327:32784,37328:23729,37329:24111,37330:24453,37331:24608,37332:24907,37333:25140,37334:26367,37335:27888,37336:28382,37337:32974,37338:33151,37339:33492,37340:34955,37341:36024,37342:36864,37343:36910,37344:38538,37345:40667,37346:39899,37347:20195,37348:21488,37349:22823,37350:31532,37351:37261,37352:38988,37353:40441,37354:28381,37355:28711,37356:21331,37357:21828,37358:23429,37359:25176,37360:25246,37361:25299,37362:27810,37363:28655,37364:29730,37365:35351,37366:37944,37367:28609,37368:35582,37369:33592,37370:20967,37371:34552,37372:21482,37440:21481,37441:20294,37442:36948,37443:36784,37444:22890,37445:33073,37446:24061,37447:31466,37448:36799,37449:26842,37450:35895,37451:29432,37452:40008,37453:27197,37454:35504,37455:20025,37456:21336,37457:22022,37458:22374,37459:25285,37460:25506,37461:26086,37462:27470,37463:28129,37464:28251,37465:28845,37466:30701,37467:31471,37468:31658,37469:32187,37470:32829,37471:32966,37472:34507,37473:35477,37474:37723,37475:22243,37476:22727,37477:24382,37478:26029,37479:26262,37480:27264,37481:27573,37482:30007,37483:35527,37484:20516,37485:30693,37486:22320,37487:24347,37488:24677,37489:26234,37490:27744,37491:30196,37492:31258,37493:32622,37494:33268,37495:34584,37496:36933,37497:39347,37498:31689,37499:30044,37500:31481,37501:31569,37502:33988,37504:36880,37505:31209,37506:31378,37507:33590,37508:23265,37509:30528,37510:20013,37511:20210,37512:23449,37513:24544,37514:25277,37515:26172,37516:26609,37517:27880,37518:34411,37519:34935,37520:35387,37521:37198,37522:37619,37523:39376,37524:27159,37525:28710,37526:29482,37527:33511,37528:33879,37529:36015,37530:19969,37531:20806,37532:20939,37533:21899,37534:23541,37535:24086,37536:24115,37537:24193,37538:24340,37539:24373,37540:24427,37541:24500,37542:25074,37543:25361,37544:26274,37545:26397,37546:28526,37547:29266,37548:30010,37549:30522,37550:32884,37551:33081,37552:33144,37553:34678,37554:35519,37555:35548,37556:36229,37557:36339,37558:37530,37559:38263,37560:38914,37561:40165,37562:21189,37563:25431,37564:30452,37565:26389,37566:27784,37567:29645,37568:36035,37569:37806,37570:38515,37571:27941,37572:22684,37573:26894,37574:27084,37575:36861,37576:37786,37577:30171,37578:36890,37579:22618,37580:26626,37581:25524,37582:27131,37583:20291,37584:28460,37585:26584,37586:36795,37587:34086,37588:32180,37589:37716,37590:26943,37591:28528,37592:22378,37593:22775,37594:23340,37595:32044,37596:29226,37597:21514,37598:37347,37599:40372,37600:20141,37601:20302,37602:20572,37603:20597,37604:21059,37605:35998,37606:21576,37607:22564,37608:23450,37609:24093,37610:24213,37611:24237,37612:24311,37613:24351,37614:24716,37615:25269,37616:25402,37617:25552,37618:26799,37619:27712,37620:30855,37621:31118,37622:31243,37623:32224,37624:33351,37625:35330,37626:35558,37627:36420,37628:36883,37696:37048,37697:37165,37698:37336,37699:40718,37700:27877,37701:25688,37702:25826,37703:25973,37704:28404,37705:30340,37706:31515,37707:36969,37708:37841,37709:28346,37710:21746,37711:24505,37712:25764,37713:36685,37714:36845,37715:37444,37716:20856,37717:22635,37718:22825,37719:23637,37720:24215,37721:28155,37722:32399,37723:29980,37724:36028,37725:36578,37726:39003,37727:28857,37728:20253,37729:27583,37730:28593,37731:3e4,37732:38651,37733:20814,37734:21520,37735:22581,37736:22615,37737:22956,37738:23648,37739:24466,37740:26007,37741:26460,37742:28193,37743:30331,37744:33759,37745:36077,37746:36884,37747:37117,37748:37709,37749:30757,37750:30778,37751:21162,37752:24230,37753:22303,37754:22900,37755:24594,37756:20498,37757:20826,37758:20908,37760:20941,37761:20992,37762:21776,37763:22612,37764:22616,37765:22871,37766:23445,37767:23798,37768:23947,37769:24764,37770:25237,37771:25645,37772:26481,37773:26691,37774:26812,37775:26847,37776:30423,37777:28120,37778:28271,37779:28059,37780:28783,37781:29128,37782:24403,37783:30168,37784:31095,37785:31561,37786:31572,37787:31570,37788:31958,37789:32113,37790:21040,37791:33891,37792:34153,37793:34276,37794:35342,37795:35588,37796:35910,37797:36367,37798:36867,37799:36879,37800:37913,37801:38518,37802:38957,37803:39472,37804:38360,37805:20685,37806:21205,37807:21516,37808:22530,37809:23566,37810:24999,37811:25758,37812:27934,37813:30643,37814:31461,37815:33012,37816:33796,37817:36947,37818:37509,37819:23776,37820:40199,37821:21311,37822:24471,37823:24499,37824:28060,37825:29305,37826:30563,37827:31167,37828:31716,37829:27602,37830:29420,37831:35501,37832:26627,37833:27233,37834:20984,37835:31361,37836:26932,37837:23626,37838:40182,37839:33515,37840:23493,37841:37193,37842:28702,37843:22136,37844:23663,37845:24775,37846:25958,37847:27788,37848:35930,37849:36929,37850:38931,37851:21585,37852:26311,37853:37389,37854:22856,37855:37027,37856:20869,37857:20045,37858:20970,37859:34201,37860:35598,37861:28760,37862:25466,37863:37707,37864:26978,37865:39348,37866:32260,37867:30071,37868:21335,37869:26976,37870:36575,37871:38627,37872:27741,37873:20108,37874:23612,37875:24336,37876:36841,37877:21250,37878:36049,37879:32905,37880:34425,37881:24319,37882:26085,37883:20083,37884:20837,37952:22914,37953:23615,37954:38894,37955:20219,37956:22922,37957:24525,37958:35469,37959:28641,37960:31152,37961:31074,37962:23527,37963:33905,37964:29483,37965:29105,37966:24180,37967:24565,37968:25467,37969:25754,37970:29123,37971:31896,37972:20035,37973:24316,37974:20043,37975:22492,37976:22178,37977:24745,37978:28611,37979:32013,37980:33021,37981:33075,37982:33215,37983:36786,37984:35223,37985:34468,37986:24052,37987:25226,37988:25773,37989:35207,37990:26487,37991:27874,37992:27966,37993:29750,37994:30772,37995:23110,37996:32629,37997:33453,37998:39340,37999:20467,38e3:24259,38001:25309,38002:25490,38003:25943,38004:26479,38005:30403,38006:29260,38007:32972,38008:32954,38009:36649,38010:37197,38011:20493,38012:22521,38013:23186,38014:26757,38016:26995,38017:29028,38018:29437,38019:36023,38020:22770,38021:36064,38022:38506,38023:36889,38024:34687,38025:31204,38026:30695,38027:33833,38028:20271,38029:21093,38030:21338,38031:25293,38032:26575,38033:27850,38034:30333,38035:31636,38036:31893,38037:33334,38038:34180,38039:36843,38040:26333,38041:28448,38042:29190,38043:32283,38044:33707,38045:39361,38046:40614,38047:20989,38048:31665,38049:30834,38050:31672,38051:32903,38052:31560,38053:27368,38054:24161,38055:32908,38056:30033,38057:30048,38058:20843,38059:37474,38060:28300,38061:30330,38062:37271,38063:39658,38064:20240,38065:32624,38066:25244,38067:31567,38068:38309,38069:40169,38070:22138,38071:22617,38072:34532,38073:38588,38074:20276,38075:21028,38076:21322,38077:21453,38078:21467,38079:24070,38080:25644,38081:26001,38082:26495,38083:27710,38084:27726,38085:29256,38086:29359,38087:29677,38088:30036,38089:32321,38090:33324,38091:34281,38092:36009,38093:31684,38094:37318,38095:29033,38096:38930,38097:39151,38098:25405,38099:26217,38100:30058,38101:30436,38102:30928,38103:34115,38104:34542,38105:21290,38106:21329,38107:21542,38108:22915,38109:24199,38110:24444,38111:24754,38112:25161,38113:25209,38114:25259,38115:26e3,38116:27604,38117:27852,38118:30130,38119:30382,38120:30865,38121:31192,38122:32203,38123:32631,38124:32933,38125:34987,38126:35513,38127:36027,38128:36991,38129:38750,38130:39131,38131:27147,38132:31800,38133:20633,38134:23614,38135:24494,38136:26503,38137:27608,38138:29749,38139:30473,38140:32654,38208:40763,38209:26570,38210:31255,38211:21305,38212:30091,38213:39661,38214:24422,38215:33181,38216:33777,38217:32920,38218:24380,38219:24517,38220:30050,38221:31558,38222:36924,38223:26727,38224:23019,38225:23195,38226:32016,38227:30334,38228:35628,38229:20469,38230:24426,38231:27161,38232:27703,38233:28418,38234:29922,38235:31080,38236:34920,38237:35413,38238:35961,38239:24287,38240:25551,38241:30149,38242:31186,38243:33495,38244:37672,38245:37618,38246:33948,38247:34541,38248:39981,38249:21697,38250:24428,38251:25996,38252:27996,38253:28693,38254:36007,38255:36051,38256:38971,38257:25935,38258:29942,38259:19981,38260:20184,38261:22496,38262:22827,38263:23142,38264:23500,38265:20904,38266:24067,38267:24220,38268:24598,38269:25206,38270:25975,38272:26023,38273:26222,38274:28014,38275:29238,38276:31526,38277:33104,38278:33178,38279:33433,38280:35676,38281:36e3,38282:36070,38283:36212,38284:38428,38285:38468,38286:20398,38287:25771,38288:27494,38289:33310,38290:33889,38291:34154,38292:37096,38293:23553,38294:26963,38295:39080,38296:33914,38297:34135,38298:20239,38299:21103,38300:24489,38301:24133,38302:26381,38303:31119,38304:33145,38305:35079,38306:35206,38307:28149,38308:24343,38309:25173,38310:27832,38311:20175,38312:29289,38313:39826,38314:20998,38315:21563,38316:22132,38317:22707,38318:24996,38319:25198,38320:28954,38321:22894,38322:31881,38323:31966,38324:32027,38325:38640,38326:25991,38327:32862,38328:19993,38329:20341,38330:20853,38331:22592,38332:24163,38333:24179,38334:24330,38335:26564,38336:20006,38337:34109,38338:38281,38339:38491,38340:31859,38341:38913,38342:20731,38343:22721,38344:30294,38345:30887,38346:21029,38347:30629,38348:34065,38349:31622,38350:20559,38351:22793,38352:29255,38353:31687,38354:32232,38355:36794,38356:36820,38357:36941,38358:20415,38359:21193,38360:23081,38361:24321,38362:38829,38363:20445,38364:33303,38365:37610,38366:22275,38367:25429,38368:27497,38369:29995,38370:35036,38371:36628,38372:31298,38373:21215,38374:22675,38375:24917,38376:25098,38377:26286,38378:27597,38379:31807,38380:33769,38381:20515,38382:20472,38383:21253,38384:21574,38385:22577,38386:22857,38387:23453,38388:23792,38389:23791,38390:23849,38391:24214,38392:25265,38393:25447,38394:25918,38395:26041,38396:26379,38464:27861,38465:27873,38466:28921,38467:30770,38468:32299,38469:32990,38470:33459,38471:33804,38472:34028,38473:34562,38474:35090,38475:35370,38476:35914,38477:37030,38478:37586,38479:39165,38480:40179,38481:40300,38482:20047,38483:20129,38484:20621,38485:21078,38486:22346,38487:22952,38488:24125,38489:24536,38490:24537,38491:25151,38492:26292,38493:26395,38494:26576,38495:26834,38496:20882,38497:32033,38498:32938,38499:33192,38500:35584,38501:35980,38502:36031,38503:37502,38504:38450,38505:21536,38506:38956,38507:21271,38508:20693,38509:21340,38510:22696,38511:25778,38512:26420,38513:29287,38514:30566,38515:31302,38516:37350,38517:21187,38518:27809,38519:27526,38520:22528,38521:24140,38522:22868,38523:26412,38524:32763,38525:20961,38526:30406,38528:25705,38529:30952,38530:39764,38531:40635,38532:22475,38533:22969,38534:26151,38535:26522,38536:27598,38537:21737,38538:27097,38539:24149,38540:33180,38541:26517,38542:39850,38543:26622,38544:40018,38545:26717,38546:20134,38547:20451,38548:21448,38549:25273,38550:26411,38551:27819,38552:36804,38553:20397,38554:32365,38555:40639,38556:19975,38557:24930,38558:28288,38559:28459,38560:34067,38561:21619,38562:26410,38563:39749,38564:24051,38565:31637,38566:23724,38567:23494,38568:34588,38569:28234,38570:34001,38571:31252,38572:33032,38573:22937,38574:31885,38575:27665,38576:30496,38577:21209,38578:22818,38579:28961,38580:29279,38581:30683,38582:38695,38583:40289,38584:26891,38585:23167,38586:23064,38587:20901,38588:21517,38589:21629,38590:26126,38591:30431,38592:36855,38593:37528,38594:40180,38595:23018,38596:29277,38597:28357,38598:20813,38599:26825,38600:32191,38601:32236,38602:38754,38603:40634,38604:25720,38605:27169,38606:33538,38607:22916,38608:23391,38609:27611,38610:29467,38611:30450,38612:32178,38613:32791,38614:33945,38615:20786,38616:26408,38617:40665,38618:30446,38619:26466,38620:21247,38621:39173,38622:23588,38623:25147,38624:31870,38625:36016,38626:21839,38627:24758,38628:32011,38629:38272,38630:21249,38631:20063,38632:20918,38633:22812,38634:29242,38635:32822,38636:37326,38637:24357,38638:30690,38639:21380,38640:24441,38641:32004,38642:34220,38643:35379,38644:36493,38645:38742,38646:26611,38647:34222,38648:37971,38649:24841,38650:24840,38651:27833,38652:30290,38720:35565,38721:36664,38722:21807,38723:20305,38724:20778,38725:21191,38726:21451,38727:23461,38728:24189,38729:24736,38730:24962,38731:25558,38732:26377,38733:26586,38734:28263,38735:28044,38736:29494,38737:29495,38738:30001,38739:31056,38740:35029,38741:35480,38742:36938,38743:37009,38744:37109,38745:38596,38746:34701,38747:22805,38748:20104,38749:20313,38750:19982,38751:35465,38752:36671,38753:38928,38754:20653,38755:24188,38756:22934,38757:23481,38758:24248,38759:25562,38760:25594,38761:25793,38762:26332,38763:26954,38764:27096,38765:27915,38766:28342,38767:29076,38768:29992,38769:31407,38770:32650,38771:32768,38772:33865,38773:33993,38774:35201,38775:35617,38776:36362,38777:36965,38778:38525,38779:39178,38780:24958,38781:25233,38782:27442,38784:27779,38785:28020,38786:32716,38787:32764,38788:28096,38789:32645,38790:34746,38791:35064,38792:26469,38793:33713,38794:38972,38795:38647,38796:27931,38797:32097,38798:33853,38799:37226,38800:20081,38801:21365,38802:23888,38803:27396,38804:28651,38805:34253,38806:34349,38807:35239,38808:21033,38809:21519,38810:23653,38811:26446,38812:26792,38813:29702,38814:29827,38815:30178,38816:35023,38817:35041,38818:37324,38819:38626,38820:38520,38821:24459,38822:29575,38823:31435,38824:33870,38825:25504,38826:30053,38827:21129,38828:27969,38829:28316,38830:29705,38831:30041,38832:30827,38833:31890,38834:38534,38835:31452,38836:40845,38837:20406,38838:24942,38839:26053,38840:34396,38841:20102,38842:20142,38843:20698,38844:20001,38845:20940,38846:23534,38847:26009,38848:26753,38849:28092,38850:29471,38851:30274,38852:30637,38853:31260,38854:31975,38855:33391,38856:35538,38857:36988,38858:37327,38859:38517,38860:38936,38861:21147,38862:32209,38863:20523,38864:21400,38865:26519,38866:28107,38867:29136,38868:29747,38869:33256,38870:36650,38871:38563,38872:40023,38873:40607,38874:29792,38875:22593,38876:28057,38877:32047,38878:39006,38879:20196,38880:20278,38881:20363,38882:20919,38883:21169,38884:23994,38885:24604,38886:29618,38887:31036,38888:33491,38889:37428,38890:38583,38891:38646,38892:38666,38893:40599,38894:40802,38895:26278,38896:27508,38897:21015,38898:21155,38899:28872,38900:35010,38901:24265,38902:24651,38903:24976,38904:28451,38905:29001,38906:31806,38907:32244,38908:32879,38976:34030,38977:36899,38978:37676,38979:21570,38980:39791,38981:27347,38982:28809,38983:36034,38984:36335,38985:38706,38986:21172,38987:23105,38988:24266,38989:24324,38990:26391,38991:27004,38992:27028,38993:28010,38994:28431,38995:29282,38996:29436,38997:31725,38998:32769,38999:32894,39e3:34635,39001:37070,39002:20845,39003:40595,39004:31108,39005:32907,39006:37682,39007:35542,39008:20525,39009:21644,39010:35441,39011:27498,39012:36036,39013:33031,39014:24785,39015:26528,39016:40434,39017:20121,39018:20120,39019:39952,39020:35435,39021:34241,39022:34152,39023:26880,39024:28286,39025:30871,39026:33109,39071:24332,39072:19984,39073:19989,39074:20010,39075:20017,39076:20022,39077:20028,39078:20031,39079:20034,39080:20054,39081:20056,39082:20098,39083:20101,39084:35947,39085:20106,39086:33298,39087:24333,39088:20110,39089:20126,39090:20127,39091:20128,39092:20130,39093:20144,39094:20147,39095:20150,39096:20174,39097:20173,39098:20164,39099:20166,39100:20162,39101:20183,39102:20190,39103:20205,39104:20191,39105:20215,39106:20233,39107:20314,39108:20272,39109:20315,39110:20317,39111:20311,39112:20295,39113:20342,39114:20360,39115:20367,39116:20376,39117:20347,39118:20329,39119:20336,39120:20369,39121:20335,39122:20358,39123:20374,39124:20760,39125:20436,39126:20447,39127:20430,39128:20440,39129:20443,39130:20433,39131:20442,39132:20432,39133:20452,39134:20453,39135:20506,39136:20520,39137:20500,39138:20522,39139:20517,39140:20485,39141:20252,39142:20470,39143:20513,39144:20521,39145:20524,39146:20478,39147:20463,39148:20497,39149:20486,39150:20547,39151:20551,39152:26371,39153:20565,39154:20560,39155:20552,39156:20570,39157:20566,39158:20588,39159:20600,39160:20608,39161:20634,39162:20613,39163:20660,39164:20658,39232:20681,39233:20682,39234:20659,39235:20674,39236:20694,39237:20702,39238:20709,39239:20717,39240:20707,39241:20718,39242:20729,39243:20725,39244:20745,39245:20737,39246:20738,39247:20758,39248:20757,39249:20756,39250:20762,39251:20769,39252:20794,39253:20791,39254:20796,39255:20795,39256:20799,39257:20800,39258:20818,39259:20812,39260:20820,39261:20834,39262:31480,39263:20841,39264:20842,39265:20846,39266:20864,39267:20866,39268:22232,39269:20876,39270:20873,39271:20879,39272:20881,39273:20883,39274:20885,39275:20886,39276:20900,39277:20902,39278:20898,39279:20905,39280:20906,39281:20907,39282:20915,39283:20913,39284:20914,39285:20912,39286:20917,39287:20925,39288:20933,39289:20937,39290:20955,39291:20960,39292:34389,39293:20969,39294:20973,39296:20976,39297:20981,39298:20990,39299:20996,39300:21003,39301:21012,39302:21006,39303:21031,39304:21034,39305:21038,39306:21043,39307:21049,39308:21071,39309:21060,39310:21067,39311:21068,39312:21086,39313:21076,39314:21098,39315:21108,39316:21097,39317:21107,39318:21119,39319:21117,39320:21133,39321:21140,39322:21138,39323:21105,39324:21128,39325:21137,39326:36776,39327:36775,39328:21164,39329:21165,39330:21180,39331:21173,39332:21185,39333:21197,39334:21207,39335:21214,39336:21219,39337:21222,39338:39149,39339:21216,39340:21235,39341:21237,39342:21240,39343:21241,39344:21254,39345:21256,39346:30008,39347:21261,39348:21264,39349:21263,39350:21269,39351:21274,39352:21283,39353:21295,39354:21297,39355:21299,39356:21304,39357:21312,39358:21318,39359:21317,39360:19991,39361:21321,39362:21325,39363:20950,39364:21342,39365:21353,39366:21358,39367:22808,39368:21371,39369:21367,39370:21378,39371:21398,39372:21408,39373:21414,39374:21413,39375:21422,39376:21424,39377:21430,39378:21443,39379:31762,39380:38617,39381:21471,39382:26364,39383:29166,39384:21486,39385:21480,39386:21485,39387:21498,39388:21505,39389:21565,39390:21568,39391:21548,39392:21549,39393:21564,39394:21550,39395:21558,39396:21545,39397:21533,39398:21582,39399:21647,39400:21621,39401:21646,39402:21599,39403:21617,39404:21623,39405:21616,39406:21650,39407:21627,39408:21632,39409:21622,39410:21636,39411:21648,39412:21638,39413:21703,39414:21666,39415:21688,39416:21669,39417:21676,39418:21700,39419:21704,39420:21672,39488:21675,39489:21698,39490:21668,39491:21694,39492:21692,39493:21720,39494:21733,39495:21734,39496:21775,39497:21780,39498:21757,39499:21742,39500:21741,39501:21754,39502:21730,39503:21817,39504:21824,39505:21859,39506:21836,39507:21806,39508:21852,39509:21829,39510:21846,39511:21847,39512:21816,39513:21811,39514:21853,39515:21913,39516:21888,39517:21679,39518:21898,39519:21919,39520:21883,39521:21886,39522:21912,39523:21918,39524:21934,39525:21884,39526:21891,39527:21929,39528:21895,39529:21928,39530:21978,39531:21957,39532:21983,39533:21956,39534:21980,39535:21988,39536:21972,39537:22036,39538:22007,39539:22038,39540:22014,39541:22013,39542:22043,39543:22009,39544:22094,39545:22096,39546:29151,39547:22068,39548:22070,39549:22066,39550:22072,39552:22123,39553:22116,39554:22063,39555:22124,39556:22122,39557:22150,39558:22144,39559:22154,39560:22176,39561:22164,39562:22159,39563:22181,39564:22190,39565:22198,39566:22196,39567:22210,39568:22204,39569:22209,39570:22211,39571:22208,39572:22216,39573:22222,39574:22225,39575:22227,39576:22231,39577:22254,39578:22265,39579:22272,39580:22271,39581:22276,39582:22281,39583:22280,39584:22283,39585:22285,39586:22291,39587:22296,39588:22294,39589:21959,39590:22300,39591:22310,39592:22327,39593:22328,39594:22350,39595:22331,39596:22336,39597:22351,39598:22377,39599:22464,39600:22408,39601:22369,39602:22399,39603:22409,39604:22419,39605:22432,39606:22451,39607:22436,39608:22442,39609:22448,39610:22467,39611:22470,39612:22484,39613:22482,39614:22483,39615:22538,39616:22486,39617:22499,39618:22539,39619:22553,39620:22557,39621:22642,39622:22561,39623:22626,39624:22603,39625:22640,39626:27584,39627:22610,39628:22589,39629:22649,39630:22661,39631:22713,39632:22687,39633:22699,39634:22714,39635:22750,39636:22715,39637:22712,39638:22702,39639:22725,39640:22739,39641:22737,39642:22743,39643:22745,39644:22744,39645:22757,39646:22748,39647:22756,39648:22751,39649:22767,39650:22778,39651:22777,39652:22779,39653:22780,39654:22781,39655:22786,39656:22794,39657:22800,39658:22811,39659:26790,39660:22821,39661:22828,39662:22829,39663:22834,39664:22840,39665:22846,39666:31442,39667:22869,39668:22864,39669:22862,39670:22874,39671:22872,39672:22882,39673:22880,39674:22887,39675:22892,39676:22889,39744:22904,39745:22913,39746:22941,39747:20318,39748:20395,39749:22947,39750:22962,39751:22982,39752:23016,39753:23004,39754:22925,39755:23001,39756:23002,39757:23077,39758:23071,39759:23057,39760:23068,39761:23049,39762:23066,39763:23104,39764:23148,39765:23113,39766:23093,39767:23094,39768:23138,39769:23146,39770:23194,39771:23228,39772:23230,39773:23243,39774:23234,39775:23229,39776:23267,39777:23255,39778:23270,39779:23273,39780:23254,39781:23290,39782:23291,39783:23308,39784:23307,39785:23318,39786:23346,39787:23248,39788:23338,39789:23350,39790:23358,39791:23363,39792:23365,39793:23360,39794:23377,39795:23381,39796:23386,39797:23387,39798:23397,39799:23401,39800:23408,39801:23411,39802:23413,39803:23416,39804:25992,39805:23418,39806:23424,39808:23427,39809:23462,39810:23480,39811:23491,39812:23495,39813:23497,39814:23508,39815:23504,39816:23524,39817:23526,39818:23522,39819:23518,39820:23525,39821:23531,39822:23536,39823:23542,39824:23539,39825:23557,39826:23559,39827:23560,39828:23565,39829:23571,39830:23584,39831:23586,39832:23592,39833:23608,39834:23609,39835:23617,39836:23622,39837:23630,39838:23635,39839:23632,39840:23631,39841:23409,39842:23660,39843:23662,39844:20066,39845:23670,39846:23673,39847:23692,39848:23697,39849:23700,39850:22939,39851:23723,39852:23739,39853:23734,39854:23740,39855:23735,39856:23749,39857:23742,39858:23751,39859:23769,39860:23785,39861:23805,39862:23802,39863:23789,39864:23948,39865:23786,39866:23819,39867:23829,39868:23831,39869:23900,39870:23839,39871:23835,39872:23825,39873:23828,39874:23842,39875:23834,39876:23833,39877:23832,39878:23884,39879:23890,39880:23886,39881:23883,39882:23916,39883:23923,39884:23926,39885:23943,39886:23940,39887:23938,39888:23970,39889:23965,39890:23980,39891:23982,39892:23997,39893:23952,39894:23991,39895:23996,39896:24009,39897:24013,39898:24019,39899:24018,39900:24022,39901:24027,39902:24043,39903:24050,39904:24053,39905:24075,39906:24090,39907:24089,39908:24081,39909:24091,39910:24118,39911:24119,39912:24132,39913:24131,39914:24128,39915:24142,39916:24151,39917:24148,39918:24159,39919:24162,39920:24164,39921:24135,39922:24181,39923:24182,39924:24186,39925:40636,39926:24191,39927:24224,39928:24257,39929:24258,39930:24264,39931:24272,39932:24271,4e4:24278,40001:24291,40002:24285,40003:24282,40004:24283,40005:24290,40006:24289,40007:24296,40008:24297,40009:24300,40010:24305,40011:24307,40012:24304,40013:24308,40014:24312,40015:24318,40016:24323,40017:24329,40018:24413,40019:24412,40020:24331,40021:24337,40022:24342,40023:24361,40024:24365,40025:24376,40026:24385,40027:24392,40028:24396,40029:24398,40030:24367,40031:24401,40032:24406,40033:24407,40034:24409,40035:24417,40036:24429,40037:24435,40038:24439,40039:24451,40040:24450,40041:24447,40042:24458,40043:24456,40044:24465,40045:24455,40046:24478,40047:24473,40048:24472,40049:24480,40050:24488,40051:24493,40052:24508,40053:24534,40054:24571,40055:24548,40056:24568,40057:24561,40058:24541,40059:24755,40060:24575,40061:24609,40062:24672,40064:24601,40065:24592,40066:24617,40067:24590,40068:24625,40069:24603,40070:24597,40071:24619,40072:24614,40073:24591,40074:24634,40075:24666,40076:24641,40077:24682,40078:24695,40079:24671,40080:24650,40081:24646,40082:24653,40083:24675,40084:24643,40085:24676,40086:24642,40087:24684,40088:24683,40089:24665,40090:24705,40091:24717,40092:24807,40093:24707,40094:24730,40095:24708,40096:24731,40097:24726,40098:24727,40099:24722,40100:24743,40101:24715,40102:24801,40103:24760,40104:24800,40105:24787,40106:24756,40107:24560,40108:24765,40109:24774,40110:24757,40111:24792,40112:24909,40113:24853,40114:24838,40115:24822,40116:24823,40117:24832,40118:24820,40119:24826,40120:24835,40121:24865,40122:24827,40123:24817,40124:24845,40125:24846,40126:24903,40127:24894,40128:24872,40129:24871,40130:24906,40131:24895,40132:24892,40133:24876,40134:24884,40135:24893,40136:24898,40137:24900,40138:24947,40139:24951,40140:24920,40141:24921,40142:24922,40143:24939,40144:24948,40145:24943,40146:24933,40147:24945,40148:24927,40149:24925,40150:24915,40151:24949,40152:24985,40153:24982,40154:24967,40155:25004,40156:24980,40157:24986,40158:24970,40159:24977,40160:25003,40161:25006,40162:25036,40163:25034,40164:25033,40165:25079,40166:25032,40167:25027,40168:25030,40169:25018,40170:25035,40171:32633,40172:25037,40173:25062,40174:25059,40175:25078,40176:25082,40177:25076,40178:25087,40179:25085,40180:25084,40181:25086,40182:25088,40183:25096,40184:25097,40185:25101,40186:25100,40187:25108,40188:25115,40256:25118,40257:25121,40258:25130,40259:25134,40260:25136,40261:25138,40262:25139,40263:25153,40264:25166,40265:25182,40266:25187,40267:25179,40268:25184,40269:25192,40270:25212,40271:25218,40272:25225,40273:25214,40274:25234,40275:25235,40276:25238,40277:25300,40278:25219,40279:25236,40280:25303,40281:25297,40282:25275,40283:25295,40284:25343,40285:25286,40286:25812,40287:25288,40288:25308,40289:25292,40290:25290,40291:25282,40292:25287,40293:25243,40294:25289,40295:25356,40296:25326,40297:25329,40298:25383,40299:25346,40300:25352,40301:25327,40302:25333,40303:25424,40304:25406,40305:25421,40306:25628,40307:25423,40308:25494,40309:25486,40310:25472,40311:25515,40312:25462,40313:25507,40314:25487,40315:25481,40316:25503,40317:25525,40318:25451,40320:25449,40321:25534,40322:25577,40323:25536,40324:25542,40325:25571,40326:25545,40327:25554,40328:25590,40329:25540,40330:25622,40331:25652,40332:25606,40333:25619,40334:25638,40335:25654,40336:25885,40337:25623,40338:25640,40339:25615,40340:25703,40341:25711,40342:25718,40343:25678,40344:25898,40345:25749,40346:25747,40347:25765,40348:25769,40349:25736,40350:25788,40351:25818,40352:25810,40353:25797,40354:25799,40355:25787,40356:25816,40357:25794,40358:25841,40359:25831,40360:33289,40361:25824,40362:25825,40363:25260,40364:25827,40365:25839,40366:25900,40367:25846,40368:25844,40369:25842,40370:25850,40371:25856,40372:25853,40373:25880,40374:25884,40375:25861,40376:25892,40377:25891,40378:25899,40379:25908,40380:25909,40381:25911,40382:25910,40383:25912,40384:30027,40385:25928,40386:25942,40387:25941,40388:25933,40389:25944,40390:25950,40391:25949,40392:25970,40393:25976,40394:25986,40395:25987,40396:35722,40397:26011,40398:26015,40399:26027,40400:26039,40401:26051,40402:26054,40403:26049,40404:26052,40405:26060,40406:26066,40407:26075,40408:26073,40409:26080,40410:26081,40411:26097,40412:26482,40413:26122,40414:26115,40415:26107,40416:26483,40417:26165,40418:26166,40419:26164,40420:26140,40421:26191,40422:26180,40423:26185,40424:26177,40425:26206,40426:26205,40427:26212,40428:26215,40429:26216,40430:26207,40431:26210,40432:26224,40433:26243,40434:26248,40435:26254,40436:26249,40437:26244,40438:26264,40439:26269,40440:26305,40441:26297,40442:26313,40443:26302,40444:26300,40512:26308,40513:26296,40514:26326,40515:26330,40516:26336,40517:26175,40518:26342,40519:26345,40520:26352,40521:26357,40522:26359,40523:26383,40524:26390,40525:26398,40526:26406,40527:26407,40528:38712,40529:26414,40530:26431,40531:26422,40532:26433,40533:26424,40534:26423,40535:26438,40536:26462,40537:26464,40538:26457,40539:26467,40540:26468,40541:26505,40542:26480,40543:26537,40544:26492,40545:26474,40546:26508,40547:26507,40548:26534,40549:26529,40550:26501,40551:26551,40552:26607,40553:26548,40554:26604,40555:26547,40556:26601,40557:26552,40558:26596,40559:26590,40560:26589,40561:26594,40562:26606,40563:26553,40564:26574,40565:26566,40566:26599,40567:27292,40568:26654,40569:26694,40570:26665,40571:26688,40572:26701,40573:26674,40574:26702,40576:26803,40577:26667,40578:26713,40579:26723,40580:26743,40581:26751,40582:26783,40583:26767,40584:26797,40585:26772,40586:26781,40587:26779,40588:26755,40589:27310,40590:26809,40591:26740,40592:26805,40593:26784,40594:26810,40595:26895,40596:26765,40597:26750,40598:26881,40599:26826,40600:26888,40601:26840,40602:26914,40603:26918,40604:26849,40605:26892,40606:26829,40607:26836,40608:26855,40609:26837,40610:26934,40611:26898,40612:26884,40613:26839,40614:26851,40615:26917,40616:26873,40617:26848,40618:26863,40619:26920,40620:26922,40621:26906,40622:26915,40623:26913,40624:26822,40625:27001,40626:26999,40627:26972,40628:27e3,40629:26987,40630:26964,40631:27006,40632:26990,40633:26937,40634:26996,40635:26941,40636:26969,40637:26928,40638:26977,40639:26974,40640:26973,40641:27009,40642:26986,40643:27058,40644:27054,40645:27088,40646:27071,40647:27073,40648:27091,40649:27070,40650:27086,40651:23528,40652:27082,40653:27101,40654:27067,40655:27075,40656:27047,40657:27182,40658:27025,40659:27040,40660:27036,40661:27029,40662:27060,40663:27102,40664:27112,40665:27138,40666:27163,40667:27135,40668:27402,40669:27129,40670:27122,40671:27111,40672:27141,40673:27057,40674:27166,40675:27117,40676:27156,40677:27115,40678:27146,40679:27154,40680:27329,40681:27171,40682:27155,40683:27204,40684:27148,40685:27250,40686:27190,40687:27256,40688:27207,40689:27234,40690:27225,40691:27238,40692:27208,40693:27192,40694:27170,40695:27280,40696:27277,40697:27296,40698:27268,40699:27298,40700:27299,40768:27287,40769:34327,40770:27323,40771:27331,40772:27330,40773:27320,40774:27315,40775:27308,40776:27358,40777:27345,40778:27359,40779:27306,40780:27354,40781:27370,40782:27387,40783:27397,40784:34326,40785:27386,40786:27410,40787:27414,40788:39729,40789:27423,40790:27448,40791:27447,40792:30428,40793:27449,40794:39150,40795:27463,40796:27459,40797:27465,40798:27472,40799:27481,40800:27476,40801:27483,40802:27487,40803:27489,40804:27512,40805:27513,40806:27519,40807:27520,40808:27524,40809:27523,40810:27533,40811:27544,40812:27541,40813:27550,40814:27556,40815:27562,40816:27563,40817:27567,40818:27570,40819:27569,40820:27571,40821:27575,40822:27580,40823:27590,40824:27595,40825:27603,40826:27615,40827:27628,40828:27627,40829:27635,40830:27631,40832:40638,40833:27656,40834:27667,40835:27668,40836:27675,40837:27684,40838:27683,40839:27742,40840:27733,40841:27746,40842:27754,40843:27778,40844:27789,40845:27802,40846:27777,40847:27803,40848:27774,40849:27752,40850:27763,40851:27794,40852:27792,40853:27844,40854:27889,40855:27859,40856:27837,40857:27863,40858:27845,40859:27869,40860:27822,40861:27825,40862:27838,40863:27834,40864:27867,40865:27887,40866:27865,40867:27882,40868:27935,40869:34893,40870:27958,40871:27947,40872:27965,40873:27960,40874:27929,40875:27957,40876:27955,40877:27922,40878:27916,40879:28003,40880:28051,40881:28004,40882:27994,40883:28025,40884:27993,40885:28046,40886:28053,40887:28644,40888:28037,40889:28153,40890:28181,40891:28170,40892:28085,40893:28103,40894:28134,40895:28088,40896:28102,40897:28140,40898:28126,40899:28108,40900:28136,40901:28114,40902:28101,40903:28154,40904:28121,40905:28132,40906:28117,40907:28138,40908:28142,40909:28205,40910:28270,40911:28206,40912:28185,40913:28274,40914:28255,40915:28222,40916:28195,40917:28267,40918:28203,40919:28278,40920:28237,40921:28191,40922:28227,40923:28218,40924:28238,40925:28196,40926:28415,40927:28189,40928:28216,40929:28290,40930:28330,40931:28312,40932:28361,40933:28343,40934:28371,40935:28349,40936:28335,40937:28356,40938:28338,40939:28372,40940:28373,40941:28303,40942:28325,40943:28354,40944:28319,40945:28481,40946:28433,40947:28748,40948:28396,40949:28408,40950:28414,40951:28479,40952:28402,40953:28465,40954:28399,40955:28466,40956:28364,161:65377,162:65378,163:65379,164:65380,165:65381,166:65382,167:65383,168:65384,169:65385,170:65386,171:65387,172:65388,173:65389,174:65390,175:65391,176:65392,177:65393,178:65394,179:65395,180:65396,181:65397,182:65398,183:65399,184:65400,185:65401,186:65402,187:65403,188:65404,189:65405,190:65406,191:65407,192:65408,193:65409,194:65410,195:65411,196:65412,197:65413,198:65414,199:65415,200:65416,201:65417,202:65418,203:65419,204:65420,205:65421,206:65422,207:65423,208:65424,209:65425,210:65426,211:65427,212:65428,213:65429,214:65430,215:65431,216:65432,217:65433,218:65434,219:65435,220:65436,221:65437,222:65438,223:65439,57408:28478,57409:28435,57410:28407,57411:28550,57412:28538,57413:28536,57414:28545,57415:28544,57416:28527,57417:28507,57418:28659,57419:28525,57420:28546,57421:28540,57422:28504,57423:28558,57424:28561,57425:28610,57426:28518,57427:28595,57428:28579,57429:28577,57430:28580,57431:28601,57432:28614,57433:28586,57434:28639,57435:28629,57436:28652,57437:28628,57438:28632,57439:28657,57440:28654,57441:28635,57442:28681,57443:28683,57444:28666,57445:28689,57446:28673,57447:28687,57448:28670,57449:28699,57450:28698,57451:28532,57452:28701,57453:28696,57454:28703,57455:28720,57456:28734,57457:28722,57458:28753,57459:28771,57460:28825,57461:28818,57462:28847,57463:28913,57464:28844,57465:28856,57466:28851,57467:28846,57468:28895,57469:28875,57470:28893,57472:28889,57473:28937,57474:28925,57475:28956,57476:28953,57477:29029,57478:29013,57479:29064,57480:29030,57481:29026,57482:29004,57483:29014,57484:29036,57485:29071,57486:29179,57487:29060,57488:29077,57489:29096,57490:29100,57491:29143,57492:29113,57493:29118,57494:29138,57495:29129,57496:29140,57497:29134,57498:29152,57499:29164,57500:29159,57501:29173,57502:29180,57503:29177,57504:29183,57505:29197,57506:29200,57507:29211,57508:29224,57509:29229,57510:29228,57511:29232,57512:29234,57513:29243,57514:29244,57515:29247,57516:29248,57517:29254,57518:29259,57519:29272,57520:29300,57521:29310,57522:29314,57523:29313,57524:29319,57525:29330,57526:29334,57527:29346,57528:29351,57529:29369,57530:29362,57531:29379,57532:29382,57533:29380,57534:29390,57535:29394,57536:29410,57537:29408,57538:29409,57539:29433,57540:29431,57541:20495,57542:29463,57543:29450,57544:29468,57545:29462,57546:29469,57547:29492,57548:29487,57549:29481,57550:29477,57551:29502,57552:29518,57553:29519,57554:40664,57555:29527,57556:29546,57557:29544,57558:29552,57559:29560,57560:29557,57561:29563,57562:29562,57563:29640,57564:29619,57565:29646,57566:29627,57567:29632,57568:29669,57569:29678,57570:29662,57571:29858,57572:29701,57573:29807,57574:29733,57575:29688,57576:29746,57577:29754,57578:29781,57579:29759,57580:29791,57581:29785,57582:29761,57583:29788,57584:29801,57585:29808,57586:29795,57587:29802,57588:29814,57589:29822,57590:29835,57591:29854,57592:29863,57593:29898,57594:29903,57595:29908,57596:29681,57664:29920,57665:29923,57666:29927,57667:29929,57668:29934,57669:29938,57670:29936,57671:29937,57672:29944,57673:29943,57674:29956,57675:29955,57676:29957,57677:29964,57678:29966,57679:29965,57680:29973,57681:29971,57682:29982,57683:29990,57684:29996,57685:30012,57686:30020,57687:30029,57688:30026,57689:30025,57690:30043,57691:30022,57692:30042,57693:30057,57694:30052,57695:30055,57696:30059,57697:30061,57698:30072,57699:30070,57700:30086,57701:30087,57702:30068,57703:30090,57704:30089,57705:30082,57706:30100,57707:30106,57708:30109,57709:30117,57710:30115,57711:30146,57712:30131,57713:30147,57714:30133,57715:30141,57716:30136,57717:30140,57718:30129,57719:30157,57720:30154,57721:30162,57722:30169,57723:30179,57724:30174,57725:30206,57726:30207,57728:30204,57729:30209,57730:30192,57731:30202,57732:30194,57733:30195,57734:30219,57735:30221,57736:30217,57737:30239,57738:30247,57739:30240,57740:30241,57741:30242,57742:30244,57743:30260,57744:30256,57745:30267,57746:30279,57747:30280,57748:30278,57749:30300,57750:30296,57751:30305,57752:30306,57753:30312,57754:30313,57755:30314,57756:30311,57757:30316,57758:30320,57759:30322,57760:30326,57761:30328,57762:30332,57763:30336,57764:30339,57765:30344,57766:30347,57767:30350,57768:30358,57769:30355,57770:30361,57771:30362,57772:30384,57773:30388,57774:30392,57775:30393,57776:30394,57777:30402,57778:30413,57779:30422,57780:30418,57781:30430,57782:30433,57783:30437,57784:30439,57785:30442,57786:34351,57787:30459,57788:30472,57789:30471,57790:30468,57791:30505,57792:30500,57793:30494,57794:30501,57795:30502,57796:30491,57797:30519,57798:30520,57799:30535,57800:30554,57801:30568,57802:30571,57803:30555,57804:30565,57805:30591,57806:30590,57807:30585,57808:30606,57809:30603,57810:30609,57811:30624,57812:30622,57813:30640,57814:30646,57815:30649,57816:30655,57817:30652,57818:30653,57819:30651,57820:30663,57821:30669,57822:30679,57823:30682,57824:30684,57825:30691,57826:30702,57827:30716,57828:30732,57829:30738,57830:31014,57831:30752,57832:31018,57833:30789,57834:30862,57835:30836,57836:30854,57837:30844,57838:30874,57839:30860,57840:30883,57841:30901,57842:30890,57843:30895,57844:30929,57845:30918,57846:30923,57847:30932,57848:30910,57849:30908,57850:30917,57851:30922,57852:30956,57920:30951,57921:30938,57922:30973,57923:30964,57924:30983,57925:30994,57926:30993,57927:31001,57928:31020,57929:31019,57930:31040,57931:31072,57932:31063,57933:31071,57934:31066,57935:31061,57936:31059,57937:31098,57938:31103,57939:31114,57940:31133,57941:31143,57942:40779,57943:31146,57944:31150,57945:31155,57946:31161,57947:31162,57948:31177,57949:31189,57950:31207,57951:31212,57952:31201,57953:31203,57954:31240,57955:31245,57956:31256,57957:31257,57958:31264,57959:31263,57960:31104,57961:31281,57962:31291,57963:31294,57964:31287,57965:31299,57966:31319,57967:31305,57968:31329,57969:31330,57970:31337,57971:40861,57972:31344,57973:31353,57974:31357,57975:31368,57976:31383,57977:31381,57978:31384,57979:31382,57980:31401,57981:31432,57982:31408,57984:31414,57985:31429,57986:31428,57987:31423,57988:36995,57989:31431,57990:31434,57991:31437,57992:31439,57993:31445,57994:31443,57995:31449,57996:31450,57997:31453,57998:31457,57999:31458,58e3:31462,58001:31469,58002:31472,58003:31490,58004:31503,58005:31498,58006:31494,58007:31539,58008:31512,58009:31513,58010:31518,58011:31541,58012:31528,58013:31542,58014:31568,58015:31610,58016:31492,58017:31565,58018:31499,58019:31564,58020:31557,58021:31605,58022:31589,58023:31604,58024:31591,58025:31600,58026:31601,58027:31596,58028:31598,58029:31645,58030:31640,58031:31647,58032:31629,58033:31644,58034:31642,58035:31627,58036:31634,58037:31631,58038:31581,58039:31641,58040:31691,58041:31681,58042:31692,58043:31695,58044:31668,58045:31686,58046:31709,58047:31721,58048:31761,58049:31764,58050:31718,58051:31717,58052:31840,58053:31744,58054:31751,58055:31763,58056:31731,58057:31735,58058:31767,58059:31757,58060:31734,58061:31779,58062:31783,58063:31786,58064:31775,58065:31799,58066:31787,58067:31805,58068:31820,58069:31811,58070:31828,58071:31823,58072:31808,58073:31824,58074:31832,58075:31839,58076:31844,58077:31830,58078:31845,58079:31852,58080:31861,58081:31875,58082:31888,58083:31908,58084:31917,58085:31906,58086:31915,58087:31905,58088:31912,58089:31923,58090:31922,58091:31921,58092:31918,58093:31929,58094:31933,58095:31936,58096:31941,58097:31938,58098:31960,58099:31954,58100:31964,58101:31970,58102:39739,58103:31983,58104:31986,58105:31988,58106:31990,58107:31994,58108:32006,58176:32002,58177:32028,58178:32021,58179:32010,58180:32069,58181:32075,58182:32046,58183:32050,58184:32063,58185:32053,58186:32070,58187:32115,58188:32086,58189:32078,58190:32114,58191:32104,58192:32110,58193:32079,58194:32099,58195:32147,58196:32137,58197:32091,58198:32143,58199:32125,58200:32155,58201:32186,58202:32174,58203:32163,58204:32181,58205:32199,58206:32189,58207:32171,58208:32317,58209:32162,58210:32175,58211:32220,58212:32184,58213:32159,58214:32176,58215:32216,58216:32221,58217:32228,58218:32222,58219:32251,58220:32242,58221:32225,58222:32261,58223:32266,58224:32291,58225:32289,58226:32274,58227:32305,58228:32287,58229:32265,58230:32267,58231:32290,58232:32326,58233:32358,58234:32315,58235:32309,58236:32313,58237:32323,58238:32311,58240:32306,58241:32314,58242:32359,58243:32349,58244:32342,58245:32350,58246:32345,58247:32346,58248:32377,58249:32362,58250:32361,58251:32380,58252:32379,58253:32387,58254:32213,58255:32381,58256:36782,58257:32383,58258:32392,58259:32393,58260:32396,58261:32402,58262:32400,58263:32403,58264:32404,58265:32406,58266:32398,58267:32411,58268:32412,58269:32568,58270:32570,58271:32581,58272:32588,58273:32589,58274:32590,58275:32592,58276:32593,58277:32597,58278:32596,58279:32600,58280:32607,58281:32608,58282:32616,58283:32617,58284:32615,58285:32632,58286:32642,58287:32646,58288:32643,58289:32648,58290:32647,58291:32652,58292:32660,58293:32670,58294:32669,58295:32666,58296:32675,58297:32687,58298:32690,58299:32697,58300:32686,58301:32694,58302:32696,58303:35697,58304:32709,58305:32710,58306:32714,58307:32725,58308:32724,58309:32737,58310:32742,58311:32745,58312:32755,58313:32761,58314:39132,58315:32774,58316:32772,58317:32779,58318:32786,58319:32792,58320:32793,58321:32796,58322:32801,58323:32808,58324:32831,58325:32827,58326:32842,58327:32838,58328:32850,58329:32856,58330:32858,58331:32863,58332:32866,58333:32872,58334:32883,58335:32882,58336:32880,58337:32886,58338:32889,58339:32893,58340:32895,58341:32900,58342:32902,58343:32901,58344:32923,58345:32915,58346:32922,58347:32941,58348:20880,58349:32940,58350:32987,58351:32997,58352:32985,58353:32989,58354:32964,58355:32986,58356:32982,58357:33033,58358:33007,58359:33009,58360:33051,58361:33065,58362:33059,58363:33071,58364:33099,58432:38539,58433:33094,58434:33086,58435:33107,58436:33105,58437:33020,58438:33137,58439:33134,58440:33125,58441:33126,58442:33140,58443:33155,58444:33160,58445:33162,58446:33152,58447:33154,58448:33184,58449:33173,58450:33188,58451:33187,58452:33119,58453:33171,58454:33193,58455:33200,58456:33205,58457:33214,58458:33208,58459:33213,58460:33216,58461:33218,58462:33210,58463:33225,58464:33229,58465:33233,58466:33241,58467:33240,58468:33224,58469:33242,58470:33247,58471:33248,58472:33255,58473:33274,58474:33275,58475:33278,58476:33281,58477:33282,58478:33285,58479:33287,58480:33290,58481:33293,58482:33296,58483:33302,58484:33321,58485:33323,58486:33336,58487:33331,58488:33344,58489:33369,58490:33368,58491:33373,58492:33370,58493:33375,58494:33380,58496:33378,58497:33384,58498:33386,58499:33387,58500:33326,58501:33393,58502:33399,58503:33400,58504:33406,58505:33421,58506:33426,58507:33451,58508:33439,58509:33467,58510:33452,58511:33505,58512:33507,58513:33503,58514:33490,58515:33524,58516:33523,58517:33530,58518:33683,58519:33539,58520:33531,58521:33529,58522:33502,58523:33542,58524:33500,58525:33545,58526:33497,58527:33589,58528:33588,58529:33558,58530:33586,58531:33585,58532:33600,58533:33593,58534:33616,58535:33605,58536:33583,58537:33579,58538:33559,58539:33560,58540:33669,58541:33690,58542:33706,58543:33695,58544:33698,58545:33686,58546:33571,58547:33678,58548:33671,58549:33674,58550:33660,58551:33717,58552:33651,58553:33653,58554:33696,58555:33673,58556:33704,58557:33780,58558:33811,58559:33771,58560:33742,58561:33789,58562:33795,58563:33752,58564:33803,58565:33729,58566:33783,58567:33799,58568:33760,58569:33778,58570:33805,58571:33826,58572:33824,58573:33725,58574:33848,58575:34054,58576:33787,58577:33901,58578:33834,58579:33852,58580:34138,58581:33924,58582:33911,58583:33899,58584:33965,58585:33902,58586:33922,58587:33897,58588:33862,58589:33836,58590:33903,58591:33913,58592:33845,58593:33994,58594:33890,58595:33977,58596:33983,58597:33951,58598:34009,58599:33997,58600:33979,58601:34010,58602:34e3,58603:33985,58604:33990,58605:34006,58606:33953,58607:34081,58608:34047,58609:34036,58610:34071,58611:34072,58612:34092,58613:34079,58614:34069,58615:34068,58616:34044,58617:34112,58618:34147,58619:34136,58620:34120,58688:34113,58689:34306,58690:34123,58691:34133,58692:34176,58693:34212,58694:34184,58695:34193,58696:34186,58697:34216,58698:34157,58699:34196,58700:34203,58701:34282,58702:34183,58703:34204,58704:34167,58705:34174,58706:34192,58707:34249,58708:34234,58709:34255,58710:34233,58711:34256,58712:34261,58713:34269,58714:34277,58715:34268,58716:34297,58717:34314,58718:34323,58719:34315,58720:34302,58721:34298,58722:34310,58723:34338,58724:34330,58725:34352,58726:34367,58727:34381,58728:20053,58729:34388,58730:34399,58731:34407,58732:34417,58733:34451,58734:34467,58735:34473,58736:34474,58737:34443,58738:34444,58739:34486,58740:34479,58741:34500,58742:34502,58743:34480,58744:34505,58745:34851,58746:34475,58747:34516,58748:34526,58749:34537,58750:34540,58752:34527,58753:34523,58754:34543,58755:34578,58756:34566,58757:34568,58758:34560,58759:34563,58760:34555,58761:34577,58762:34569,58763:34573,58764:34553,58765:34570,58766:34612,58767:34623,58768:34615,58769:34619,58770:34597,58771:34601,58772:34586,58773:34656,58774:34655,58775:34680,58776:34636,58777:34638,58778:34676,58779:34647,58780:34664,58781:34670,58782:34649,58783:34643,58784:34659,58785:34666,58786:34821,58787:34722,58788:34719,58789:34690,58790:34735,58791:34763,58792:34749,58793:34752,58794:34768,58795:38614,58796:34731,58797:34756,58798:34739,58799:34759,58800:34758,58801:34747,58802:34799,58803:34802,58804:34784,58805:34831,58806:34829,58807:34814,58808:34806,58809:34807,58810:34830,58811:34770,58812:34833,58813:34838,58814:34837,58815:34850,58816:34849,58817:34865,58818:34870,58819:34873,58820:34855,58821:34875,58822:34884,58823:34882,58824:34898,58825:34905,58826:34910,58827:34914,58828:34923,58829:34945,58830:34942,58831:34974,58832:34933,58833:34941,58834:34997,58835:34930,58836:34946,58837:34967,58838:34962,58839:34990,58840:34969,58841:34978,58842:34957,58843:34980,58844:34992,58845:35007,58846:34993,58847:35011,58848:35012,58849:35028,58850:35032,58851:35033,58852:35037,58853:35065,58854:35074,58855:35068,58856:35060,58857:35048,58858:35058,58859:35076,58860:35084,58861:35082,58862:35091,58863:35139,58864:35102,58865:35109,58866:35114,58867:35115,58868:35137,58869:35140,58870:35131,58871:35126,58872:35128,58873:35148,58874:35101,58875:35168,58876:35166,58944:35174,58945:35172,58946:35181,58947:35178,58948:35183,58949:35188,58950:35191,58951:35198,58952:35203,58953:35208,58954:35210,58955:35219,58956:35224,58957:35233,58958:35241,58959:35238,58960:35244,58961:35247,58962:35250,58963:35258,58964:35261,58965:35263,58966:35264,58967:35290,58968:35292,58969:35293,58970:35303,58971:35316,58972:35320,58973:35331,58974:35350,58975:35344,58976:35340,58977:35355,58978:35357,58979:35365,58980:35382,58981:35393,58982:35419,58983:35410,58984:35398,58985:35400,58986:35452,58987:35437,58988:35436,58989:35426,58990:35461,58991:35458,58992:35460,58993:35496,58994:35489,58995:35473,58996:35493,58997:35494,58998:35482,58999:35491,59e3:35524,59001:35533,59002:35522,59003:35546,59004:35563,59005:35571,59006:35559,59008:35556,59009:35569,59010:35604,59011:35552,59012:35554,59013:35575,59014:35550,59015:35547,59016:35596,59017:35591,59018:35610,59019:35553,59020:35606,59021:35600,59022:35607,59023:35616,59024:35635,59025:38827,59026:35622,59027:35627,59028:35646,59029:35624,59030:35649,59031:35660,59032:35663,59033:35662,59034:35657,59035:35670,59036:35675,59037:35674,59038:35691,59039:35679,59040:35692,59041:35695,59042:35700,59043:35709,59044:35712,59045:35724,59046:35726,59047:35730,59048:35731,59049:35734,59050:35737,59051:35738,59052:35898,59053:35905,59054:35903,59055:35912,59056:35916,59057:35918,59058:35920,59059:35925,59060:35938,59061:35948,59062:35960,59063:35962,59064:35970,59065:35977,59066:35973,59067:35978,59068:35981,59069:35982,59070:35988,59071:35964,59072:35992,59073:25117,59074:36013,59075:36010,59076:36029,59077:36018,59078:36019,59079:36014,59080:36022,59081:36040,59082:36033,59083:36068,59084:36067,59085:36058,59086:36093,59087:36090,59088:36091,59089:36100,59090:36101,59091:36106,59092:36103,59093:36111,59094:36109,59095:36112,59096:40782,59097:36115,59098:36045,59099:36116,59100:36118,59101:36199,59102:36205,59103:36209,59104:36211,59105:36225,59106:36249,59107:36290,59108:36286,59109:36282,59110:36303,59111:36314,59112:36310,59113:36300,59114:36315,59115:36299,59116:36330,59117:36331,59118:36319,59119:36323,59120:36348,59121:36360,59122:36361,59123:36351,59124:36381,59125:36382,59126:36368,59127:36383,59128:36418,59129:36405,59130:36400,59131:36404,59132:36426,59200:36423,59201:36425,59202:36428,59203:36432,59204:36424,59205:36441,59206:36452,59207:36448,59208:36394,59209:36451,59210:36437,59211:36470,59212:36466,59213:36476,59214:36481,59215:36487,59216:36485,59217:36484,59218:36491,59219:36490,59220:36499,59221:36497,59222:36500,59223:36505,59224:36522,59225:36513,59226:36524,59227:36528,59228:36550,59229:36529,59230:36542,59231:36549,59232:36552,59233:36555,59234:36571,59235:36579,59236:36604,59237:36603,59238:36587,59239:36606,59240:36618,59241:36613,59242:36629,59243:36626,59244:36633,59245:36627,59246:36636,59247:36639,59248:36635,59249:36620,59250:36646,59251:36659,59252:36667,59253:36665,59254:36677,59255:36674,59256:36670,59257:36684,59258:36681,59259:36678,59260:36686,59261:36695,59262:36700,59264:36706,59265:36707,59266:36708,59267:36764,59268:36767,59269:36771,59270:36781,59271:36783,59272:36791,59273:36826,59274:36837,59275:36834,59276:36842,59277:36847,59278:36999,59279:36852,59280:36869,59281:36857,59282:36858,59283:36881,59284:36885,59285:36897,59286:36877,59287:36894,59288:36886,59289:36875,59290:36903,59291:36918,59292:36917,59293:36921,59294:36856,59295:36943,59296:36944,59297:36945,59298:36946,59299:36878,59300:36937,59301:36926,59302:36950,59303:36952,59304:36958,59305:36968,59306:36975,59307:36982,59308:38568,59309:36978,59310:36994,59311:36989,59312:36993,59313:36992,59314:37002,59315:37001,59316:37007,59317:37032,59318:37039,59319:37041,59320:37045,59321:37090,59322:37092,59323:25160,59324:37083,59325:37122,59326:37138,59327:37145,59328:37170,59329:37168,59330:37194,59331:37206,59332:37208,59333:37219,59334:37221,59335:37225,59336:37235,59337:37234,59338:37259,59339:37257,59340:37250,59341:37282,59342:37291,59343:37295,59344:37290,59345:37301,59346:37300,59347:37306,59348:37312,59349:37313,59350:37321,59351:37323,59352:37328,59353:37334,59354:37343,59355:37345,59356:37339,59357:37372,59358:37365,59359:37366,59360:37406,59361:37375,59362:37396,59363:37420,59364:37397,59365:37393,59366:37470,59367:37463,59368:37445,59369:37449,59370:37476,59371:37448,59372:37525,59373:37439,59374:37451,59375:37456,59376:37532,59377:37526,59378:37523,59379:37531,59380:37466,59381:37583,59382:37561,59383:37559,59384:37609,59385:37647,59386:37626,59387:37700,59388:37678,59456:37657,59457:37666,59458:37658,59459:37667,59460:37690,59461:37685,59462:37691,59463:37724,59464:37728,59465:37756,59466:37742,59467:37718,59468:37808,59469:37804,59470:37805,59471:37780,59472:37817,59473:37846,59474:37847,59475:37864,59476:37861,59477:37848,59478:37827,59479:37853,59480:37840,59481:37832,59482:37860,59483:37914,59484:37908,59485:37907,59486:37891,59487:37895,59488:37904,59489:37942,59490:37931,59491:37941,59492:37921,59493:37946,59494:37953,59495:37970,59496:37956,59497:37979,59498:37984,59499:37986,59500:37982,59501:37994,59502:37417,59503:38e3,59504:38005,59505:38007,59506:38013,59507:37978,59508:38012,59509:38014,59510:38017,59511:38015,59512:38274,59513:38279,59514:38282,59515:38292,59516:38294,59517:38296,59518:38297,59520:38304,59521:38312,59522:38311,59523:38317,59524:38332,59525:38331,59526:38329,59527:38334,59528:38346,59529:28662,59530:38339,59531:38349,59532:38348,59533:38357,59534:38356,59535:38358,59536:38364,59537:38369,59538:38373,59539:38370,59540:38433,59541:38440,59542:38446,59543:38447,59544:38466,59545:38476,59546:38479,59547:38475,59548:38519,59549:38492,59550:38494,59551:38493,59552:38495,59553:38502,59554:38514,59555:38508,59556:38541,59557:38552,59558:38549,59559:38551,59560:38570,59561:38567,59562:38577,59563:38578,59564:38576,59565:38580,59566:38582,59567:38584,59568:38585,59569:38606,59570:38603,59571:38601,59572:38605,59573:35149,59574:38620,59575:38669,59576:38613,59577:38649,59578:38660,59579:38662,59580:38664,59581:38675,59582:38670,59583:38673,59584:38671,59585:38678,59586:38681,59587:38692,59588:38698,59589:38704,59590:38713,59591:38717,59592:38718,59593:38724,59594:38726,59595:38728,59596:38722,59597:38729,59598:38748,59599:38752,59600:38756,59601:38758,59602:38760,59603:21202,59604:38763,59605:38769,59606:38777,59607:38789,59608:38780,59609:38785,59610:38778,59611:38790,59612:38795,59613:38799,59614:38800,59615:38812,59616:38824,59617:38822,59618:38819,59619:38835,59620:38836,59621:38851,59622:38854,59623:38856,59624:38859,59625:38876,59626:38893,59627:40783,59628:38898,59629:31455,59630:38902,59631:38901,59632:38927,59633:38924,59634:38968,59635:38948,59636:38945,59637:38967,59638:38973,59639:38982,59640:38991,59641:38987,59642:39019,59643:39023,59644:39024,59712:39025,59713:39028,59714:39027,59715:39082,59716:39087,59717:39089,59718:39094,59719:39108,59720:39107,59721:39110,59722:39145,59723:39147,59724:39171,59725:39177,59726:39186,59727:39188,59728:39192,59729:39201,59730:39197,59731:39198,59732:39204,59733:39200,59734:39212,59735:39214,59736:39229,59737:39230,59738:39234,59739:39241,59740:39237,59741:39248,59742:39243,59743:39249,59744:39250,59745:39244,59746:39253,59747:39319,59748:39320,59749:39333,59750:39341,59751:39342,59752:39356,59753:39391,59754:39387,59755:39389,59756:39384,59757:39377,59758:39405,59759:39406,59760:39409,59761:39410,59762:39419,59763:39416,59764:39425,59765:39439,59766:39429,59767:39394,59768:39449,59769:39467,59770:39479,59771:39493,59772:39490,59773:39488,59774:39491,59776:39486,59777:39509,59778:39501,59779:39515,59780:39511,59781:39519,59782:39522,59783:39525,59784:39524,59785:39529,59786:39531,59787:39530,59788:39597,59789:39600,59790:39612,59791:39616,59792:39631,59793:39633,59794:39635,59795:39636,59796:39646,59797:39647,59798:39650,59799:39651,59800:39654,59801:39663,59802:39659,59803:39662,59804:39668,59805:39665,59806:39671,59807:39675,59808:39686,59809:39704,59810:39706,59811:39711,59812:39714,59813:39715,59814:39717,59815:39719,59816:39720,59817:39721,59818:39722,59819:39726,59820:39727,59821:39730,59822:39748,59823:39747,59824:39759,59825:39757,59826:39758,59827:39761,59828:39768,59829:39796,59830:39827,59831:39811,59832:39825,59833:39830,59834:39831,59835:39839,59836:39840,59837:39848,59838:39860,59839:39872,59840:39882,59841:39865,59842:39878,59843:39887,59844:39889,59845:39890,59846:39907,59847:39906,59848:39908,59849:39892,59850:39905,59851:39994,59852:39922,59853:39921,59854:39920,59855:39957,59856:39956,59857:39945,59858:39955,59859:39948,59860:39942,59861:39944,59862:39954,59863:39946,59864:39940,59865:39982,59866:39963,59867:39973,59868:39972,59869:39969,59870:39984,59871:40007,59872:39986,59873:40006,59874:39998,59875:40026,59876:40032,59877:40039,59878:40054,59879:40056,59880:40167,59881:40172,59882:40176,59883:40201,59884:40200,59885:40171,59886:40195,59887:40198,59888:40234,59889:40230,59890:40367,59891:40227,59892:40223,59893:40260,59894:40213,59895:40210,59896:40257,59897:40255,59898:40254,59899:40262,59900:40264,59968:40285,59969:40286,59970:40292,59971:40273,59972:40272,59973:40281,59974:40306,59975:40329,59976:40327,59977:40363,59978:40303,59979:40314,59980:40346,59981:40356,59982:40361,59983:40370,59984:40388,59985:40385,59986:40379,59987:40376,59988:40378,59989:40390,59990:40399,59991:40386,59992:40409,59993:40403,59994:40440,59995:40422,59996:40429,59997:40431,59998:40445,59999:40474,6e4:40475,60001:40478,60002:40565,60003:40569,60004:40573,60005:40577,60006:40584,60007:40587,60008:40588,60009:40594,60010:40597,60011:40593,60012:40605,60013:40613,60014:40617,60015:40632,60016:40618,60017:40621,60018:38753,60019:40652,60020:40654,60021:40655,60022:40656,60023:40660,60024:40668,60025:40670,60026:40669,60027:40672,60028:40677,60029:40680,60030:40687,60032:40692,60033:40694,60034:40695,60035:40697,60036:40699,60037:40700,60038:40701,60039:40711,60040:40712,60041:30391,60042:40725,60043:40737,60044:40748,60045:40766,60046:40778,60047:40786,60048:40788,60049:40803,60050:40799,60051:40800,60052:40801,60053:40806,60054:40807,60055:40812,60056:40810,60057:40823,60058:40818,60059:40822,60060:40853,60061:40860,60062:40864,60063:22575,60064:27079,60065:36953,60066:29796,60067:20956,60068:29081}},function(o,e,r){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var t=r(1),c=r(2);e.decode=function(o,e){var r=new Uint8ClampedArray(o.length);r.set(o);for(var s=new t.default(285,256,0),a=new c.default(s,r),n=new Uint8ClampedArray(e),d=!1,l=0;l<e;l++){var i=a.evaluateAt(s.exp(l+s.generatorBase));n[n.length-1-l]=i,0!==i&&(d=!0)}if(!d)return r;var B=new c.default(s,n),k=function(o,e,r,t){var c;e.degree()<r.degree()&&(e=(c=[r,e])[0],r=c[1]);for(var s=e,a=r,n=o.zero,d=o.one;a.degree()>=t/2;){var l=s,i=n;if(n=d,(s=a).isZero())return null;a=l;for(var B=o.zero,k=s.getCoefficient(s.degree()),u=o.inverse(k);a.degree()>=s.degree()&&!a.isZero();){var C=a.degree()-s.degree(),m=o.multiply(a.getCoefficient(a.degree()),u);B=B.addOrSubtract(o.buildMonomial(C,m)),a=a.addOrSubtract(s.multiplyByMonomial(C,m))}if(d=B.multiplyPoly(n).addOrSubtract(i),a.degree()>=s.degree())return null}var f=d.getCoefficient(0);if(0===f)return null;var w=o.inverse(f);return[d.multiply(w),a.multiply(w)]}(s,s.buildMonomial(e,1),B,e);if(null===k)return null;var u=function(o,e){var r=e.degree();if(1===r)return[e.getCoefficient(1)];for(var t=new Array(r),c=0,s=1;s<o.size&&c<r;s++)0===e.evaluateAt(s)&&(t[c]=o.inverse(s),c++);return c!==r?null:t}(s,k[0]);if(null==u)return null;for(var C=function(o,e,r){for(var c=r.length,s=new Array(c),a=0;a<c;a++){for(var n=o.inverse(r[a]),d=1,l=0;l<c;l++)a!==l&&(d=o.multiply(d,t.addOrSubtractGF(1,o.multiply(r[l],n))));s[a]=o.multiply(e.evaluateAt(n),o.inverse(d)),0!==o.generatorBase&&(s[a]=o.multiply(s[a],n))}return s}(s,k[1],u),m=0;m<u.length;m++){var f=r.length-1-s.log(u[m]);if(f<0)return null;r[f]=t.addOrSubtractGF(r[f],C[m])}return r}},function(o,e,r){"use strict";Object.defineProperty(e,"__esModule",{value:!0}),e.VERSIONS=[{infoBits:null,versionNumber:1,alignmentPatternCenters:[],errorCorrectionLevels:[{ecCodewordsPerBlock:7,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:19}]},{ecCodewordsPerBlock:10,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:16}]},{ecCodewordsPerBlock:13,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:13}]},{ecCodewordsPerBlock:17,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:9}]}]},{infoBits:null,versionNumber:2,alignmentPatternCenters:[6,18],errorCorrectionLevels:[{ecCodewordsPerBlock:10,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:34}]},{ecCodewordsPerBlock:16,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:28}]},{ecCodewordsPerBlock:22,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:22}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:16}]}]},{infoBits:null,versionNumber:3,alignmentPatternCenters:[6,22],errorCorrectionLevels:[{ecCodewordsPerBlock:15,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:55}]},{ecCodewordsPerBlock:26,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:44}]},{ecCodewordsPerBlock:18,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:17}]},{ecCodewordsPerBlock:22,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:13}]}]},{infoBits:null,versionNumber:4,alignmentPatternCenters:[6,26],errorCorrectionLevels:[{ecCodewordsPerBlock:20,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:80}]},{ecCodewordsPerBlock:18,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:32}]},{ecCodewordsPerBlock:26,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:24}]},{ecCodewordsPerBlock:16,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:9}]}]},{infoBits:null,versionNumber:5,alignmentPatternCenters:[6,30],errorCorrectionLevels:[{ecCodewordsPerBlock:26,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:108}]},{ecCodewordsPerBlock:24,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:43}]},{ecCodewordsPerBlock:18,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:15},{numBlocks:2,dataCodewordsPerBlock:16}]},{ecCodewordsPerBlock:22,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:11},{numBlocks:2,dataCodewordsPerBlock:12}]}]},{infoBits:null,versionNumber:6,alignmentPatternCenters:[6,34],errorCorrectionLevels:[{ecCodewordsPerBlock:18,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:68}]},{ecCodewordsPerBlock:16,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:27}]},{ecCodewordsPerBlock:24,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:19}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:15}]}]},{infoBits:31892,versionNumber:7,alignmentPatternCenters:[6,22,38],errorCorrectionLevels:[{ecCodewordsPerBlock:20,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:78}]},{ecCodewordsPerBlock:18,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:31}]},{ecCodewordsPerBlock:18,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:14},{numBlocks:4,dataCodewordsPerBlock:15}]},{ecCodewordsPerBlock:26,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:13},{numBlocks:1,dataCodewordsPerBlock:14}]}]},{infoBits:34236,versionNumber:8,alignmentPatternCenters:[6,24,42],errorCorrectionLevels:[{ecCodewordsPerBlock:24,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:97}]},{ecCodewordsPerBlock:22,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:38},{numBlocks:2,dataCodewordsPerBlock:39}]},{ecCodewordsPerBlock:22,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:18},{numBlocks:2,dataCodewordsPerBlock:19}]},{ecCodewordsPerBlock:26,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:14},{numBlocks:2,dataCodewordsPerBlock:15}]}]},{infoBits:39577,versionNumber:9,alignmentPatternCenters:[6,26,46],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:116}]},{ecCodewordsPerBlock:22,ecBlocks:[{numBlocks:3,dataCodewordsPerBlock:36},{numBlocks:2,dataCodewordsPerBlock:37}]},{ecCodewordsPerBlock:20,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:16},{numBlocks:4,dataCodewordsPerBlock:17}]},{ecCodewordsPerBlock:24,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:12},{numBlocks:4,dataCodewordsPerBlock:13}]}]},{infoBits:42195,versionNumber:10,alignmentPatternCenters:[6,28,50],errorCorrectionLevels:[{ecCodewordsPerBlock:18,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:68},{numBlocks:2,dataCodewordsPerBlock:69}]},{ecCodewordsPerBlock:26,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:43},{numBlocks:1,dataCodewordsPerBlock:44}]},{ecCodewordsPerBlock:24,ecBlocks:[{numBlocks:6,dataCodewordsPerBlock:19},{numBlocks:2,dataCodewordsPerBlock:20}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:6,dataCodewordsPerBlock:15},{numBlocks:2,dataCodewordsPerBlock:16}]}]},{infoBits:48118,versionNumber:11,alignmentPatternCenters:[6,30,54],errorCorrectionLevels:[{ecCodewordsPerBlock:20,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:81}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:50},{numBlocks:4,dataCodewordsPerBlock:51}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:22},{numBlocks:4,dataCodewordsPerBlock:23}]},{ecCodewordsPerBlock:24,ecBlocks:[{numBlocks:3,dataCodewordsPerBlock:12},{numBlocks:8,dataCodewordsPerBlock:13}]}]},{infoBits:51042,versionNumber:12,alignmentPatternCenters:[6,32,58],errorCorrectionLevels:[{ecCodewordsPerBlock:24,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:92},{numBlocks:2,dataCodewordsPerBlock:93}]},{ecCodewordsPerBlock:22,ecBlocks:[{numBlocks:6,dataCodewordsPerBlock:36},{numBlocks:2,dataCodewordsPerBlock:37}]},{ecCodewordsPerBlock:26,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:20},{numBlocks:6,dataCodewordsPerBlock:21}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:7,dataCodewordsPerBlock:14},{numBlocks:4,dataCodewordsPerBlock:15}]}]},{infoBits:55367,versionNumber:13,alignmentPatternCenters:[6,34,62],errorCorrectionLevels:[{ecCodewordsPerBlock:26,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:107}]},{ecCodewordsPerBlock:22,ecBlocks:[{numBlocks:8,dataCodewordsPerBlock:37},{numBlocks:1,dataCodewordsPerBlock:38}]},{ecCodewordsPerBlock:24,ecBlocks:[{numBlocks:8,dataCodewordsPerBlock:20},{numBlocks:4,dataCodewordsPerBlock:21}]},{ecCodewordsPerBlock:22,ecBlocks:[{numBlocks:12,dataCodewordsPerBlock:11},{numBlocks:4,dataCodewordsPerBlock:12}]}]},{infoBits:58893,versionNumber:14,alignmentPatternCenters:[6,26,46,66],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:3,dataCodewordsPerBlock:115},{numBlocks:1,dataCodewordsPerBlock:116}]},{ecCodewordsPerBlock:24,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:40},{numBlocks:5,dataCodewordsPerBlock:41}]},{ecCodewordsPerBlock:20,ecBlocks:[{numBlocks:11,dataCodewordsPerBlock:16},{numBlocks:5,dataCodewordsPerBlock:17}]},{ecCodewordsPerBlock:24,ecBlocks:[{numBlocks:11,dataCodewordsPerBlock:12},{numBlocks:5,dataCodewordsPerBlock:13}]}]},{infoBits:63784,versionNumber:15,alignmentPatternCenters:[6,26,48,70],errorCorrectionLevels:[{ecCodewordsPerBlock:22,ecBlocks:[{numBlocks:5,dataCodewordsPerBlock:87},{numBlocks:1,dataCodewordsPerBlock:88}]},{ecCodewordsPerBlock:24,ecBlocks:[{numBlocks:5,dataCodewordsPerBlock:41},{numBlocks:5,dataCodewordsPerBlock:42}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:5,dataCodewordsPerBlock:24},{numBlocks:7,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:24,ecBlocks:[{numBlocks:11,dataCodewordsPerBlock:12},{numBlocks:7,dataCodewordsPerBlock:13}]}]},{infoBits:68472,versionNumber:16,alignmentPatternCenters:[6,26,50,74],errorCorrectionLevels:[{ecCodewordsPerBlock:24,ecBlocks:[{numBlocks:5,dataCodewordsPerBlock:98},{numBlocks:1,dataCodewordsPerBlock:99}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:7,dataCodewordsPerBlock:45},{numBlocks:3,dataCodewordsPerBlock:46}]},{ecCodewordsPerBlock:24,ecBlocks:[{numBlocks:15,dataCodewordsPerBlock:19},{numBlocks:2,dataCodewordsPerBlock:20}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:3,dataCodewordsPerBlock:15},{numBlocks:13,dataCodewordsPerBlock:16}]}]},{infoBits:70749,versionNumber:17,alignmentPatternCenters:[6,30,54,78],errorCorrectionLevels:[{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:107},{numBlocks:5,dataCodewordsPerBlock:108}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:10,dataCodewordsPerBlock:46},{numBlocks:1,dataCodewordsPerBlock:47}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:22},{numBlocks:15,dataCodewordsPerBlock:23}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:14},{numBlocks:17,dataCodewordsPerBlock:15}]}]},{infoBits:76311,versionNumber:18,alignmentPatternCenters:[6,30,56,82],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:5,dataCodewordsPerBlock:120},{numBlocks:1,dataCodewordsPerBlock:121}]},{ecCodewordsPerBlock:26,ecBlocks:[{numBlocks:9,dataCodewordsPerBlock:43},{numBlocks:4,dataCodewordsPerBlock:44}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:17,dataCodewordsPerBlock:22},{numBlocks:1,dataCodewordsPerBlock:23}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:14},{numBlocks:19,dataCodewordsPerBlock:15}]}]},{infoBits:79154,versionNumber:19,alignmentPatternCenters:[6,30,58,86],errorCorrectionLevels:[{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:3,dataCodewordsPerBlock:113},{numBlocks:4,dataCodewordsPerBlock:114}]},{ecCodewordsPerBlock:26,ecBlocks:[{numBlocks:3,dataCodewordsPerBlock:44},{numBlocks:11,dataCodewordsPerBlock:45}]},{ecCodewordsPerBlock:26,ecBlocks:[{numBlocks:17,dataCodewordsPerBlock:21},{numBlocks:4,dataCodewordsPerBlock:22}]},{ecCodewordsPerBlock:26,ecBlocks:[{numBlocks:9,dataCodewordsPerBlock:13},{numBlocks:16,dataCodewordsPerBlock:14}]}]},{infoBits:84390,versionNumber:20,alignmentPatternCenters:[6,34,62,90],errorCorrectionLevels:[{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:3,dataCodewordsPerBlock:107},{numBlocks:5,dataCodewordsPerBlock:108}]},{ecCodewordsPerBlock:26,ecBlocks:[{numBlocks:3,dataCodewordsPerBlock:41},{numBlocks:13,dataCodewordsPerBlock:42}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:15,dataCodewordsPerBlock:24},{numBlocks:5,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:15,dataCodewordsPerBlock:15},{numBlocks:10,dataCodewordsPerBlock:16}]}]},{infoBits:87683,versionNumber:21,alignmentPatternCenters:[6,28,50,72,94],errorCorrectionLevels:[{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:116},{numBlocks:4,dataCodewordsPerBlock:117}]},{ecCodewordsPerBlock:26,ecBlocks:[{numBlocks:17,dataCodewordsPerBlock:42}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:17,dataCodewordsPerBlock:22},{numBlocks:6,dataCodewordsPerBlock:23}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:19,dataCodewordsPerBlock:16},{numBlocks:6,dataCodewordsPerBlock:17}]}]},{infoBits:92361,versionNumber:22,alignmentPatternCenters:[6,26,50,74,98],errorCorrectionLevels:[{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:111},{numBlocks:7,dataCodewordsPerBlock:112}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:17,dataCodewordsPerBlock:46}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:7,dataCodewordsPerBlock:24},{numBlocks:16,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:24,ecBlocks:[{numBlocks:34,dataCodewordsPerBlock:13}]}]},{infoBits:96236,versionNumber:23,alignmentPatternCenters:[6,30,54,74,102],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:121},{numBlocks:5,dataCodewordsPerBlock:122}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:47},{numBlocks:14,dataCodewordsPerBlock:48}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:11,dataCodewordsPerBlock:24},{numBlocks:14,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:16,dataCodewordsPerBlock:15},{numBlocks:14,dataCodewordsPerBlock:16}]}]},{infoBits:102084,versionNumber:24,alignmentPatternCenters:[6,28,54,80,106],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:6,dataCodewordsPerBlock:117},{numBlocks:4,dataCodewordsPerBlock:118}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:6,dataCodewordsPerBlock:45},{numBlocks:14,dataCodewordsPerBlock:46}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:11,dataCodewordsPerBlock:24},{numBlocks:16,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:30,dataCodewordsPerBlock:16},{numBlocks:2,dataCodewordsPerBlock:17}]}]},{infoBits:102881,versionNumber:25,alignmentPatternCenters:[6,32,58,84,110],errorCorrectionLevels:[{ecCodewordsPerBlock:26,ecBlocks:[{numBlocks:8,dataCodewordsPerBlock:106},{numBlocks:4,dataCodewordsPerBlock:107}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:8,dataCodewordsPerBlock:47},{numBlocks:13,dataCodewordsPerBlock:48}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:7,dataCodewordsPerBlock:24},{numBlocks:22,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:22,dataCodewordsPerBlock:15},{numBlocks:13,dataCodewordsPerBlock:16}]}]},{infoBits:110507,versionNumber:26,alignmentPatternCenters:[6,30,58,86,114],errorCorrectionLevels:[{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:10,dataCodewordsPerBlock:114},{numBlocks:2,dataCodewordsPerBlock:115}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:19,dataCodewordsPerBlock:46},{numBlocks:4,dataCodewordsPerBlock:47}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:28,dataCodewordsPerBlock:22},{numBlocks:6,dataCodewordsPerBlock:23}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:33,dataCodewordsPerBlock:16},{numBlocks:4,dataCodewordsPerBlock:17}]}]},{infoBits:110734,versionNumber:27,alignmentPatternCenters:[6,34,62,90,118],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:8,dataCodewordsPerBlock:122},{numBlocks:4,dataCodewordsPerBlock:123}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:22,dataCodewordsPerBlock:45},{numBlocks:3,dataCodewordsPerBlock:46}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:8,dataCodewordsPerBlock:23},{numBlocks:26,dataCodewordsPerBlock:24}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:12,dataCodewordsPerBlock:15},{numBlocks:28,dataCodewordsPerBlock:16}]}]},{infoBits:117786,versionNumber:28,alignmentPatternCenters:[6,26,50,74,98,122],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:3,dataCodewordsPerBlock:117},{numBlocks:10,dataCodewordsPerBlock:118}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:3,dataCodewordsPerBlock:45},{numBlocks:23,dataCodewordsPerBlock:46}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:24},{numBlocks:31,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:11,dataCodewordsPerBlock:15},{numBlocks:31,dataCodewordsPerBlock:16}]}]},{infoBits:119615,versionNumber:29,alignmentPatternCenters:[6,30,54,78,102,126],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:7,dataCodewordsPerBlock:116},{numBlocks:7,dataCodewordsPerBlock:117}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:21,dataCodewordsPerBlock:45},{numBlocks:7,dataCodewordsPerBlock:46}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:23},{numBlocks:37,dataCodewordsPerBlock:24}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:19,dataCodewordsPerBlock:15},{numBlocks:26,dataCodewordsPerBlock:16}]}]},{infoBits:126325,versionNumber:30,alignmentPatternCenters:[6,26,52,78,104,130],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:5,dataCodewordsPerBlock:115},{numBlocks:10,dataCodewordsPerBlock:116}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:19,dataCodewordsPerBlock:47},{numBlocks:10,dataCodewordsPerBlock:48}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:15,dataCodewordsPerBlock:24},{numBlocks:25,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:23,dataCodewordsPerBlock:15},{numBlocks:25,dataCodewordsPerBlock:16}]}]},{infoBits:127568,versionNumber:31,alignmentPatternCenters:[6,30,56,82,108,134],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:13,dataCodewordsPerBlock:115},{numBlocks:3,dataCodewordsPerBlock:116}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:46},{numBlocks:29,dataCodewordsPerBlock:47}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:42,dataCodewordsPerBlock:24},{numBlocks:1,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:23,dataCodewordsPerBlock:15},{numBlocks:28,dataCodewordsPerBlock:16}]}]},{infoBits:133589,versionNumber:32,alignmentPatternCenters:[6,34,60,86,112,138],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:17,dataCodewordsPerBlock:115}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:10,dataCodewordsPerBlock:46},{numBlocks:23,dataCodewordsPerBlock:47}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:10,dataCodewordsPerBlock:24},{numBlocks:35,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:19,dataCodewordsPerBlock:15},{numBlocks:35,dataCodewordsPerBlock:16}]}]},{infoBits:136944,versionNumber:33,alignmentPatternCenters:[6,30,58,86,114,142],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:17,dataCodewordsPerBlock:115},{numBlocks:1,dataCodewordsPerBlock:116}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:14,dataCodewordsPerBlock:46},{numBlocks:21,dataCodewordsPerBlock:47}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:29,dataCodewordsPerBlock:24},{numBlocks:19,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:11,dataCodewordsPerBlock:15},{numBlocks:46,dataCodewordsPerBlock:16}]}]},{infoBits:141498,versionNumber:34,alignmentPatternCenters:[6,34,62,90,118,146],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:13,dataCodewordsPerBlock:115},{numBlocks:6,dataCodewordsPerBlock:116}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:14,dataCodewordsPerBlock:46},{numBlocks:23,dataCodewordsPerBlock:47}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:44,dataCodewordsPerBlock:24},{numBlocks:7,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:59,dataCodewordsPerBlock:16},{numBlocks:1,dataCodewordsPerBlock:17}]}]},{infoBits:145311,versionNumber:35,alignmentPatternCenters:[6,30,54,78,102,126,150],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:12,dataCodewordsPerBlock:121},{numBlocks:7,dataCodewordsPerBlock:122}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:12,dataCodewordsPerBlock:47},{numBlocks:26,dataCodewordsPerBlock:48}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:39,dataCodewordsPerBlock:24},{numBlocks:14,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:22,dataCodewordsPerBlock:15},{numBlocks:41,dataCodewordsPerBlock:16}]}]},{infoBits:150283,versionNumber:36,alignmentPatternCenters:[6,24,50,76,102,128,154],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:6,dataCodewordsPerBlock:121},{numBlocks:14,dataCodewordsPerBlock:122}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:6,dataCodewordsPerBlock:47},{numBlocks:34,dataCodewordsPerBlock:48}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:46,dataCodewordsPerBlock:24},{numBlocks:10,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:15},{numBlocks:64,dataCodewordsPerBlock:16}]}]},{infoBits:152622,versionNumber:37,alignmentPatternCenters:[6,28,54,80,106,132,158],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:17,dataCodewordsPerBlock:122},{numBlocks:4,dataCodewordsPerBlock:123}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:29,dataCodewordsPerBlock:46},{numBlocks:14,dataCodewordsPerBlock:47}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:49,dataCodewordsPerBlock:24},{numBlocks:10,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:24,dataCodewordsPerBlock:15},{numBlocks:46,dataCodewordsPerBlock:16}]}]},{infoBits:158308,versionNumber:38,alignmentPatternCenters:[6,32,58,84,110,136,162],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:122},{numBlocks:18,dataCodewordsPerBlock:123}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:13,dataCodewordsPerBlock:46},{numBlocks:32,dataCodewordsPerBlock:47}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:48,dataCodewordsPerBlock:24},{numBlocks:14,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:42,dataCodewordsPerBlock:15},{numBlocks:32,dataCodewordsPerBlock:16}]}]},{infoBits:161089,versionNumber:39,alignmentPatternCenters:[6,26,54,82,110,138,166],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:20,dataCodewordsPerBlock:117},{numBlocks:4,dataCodewordsPerBlock:118}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:40,dataCodewordsPerBlock:47},{numBlocks:7,dataCodewordsPerBlock:48}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:43,dataCodewordsPerBlock:24},{numBlocks:22,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:10,dataCodewordsPerBlock:15},{numBlocks:67,dataCodewordsPerBlock:16}]}]},{infoBits:167017,versionNumber:40,alignmentPatternCenters:[6,30,58,86,114,142,170],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:19,dataCodewordsPerBlock:118},{numBlocks:6,dataCodewordsPerBlock:119}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:18,dataCodewordsPerBlock:47},{numBlocks:31,dataCodewordsPerBlock:48}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:34,dataCodewordsPerBlock:24},{numBlocks:34,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:20,dataCodewordsPerBlock:15},{numBlocks:61,dataCodewordsPerBlock:16}]}]}]},function(o,e,r){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var t=r(0);function c(o,e,r,t){var c=o.x-e.x+r.x-t.x,s=o.y-e.y+r.y-t.y;if(0===c&&0===s)return{a11:e.x-o.x,a12:e.y-o.y,a13:0,a21:r.x-e.x,a22:r.y-e.y,a23:0,a31:o.x,a32:o.y,a33:1};var a=e.x-r.x,n=t.x-r.x,d=e.y-r.y,l=t.y-r.y,i=a*l-n*d,B=(c*l-n*s)/i,k=(a*s-c*d)/i;return{a11:e.x-o.x+B*e.x,a12:e.y-o.y+B*e.y,a13:B,a21:t.x-o.x+k*t.x,a22:t.y-o.y+k*t.y,a23:k,a31:o.x,a32:o.y,a33:1}}e.extract=function(o,e){for(var r,s,a=function(o,e,r,t){var s=c(o,e,r,t);return{a11:s.a22*s.a33-s.a23*s.a32,a12:s.a13*s.a32-s.a12*s.a33,a13:s.a12*s.a23-s.a13*s.a22,a21:s.a23*s.a31-s.a21*s.a33,a22:s.a11*s.a33-s.a13*s.a31,a23:s.a13*s.a21-s.a11*s.a23,a31:s.a21*s.a32-s.a22*s.a31,a32:s.a12*s.a31-s.a11*s.a32,a33:s.a11*s.a22-s.a12*s.a21}}({x:3.5,y:3.5},{x:e.dimension-3.5,y:3.5},{x:e.dimension-6.5,y:e.dimension-6.5},{x:3.5,y:e.dimension-3.5}),n=c(e.topLeft,e.topRight,e.alignmentPattern,e.bottomLeft),d=(s=a,{a11:(r=n).a11*s.a11+r.a21*s.a12+r.a31*s.a13,a12:r.a12*s.a11+r.a22*s.a12+r.a32*s.a13,a13:r.a13*s.a11+r.a23*s.a12+r.a33*s.a13,a21:r.a11*s.a21+r.a21*s.a22+r.a31*s.a23,a22:r.a12*s.a21+r.a22*s.a22+r.a32*s.a23,a23:r.a13*s.a21+r.a23*s.a22+r.a33*s.a23,a31:r.a11*s.a31+r.a21*s.a32+r.a31*s.a33,a32:r.a12*s.a31+r.a22*s.a32+r.a32*s.a33,a33:r.a13*s.a31+r.a23*s.a32+r.a33*s.a33}),l=t.BitMatrix.createEmpty(e.dimension,e.dimension),i=function(o,e){var r=d.a13*o+d.a23*e+d.a33;return{x:(d.a11*o+d.a21*e+d.a31)/r,y:(d.a12*o+d.a22*e+d.a32)/r}},B=0;B<e.dimension;B++)for(var k=0;k<e.dimension;k++){var u=i(k+.5,B+.5);l.set(k,B,o.get(Math.floor(u.x),Math.floor(u.y)))}return{matrix:l,mappingFunction:i}}},function(o,e,r){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var t=function(o,e){return Math.sqrt(Math.pow(e.x-o.x,2)+Math.pow(e.y-o.y,2))};function c(o){return o.reduce((function(o,e){return o+e}))}function s(o,e,r,c){var s,a,n,d,l=[{x:Math.floor(o.x),y:Math.floor(o.y)}],i=Math.abs(e.y-o.y)>Math.abs(e.x-o.x);i?(s=Math.floor(o.y),a=Math.floor(o.x),n=Math.floor(e.y),d=Math.floor(e.x)):(s=Math.floor(o.x),a=Math.floor(o.y),n=Math.floor(e.x),d=Math.floor(e.y));for(var B=Math.abs(n-s),k=Math.abs(d-a),u=Math.floor(-B/2),C=s<n?1:-1,m=a<d?1:-1,f=!0,w=s,P=a;w!==n+C;w+=C){var v=i?P:w,h=i?w:P;if(r.get(v,h)!==f&&(f=!f,l.push({x:v,y:h}),l.length===c+1))break;if((u+=k)>0){if(P===d)break;P+=m,u-=B}}for(var y=[],p=0;p<c;p++)l[p]&&l[p+1]?y.push(t(l[p],l[p+1])):y.push(0);return y}function a(o,e,r,t){var c,a=e.y-o.y,n=e.x-o.x,d=s(o,e,r,Math.ceil(t/2)),l=s(o,{x:o.x-n,y:o.y-a},r,Math.ceil(t/2)),i=d.shift()+l.shift()-1;return(c=l.concat(i)).concat.apply(c,d)}function n(o,e){var r=c(o)/c(e),t=0;return e.forEach((function(e,c){t+=Math.pow(o[c]-e*r,2)})),{averageSize:r,error:t}}function d(o,e,r){try{var t=a(o,{x:-1,y:o.y},r,e.length),c=a(o,{x:o.x,y:-1},r,e.length),s=a(o,{x:Math.max(0,o.x-o.y)-1,y:Math.max(0,o.y-o.x)-1},r,e.length),d=a(o,{x:Math.min(r.width,o.x+o.y)+1,y:Math.min(r.height,o.y+o.x)+1},r,e.length),l=n(t,e),i=n(c,e),B=n(s,e),k=n(d,e),u=Math.sqrt(l.error*l.error+i.error*i.error+B.error*B.error+k.error*k.error),C=(l.averageSize+i.averageSize+B.averageSize+k.averageSize)/4;return u+(Math.pow(l.averageSize-C,2)+Math.pow(i.averageSize-C,2)+Math.pow(B.averageSize-C,2)+Math.pow(k.averageSize-C,2))/C}catch(o){return 1/0}}function l(o,e){for(var r=Math.round(e.x);o.get(r,Math.round(e.y));)r--;for(var t=Math.round(e.x);o.get(t,Math.round(e.y));)t++;for(var c=(r+t)/2,s=Math.round(e.y);o.get(Math.round(c),s);)s--;for(var a=Math.round(e.y);o.get(Math.round(c),a);)a++;return{x:c,y:(s+a)/2}}function i(o,e,r,s,n){var l,i,B;try{l=function(o,e,r,s){var n=(c(a(o,r,s,5))/7+c(a(o,e,s,5))/7+c(a(r,o,s,5))/7+c(a(e,o,s,5))/7)/4;if(n<1)throw new Error("Invalid module size");var d=Math.round(t(o,e)/n),l=Math.round(t(o,r)/n),i=Math.floor((d+l)/2)+7;switch(i%4){case 0:i++;break;case 2:i--}return{dimension:i,moduleSize:n}}(s,r,n,o),i=l.dimension,B=l.moduleSize}catch(o){return null}var k=r.x-s.x+n.x,u=r.y-s.y+n.y,C=(t(s,n)+t(s,r))/2/B,m=1-3/C,f={x:s.x+m*(k-s.x),y:s.y+m*(u-s.y)},w=e.map((function(e){var r=(e.top.startX+e.top.endX+e.bottom.startX+e.bottom.endX)/4,s=(e.top.y+e.bottom.y+1)/2;if(o.get(Math.floor(r),Math.floor(s))){var a=[e.top.endX-e.top.startX,e.bottom.endX-e.bottom.startX,e.bottom.y-e.top.y+1];c(a);return{x:r,y:s,score:d({x:Math.floor(r),y:Math.floor(s)},[1,1,1],o)+t({x:r,y:s},f)}}})).filter((function(o){return!!o})).sort((function(o,e){return o.score-e.score}));return{alignmentPattern:C>=15&&w.length?w[0]:f,dimension:i}}e.locate=function(o){for(var e=[],r=[],s=[],a=[],n=function(t){for(var n=0,d=!1,l=[0,0,0,0,0],i=function(e){var s=o.get(e,t);if(s===d)n++;else{l=[l[1],l[2],l[3],l[4],n],n=1,d=s;var i=c(l)/7,B=Math.abs(l[0]-i)<i&&Math.abs(l[1]-i)<i&&Math.abs(l[2]-3*i)<3*i&&Math.abs(l[3]-i)<i&&Math.abs(l[4]-i)<i&&!s,k=c(l.slice(-3))/3,u=Math.abs(l[2]-k)<k&&Math.abs(l[3]-k)<k&&Math.abs(l[4]-k)<k&&s;if(B){var C=e-l[3]-l[4],m=C-l[2],f={startX:m,endX:C,y:t};(w=r.filter((function(o){return m>=o.bottom.startX&&m<=o.bottom.endX||C>=o.bottom.startX&&m<=o.bottom.endX||m<=o.bottom.startX&&C>=o.bottom.endX&&l[2]/(o.bottom.endX-o.bottom.startX)<1.5&&l[2]/(o.bottom.endX-o.bottom.startX)>.5}))).length>0?w[0].bottom=f:r.push({top:f,bottom:f})}if(u){var w,P=e-l[4],v=P-l[3];f={startX:v,y:t,endX:P};(w=a.filter((function(o){return v>=o.bottom.startX&&v<=o.bottom.endX||P>=o.bottom.startX&&v<=o.bottom.endX||v<=o.bottom.startX&&P>=o.bottom.endX&&l[2]/(o.bottom.endX-o.bottom.startX)<1.5&&l[2]/(o.bottom.endX-o.bottom.startX)>.5}))).length>0?w[0].bottom=f:a.push({top:f,bottom:f})}}},B=-1;B<=o.width;B++)i(B);e.push.apply(e,r.filter((function(o){return o.bottom.y!==t&&o.bottom.y-o.top.y>=2}))),r=r.filter((function(o){return o.bottom.y===t})),s.push.apply(s,a.filter((function(o){return o.bottom.y!==t}))),a=a.filter((function(o){return o.bottom.y===t}))},B=0;B<=o.height;B++)n(B);e.push.apply(e,r.filter((function(o){return o.bottom.y-o.top.y>=2}))),s.push.apply(s,a);var k=e.filter((function(o){return o.bottom.y-o.top.y>=2})).map((function(e){var r=(e.top.startX+e.top.endX+e.bottom.startX+e.bottom.endX)/4,t=(e.top.y+e.bottom.y+1)/2;if(o.get(Math.round(r),Math.round(t))){var s=[e.top.endX-e.top.startX,e.bottom.endX-e.bottom.startX,e.bottom.y-e.top.y+1],a=c(s)/s.length;return{score:d({x:Math.round(r),y:Math.round(t)},[1,1,3,1,1],o),x:r,y:t,size:a}}})).filter((function(o){return!!o})).sort((function(o,e){return o.score-e.score})).map((function(o,e,r){if(e>4)return null;var t=r.filter((function(o,r){return e!==r})).map((function(e){return{x:e.x,y:e.y,score:e.score+Math.pow(e.size-o.size,2)/o.size,size:e.size}})).sort((function(o,e){return o.score-e.score}));if(t.length<2)return null;var c=o.score+t[0].score+t[1].score;return{points:[o].concat(t.slice(0,2)),score:c}})).filter((function(o){return!!o})).sort((function(o,e){return o.score-e.score}));if(0===k.length)return null;var u=function(o,e,r){var c,s,a,n,d,l,i,B=t(o,e),k=t(e,r),u=t(o,r);return k>=B&&k>=u?(d=(c=[e,o,r])[0],l=c[1],i=c[2]):u>=k&&u>=B?(d=(s=[o,e,r])[0],l=s[1],i=s[2]):(d=(a=[o,r,e])[0],l=a[1],i=a[2]),(i.x-l.x)*(d.y-l.y)-(i.y-l.y)*(d.x-l.x)<0&&(d=(n=[i,d])[0],i=n[1]),{bottomLeft:d,topLeft:l,topRight:i}}(k[0].points[0],k[0].points[1],k[0].points[2]),C=u.topRight,m=u.topLeft,f=u.bottomLeft,w=i(o,s,C,m,f),P=[];w&&P.push({alignmentPattern:{x:w.alignmentPattern.x,y:w.alignmentPattern.y},bottomLeft:{x:f.x,y:f.y},dimension:w.dimension,topLeft:{x:m.x,y:m.y},topRight:{x:C.x,y:C.y}});var v=l(o,C),h=l(o,m),y=l(o,f),p=i(o,s,v,h,y);return p&&P.push({alignmentPattern:{x:p.alignmentPattern.x,y:p.alignmentPattern.y},bottomLeft:{x:y.x,y:y.y},topLeft:{x:h.x,y:h.y},topRight:{x:v.x,y:v.y},dimension:p.dimension}),0===P.length?null:P}}]).default}));
//# sourceMappingURL=/sm/261261d91f249d4079ae119cfa50f739467d90fc365078a671172e0f499e862a.map
