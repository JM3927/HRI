/*
 * survey.js — Shared behaviour for the pre-test and post-test forms.
 *
 *   SurveyForm.attach(formEl, { buildPayload(form, responses) → object })
 *
 * The form's `data-endpoint` receives the JSON payload. Required questions
 * are marked with `data-required="<field name>"` (see templates/macros.html).
 * On success the server replies {status, next_url} and the browser follows
 * next_url; on 422 the server's per-field errors are shown.
 *
 * The form is split into screen-sized pages by static/js/pager.js. "Next"
 * only advances once every required question on the current page is
 * answered; unanswered ones are highlighted in place (nothing scrolls).
 */
(function (global) {
  'use strict';

  /** Collect every named control into a plain object (checkbox groups → arrays). */
  function collect(form) {
    var out = {};
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name || el.disabled) return;
      if (el.type === 'radio') {
        if (el.checked) out[el.name] = el.value;
      } else if (el.type === 'checkbox') {
        if (!Array.isArray(out[el.name])) out[el.name] = [];
        if (el.checked) out[el.name].push(el.value);
      } else if (el.type === 'number') {
        if (el.value !== '') out[el.name] = Number(el.value);
      } else if (el.value.trim() !== '') {
        out[el.name] = el.value.trim();
      }
    });
    return out;
  }

  function isAnswered(name, responses, container) {
    var v = responses[name];
    if (Array.isArray(v)) return v.length > 0;
    if (v === undefined || v === '') return false;
    var input = container.querySelector('input[type="number"][name="' + name + '"]');
    if (input) {
      var min = Number(input.getAttribute('data-min'));
      var max = Number(input.getAttribute('data-max'));
      return Number.isInteger(v) && v >= min && v <= max;
    }
    return true;
  }

  function attach(form, options) {
    var endpoint = form.getAttribute('data-endpoint');
    var submitBtn = form.querySelector('[type="submit"]');
    var errorBox = form.querySelector('#form-error');
    var counter = form.querySelector('#answered-count');
    var required = Array.prototype.slice.call(form.querySelectorAll('[data-required]'));
    var attempted = false;
    var pager = global.Pager ? global.Pager.of(form) : null;
    var checked = new Set();   // questions the participant has tried to leave unanswered

    // "Prefer to self-describe" reveals a text box.
    form.querySelectorAll('[data-reveals]').forEach(function (trigger) {
      var box = form.querySelector('.self-describe[data-for="' + trigger.getAttribute('data-reveals') + '"]');
      var group = form.querySelectorAll('input[name="' + trigger.name + '"]');
      group.forEach(function (el) {
        el.addEventListener('change', function () { box.hidden = !trigger.checked; });
      });
    });

    // "Prefer not to say" is exclusive within a checkbox group.
    form.querySelectorAll('input[type="checkbox"][data-exclusive]').forEach(function (excl) {
      var group = form.querySelectorAll('input[type="checkbox"][name="' + excl.name + '"]');
      group.forEach(function (el) {
        el.addEventListener('change', function () {
          if (!el.checked) return;
          group.forEach(function (other) {
            if (el === excl ? other !== excl : other === excl) other.checked = false;
          });
          var reveal = form.querySelector('.self-describe[data-for="' + excl.name + '_self_describe"]');
          if (reveal && el === excl) reveal.hidden = true;
        });
      });
    });

    function refresh() {
      var responses = collect(form);
      var answered = 0;
      var missing = [];
      required.forEach(function (node) {
        var ok = isAnswered(node.getAttribute('data-required'), responses, node);
        if (ok) answered += 1;
        else missing.push(node);
        var flag = !ok && (attempted || checked.has(node));
        node.classList.toggle('is-missing', flag);
        var err = node.querySelector('.field-error');
        if (err) err.hidden = !flag;
      });
      if (counter) counter.textContent = answered + ' of ' + required.length + ' answered';
      if (!missing.some(function (n) { return n.classList.contains('is-missing'); })) errorBox.hidden = true;
      return { responses: responses, complete: answered === required.length, missing: missing };
    }

    form.addEventListener('change', refresh);
    form.addEventListener('input', refresh);
    refresh();

    function showError(html) {
      errorBox.innerHTML = html;
      errorBox.hidden = false;
    }

    // Validate the questions on the current page before moving on.
    if (pager) {
      pager.beforeNext = function (units) {
        var onPage = required.filter(function (node) {
          return units.indexOf(node.closest('[data-unit]')) !== -1;
        });
        onPage.forEach(function (node) { checked.add(node); });
        var state = refresh();
        var blocking = state.missing.filter(function (node) { return onPage.indexOf(node) !== -1; });
        if (blocking.length) {
          showError('Please answer the highlighted questions before continuing.');
          return false;
        }
        errorBox.hidden = true;
        return true;
      };
      form.addEventListener('pager:change', function () { errorBox.hidden = true; });
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      // A submit before the last page (e.g. Enter pressed somewhere) only means
      // "Next": check this page, never flag questions on later pages.
      if (pager && !pager.isLast()) { pager.goNext(); return; }
      attempted = true;
      var state = refresh();
      errorBox.hidden = true;

      if (!state.complete) {
        // Normally impossible (each page is checked on Next); show the first gap.
        if (pager) pager.goToUnit(state.missing[0]);
        showError('Please answer the highlighted questions before continuing.');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.classList.add('is-busy');
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options.buildPayload(form, state.responses))
      })
        .then(function (resp) {
          return resp.json().catch(function () { return {}; }).then(function (body) {
            return { ok: resp.ok, status: resp.status, body: body };
          });
        })
        .then(function (r) {
          if (r.ok && r.body.next_url) {
            window.location.assign(r.body.next_url);
            return;
          }
          var msg = escapeHtml(r.body.message || ('The server responded with an error (' + r.status + ').'));
          if (Array.isArray(r.body.errors) && r.body.errors.length) {
            msg += '<ul>' + r.body.errors.map(function (e) { return '<li>' + escapeHtml(e) + '</li>'; }).join('') + '</ul>';
          }
          showError(msg);
          submitBtn.disabled = false;
          submitBtn.classList.remove('is-busy');
        })
        .catch(function () {
          showError('Could not reach the server. Please check the connection and try again, or ask the researcher for help.');
          submitBtn.disabled = false;
          submitBtn.classList.remove('is-busy');
        });
    });
  }

  global.SurveyForm = { attach: attach };
})(window);
