/*
 * Pinterest tracking for digistore24-7.netlify.app
 * ------------------------------------------------------------------
 * 1. Loads the Pinterest tag (PageVisit, Lead, InitiateCheckout).
 * 2. Mirrors each event to the Netlify function, which forwards it to
 *    Pinterest's Conversions API with a shared event_id so Pinterest
 *    deduplicates the two copies.
 * 3. Forwards the Pinterest click id (epik) to Payhip links so clicks
 *    that leave this site can still be attributed.
 *
 * SETUP: put your Pinterest tag id in TAG_ID below. It is public.
 * The Conversions API token is NOT here - it lives in a Netlify
 * environment variable (see PINTEREST-SETUP.md).
 */
(function () {
  "use strict";

  var TAG_ID = "2613590686504";
  var ENDPOINT = "/.netlify/functions/pinterest-event";

  /* Payhip product id -> price. Used as the checkout value. */
  var PRICES = {
    NOHiI: 7,
    TWYRm: 40,
    HtVOm: 17,
    VWAE4: 47,
    "9zJxC": 17,
    MBFzo: 9,
    YZzvP: 57,
    YyVCS: 29,
    "7ZGzl": 47,
    "v64nf": 12,
    McyES: 25,
    xXa9j: 17,
    E7Aj0: 17
  };

  var hasTag = /^\d{5,}$/.test(TAG_ID);
  var debug = /[?&]pin_debug=1/.test(location.search);
  var isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  var optedOut =
    navigator.globalPrivacyControl === true ||
    navigator.doNotTrack === "1" ||
    window.doNotTrack === "1" ||
    navigator.msDoNotTrack === "1";

  /* Official Pinterest tag loader. */
  if (hasTag) {
    (function (e) {
      if (window.pintrk) return;
      window.pintrk = function () {
        window.pintrk.queue.push(Array.prototype.slice.call(arguments));
      };
      var n = window.pintrk;
      n.queue = [];
      n.version = "3.0";
      var t = document.createElement("script");
      t.async = true;
      t.src = e;
      var r = document.getElementsByTagName("script")[0];
      if (r && r.parentNode) r.parentNode.insertBefore(t, r);
      else document.head.appendChild(t);
    })("https://s.pinimg.com/ct/core.js");
    window.pintrk("load", TAG_ID);
  }

  function log() {
    if (debug && window.console) console.info.apply(console, ["[pinterest]"].concat([].slice.call(arguments)));
  }

  function makeId(name) {
    var rand;
    try {
      rand = window.crypto.randomUUID();
    } catch (e) {
      rand = Date.now().toString(36) + "_" + Math.random().toString(36).slice(2);
    }
    return name.toLowerCase() + "_" + rand;
  }

  function cookie(name) {
    var m = document.cookie.match(new RegExp("(?:^|; )" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : "";
  }

  function getEpik() {
    try {
      var qs = new URLSearchParams(location.search);
      return qs.get("epik") || qs.get("_epik") || cookie("_epik");
    } catch (e) {
      return cookie("_epik");
    }
  }

  function sendServer(payload, beacon) {
    var body = JSON.stringify(payload);
    try {
      if (beacon && navigator.sendBeacon) {
        if (navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }))) return;
      }
    } catch (e) {}
    try {
      fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body,
        keepalive: !!beacon
      }).catch(function (err) {
        log("server event failed", err && err.message);
      });
    } catch (e) {
      log("server event failed", e && e.message);
    }
  }

  function fire(name, data, opts) {
    if (optedOut) return log("skipped, visitor opted out");
    if (isLocal && !debug) return log("skipped, local host");

    data = data || {};
    var id = makeId(name);
    var tagParams = { event_id: id };

    if (data.value != null) {
      tagParams.value = data.value;
      tagParams.currency = data.currency || "USD";
    }

    if (hasTag) {
      try {
        window.pintrk("track", name, tagParams);
      } catch (e) {
        log("tag event failed", e && e.message);
      }
    }

    var payload = {
      name: name,
      event_id: id,
      url: location.href,
      epik: getEpik()
    };
    if (data.email) payload.email = data.email;
    if (data.product_id) payload.product_id = data.product_id;
    if (data.value != null) payload.value = data.value;
    if (data.currency) payload.currency = data.currency;
    if (data.content_name) payload.content_name = data.content_name;

    log(name, payload);
    sendServer(payload, opts && opts.beacon);
  }

  function track(name, data, opts) {
    fire(name, data || {}, opts);
  }

  function onFormSubmit(e) {
    var form = e.target;
    if (!form || form.id !== "hookform") return;
    var input = form.querySelector('input[name="email"]');
    var email = input && input.value ? input.value.trim() : "";
    if (!email || email.indexOf("@") < 1) return;
    track("Lead", { email: email, content_name: "free-hooks" });
  }

  function onLinkClick(e) {
    if (e.defaultPrevented || (e.button !== undefined && e.button !== 0)) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    var el = e.target;
    while (el && el.nodeName !== "A") el = el.parentNode;
    if (!el || !el.href) return;

    var url;
    try {
      url = new URL(el.href);
    } catch (err) {
      return;
    }
    if (!/(^|\.)payhip\.com$/.test(url.hostname)) return;

    var match = url.pathname.match(/\/b\/([A-Za-z0-9]+)/);
    var productId = match ? match[1] : "";
    var value = productId && PRICES[productId] != null ? PRICES[productId] : null;

    /* Keep the ad click id when the visitor crosses to Payhip. */
    var epik = getEpik();
    if (epik && !url.searchParams.get("epik")) {
      url.searchParams.set("epik", epik);
      el.href = url.toString();
    }

    track(
      "InitiateCheckout",
      { product_id: productId || undefined, value: value, currency: "USD", content_name: "payhip-click" },
      { beacon: true }
    );
  }

  function init() {
    track("PageVisit");
    document.addEventListener("submit", onFormSubmit, true);
    document.addEventListener("click", onLinkClick, true);
  }

  /* Expose for future events: dgPinterest.track("SignUp", {...}) */
  window.dgPinterest = { track: track, epik: getEpik };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
