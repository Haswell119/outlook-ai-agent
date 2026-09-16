/**
 * Office.js **host simulator** — Outlook on the web, faked faithfully enough to
 * hunt bugs with.
 *
 * Why this exists: every bug the pane has when the user switches messages lives
 * in the *behaviour* of the host, not in its API surface. A mock that just
 * answers `getAsync` cannot reproduce "I opened an email, closed it, opened
 * another one and the pane is stuck on the previous one". So this simulator
 * copies the behaviour that matters:
 *
 *  - `Office.context.mailbox.item` is swapped **in place** when the selection
 *    changes, and `ItemChanged` is raised *only* when the add-in has registered
 *    a handler — exactly like a pinned pane in OWA. Registering the handler late
 *    (or on a host without Mailbox 1.5) means the swap happens silently, which
 *    is how a pane ends up showing the previous message.
 *  - closing a message sets `item` to `null` and raises `ItemChanged` with no
 *    item, so `hasSelectedItem()` and `getSelectedItemsAsync` disagree for a few
 *    milliseconds, as they do in the real host.
 *  - `reloadPane()` re-creates the iframe (`location.reload()`), keeping the
 *    chosen item in `sessionStorage` — what OWA does for a non-pinned pane.
 *  - every asynchronous API answers through `setTimeout` with a realistic
 *    latency (`body.getAsync` is the slow one), so mid-flight item switches are
 *    reproducible instead of theoretical.
 *  - `OfficeRuntime.auth.getAccessToken` rejects with error 13000, like a
 *    sideloaded dev manifest with no `WebApplicationInfo`.
 *
 * Plain ES5-compatible JavaScript with no imports: loaded verbatim by
 * `sim.html` and injectable with `page.addInitScript({ path })`.
 *
 * Controls (`window.__oaoSim`):
 *   openItem(key, { silent })   select/open a message (silent = no ItemChanged)
 *   closeItem()                 close it (item = null + ItemChanged)
 *   reloadPane()                re-create the pane, keeping the chosen item
 *   select(keys[])              multi-select several messages
 *   compose(draftKey)           switch to the compose surface
 *   setLatency(ms)              base latency of every async Office call
 *   failNext(api)               make the next call to `api` fail
 *   failNextRequest(opts)       make the next matching HTTP call fail
 *   setEventSupport(map)        pretend a requirement set is missing
 *   state()                     what the host currently holds
 */
