/**
 * Splash window controls for public/splash.html. Buttons render disabled and
 * wire up once a Tauri window API resolves, mirroring
 * src/components/ide/window-controls.tsx (minimize/maximize/unmaximize/close
 * + isMaximized). Tries the compat global first, then the invoke channel with
 * the current window label. Stays disabled if neither answers — never dead
 * chrome. Maximize label re-syncs on webview resize; no event plugin needed.
 * Dependency-free and non-blocking by design (fastest-paint path).
 */
(function () {
  function isMac() {
    try {
      var platform = (navigator && navigator.platform) || "";
      var ua = (navigator && navigator.userAgent) || "";
      return /Mac|iPhone|iPad|iPod/.test(platform) || /Mac/.test(ua);
    } catch (e) {
      return false;
    }
  }

  function setEnabled(ids, enabled) {
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (el) {
        if (enabled) el.removeAttribute("disabled");
        else el.setAttribute("disabled", "");
      }
    }
  }

  function pickCluster() {
    var mac = isMac();
    var win = document.getElementById("chrome-win");
    var macEl = document.getElementById("chrome-mac");
    if (mac && macEl && win) {
      win.setAttribute("hidden", "");
      macEl.removeAttribute("hidden");
      return { min: "btn-min-mac", max: "btn-max-mac", close: "btn-close-mac" };
    }
    if (macEl) macEl.setAttribute("hidden", "");
    if (win) win.removeAttribute("hidden");
    return { min: "btn-min", max: "btn-max", close: "btn-close" };
  }

  function currentLabel() {
    try {
      var meta = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.metadata;
      var label =
        (meta && meta.currentWindow && meta.currentWindow.label) ||
        (meta && meta.currentWebview && meta.currentWebview.windowLabel);
      if (typeof label === "string" && label) return label;
    } catch (e) {}
    return "main";
  }

  function internalsShim() {
    try {
      var internals = window.__TAURI_INTERNALS__;
      if (!internals || typeof internals.invoke !== "function") return null;
      var label = currentLabel();
      return {
        minimize: function () { return internals.invoke("plugin:window|minimize", { label: label }); },
        maximize: function () { return internals.invoke("plugin:window|maximize", { label: label }); },
        unmaximize: function () { return internals.invoke("plugin:window|unmaximize", { label: label }); },
        close: function () { return internals.invoke("plugin:window|close", { label: label }); },
        isMaximized: function () { return internals.invoke("plugin:window|is_maximized", { label: label }); },
      };
    } catch (e) {
      return null;
    }
  }

  function compatWindow() {
    try {
      var ns = window.__TAURI__ && window.__TAURI__.window;
      if (ns && typeof ns.getCurrentWindow === "function") return ns.getCurrentWindow();
    } catch (e) {}
    return null;
  }

  function refreshMaxLabel(win, maxBtn) {
    try {
      var p = win.isMaximized();
      var done = function (maximized) {
        try {
          maxBtn.setAttribute("aria-label", maximized ? "Restore" : "Maximize");
        } catch (e) {}
      };
      if (p && typeof p.then === "function") p.then(done).catch(function () {});
      else done(!!p);
    } catch (e) {}
  }

  function wire(ids, win) {
    var minBtn = document.getElementById(ids.min);
    var maxBtn = document.getElementById(ids.max);
    var closeBtn = document.getElementById(ids.close);

    if (minBtn) {
      minBtn.addEventListener("click", function () {
        try {
          var p = win.minimize();
          if (p && typeof p.catch === "function") p.catch(function () {});
        } catch (e) {}
      });
    }
    if (closeBtn) {
      closeBtn.addEventListener("click", function () {
        try {
          var p = win.close();
          if (p && typeof p.catch === "function") p.catch(function () {});
        } catch (e) {}
      });
    }
    if (maxBtn) {
      // Gate maximize on isMaximized() resolution — never show a lying icon.
      refreshMaxLabel(win, maxBtn);
      maxBtn.addEventListener("click", function () {
        try {
          var q = win.isMaximized();
          var toggle = function (maximized) {
            try {
              var r = maximized ? win.unmaximize() : win.maximize();
              if (r && typeof r.then === "function") {
                r.then(function () {
                  refreshMaxLabel(win, maxBtn);
                }).catch(function () {});
              } else {
                refreshMaxLabel(win, maxBtn);
              }
            } catch (e) {}
          };
          if (q && typeof q.then === "function") q.then(toggle).catch(function () {});
          else toggle(!!q);
        } catch (e) {}
      });
      // Webview resize fires on maximize/restore — re-sync the label without
      // any Tauri event channel.
      var pending = false;
      window.addEventListener("resize", function () {
        if (pending) return;
        pending = true;
        setTimeout(function () {
          pending = false;
          refreshMaxLabel(win, maxBtn);
        }, 200);
      });
    }
  }

  function boot() {
    var ids = pickCluster();
    var all = [ids.min, ids.max, ids.close];
    // Buttons render disabled until the API is ready (safe during load).
    setEnabled(all, false);

    function enableWith(win) {
      if (!win) return false;
      try {
        var probe = win.isMaximized();
        if (probe && typeof probe.then === "function") {
          probe.then(
            function () {
              wire(ids, win);
              setEnabled(all, true);
            },
            function () {},
          );
        } else {
          wire(ids, win);
          setEnabled(all, true);
        }
        return true;
      } catch (e) {
        return false;
      }
    }

    // 1. Compat global (zero channel guessing when the host exposes it).
    try {
      if (enableWith(compatWindow())) return;
    } catch (e) {}
    // 2. Invoke-channel shim with the current window label.
    try {
      if (enableWith(internalsShim())) return;
    } catch (e) {}
    // Otherwise: stay disabled (draggable window, no dead chrome).
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
