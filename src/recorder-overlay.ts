/**
 * recorder-overlay — the in-page capture script.
 *
 * This module exports a single self-contained function source string that is
 * injected into every page/frame at record time via Playwright's
 * `addInitScript`. It runs in the BROWSER context (no Node APIs), listens for
 * user interactions (click / input / change / navigation), and for each one
 * computes a redundant `SelectorBundle`. Captured events are forwarded to Node
 * through a binding the recorder exposes as `window.__flowcastEmit`.
 *
 * Keeping the overlay as a stringified function (rather than a normal import)
 * means it survives serialization across the Node↔browser boundary cleanly and
 * has zero dependency on the bundler's module graph.
 */

/** The shape the overlay emits for each captured interaction. */
export interface CapturedEvent {
  action: "click" | "fill" | "select";
  /** Redundant locator clues for the target element. */
  target: {
    css?: string;
    xpath?: string;
    role?: string;
    name?: string;
    text?: string;
    nthOfType?: number;
    tagName?: string;
  };
  /** For fill/select: the value the user entered/picked. */
  value?: string;
  /** A short human label for logs / the editor. */
  label?: string;
}

/** Name of the page binding the recorder installs to receive events. */
export const EMIT_BINDING = "__flowcastEmit";

/**
 * Returns the overlay source as an IIFE string suitable for
 * `page.addInitScript({ content })`. The function body is intentionally
 * dependency-free and defensive (sites may be hostile to injected scripts).
 */
export function overlayScript(bindingName: string = EMIT_BINDING): string {
  // The function below is stringified and runs in the browser. It is written
  // to be ES2017-safe and never throw into the host page.
  const fn = `(function(){
  "use strict";
  if (window.__flowcastOverlayInstalled) return;
  window.__flowcastOverlayInstalled = true;

  function emit(payload){
    try {
      if (typeof window[${JSON.stringify(bindingName)}] === "function") {
        window[${JSON.stringify(bindingName)}](JSON.stringify(payload));
      }
    } catch (e) { /* never break the host page */ }
  }

  function cssEscape(value){
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }
    return String(value).replace(/([^a-zA-Z0-9_-])/g, "\\\\$1");
  }

  // A short, reasonably-stable CSS path. Prefers #id, then a stable-looking
  // class, then tag + :nth-of-type up the tree (capped depth).
  function cssPath(el){
    if (!el || el.nodeType !== 1) return undefined;
    if (el.id) return "#" + cssEscape(el.id);
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 5) {
      var tag = node.tagName.toLowerCase();
      var sel = tag;
      var stableClass = null;
      if (node.classList && node.classList.length) {
        for (var i = 0; i < node.classList.length; i++) {
          var c = node.classList[i];
          // skip utility/hash-looking classes
          if (/^[a-z][a-z0-9_-]{2,}$/i.test(c) && !/[0-9]{4,}/.test(c)) {
            stableClass = c; break;
          }
        }
      }
      if (stableClass) sel += "." + cssEscape(stableClass);
      var parent = node.parentElement;
      if (parent) {
        var same = [];
        var kids = parent.children;
        for (var j = 0; j < kids.length; j++) {
          if (kids[j].tagName === node.tagName) same.push(kids[j]);
        }
        if (same.length > 1) {
          sel += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
        }
        if (node.id) { parts.unshift(sel); break; }
      }
      parts.unshift(sel);
      node = parent;
      depth++;
    }
    return parts.join(" > ");
  }

  function xpathOf(el){
    if (!el || el.nodeType !== 1) return undefined;
    if (el.id) return '//*[@id="' + el.id + '"]';
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 8) {
      var ix = 1;
      var sib = node.previousElementSibling;
      while (sib) {
        if (sib.tagName === node.tagName) ix++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(node.tagName.toLowerCase() + "[" + ix + "]");
      node = node.parentElement;
      depth++;
    }
    return "/" + parts.join("/");
  }

  function nthOfType(el){
    if (!el || !el.parentElement) return undefined;
    var same = [];
    var kids = el.parentElement.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].tagName === el.tagName) same.push(kids[i]);
    }
    return same.indexOf(el);
  }

  function accName(el){
    var aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria) return aria.trim();
    if (el.labels && el.labels.length) {
      var t = el.labels[0].textContent;
      if (t) return t.trim();
    }
    var ph = el.getAttribute && el.getAttribute("placeholder");
    if (ph) return ph.trim();
    var val = el.value;
    if ((el.tagName === "BUTTON" || el.type === "submit" || el.type === "button") && val) {
      return String(val).trim();
    }
    return undefined;
  }

  function roleOf(el){
    var r = el.getAttribute && el.getAttribute("role");
    if (r) return r;
    var tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      var ty = (el.getAttribute("type") || "text").toLowerCase();
      if (ty === "submit" || ty === "button") return "button";
      if (ty === "checkbox") return "checkbox";
      if (ty === "radio") return "radio";
      return "textbox";
    }
    return undefined;
  }

  function textOf(el){
    var t = (el.innerText || el.textContent || "").trim();
    if (t && t.length <= 80) return t;
    return undefined;
  }

  function bundle(el){
    var b = {};
    var css = cssPath(el); if (css) b.css = css;
    var xp = xpathOf(el); if (xp) b.xpath = xp;
    var role = roleOf(el); if (role) b.role = role;
    var name = accName(el); if (name) b.name = name;
    var text = textOf(el); if (text) b.text = text;
    var n = nthOfType(el); if (n !== undefined) b.nthOfType = n;
    b.tagName = el.tagName.toLowerCase();
    return b;
  }

  function labelFor(el, action){
    var name = accName(el) || textOf(el) || el.tagName.toLowerCase();
    return action + " " + (name || "element");
  }

  document.addEventListener("click", function(ev){
    var el = ev.target;
    if (!el || el.nodeType !== 1) return;
    // climb to a meaningful interactive ancestor if a child was hit
    var node = el;
    var hops = 0;
    while (node && hops < 3 && !/^(a|button|input|select|textarea|label)$/i.test(node.tagName) && !node.getAttribute("role")) {
      node = node.parentElement; hops++;
    }
    node = node || el;
    if (/^(input|textarea|select)$/i.test(node.tagName)) return; // handled by change
    emit({ action: "click", target: bundle(node), label: labelFor(node, "click") });
  }, true);

  document.addEventListener("change", function(ev){
    var el = ev.target;
    if (!el || el.nodeType !== 1) return;
    var tag = el.tagName.toLowerCase();
    if (tag === "select") {
      emit({ action: "select", target: bundle(el), value: el.value, label: labelFor(el, "select") });
    } else if (tag === "input" || tag === "textarea") {
      var ty = (el.getAttribute("type") || "text").toLowerCase();
      if (ty === "password" || ty === "text" || ty === "email" || ty === "search" || ty === "tel" || ty === "url" || ty === "number" || tag === "textarea") {
        emit({ action: "fill", target: bundle(el), value: el.value, label: labelFor(el, "fill") });
      } else if (ty === "checkbox" || ty === "radio") {
        emit({ action: "click", target: bundle(el), label: labelFor(el, "toggle") });
      }
    }
  }, true);
})();`;
  return fn;
}
