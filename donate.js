(function () {
  "use strict";

  // Public endpoint of the create-checkout Supabase function.
  var FUNCTION_URL = "https://raqzifwjqyvnygxqvief.supabase.co/functions/v1/create-checkout";
  var BAG_PENCE = 4000;
  var MIN_PENCE = 100;
  var MAX_PENCE = 1000000;

  var AMOUNTS = {
    one_off: [
      { pence: 4000, label: "£40", sub: "1 bag" },
      { pence: 40000, label: "£400", sub: "10 bags" },
      { pence: 100000, label: "£1,000", sub: "25 bags" },
      { pence: 200000, label: "£2,000", sub: "50 bags" }
    ],
    monthly: [
      { pence: 500, label: "£5", sub: "a month" },
      { pence: 1000, label: "£10", sub: "a month" },
      { pence: 2000, label: "£20", sub: "a month" }
    ]
  };

  var $ = function (id) { return document.getElementById(id); };
  var form = $("donate-form");
  if (!form) return;

  var state = { frequency: "one_off", selected: 4000, other: false };

  function gbp(pence) {
    var pounds = pence / 100;
    return "£" + (pounds % 1 === 0 ? pounds.toLocaleString("en-GB") : pounds.toFixed(2));
  }

  // Parses "25", "25.50", "£1,000" into pence. Returns null when not a valid amount.
  function parseAmount(text) {
    var t = String(text).replace(/[£,\s]/g, "");
    if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
    return Math.round(parseFloat(t) * 100);
  }

  function currentPence() {
    if (state.other) return parseAmount($("other-amount").value);
    return state.selected;
  }

  function renderChips() {
    var wrap = $("amount-chips");
    wrap.innerHTML = "";
    AMOUNTS[state.frequency].forEach(function (a, i) {
      var id = "amt-" + i;
      var div = document.createElement("div");
      div.className = "chip";
      var input = document.createElement("input");
      input.type = "radio"; input.name = "amount"; input.id = id; input.value = String(a.pence);
      input.checked = !state.other && state.selected === a.pence;
      var label = document.createElement("label");
      label.htmlFor = id;
      label.appendChild(document.createTextNode(a.label));
      var small = document.createElement("small");
      small.textContent = a.sub;
      label.appendChild(small);
      div.appendChild(input); div.appendChild(label);
      wrap.appendChild(div);
    });
    var div = document.createElement("div");
    div.className = "chip";
    var input = document.createElement("input");
    input.type = "radio"; input.name = "amount"; input.id = "amt-other"; input.value = "other"; input.checked = state.other;
    var label = document.createElement("label");
    label.htmlFor = "amt-other"; label.textContent = "Other";
    div.appendChild(input); div.appendChild(label);
    wrap.appendChild(div);
    $("other-wrap").hidden = !state.other;
  }

  function updateSummary() {
    var pence = currentPence();
    var el = $("summary");
    if (pence === null || pence < MIN_PENCE || pence > MAX_PENCE) {
      el.textContent = state.other ? "Enter an amount between £1 and £10,000." : "";
      return;
    }
    var monthly = state.frequency === "monthly";
    var text = "You are giving " + gbp(pence) + (monthly ? " every month." : " once.");
    if (!monthly && pence % BAG_PENCE === 0) {
      var bags = pence / BAG_PENCE;
      text += " That sponsors " + bags + " winter bag" + (bags === 1 ? "" : "s") + ".";
    }
    var individual = form.donor_type.value === "individual";
    if (individual && $("gift_aid").checked) {
      text += " With Gift Aid we can claim " + gbp(Math.round(pence * 0.25)) + (monthly ? " extra each month." : " extra.");
    }
    el.textContent = text;
  }

  function updateDonorType() {
    var business = form.donor_type.value === "business";
    $("business-field").hidden = !business;
    $("naming-check").hidden = !business;
    $("giftaid-box").hidden = business;
    $("first-label").textContent = business ? "Contact first name" : "First name";
    $("last-label").textContent = business ? "Contact last name" : "Last name";
    $("type-note").textContent = business
      ? "Limited companies cannot claim Gift Aid but may deduct gifts to a registered charity from taxable profits."
      : "Sole traders and partners giving from their own money should choose Individual.";
    if (business) { $("gift_aid").checked = false; }
    updateGiftAid();
  }

  function updateGiftAid() {
    $("giftaid-address").hidden = !$("gift_aid").checked || form.donor_type.value === "business";
    updateSummary();
  }

  function clearErrors() {
    var errs = form.querySelectorAll(".err");
    for (var i = 0; i < errs.length; i++) errs[i].textContent = "";
    var inputs = form.querySelectorAll("[aria-invalid]");
    for (var j = 0; j < inputs.length; j++) inputs[j].removeAttribute("aria-invalid");
    $("form-error").hidden = true;
  }

  function showError(field, message) {
    var err = $(field + "-err");
    if (err) err.textContent = message;
    var input = $(field);
    if (input) input.setAttribute("aria-invalid", "true");
  }

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var POSTCODE_RE = /^[A-Za-z]{1,2}[0-9][A-Za-z0-9]?\s*[0-9][A-Za-z]{2}$/;

  function collect() {
    var business = form.donor_type.value === "business";
    var giftAid = !business && $("gift_aid").checked;
    return {
      frequency: state.frequency,
      amount_pence: currentPence(),
      donor_type: form.donor_type.value,
      first_name: $("first_name").value.trim(),
      last_name: $("last_name").value.trim(),
      email: $("email").value.trim(),
      business_name: business ? $("business_name").value.trim() : null,
      gift_aid: giftAid,
      house_name_or_number: giftAid ? $("house_name_or_number").value.trim() : null,
      address_line_1: giftAid ? $("address_line_1").value.trim() : null,
      town: giftAid ? $("town").value.trim() : null,
      postcode: giftAid ? $("postcode").value.trim() : null,
      public_naming_ok: business && $("public_naming_ok").checked,
      marketing_consent: $("marketing_consent").checked,
      website: $("website").value
    };
  }

  function validate(p) {
    var bad = [];
    function add(field, msg) { showError(field, msg); bad.push(field); }
    if (p.amount_pence === null || p.amount_pence < MIN_PENCE || p.amount_pence > MAX_PENCE) {
      $("amount-err").textContent = "Enter an amount between £1 and £10,000.";
      if (state.other) $("other-amount").setAttribute("aria-invalid", "true");
      bad.push(state.other ? "other-amount" : "amount-chips");
    }
    if (p.donor_type === "business" && !p.business_name) add("business_name", "Enter the business or organisation name.");
    if (!p.first_name) add("first_name", "Enter a first name.");
    if (!p.last_name) add("last_name", "Enter a last name.");
    if (!EMAIL_RE.test(p.email)) add("email", "Enter a valid email address.");
    if (p.gift_aid) {
      if (!p.house_name_or_number) add("house_name_or_number", "Enter your house name or number.");
      if (!POSTCODE_RE.test(p.postcode)) add("postcode", "Enter a valid UK postcode.");
    }
    return bad;
  }

  function focusFirst(fields) {
    var el = fields.length ? $(fields[0]) : null;
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "center" });
    if (el && el.focus) el.focus();
  }

  var submitBtn = $("submit");
  function setBusy(busy) {
    submitBtn.disabled = busy;
    submitBtn.textContent = busy ? "Taking you to Stripe..." : "Continue to secure payment";
  }

  function fail(message) {
    var box = $("form-error");
    box.textContent = message;
    box.hidden = false;
    box.scrollIntoView({ block: "center" });
    setBusy(false);
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    clearErrors();
    var payload = collect();
    var bad = validate(payload);
    if (bad.length) { focusFirst(bad); return; }

    setBusy(true);
    fetch(FUNCTION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (res) {
        return res.json().then(function (body) { return { ok: res.ok, status: res.status, body: body }; });
      })
      .then(function (r) {
        if (r.ok && r.body && typeof r.body.url === "string" && /^https:\/\/(checkout\.stripe\.com|kiauk\.org)\//.test(r.body.url)) {
          window.location.href = r.body.url;
          return;
        }
        if (r.status === 422 && r.body && r.body.fields) {
          var names = Object.keys(r.body.fields), first = [];
          names.forEach(function (f) {
            if (f === "amount_pence") { $("amount-err").textContent = r.body.fields[f]; first.push("amount-chips"); }
            else { showError(f, r.body.fields[f]); first.push(f); }
          });
          setBusy(false);
          focusFirst(first);
          return;
        }
        fail((r.body && r.body.error) || "Something went wrong. Please try again, or email contact@kiauk.org.");
      })
      .catch(function () {
        fail("We could not reach the payment service. Check your connection and try again, or email contact@kiauk.org.");
      });
  });

  // Frequency
  $("freq-chips").addEventListener("change", function (e) {
    if (e.target.name !== "frequency") return;
    state.frequency = e.target.value;
    state.other = false;
    state.selected = AMOUNTS[state.frequency][state.frequency === "monthly" ? 1 : 0].pence;
    renderChips();
    updateSummary();
  });

  // Amount
  $("amount-chips").addEventListener("change", function (e) {
    if (e.target.name !== "amount") return;
    $("amount-err").textContent = "";
    if (e.target.value === "other") {
      state.other = true;
      $("other-wrap").hidden = false;
      $("other-amount").focus();
    } else {
      state.other = false;
      state.selected = parseInt(e.target.value, 10);
      $("other-wrap").hidden = true;
    }
    updateSummary();
  });
  $("other-amount").addEventListener("input", function () { $("amount-err").textContent = ""; updateSummary(); });

  form.addEventListener("change", function (e) {
    if (e.target.name === "donor_type") updateDonorType();
    if (e.target.id === "gift_aid") updateGiftAid();
  });

  // Clear a field's error as soon as it is edited
  form.addEventListener("input", function (e) {
    var t = e.target;
    if (!t.id) return;
    var err = $(t.id + "-err");
    if (err) err.textContent = "";
    if (t.getAttribute("aria-invalid")) t.removeAttribute("aria-invalid");
  });

  window.addEventListener("pageshow", function () { setBusy(false); });

  if (/[?&]cancelled=1/.test(window.location.search)) $("cancelled").hidden = false;

  renderChips();
  updateDonorType();
  updateSummary();
})();
