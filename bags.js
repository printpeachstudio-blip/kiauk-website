(function () {
  "use strict";
  // Public endpoint of the bag-count Supabase function. Shows how many winter bags have been sponsored.
  var URL = "https://raqzifwjqyvnygxqvief.supabase.co/functions/v1/bag-count";
  var blocks = document.querySelectorAll("[data-bag-progress]");
  if (!blocks.length || !window.fetch) return;

  function fmt(n) { return n.toLocaleString("en-GB"); }

  fetch(URL)
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("bad status")); })
    .then(function (d) {
      if (!d || typeof d.sponsored !== "number" || typeof d.target !== "number" || d.target <= 0) return;
      var sponsored = Math.max(0, Math.floor(d.sponsored));
      var target = Math.floor(d.target);
      var pct = Math.min(100, Math.round((sponsored / target) * 100));
      var text;
      if (sponsored >= target) text = "All " + fmt(target) + " bags are sponsored. Thank you.";
      else if (sponsored === 0) text = fmt(target) + " bags to fill. Be the first to sponsor one.";
      else text = fmt(sponsored) + " of " + fmt(target) + " bags sponsored so far.";
      for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i];
        var bar = b.querySelector("[role=progressbar]");
        var fill = b.querySelector(".bag-fill");
        var label = b.querySelector(".bag-text");
        if (bar) { bar.setAttribute("aria-valuemax", String(target)); bar.setAttribute("aria-valuenow", String(Math.min(sponsored, target))); }
        if (fill) fill.style.width = pct + "%";
        if (label) label.textContent = text;
        b.hidden = false;
      }
    })
    .catch(function () { /* leave the counter hidden if it cannot load */ });
})();
