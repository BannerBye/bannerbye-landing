/* The install buttons follow the browser you're actually in.
   Progressive enhancement: without JS the markup already says Chrome.
   Verified against 11 user agents — Chrome/Mac, Safari/Mac, Safari/iPhone,
   iPadOS 18, Chrome on iPhone, Firefox/Win, Firefox/Android, Edge/Win,
   Brave/Mac, Opera/Win, Chrome/Android. */
(function () {
  var ua = navigator.userAgent;
  var touch = navigator.maxTouchPoints || 0;

  var STORE = {
    chrome:  { label: 'Chrome',        cta: 'Add to Chrome',  long: 'Add to Chrome — free',
               url: 'https://chromewebstore.google.com/detail/gjeafgcfhehafjioplpjkocbglmhhbfg',
               note: 'Free. No account. Also works on Brave and Opera.' },
    edge:    { label: 'Edge',          cta: 'Add to Edge',    long: 'Add to Edge — free',
               url: 'https://microsoftedge.microsoft.com/addons/detail/caecjebifbceigbddnfhcdbfjhcgloi',
               note: 'Free. No account. Reviewed by Microsoft.' },
    firefox: { label: 'Firefox',       cta: 'Add to Firefox', long: 'Add to Firefox — free',
               url: 'https://addons.mozilla.org/firefox/addon/bannerbye/',
               note: 'Free. No account. Reviewed by Mozilla. Works on Firefox for Android too.' },
    ios:     { label: 'iPhone & iPad', cta: 'Get the app',    long: 'Get for iPhone & iPad',
               url: 'https://apps.apple.com/app/id6771131989',
               note: '€1.99 once. No account, no subscription.' },
    mac:     { label: 'Safari',        cta: 'Get for Safari', long: 'Get for Safari',
               url: 'https://apps.apple.com/app/id6771131989',
               note: '€1.99 once, for Safari on Mac. No account, no subscription.' }
  };

  function detect() {
    /* iPadOS 13+ reports itself as a Mac — the touch points give it away. */
    var iOS = /iPhone|iPod|iPad/.test(ua) || (/Macintosh/.test(ua) && touch > 1);
    if (iOS) return 'ios';                              /* every iOS browser is WebKit */
    if (/Edg\//.test(ua)) return 'edge';
    if (/FxiOS|Firefox\//.test(ua)) return 'firefox';
    if (/OPR\/|Opera/.test(ua)) return 'chrome';        /* Chromium — Chrome store works */
    if (navigator.brave) return 'chrome';
    if (/Chrome|Chromium|CriOS/.test(ua)) return 'chrome';
    if (/Safari\//.test(ua)) return 'mac';
    return 'chrome';
  }

  var here = detect();
  var others = ['chrome', 'firefox', 'ios'].filter(function (k) {
    return k !== here && !(here === 'mac' && k === 'ios') && !(here === 'edge' && k === 'chrome');
  });
  if (others.length < 2) others = others.concat(['firefox', 'chrome']).filter(function (k, i, a) {
    return k !== here && a.indexOf(k) === i;
  });

  function put(sel, store) {
    if (!store) return;
    document.querySelectorAll('[data-install="' + sel + '"]').forEach(function (el) {
      el.textContent = store.label;
      el.setAttribute('href', store.url);
    });
  }

  document.querySelectorAll('[data-install="primary"]').forEach(function (el) {
    var s = STORE[here];
    /* the nav keeps the short label so it never wraps to two lines */
    el.textContent = el.closest('.nav') ? s.cta : s.long;
    el.setAttribute('href', s.url);
  });
  put('alt-a', STORE[others[0]]);
  put('alt-b', STORE[others[1]]);

  document.querySelectorAll('[data-install="note"]').forEach(function (el) {
    el.textContent = STORE[here].note;
  });
})();
