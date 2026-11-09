/*
 * pager.js — Splits long content into screen-sized pages so no page ever scrolls.
 *
 * Markup (see templates/*.html):
 *
 *   <div class="pager" data-pager>                     root (a bounded flex column)
 *     <div class="pager-body">                          the visible area; never scrolls
 *       <section data-pager-group>                      optional box: shown only while it
 *         <h2>…</h2>                                    contains a visible unit, so its
 *         <p data-unit>…</p>                            heading repeats on every page the
 *         <p data-unit>…</p>                            box continues onto
 *       </section>
 *       <div data-unit>…</div>                          atomic piece of content
 *     </div>
 *     <div class="pager-nav">
 *       <button data-pager-back>  <span data-pager-count>  <button data-pager-next>
 *       <button data-pager-final>  (shown only on the last page, e.g. Submit)
 *     </div>
 *   </div>
 *
 * data-pager-break on a unit, or on an element containing units, starts a new
 * page there even if it would fit on the current one (one topic per page).
 *
 * data-pager-reserve on a hidden element inside a unit (e.g. the "Please
 * describe" box that a "Prefer to self-describe" answer reveals) keeps room for
 * it when pages are laid out, so revealing it later never pushes the question
 * onto another page.
 *
 * Units are packed greedily, in document order, into pages that fit the body
 * at the current window size. Nothing is cloned or moved, so form controls keep
 * their state and every unit appears exactly once. Pages are rebuilt when the
 * window is resized or a unit changes size (e.g. a revealed text box), keeping
 * the participant on the page that holds the unit they were looking at. If a
 * single unit is taller than the screen, the root font size is reduced step by
 * step so it still fits instead of being clipped.
 *
 * API:  Pager.of(root) → instance, with
 *         .beforeNext = (unitsOnPage) => boolean   veto leaving the page (validation)
 *         .goToUnit(el)                            show the page containing el
 *         .units(), .pageIndex, .pageCount
 *       root dispatches 'pager:change' (detail {index, count}) after every page change.
 *       data-pager-nav="always" keeps the nav bar visible on single-page content.
 */