(function () {
  "use strict";

  var STORE_KEY = "oao.sim.state.v1";
  var DEFAULT_LATENCY = 40;

  function fixtures() {
    return window.__oaoSimFixtures;
  }

  function queryParam(name) {
    try {
      return new URLSearchParams(window.location.search).get(name);
    } catch (e) {
      return null;
    }
  }

  /**
   * Which mailbox the host says it is.
   *
   * `?user=<address>` overrides it, which is how a test asks for a *cold* path:
   * the orchestrator caches analyses per user, so re-analysing the same email as
   * the same person is served from its content cache (`source: "cache"`). A
   * mailbox nobody has analysed before is the only honest way to prove that the
   * model really is called (`source: "llm"`).
   */
  function userProfile() {
    var base = fixtures() ? fixtures().userProfile : { displayName: "", emailAddress: "" };
    var override = queryParam("user");
    if (!override) return base;
    return {
      displayName: base.displayName,
      emailAddress: override,
      timeZone: base.timeZone,
      accountType: base.accountType,
    };
  }

  /* ------------------------------------------------------------------ */
  /* persisted host state (survives `location.reload()`, like OWA)      */
  /* ------------------------------------------------------------------ */

  function readStored() {
    try {
      var raw = window.sessionStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeStored(state) {
    try {
      window.sessionStorage.setItem(
        STORE_KEY,
        JSON.stringify({ surface: state.surface, itemKey: state.itemKey, selection: state.selection, draftKey: state.draftKey, latency: state.latency }),
      );
    } catch (e) {
      /* private mode: the simulator still works, it just forgets on reload */
    }
  }

  var state = {
    /** "read" | "none" | "selection" | "compose" */
    surface: "read",
    itemKey: "A",
    selection: [],
    draftKey: "issues",
    latency: DEFAULT_LATENCY,
    /** one-shot failures, keyed by api name */
    fail: {},
    /** requirement sets the host pretends not to have */
    unsupported: {},
    /** handlers registered through `mailbox.addHandlerAsync` */
    handlers: { ItemChanged: [], SelectedItemsChanged: [] },
    /** handlers registered on the compose item */
    itemHandlers: { RecipientsChanged: [], AttachmentsChanged: [] },
    /** notification messages currently shown on the item */
    notifications: {},
    /** every host call, for assertions and for the sim page log */
    calls: [],
  };

  var stored = readStored();
  if (stored) {
    if (stored.surface) state.surface = stored.surface;
    if (typeof stored.itemKey === "string") state.itemKey = stored.itemKey;
    if (stored.selection) state.selection = stored.selection;
    if (stored.draftKey) state.draftKey = stored.draftKey;
    if (typeof stored.latency === "number") state.latency = stored.latency;
  }

  function log(api, detail) {
    state.calls.push({ api: api, detail: detail, at: Date.now() });
    if (state.calls.length > 400) state.calls.shift();
    if (window.__oaoSimOnCall) {
      try {
        window.__oaoSimOnCall(api, detail);
      } catch (e) {
        /* the log must never break the host */
      }
    }
  }

  /** True (and consumed) when `failNext(api)` armed this call. */
  function shouldFail(api) {
    if (!state.fail[api]) return false;
    state.fail[api] -= 1;
    if (state.fail[api] <= 0) delete state.fail[api];
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* AsyncResult plumbing                                               */
  /* ------------------------------------------------------------------ */

  function succeeded(value) {
    return { status: "succeeded", value: value, error: undefined, asyncContext: undefined };
  }

  function failed(message, code) {
    return { status: "failed", value: undefined, error: { name: "OfficeError", message: message, code: code || 5001 }, asyncContext: undefined };
  }

  /** Answer a callback asynchronously, like the real host always does. */
  function deliver(api, cb, produce, extraMs) {
    log(api);
    var ms = state.latency + (extraMs || 0);
    window.setTimeout(function () {
      if (typeof cb !== "function") return;
      if (shouldFail(api)) {
        cb(failed("Simulated failure of " + api, 9000));
        return;
      }
      var result;
      try {
        result = succeeded(produce());
      } catch (e) {
        result = failed(e && e.message ? e.message : String(e));
      }
      cb(result);
    }, ms);
  }

  /* ------------------------------------------------------------------ */
  /* items                                                              */
  /* ------------------------------------------------------------------ */

  function fixtureFor(key) {
    var f = fixtures();
    return f ? f.byKey(key) : undefined;
  }

  function addressDetails(a) {
    return { displayName: a.displayName, emailAddress: a.emailAddress, appointmentResponse: undefined, recipientType: "user" };
  }

  /**
   * A read item, built fresh for each selection so that a pane holding on to the
   * previous object reads stale data — exactly the failure mode we are hunting.
   */
  function makeReadItem(fx) {
    var categories = fx.categories.slice();
    var item = {
      itemType: "message",
      itemId: fx.itemId,
      conversationId: fx.conversationId,
      internetMessageId: fx.internetMessageId,
      subject: fx.subject,
      normalizedSubject: fx.subject.replace(/^((re|tr|fw|fwd)\s*:\s*)+/i, ""),
      importance: fx.importance,
      from: addressDetails(fx.from),
      sender: addressDetails(fx.from),
      to: fx.to.map(addressDetails),
      cc: fx.cc.map(addressDetails),
      bcc: [],
      dateTimeCreated: new Date(fx.dateTimeCreated),
      dateTimeModified: new Date(fx.dateTimeCreated),
      attachments: fx.attachments.map(function (a) {
        return { id: a.id, name: a.name, size: a.size, contentType: a.contentType, attachmentType: "file", isInline: !!a.isInline };
      }),
      body: {
        getAsync: function (coercionType, optionsOrCb, maybeCb) {
          var cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
          // A body read is the slow call in OWA (round trip to the store).
          deliver("body.getAsync", cb, function () {
            return coercionType === "html" ? "<div>" + fx.body.replace(/\n/g, "<br/>") + "</div>" : fx.body;
          }, 120);
        },
      },
      categories: {
        getAsync: function (cb) {
          deliver("categories.getAsync", cb, function () {
            return categories.map(function (c) {
              return { displayName: c, color: "Preset0" };
            });
          });
        },
        addAsync: function (names, cb) {
          deliver("categories.addAsync", cb, function () {
            for (var i = 0; i < names.length; i++) if (categories.indexOf(names[i]) < 0) categories.push(names[i]);
            return undefined;
          });
        },
        removeAsync: function (names, cb) {
          deliver("categories.removeAsync", cb, function () {
            categories = categories.filter(function (c) {
              return names.indexOf(c) < 0;
            });
            return undefined;
          });
        },
      },
      notificationMessages: notificationMessages(),
      displayReplyForm: function (options) {
        log("displayReplyForm", typeof options === "string" ? options.slice(0, 80) : (options && options.htmlBody ? String(options.htmlBody).slice(0, 80) : ""));
        state.lastReply = options;
      },
      displayReplyAllForm: function (options) {
        log("displayReplyAllForm");
        state.lastReply = options;
      },
      getAttachmentContentAsync: function (id, cb) {
        deliver("getAttachmentContentAsync", cb, function () {
          return { format: "base64", content: "" };
        });
      },
      addHandlerAsync: function (type, handler, cb) {
        deliver("item.addHandlerAsync", cb, function () {
          return undefined;
        });
      },
      removeHandlerAsync: function (type, cb) {
        deliver("item.removeHandlerAsync", cb, function () {
          return undefined;
        });
      },
    };
    return item;
  }

  function notificationMessages() {
    return {
      addAsync: function (key, message, cb) {
        deliver("notificationMessages.addAsync", cb, function () {
          state.notifications[key] = message;
          return undefined;
        });
      },
      replaceAsync: function (key, message, cb) {
        deliver("notificationMessages.replaceAsync", cb, function () {
          state.notifications[key] = message;
          return undefined;
        });
      },
      removeAsync: function (key, cb) {
        deliver("notificationMessages.removeAsync", cb, function () {
          delete state.notifications[key];
          return undefined;
        });
      },
      getAllAsync: function (cb) {
        deliver("notificationMessages.getAllAsync", cb, function () {
          return Object.keys(state.notifications).map(function (k) {
            var m = state.notifications[k];
            return { key: k, type: m.type, message: m.message, icon: m.icon, persistent: m.persistent };
          });
        });
      },
    };
  }

  /** A compose (draft) item: every field is an accessor, as in the real host. */
  function makeComposeItem(draft) {
    var to = draft.to.slice();
    var cc = draft.cc.slice();
    var bcc = draft.bcc.slice();
    var subject = draft.subject;
    var body = draft.body;
    var attachments = draft.attachments.slice();
    var label = draft.sensitivityLabelId || null;

    function recipients(list, name) {
      return {
        getAsync: function (optionsOrCb, maybeCb) {
          var cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
          deliver(name + ".getAsync", cb, function () {
            return list().map(addressDetails);
          });
        },
        setAsync: function (value, optionsOrCb, maybeCb) {
          var cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
          deliver(name + ".setAsync", cb, function () {
            return undefined;
          });
        },
        addAsync: function (value, optionsOrCb, maybeCb) {
          var cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
          deliver(name + ".addAsync", cb, function () {
            return undefined;
          });
        },
      };
    }

    var item = {
      itemType: "message",
      itemId: draft.itemId,
      conversationId: undefined,
      to: recipients(function () {
        return to;
      }, "to"),
      cc: recipients(function () {
        return cc;
      }, "cc"),
      bcc: recipients(function () {
        return bcc;
      }, "bcc"),
      subject: {
        getAsync: function (optionsOrCb, maybeCb) {
          var cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
          deliver("subject.getAsync", cb, function () {
            return subject;
          });
        },
        setAsync: function (value, optionsOrCb, maybeCb) {
          var cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
          subject = value;
          deliver("subject.setAsync", cb, function () {
            return undefined;
          });
        },
      },
      body: {
        getAsync: function (coercionType, optionsOrCb, maybeCb) {
          var cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
          deliver("body.getAsync", cb, function () {
            return body;
          }, 120);
        },
        setSelectedDataAsync: function (data, optionsOrCb, maybeCb) {
          var cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
          deliver("body.setSelectedDataAsync", cb, function () {
            return undefined;
          });
        },
      },
      from: {
        getAsync: function (optionsOrCb, maybeCb) {
          var cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
          deliver("from.getAsync", cb, function () {
            return addressDetails(draft.from);
          });
        },
      },
      getAttachmentsAsync: function (optionsOrCb, maybeCb) {
        var cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
        deliver("getAttachmentsAsync", cb, function () {
          return attachments.map(function (a) {
            return { id: a.id, name: a.name, size: a.size, attachmentType: "file", isInline: !!a.isInline };
          });
        });
      },
      removeAttachmentAsync: function (id, optionsOrCb, maybeCb) {
        var cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
        deliver("removeAttachmentAsync", cb, function () {
          attachments = attachments.filter(function (a) {
            return a.id !== id;
          });
          fireItemEvent("AttachmentsChanged");
          return undefined;
        });
      },
      addFileAttachmentAsync: function (uri, name, optionsOrCb, maybeCb) {
        var cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
        deliver("addFileAttachmentAsync", cb, function () {
          return undefined;
        });
      },
      /**
       * Mailbox 1.13 + IRM. The accessor hands out the catalogue **id**, not the
       * display name — which is exactly why the pane has to resolve it through
       * `Office.context.sensitivityLabelsCatalog`.
       */
      sensitivityLabel: {
        getAsync: function (optionsOrCb, maybeCb) {
          var cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
          deliver("sensitivityLabel.getAsync", cb, function () {
            return label;
          });
        },
        setAsync: function (id, optionsOrCb, maybeCb) {
          var cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
          deliver("sensitivityLabel.setAsync", cb, function () {
            label = id;
            return undefined;
          });
        },
      },
      notificationMessages: notificationMessages(),
      addHandlerAsync: function (type, handler, cb) {
        var name = String(type);
        if (!state.itemHandlers[name]) state.itemHandlers[name] = [];
        state.itemHandlers[name].push(handler);
        deliver("item.addHandlerAsync:" + name, cb, function () {
          return undefined;
        });
      },
      removeHandlerAsync: function (type, cb) {
        var name = String(type);
        state.itemHandlers[name] = [];
        deliver("item.removeHandlerAsync:" + name, cb, function () {
          return undefined;
        });
      },
      /** Test seam so the sim page can mutate the draft and fire the event. */
      __setRecipients: function (next) {
        to = next;
        fireItemEvent("RecipientsChanged");
      },
    };
    return item;
  }

  function fireItemEvent(name) {
    var list = (state.itemHandlers[name] || []).slice();
    log("event:" + name, String(list.length));
    for (var i = 0; i < list.length; i++) {
      try {
        list[i]({ type: name });
      } catch (e) {
        /* a broken handler must not stop the host */
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* the Office global                                                  */
  /* ------------------------------------------------------------------ */

  /** Matches the orchestrator's default `requiredClassificationLabels`. */
  var LABEL_CATALOG = [
    { id: "lbl-public", name: "Public" },
    { id: "lbl-internal", name: "Internal" },
    { id: "lbl-confidential", name: "Confidential" },
    { id: "lbl-highly-confidential", name: "Highly Confidential" },
  ];

  var REQUIREMENTS = {
    // What Outlook on the web reports in 2026.
    mailbox: ["1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7", "1.8", "1.9", "1.10", "1.11", "1.12", "1.13", "1.14", "1.15"],
    identityapi: ["1.3"],
  };

  function isSetSupported(name, version) {
    var key = String(name || "").toLowerCase();
    if (state.unsupported[name] && (state.unsupported[name] === true || state.unsupported[name] === version)) return false;
    if (state.unsupported[key + ":" + version]) return false;
    var list = REQUIREMENTS[key];
    if (!list) return false;
    if (!version) return true;
    return list.indexOf(String(version)) >= 0;
  }

  function currentItem() {
    if (state.surface === "compose") {
      if (!state.composeItem) state.composeItem = makeComposeItem(fixtures().drafts[state.draftKey] || fixtures().drafts.issues);
      return state.composeItem;
    }
    if (state.surface !== "read") return null;
    var fx = fixtureFor(state.itemKey);
    if (!fx) return null;
    if (!state.readItem || state.readItemKey !== fx.key) {
      state.readItem = makeReadItem(fx);
      state.readItemKey = fx.key;
    }
    return state.readItem;
  }

  function selectedRefs() {
    if (state.surface === "selection") {
      return state.selection
        .map(function (k) {
          return fixtureFor(k);
        })
        .filter(Boolean)
        .map(function (fx) {
          return {
            itemId: fx.itemId,
            conversationId: fx.conversationId,
            internetMessageId: fx.internetMessageId,
            subject: fx.subject,
            itemType: "message",
            itemMode: "read",
          };
        });
    }
    if (state.surface === "read") {
      var fx = fixtureFor(state.itemKey);
      return fx ? [{ itemId: fx.itemId, conversationId: fx.conversationId, subject: fx.subject, itemType: "message", itemMode: "read" }] : [];
    }
    return [];
  }

  var mailbox = {
    ewsUrl: "https://outlook.office365.com/EWS/Exchange.asmx",
    restUrl: "https://outlook.office.com/api",
    diagnostics: { hostName: "OutlookWebApp", hostVersion: "16.0.0000.0000", OWAView: "ThreeColumns" },
    userProfile: userProfile(),
    masterCategories: {
      getAsync: function (cb) {
        deliver("masterCategories.getAsync", cb, function () {
          return [{ displayName: "Atlas", color: "Preset0" }];
        });
      },
      addAsync: function (categories, cb) {
        deliver("masterCategories.addAsync", cb, function () {
          return undefined;
        });
      },
    },
    /** Outlook on the web already hands out REST ids: the conversion is a no-op. */
    convertToRestId: function (itemId, version) {
      log("convertToRestId", version);
      if (!itemId) throw new Error("convertToRestId: itemId is required");
      return itemId;
    },
    convertToEwsId: function (itemId) {
      return itemId;
    },
    addHandlerAsync: function (type, handler, optionsOrCb, maybeCb) {
      var cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
      var name = String(type);
      if (!isSetSupported("Mailbox", name === "olkItemSelectedChanged" ? "1.13" : "1.5")) {
        log("addHandlerAsync:refused", name);
        if (typeof cb === "function") window.setTimeout(function () {
          cb(failed("The requirement set for " + name + " is not supported", 9010));
        }, state.latency);
        return;
      }
      if (!state.handlers[name]) state.handlers[name] = [];
      state.handlers[name].push(handler);
      deliver("addHandlerAsync:" + name, cb, function () {
        return undefined;
      });
    },
    removeHandlerAsync: function (type, optionsOrCb, maybeCb) {
      var cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
      var name = String(type);
      state.handlers[name] = [];
      deliver("removeHandlerAsync:" + name, cb, function () {
        return undefined;
      });
    },
    getSelectedItemsAsync: function (optionsOrCb, maybeCb) {
      var cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
      deliver("getSelectedItemsAsync", cb, selectedRefs, 20);
    },
    loadItemByIdAsync: function (itemId, optionsOrCb, maybeCb) {
      var cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
      deliver("loadItemByIdAsync", cb, function () {
        var fx = fixtureFor(itemId);
        if (!fx) throw new Error("Item not found: " + itemId);
        return makeReadItem(fx);
      }, 60);
    },
    displayMessageForm: function (itemId) {
      log("displayMessageForm", itemId);
      state.lastDisplayed = itemId;
    },
    displayNewAppointmentForm: function (parameters) {
      log("displayNewAppointmentForm", parameters && parameters.subject);
      state.lastAppointment = parameters;
    },
    displayNewMessageForm: function (parameters) {
      log("displayNewMessageForm");
      state.lastNewMessage = parameters;
    },
    getCallbackTokenAsync: function (optionsOrCb, maybeCb) {
      var cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
      deliver("getCallbackTokenAsync", cb, function () {
        throw new Error("Callback tokens are not available in this simulator");
      });
    },
  };

  Object.defineProperty(mailbox, "item", {
    configurable: true,
    enumerable: true,
    get: function () {
      return currentItem();
    },
  });

  var Office = {
    // `onReady` resolves immediately; callers also get the promise form.
    onReady: function (callback) {
      var info = { host: "Outlook", platform: "OfficeOnline" };
      log("onReady");
      var promise = new Promise(function (resolve) {
        window.setTimeout(function () {
          if (typeof callback === "function") {
            try {
              callback(info);
            } catch (e) {
              /* ignore */
            }
          }
          resolve(info);
        }, 0);
      });
      return promise;
    },
    initialize: function () {},
    context: {
      host: "Outlook",
      platform: "OfficeOnline",
      diagnostics: { host: "Outlook", platform: "OfficeOnline", version: "16.0.0000.0000" },
      displayLanguage: "fr-FR",
      contentLanguage: "fr-FR",
      touchEnabled: false,
      officeTheme: {
        bodyBackgroundColor: "#ffffff",
        bodyForegroundColor: "#242424",
        controlBackgroundColor: "#faf9f8",
        controlForegroundColor: "#242424",
      },
      requirements: { isSetSupported: isSetSupported },
      /** Sensitivity-label catalogue (Mailbox 1.13): id ↔ display name. */
      sensitivityLabelsCatalog: {
        getIsEnabledAsync: function (cb) {
          deliver("sensitivityLabelsCatalog.getIsEnabledAsync", cb, function () {
            return true;
          });
        },
        getAsync: function (cb) {
          deliver("sensitivityLabelsCatalog.getAsync", cb, function () {
            return LABEL_CATALOG;
          });
        },
      },
      mailbox: mailbox,
      ui: {
        closeContainer: function () {
          log("ui.closeContainer");
          state.closed = true;
        },
        displayDialogAsync: function (url, optionsOrCb, maybeCb) {
          var cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
          deliver("ui.displayDialogAsync", cb, function () {
            throw new Error("Dialogs are not simulated");
          });
        },
      },
      roamingSettings: (function () {
        var bag = {};
        return {
          get: function (key) {
            return bag[key];
          },
          set: function (key, value) {
            bag[key] = value;
          },
          remove: function (key) {
            delete bag[key];
          },
          saveAsync: function (cb) {
            deliver("roamingSettings.saveAsync", cb, function () {
              return undefined;
            });
          },
        };
      })(),
    },
    AsyncResultStatus: { Succeeded: "succeeded", Failed: "failed" },
    CoercionType: { Text: "text", Html: "html" },
    EventType: {
      ItemChanged: "olkItemSelectedChanged",
      SelectedItemsChanged: "olkSelectedItemsChanged",
      RecipientsChanged: "olkRecipientsChanged",
      AttachmentsChanged: "olkAttachmentsChanged",
      AppointmentTimeChanged: "olkAppointmentTimeChanged",
      EnhancedLocationsChanged: "olkEnhancedLocationsChanged",
      RecurrenceChanged: "olkRecurrenceChanged",
      InfobarClicked: "olkInfobarClicked",
    },
    MailboxEnums: {
      RestVersion: { v1_0: "v1.0", v2_0: "v2.0", Beta: "beta" },
      ItemType: { Message: "message", Appointment: "appointment" },
      CategoryColor: (function () {
        var out = {};
        for (var i = 0; i <= 24; i++) out["Preset" + i] = "Preset" + i;
        out.None = "None";
        return out;
      })(),
      ItemNotificationMessageType: {
        ProgressIndicator: "progressIndicator",
        InformationalMessage: "informationalMessage",
        ErrorMessage: "errorMessage",
        InsightMessage: "insightMessage",
      },
      RecipientType: { User: "user", DistributionList: "distributionList", ExternalUser: "externalUser", Other: "other" },
      AttachmentType: { File: "file", Item: "item", Cloud: "cloud" },
    },
    HostType: { Outlook: "Outlook" },
    PlatformType: { OfficeOnline: "OfficeOnline" },
  };

  /**
   * `OfficeRuntime.auth.getAccessToken` on a dev host that has no
   * `WebApplicationInfo` in its manifest: error 13000, "SSO is not supported".
   * The pane must fall back to dev headers rather than break.
   */
  var OfficeRuntime = {
    auth: {
      getAccessToken: function () {
        log("auth.getAccessToken");
        return new Promise(function (_resolve, reject) {
          window.setTimeout(function () {
            var err = new Error("SSO is not supported for this add-in (no WebApplicationInfo in the manifest).");
            err.code = 13000;
            err.name = "OfficeRuntimeError";
            reject(err);
          }, state.latency);
        });
      },
    },
    storage: (function () {
      return {
        getItem: function (key) {
          return Promise.resolve(window.localStorage.getItem("oao.rt." + key));
        },
        setItem: function (key, value) {
          window.localStorage.setItem("oao.rt." + key, value);
          return Promise.resolve();
        },
        removeItem: function (key) {
          window.localStorage.removeItem("oao.rt." + key);
          return Promise.resolve();
        },
      };
    })(),
  };

  /* ------------------------------------------------------------------ */
  /* the host events                                                    */
  /* ------------------------------------------------------------------ */

  function fireMailboxEvent(name) {
    var type = Office.EventType[name];
    var list = (state.handlers[type] || []).slice();
    log("event:" + name, String(list.length));
    for (var i = 0; i < list.length; i++) {
      try {
        list[i]({ type: type });
      } catch (e) {
        /* ignore */
      }
    }
    return list.length;
  }

  /* ------------------------------------------------------------------ */
  /* controls                                                           */
  /* ------------------------------------------------------------------ */

  var sim = {
    fixtures: function () {
      return fixtures();
    },
    /**
     * Select (open) a message. `silent: true` swaps `mailbox.item` **without**
     * raising `ItemChanged` — what happens when the pane is not pinned, or when
     * it registered its handler after the host had already moved on.
     */
    openItem: function (key, opts) {
      var fx = fixtureFor(key);
      if (!fx) throw new Error("Unknown fixture: " + key);
      state.surface = "read";
      state.itemKey = fx.key;
      state.selection = [];
      state.readItem = null;
      state.readItemKey = null;
      state.composeItem = null;
      writeStored(state);
      log("sim.openItem", fx.key + (opts && opts.silent ? " (silent)" : ""));
      if (!(opts && opts.silent)) fireMailboxEvent("ItemChanged");
      return fx.itemId;
    },
    /** Close the opened message: `item` becomes null and `ItemChanged` fires. */
    closeItem: function (opts) {
      state.surface = "none";
      state.readItem = null;
      state.readItemKey = null;
      state.composeItem = null;
      writeStored(state);
      log("sim.closeItem");
      if (!(opts && opts.silent)) fireMailboxEvent("ItemChanged");
    },
    /** Several messages selected in the list (`SelectedItemsChanged`). */
    select: function (keys, opts) {
      var resolved = (keys || []).map(function (k) {
        var fx = fixtureFor(k);
        if (!fx) throw new Error("Unknown fixture: " + k);
        return fx.key;
      });
      state.surface = resolved.length > 1 ? "selection" : "read";
      state.selection = resolved;
      if (resolved.length === 1) state.itemKey = resolved[0];
      state.readItem = null;
      state.readItemKey = null;
      writeStored(state);
      log("sim.select", resolved.join(","));
      if (!(opts && opts.silent)) {
        fireMailboxEvent("ItemChanged");
        fireMailboxEvent("SelectedItemsChanged");
      }
    },
    /** Switch to the compose surface with one of the fixture drafts. */
    compose: function (draftKey) {
      var key = draftKey || "issues";
      if (!fixtures().drafts[key]) throw new Error("Unknown draft: " + key);
      state.surface = "compose";
      state.draftKey = key;
      state.composeItem = null;
      state.readItem = null;
      writeStored(state);
      log("sim.compose", key);
      fireMailboxEvent("ItemChanged");
    },
    /** Change the recipients of the open draft and raise `RecipientsChanged`. */
    composeAddRecipient: function (address) {
      var item = currentItem();
      if (!item || !item.__setRecipients) throw new Error("Not in compose mode");
      var draft = fixtures().drafts[state.draftKey];
      item.__setRecipients(draft.to.concat([{ displayName: address, emailAddress: address }]));
    },
    /** OWA re-creating the pane's iframe: full reload, same selected item. */
    reloadPane: function () {
      writeStored(state);
      log("sim.reloadPane");
      window.location.reload();
    },
    /** Pretend the pane is open on another mailbox (cold server-side cache). */
    setUser: function (address) {
      mailbox.userProfile = { displayName: mailbox.userProfile.displayName, emailAddress: address, timeZone: mailbox.userProfile.timeZone, accountType: mailbox.userProfile.accountType };
      log("sim.setUser", address);
    },
    setLatency: function (ms) {
      state.latency = Math.max(0, Number(ms) || 0);
      writeStored(state);
      log("sim.setLatency", String(state.latency));
      return state.latency;
    },
    /** Make the next call to `api` (e.g. "body.getAsync") fail. */
    failNext: function (api, times) {
      state.fail[api] = (state.fail[api] || 0) + (times || 1);
      log("sim.failNext", api);
    },
    /** Pretend a requirement set is missing, e.g. setEventSupport({ ItemChanged: false }). */
    setEventSupport: function (map) {
      if (map && map.ItemChanged === false) state.unsupported["mailbox:1.5"] = true;
      else delete state.unsupported["mailbox:1.5"];
      if (map && map.SelectedItemsChanged === false) state.unsupported["mailbox:1.13"] = true;
      else delete state.unsupported["mailbox:1.13"];
      if (map && map.LoadItemById === false) state.unsupported["mailbox:1.15"] = true;
      else delete state.unsupported["mailbox:1.15"];
      log("sim.setEventSupport", JSON.stringify(map || {}));
    },
    /**
     * Fail the next HTTP call whose URL contains `path` (default: any call to the
     * orchestrator). `status: 0` simulates an unreachable backend.
     */
    failNextRequest: function (opts) {
      var o = opts || {};
      var path = o.path || "/api/v1/";
      var status = o.status === undefined ? 500 : o.status;
      var times = o.times || 1;
      installFetchHook();
      state.httpFail = { path: path, status: status, times: times, body: o.body };
      log("sim.failNextRequest", path + " -> " + status);
    },
    /** Everything the host currently holds (used by tests and by the sim page). */
    state: function () {
      var fx = fixtureFor(state.itemKey);
      return {
        surface: state.surface,
        itemKey: state.surface === "read" ? state.itemKey : null,
        itemId: state.surface === "read" && fx ? fx.itemId : null,
        subject: state.surface === "read" && fx ? fx.subject : null,
        selection: state.selection.slice(),
        draftKey: state.surface === "compose" ? state.draftKey : null,
        latency: state.latency,
        handlers: {
          ItemChanged: (state.handlers[Office.EventType.ItemChanged] || []).length,
          SelectedItemsChanged: (state.handlers[Office.EventType.SelectedItemsChanged] || []).length,
        },
        notifications: Object.keys(state.notifications),
        lastReply: state.lastReply || null,
        lastAppointment: state.lastAppointment || null,
        lastDisplayed: state.lastDisplayed || null,
      };
    },
    /** Every host call made so far (diagnostics). */
    calls: function (filter) {
      return state.calls
        .filter(function (c) {
          return !filter || c.api.indexOf(filter) >= 0;
        })
        .map(function (c) {
          return c.api + (c.detail ? " " + c.detail : "");
        });
    },
    reset: function () {
      state.calls = [];
      state.fail = {};
      state.httpFail = null;
      state.notifications = {};
      state.lastReply = null;
      state.lastAppointment = null;
    },
  };

  /* ------------------------------------------------------------------ */
  /* HTTP failure injection (backend unreachable / 5xx states)          */
  /* ------------------------------------------------------------------ */

  var fetchHooked = false;
  function installFetchHook() {
    if (fetchHooked) return;
    fetchHooked = true;
    var original = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : input && input.url ? input.url : String(input);
      var f = state.httpFail;
      if (f && f.times > 0 && url.indexOf(f.path) >= 0) {
        f.times -= 1;
        log("http.fail", url + " -> " + f.status);
        if (f.status === 0) return Promise.reject(new TypeError("Failed to fetch"));
        var payload = f.body || {
          error: { code: f.status >= 500 ? "internal" : "validation", message: "Simulated backend failure", correlationId: "sim-" + Date.now().toString(36) },
        };
        return Promise.resolve(
          new Response(JSON.stringify(payload), { status: f.status, headers: { "content-type": "application/json" } }),
        );
      }
      return original(input, init);
    };
  }

  /* ------------------------------------------------------------------ */
  /* install                                                            */
  /* ------------------------------------------------------------------ */

  window.Office = Office;
  window.OfficeRuntime = OfficeRuntime;
  window.__oaoSim = sim;
  window.__oaoSimInstalled = true;
})();
