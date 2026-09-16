/**
 * Control bar for `sim.html` — every `window.__oaoSim` control as a button, so
 * the add-in can be driven exactly as a user drives Outlook, without Outlook.
 *
 * Plain JS, no imports (same reason as `office-sim.js`), and it must run
 * *before* the pane's module script so `Office` already exists when
 * `waitForOffice()` runs.
 *
 * `?bar=0` hides the bar (used for the state screenshots).
 */
(function () {
  "use strict";

  var sim = window.__oaoSim;
  if (!sim) return;

  function param(name) {
    try {
      return new URLSearchParams(window.location.search).get(name);
    } catch (e) {
      return null;
    }
  }

  if (param("bar") === "0") {
    document.documentElement.setAttribute("data-sim-bar", "hidden");
    return;
  }

  var LOG_MAX = 40;
  var logLines = [];

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (k === "text") node.textContent = attrs[k];
        else if (k === "class") node.className = attrs[k];
        else node.setAttribute(k, attrs[k]);
      }
    }
    (children || []).forEach(function (c) {
      node.appendChild(c);
    });
    return node;
  }

  function button(label, testId, onClick, title) {
    var b = el("button", { type: "button", "data-testid": testId, class: "sim-btn", text: label, title: title || label });
    b.addEventListener("click", function () {
      try {
        onClick();
      } catch (e) {
        pushLog("error: " + (e && e.message ? e.message : String(e)));
      }
      renderState();
    });
    return b;
  }

  function group(label, buttons) {
    return el("div", { class: "sim-group" }, [el("span", { class: "sim-label", text: label })].concat(buttons));
  }

  var stateOut, logOut;

  function renderState() {
    if (!stateOut) return;
    var s = sim.state();
    stateOut.textContent =
      "surface=" + s.surface +
      " · item=" + (s.itemKey || "—") +
      " · handlers ItemChanged=" + s.handlers.ItemChanged +
      "/SelectedItems=" + s.handlers.SelectedItemsChanged +
      " · latency=" + s.latency + "ms" +
      (s.selection.length ? " · selection=" + s.selection.join(",") : "") +
      (s.draftKey ? " · draft=" + s.draftKey : "");
    stateOut.setAttribute("data-surface", s.surface);
    stateOut.setAttribute("data-item", s.itemKey || "");
  }

  function pushLog(line) {
    logLines.push(line);
    if (logLines.length > LOG_MAX) logLines.shift();
    if (logOut) logOut.textContent = logLines.slice(-6).join("\n");
  }

  window.__oaoSimOnCall = function (api, detail) {
    if (api.indexOf("sim.") === 0 || api.indexOf("event:") === 0 || api.indexOf("http.fail") === 0 || api.indexOf("addHandlerAsync") === 0) {
      pushLog(api + (detail ? " " + detail : ""));
    }
  };

  function build() {
    var style = el("style");
    style.textContent = [
      "html[data-sim-bar='hidden'] #oao-sim-bar{display:none}",
      "#oao-sim-bar{position:sticky;top:0;z-index:9999;font:12px/1.4 'Segoe UI',system-ui,sans-serif;",
      "background:#1b1b1f;color:#f3f2f1;padding:8px 10px;display:flex;flex-direction:column;gap:6px;border-bottom:2px solid #0f6cbd}",
      "#oao-sim-bar h2{margin:0;font-size:12px;font-weight:600;color:#9ad1ff;letter-spacing:.04em;text-transform:uppercase}",
      ".sim-group{display:flex;flex-wrap:wrap;gap:4px;align-items:center}",
      ".sim-label{color:#a19f9d;min-width:62px;font-size:11px;text-transform:uppercase;letter-spacing:.03em}",
      ".sim-btn{background:#2d2d32;color:#f3f2f1;border:1px solid #484650;border-radius:4px;padding:3px 8px;cursor:pointer;font:inherit}",
      ".sim-btn:hover{background:#3b3b42}",
      ".sim-btn:focus-visible{outline:2px solid #9ad1ff;outline-offset:1px}",
      "#oao-sim-state{font-family:Consolas,monospace;font-size:11px;color:#c8f1d4;word-break:break-all}",
      "#oao-sim-log{font-family:Consolas,monospace;font-size:10px;color:#a19f9d;white-space:pre-line;min-height:16px}",
    ].join("");

    var items = sim.fixtures().items;
    var openButtons = items.map(function (fx) {
      return button(fx.key, "sim-open-" + fx.key, function () {
        sim.openItem(fx.key);
      }, "Open " + fx.label);
    });

    var bar = el("div", { id: "oao-sim-bar" }, [
      el("h2", { text: "Outlook host simulator" }),
      group("Open", openButtons.concat([
        button("close", "sim-close", function () {
          sim.closeItem();
        }, "Close the opened message (item = null + ItemChanged)"),
        button("reload pane", "sim-reload", function () {
          sim.reloadPane();
        }, "Outlook re-creating the pane iframe"),
        button("open B silently", "sim-open-silent", function () {
          sim.openItem("B", { silent: true });
        }, "Swap the item without raising ItemChanged (non-pinned pane)"),
      ])),
      group("Select", [
        button("select 3", "sim-select-3", function () {
          sim.select(["A", "B", "F"]);
        }),
        button("select 2", "sim-select-2", function () {
          sim.select(["A", "C"]);
        }),
      ]),
      group("Compose", [
        button("draft with issues", "sim-compose-issues", function () {
          sim.compose("issues");
        }),
        button("clean draft", "sim-compose-clean", function () {
          sim.compose("clean");
        }),
        button("add recipient", "sim-compose-recipient", function () {
          sim.composeAddRecipient("external@brokerline-markets.example");
        }),
      ]),
      group("Latency", [
        button("0 ms", "sim-latency-0", function () {
          sim.setLatency(0);
        }),
        button("300 ms", "sim-latency-300", function () {
          sim.setLatency(300);
        }),
        button("1500 ms", "sim-latency-1500", function () {
          sim.setLatency(1500);
        }),
      ]),
      group("Fail next", [
        button("body.getAsync", "sim-fail-body", function () {
          sim.failNext("body.getAsync");
        }),
        button("getSelectedItems", "sim-fail-selection", function () {
          sim.failNext("getSelectedItemsAsync");
        }),
        button("HTTP 500", "sim-fail-500", function () {
          sim.failNextRequest({ status: 500, path: "/api/v1/analyze" });
        }),
        button("backend down", "sim-fail-offline", function () {
          sim.failNextRequest({ status: 0, path: "/api/v1/", times: 99 });
        }),
        button("backend up", "sim-fail-clear", function () {
          sim.failNextRequest({ status: 0, path: "/api/v1/", times: 0 });
        }),
      ]),
      (stateOut = el("div", { id: "oao-sim-state" })),
      (logOut = el("div", { id: "oao-sim-log" })),
    ]);

    document.head.appendChild(style);
    document.body.insertBefore(bar, document.body.firstChild);
    renderState();
    window.setInterval(renderState, 500);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
  else build();
})();
