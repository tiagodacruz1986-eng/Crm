// Page d'installation sur téléphone / tablette : détecte l'appareil et la connexion,
// propose le bouton d'installation (Android, ordinateur) ou les étapes (iPhone / iPad).
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var show = function (id, on) { $(id).hidden = on === false; };
  var kiosk = /[?&]app=kiosk\b/.test(location.search);
  var ua = navigator.userAgent || '';
  var isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isAndroid = /Android/.test(ua);
  var iosOtherBrowser = isIOS && /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  var standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  var deferred = null;

  $(kiosk ? 'sw-kiosk' : 'sw-app').classList.add('on');
  $('title').textContent = kiosk ? 'Installer le pointage atelier' : "Installer l'application";
  $('open-app').href = kiosk ? '/kiosk.html' : '/';
  $('continue').href = kiosk ? '/kiosk.html' : '/';

  // Nom et logo du garage
  fetch('/app-info.json').then(function (r) { return r.json(); }).then(function (info) {
    $('company').textContent = info.company || '';
    if (info.logo) { $('logo').src = info.logo; $('logo').hidden = false; }
    var secure = info.secure_url;
    if (!window.isSecureContext) {
      if (secure) {
        $('secure-link').href = secure.replace(/\/$/, '') + '/installer.html' + (kiosk ? '?app=kiosk' : '');
        $('secure-link').hidden = false;
      } else {
        $('no-secure').hidden = false;
      }
    }
  }).catch(function () {});

  // Le service worker est nécessaire au mode hors-ligne (seulement en https ou sur l'ordinateur lui-même)
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(function () {});

  if (standalone) { show('installed'); return; }
  if (!window.isSecureContext) show('insecure');

  if (isIOS) {
    show('ios');
    if (iosOtherBrowser) show('ios-browser');
  } else if (isAndroid) {
    show('android');
    if (!window.isSecureContext) {
      // Sans https, Chrome ne propose qu'un raccourci (qui s'ouvre dans le navigateur)
      $('android-step2').innerHTML = 'Touchez <b>« Ajouter à l\'écran d\'accueil »</b>, puis <b>« Ajouter »</b>.';
      $('android-step3').textContent = "Un raccourci apparaît sur l'écran d'accueil. Pour une vraie application, utilisez l'adresse sécurisée (https).";
    }
    if (window.isSecureContext) show('install-wait');
  } else {
    show('desktop');
  }

  // Android / ordinateur : Chrome propose l'installation quand l'application remplit les conditions
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    show('install-wait', false);
    show(isAndroid ? 'install-btn' : 'install-btn-desk');
  });
  function install() {
    if (!deferred) return;
    deferred.prompt();
    deferred.userChoice.then(function (c) {
      deferred = null;
      if (c.outcome === 'accepted') { show('install-btn', false); show('install-btn-desk', false); }
    });
  }
  $('install-btn').addEventListener('click', install);
  $('install-btn-desk').addEventListener('click', install);
  window.addEventListener('appinstalled', function () {
    ['android', 'ios', 'desktop', 'insecure'].forEach(function (id) { show(id, false); });
    show('installed');
  });
  // Pas de proposition après quelques secondes : on garde seulement les étapes manuelles
  setTimeout(function () { show('install-wait', false); }, 4000);
})();