(function (global) {
  'use strict';

  var MIN_ROOT_FONT_PX = 12;
  var instances = new WeakMap();

  function Pager(root) {
    this.root = root;
    this.body = root.querySelector('.pager-body');
    this.nav = root.querySelector('.pager-nav');
    this.unitList = Array.prototype.slice.call(this.body.querySelectorAll('[data-unit]'));
    this.boxes = Array.prototype.slice.call(this.body.querySelectorAll('[data-pager-group]'));
    this.back = this.nav && this.nav.querySelector('[data-pager-back]');
    this.next = this.nav && this.nav.querySelector('[data-pager-next]');
    this.count = this.nav && this.nav.querySelector('[data-pager-count]');
    this.finals = this.nav ? Array.prototype.slice.call(this.nav.querySelectorAll('[data-pager-final]')) : [];
    this.navAlways = root.getAttribute('data-pager-nav') === 'always';
    this.pages = [[]];
    this.pageIndex = 0;
    this.beforeNext = null;
    this.busy = false;
    this.body.setAttribute('tabindex', '-1');

    var self = this;
    if (this.back) this.back.addEventListener('click', function () { self.go(self.pageIndex - 1); });
    if (this.next) this.next.addEventListener('click', function () { self.goNext(); });

    // Enter in a form field (text box, radio button, checkbox, list) acts like
    // "Next" until the last page. Without this the browser treats Enter as
    // submitting the whole form, which flags every unanswered question red,
    // including those on pages not reached yet. Buttons, links and multi-line
    // text boxes keep their usual Enter behaviour.
    root.addEventListener('keydown', function (ev) {
      var t = ev.target;
      if (ev.key !== 'Enter' || ev.isComposing || self.isLast()) return;
      var field = (t.tagName === 'INPUT' && !/^(submit|button|reset|image)$/.test(t.type)) ||
                  t.tagName === 'SELECT';
      if (field) {
        ev.preventDefault();
        self.goNext();
      }
    });

    var resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        document.documentElement.style.fontSize = '';   // a larger window may not need the reduced font
        self.paginate(self.anchor());
      }, 150);
    });
    // Re-check whenever content may have changed height. ResizeObserver covers
    // layout changes but is only delivered while the page is being rendered;
    // the MutationObserver also catches content being shown, hidden or replaced
    // while the window is in the background (e.g. the sound check appearing).
    var pending = false;
    var schedule = function () {
      if (self.busy || pending) return;
      pending = true;
      setTimeout(function () { pending = false; self.check(); }, 0);
    };
    if ('ResizeObserver' in global) {
      this.observer = new ResizeObserver(schedule);
      this.unitList.forEach(function (u) { self.observer.observe(u); });
      this.observer.observe(this.body);
    }
    if ('MutationObserver' in global) {
      this.mutations = new MutationObserver(schedule);
      this.mutations.observe(this.body, {
        subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ['hidden', 'class', 'style'],
      });
    }
    // Web fonts or late layout can change heights after first paint.
    window.addEventListener('load', function () { self.paginate(self.anchor()); });

    this.paginate(null);
  }

  Pager.prototype.fits = function () {
    return this.body.scrollHeight <= this.body.clientHeight + 1;
  };

  /**
   * True if `unit` must open a new page: it carries data-pager-break itself,
   * or it is the first unit inside an element that does (e.g. a topic section).
   */
  Pager.prototype.startsPage = function (unit) {
    if (unit.hasAttribute('data-pager-break')) return true;
    var box = unit.parentElement && unit.parentElement.closest('[data-pager-break]');
    return !!box && this.body.contains(box) && box.querySelector('[data-unit]') === unit;
  };

  Pager.prototype.units = function () { return this.pages[this.pageIndex] || []; };
  Pager.prototype.isLast = function () { return this.pageIndex >= this.pages.length - 1; };
  Pager.prototype.anchor = function () { return this.units()[0] || null; };

  /** Show a box only while it contains a visible unit. */
  Pager.prototype.syncBoxes = function () {
    this.boxes.forEach(function (box) {
      box.classList.toggle('pager-off', !box.querySelector('[data-unit]:not(.pager-off)'));
    });
  };

  Pager.prototype.setVisible = function (units) {
    this.unitList.forEach(function (u) { u.classList.add('pager-off'); });
    units.forEach(function (u) { u.classList.remove('pager-off'); });
    this.syncBoxes();
  };

  /** Rebuild the pages for the current size; stay on the page holding `anchor`. */
  Pager.prototype.paginate = function (anchor) {
    if (!this.unitList.length) return;
    this.busy = true;
    // Measure with every nav control visible, so the last page (which may show
    // extra buttons) is never taller than the space that was measured.
    if (this.nav) { this.nav.hidden = false; this.nav.classList.add('pager-measuring'); }

    var self = this;
    var pages = [];
    var tooTall = false;
    var cur = [];
    this.unitList.forEach(function (u) { u.style.zoom = ''; });
    var reserved = this.reserve();
    this.setVisible([]);
    this.unitList.forEach(function (u) {
      if (cur.length && self.startsPage(u)) {
        cur.forEach(function (c) { c.classList.add('pager-off'); });
        pages.push(cur);
        cur = [];
      }
      u.classList.remove('pager-off');
      self.syncBoxes();
      if (!self.fits() && cur.length) {
        cur.forEach(function (c) { c.classList.add('pager-off'); });
        self.syncBoxes();
        pages.push(cur);
        cur = [];
      }
      cur.push(u);
      if (cur.length === 1 && !self.fits()) tooTall = true;
    });
    if (cur.length) pages.push(cur);

    if (tooTall) {
      var html = document.documentElement;
      var size = parseFloat(getComputedStyle(html).fontSize) || 16;
      if (size > MIN_ROOT_FONT_PX) {
        html.style.fontSize = (size - 1) + 'px';
        this.unreserve(reserved);
        this.busy = false;
        return this.paginate(anchor);
      }
    }

    this.pages = pages;
    if (tooTall) this.zoomOversized();
    this.unreserve(reserved);
    if (this.nav) this.nav.classList.remove('pager-measuring');
    var index = 0;
    if (anchor) {
      pages.forEach(function (p, i) { if (p.indexOf(anchor) !== -1) index = i; });
    }
    this.show(index, false);
    this.size = this.bodySize();
    this.busy = false;
  };

  /** Show hidden [data-pager-reserve] elements, invisibly, so they are measured. */
  Pager.prototype.reserve = function () {
    var list = Array.prototype.filter.call(
      this.body.querySelectorAll('[data-pager-reserve]'), function (el) { return el.hidden; });
    list.forEach(function (el) { el.hidden = false; el.style.visibility = 'hidden'; });
    return list;
  };

  Pager.prototype.unreserve = function (list) {
    list.forEach(function (el) { el.hidden = true; el.style.visibility = ''; });
  };

  /**
   * Last resort, at the minimum font size: a unit that still cannot fit on a
   * page of its own is zoomed out until it does, so it is shown whole instead
   * of being clipped (there is no scrolling to fall back on).
   */
  Pager.prototype.zoomOversized = function () {
    var self = this;
    this.pages.forEach(function (page) {
      if (page.length !== 1) return;
      var unit = page[0];
      self.setVisible(page);
      if (self.fits()) return;
      // Largest zoom that fits, by bisection: zooming out can re-flow the unit
      // (e.g. more columns), so the needed zoom is not simply height ratio.
      var lo = 0.3, hi = 1, best = lo;
      for (var i = 0; i < 8; i++) {
        var mid = (lo + hi) / 2;
        unit.style.zoom = String(mid);
        if (self.fits()) { best = mid; lo = mid; } else { hi = mid; }
      }
      unit.style.zoom = String(Math.floor(best * 100) / 100);
      if (!self.fits()) console.warn('pager: content does not fit even when zoomed out', unit);
    });
  };

  Pager.prototype.bodySize = function () {
    return this.body.clientWidth + 'x' + this.body.clientHeight;
  };

  /**
   * Called when content or the visible area may have changed. A different
   * visible area (window resized, rotated, zoomed) rebuilds every page at the
   * normal font size; otherwise pages are rebuilt only if the current one overflows.
   */
  Pager.prototype.check = function () {
    if (this.size && this.bodySize() !== this.size) {
      document.documentElement.style.fontSize = '';
      this.paginate(this.anchor());
    } else if (!this.fits()) {
      this.paginate(this.anchor());
    }
  };

  Pager.prototype.show = function (index, focus) {
    index = Math.max(0, Math.min(index, this.pages.length - 1));
    this.pageIndex = index;
    this.setVisible(this.pages[index]);
    var last = this.isLast();
    var single = this.pages.length === 1;
    if (this.back) this.back.hidden = index === 0;
    if (this.next) this.next.hidden = last;
    this.finals.forEach(function (f) { f.hidden = !last; });
    if (this.count) {
      this.count.textContent = single ? '' : 'Page ' + (index + 1) + ' of ' + this.pages.length;
    }
    if (this.nav && !this.navAlways) this.nav.hidden = single && !this.finals.length;
    this.body.scrollTop = 0;
    if (focus) this.body.focus({ preventScroll: true });
    this.root.dispatchEvent(new CustomEvent('pager:change', {
      detail: { index: index, count: this.pages.length },
    }));
  };

  Pager.prototype.go = function (index) {
    if (index === this.pageIndex) return;
    this.show(index, true);
  };

  Pager.prototype.goNext = function () {
    if (this.isLast()) return;
    if (this.beforeNext && this.beforeNext(this.units()) === false) return;
    this.go(this.pageIndex + 1);
  };

  Pager.prototype.goToUnit = function (el) {
    var unit = el && el.closest('[data-unit]');
    for (var i = 0; i < this.pages.length; i++) {
      if (this.pages[i].indexOf(unit) !== -1) { this.go(i); return; }
    }
  };

  Object.defineProperty(Pager.prototype, 'pageCount', { get: function () { return this.pages.length; } });

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-pager]'), function (root) {
      if (!instances.has(root)) instances.set(root, new Pager(root));
    });
  }

  global.Pager = {
    of: function (root) {
      if (!instances.has(root)) instances.set(root, new Pager(root));
      return instances.get(root);
    },
    init: init,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
