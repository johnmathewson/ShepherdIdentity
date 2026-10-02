/* Shepherd strip for static sub-apps (HUB.md §9b, rule 5).
   Include once, anywhere in <head> or <body>:
     <script src="/strip.js" data-app="Formation" data-max="720" defer></script>
   The root-absolute src resolves to the hub only when the app is served through the
   hub proxy (apps.shepherdchurch.co/<app>/ or the staging hub); on the app's own
   domain it 404s harmlessly and no strip appears. The hub is always "/" here. */
(function () {
  var me = document.currentScript || document.querySelector('script[src$="/strip.js"]');
  var app = (me && me.dataset.app) || "";
  var max = (me && me.dataset.max) || "720";
  var css = "#shepherd-strip{position:sticky;top:0;z-index:2147483000;background:#1B2027;border-bottom:1px solid #2C333C;font-family:Montserrat,system-ui,-apple-system,'Segoe UI',sans-serif}" +
    "#shepherd-strip .ss-in{box-sizing:border-box;width:100%;max-width:" + parseInt(max, 10) + "px;margin:0 auto;padding:0 20px;height:44px;display:flex;justify-content:space-between;align-items:center;position:relative}" +
    "#shepherd-strip a{color:#fff;text-decoration:none;display:flex;margin:0;padding:0;border:0;background:none;font-size:inherit;line-height:1;align-items:center;gap:10px;min-height:44px}" +
    "#shepherd-strip .ss-brand{font-weight:800;font-size:12px;letter-spacing:.22em}" +
    "#shepherd-strip .ss-brand img{width:24px;height:24px;display:block}" +
    "#shepherd-strip .ss-app{margin:0;display:block;line-height:1;position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);white-space:nowrap;font-weight:700;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#B4BAC5}" +
    "#shepherd-strip .ss-all{font-family:Lato,system-ui,sans-serif;font-size:13px;color:#E6E8EE;gap:6px}" +
    "#shepherd-strip .ss-all span:last-child{opacity:.7}" +
    "@media(max-width:480px){#shepherd-strip .ss-app{display:none}}";
  var style = document.createElement("style"); style.textContent = css;
  var bar = document.createElement("div"); bar.id = "shepherd-strip";
  bar.innerHTML = '<div class="ss-in">' +
    '<a class="ss-brand" href="/" aria-label="Shepherd apps home"><img src="/mark.png" alt=""><span>SHEPHERD</span></a>' +
    '<span class="ss-app"></span>' +
    '<a class="ss-all" href="/"><span>All apps</span><span aria-hidden="true">›</span></a></div>';
  bar.querySelector(".ss-app").textContent = app;
  function mount() { document.head.appendChild(style); document.body.insertBefore(bar, document.body.firstChild); }
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);
})();
