/**
 * Mailbox fixtures for the Office.js host simulator.
 *
 * Plain ES5-compatible JavaScript on purpose: this file is loaded verbatim by
 * `sim.html` **and** injected into a Playwright page with
 * `page.addInitScript({ path })`, which evaluates a script, not a module.
 * It therefore has no imports and only publishes `window.__oaoSimFixtures`.
 *
 * Seven realistic messages, French and English, with invented organisations
 * (Northbridge Capital, Atlas Partners) and no real names — the six shapes the
 * pane has to get right, plus one that legitimately contains nothing to act on:
 *
 *   | id          | language | shape                                            | expected path |
 *   |-------------|----------|--------------------------------------------------|---------------|
 *   | `A`         | en       | long follow-up, numbered open points             | model (llm)   |
 *   | `B`         | fr       | forward whose body *starts* with `De :/Envoyé :` | model (llm)   |
 *   | `C`         | en       | newsletter with an unsubscribe footer            | rules only    |
 *   | `D`         | fr       | out-of-office auto-reply                         | rules only    |
 *   | `E`         | fr       | two-word acknowledgement ("Merci !")             | rules only    |
 *   | `F`         | fr/en    | IBAN + an external recipient in To               | model (llm)   |
 *   | `G`         | fr       | short internal note: nothing to decide or do     | model (llm)   |
 *
 * Ids are shaped like the base64url ids Outlook on the web hands out, so
 * `convertToRestId` and `looksLikeRestId()` behave as they do in the real host.
 */
(function () {
  "use strict";

  /** Outlook-on-the-web-shaped id: long base64url, no EWS padding. */
  function owaId(seed) {
    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    var out = "";
    var h = 2166136261;
    for (var i = 0; i < seed.length; i++) {
      h = (Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0);
    }
    for (var n = 0; n < 88; n++) {
      h = (Math.imul(h ^ (n + 7), 16777619) >>> 0);
      out += alphabet.charAt(h % alphabet.length);
    }
    return "AAMkAD" + out;
  }

  var ME = { displayName: "Alex Moreau", emailAddress: "alex.moreau@northbridge.example" };

  var items = [
    {
      key: "A",
      label: "A · Atlas follow-up (EN, long)",
      language: "en",
      itemId: owaId("atlas-followup"),
      conversationId: "conv-atlas-onboarding",
      internetMessageId: "<atlas-followup-0916@atlas-partners.example>",
      subject: "Re: Atlas project — open points before the 30 September go-live",
      from: { displayName: "Dana Whitfield", emailAddress: "dana.whitfield@atlas-partners.example" },
      to: [ME],
      cc: [{ displayName: "Operations Desk", emailAddress: "operations@northbridge.example" }],
      dateTimeCreated: "2026-09-15T07:24:00.000Z",
      importance: "high",
      categories: [],
      attachments: [
        { id: "att-atlas-plan", name: "Atlas cutover plan v7.pdf", size: 482113, contentType: "application/pdf", isInline: false },
      ],
      body:
        "Hello Alex,\n\n" +
        "Thanks for the call yesterday. Before we can confirm the 30 September go-live for the Atlas project, " +
        "five points are still open on our side and I would like your written position on each of them.\n\n" +
        "1. Reconciliation window — you proposed T+1, our operations team needs T+2 for the first month. " +
        "Can Northbridge Capital accept T+2 until 31 October?\n" +
        "2. Signed service schedule — we still do not have the countersigned copy of schedule 3 (sent on 2 September). " +
        "Without it the legal team will not release the production environment.\n" +
        "3. Data retention — your draft says 10 years, our policy says 7. We will follow yours if you confirm it in writing.\n" +
        "4. Escalation contacts — please confirm the two 24/7 contacts for the cutover weekend.\n" +
        "5. Penalty clause — the 0.5 % per late day in section 9 is not acceptable to our board. We propose 0.2 % capped at 5 %.\n\n" +
        "Point 2 is the blocker: if the countersigned schedule does not reach us by Friday 18 September we will have to move " +
        "the go-live to 14 October, which pushes the migration into the quarter-end freeze.\n\n" +
        "Could you also let me know who signs off the final cutover decision on your side?\n\n" +
        "Best regards,\n" +
        "Dana Whitfield\n" +
        "Programme Director — Atlas Partners\n" +
        "Tel. +41 22 000 00 00\n\n" +
        "This e-mail and any attachments are confidential and intended solely for the addressee.",
    },
    {
      key: "B",
      label: "B · TR: relevé Atlas (FR, forward)",
      language: "fr",
      itemId: owaId("atlas-forward"),
      conversationId: "conv-atlas-releve",
      internetMessageId: "<tr-atlas-releve-0915@northbridge.example>",
      subject: "TR : Atlas — relevé trimestriel à valider",
      from: { displayName: "Claire Fontaine", emailAddress: "claire.fontaine@northbridge.example" },
      to: [ME],
      cc: [],
      dateTimeCreated: "2026-09-15T16:41:00.000Z",
      importance: "normal",
      categories: [],
      attachments: [],
      // The whole message *is* the forwarded mail: the body starts with the
      // `De :/Envoyé :/À :/Objet :` quote header, with no words of its own.
      // This is the shape that used to produce an empty summary.
      body:
        "De : Comptabilité Atlas <compta@atlas-partners.example>\n" +
        "Envoyé : lundi 14 septembre 2026 17:42\n" +
        "À : Claire Fontaine <claire.fontaine@northbridge.example>\n" +
        "Objet : Atlas — relevé trimestriel à valider\n\n" +
        "Bonjour Claire,\n\n" +
        "Nous avons besoin de votre validation sur le relevé trimestriel Atlas avant le 22 septembre 2026. " +
        "Deux écritures restent sans justificatif : la facture 2026-0431 (18 400 EUR) et la facture 2026-0448 (7 250 EUR).\n\n" +
        "Pouvez-vous également confirmer que le compte de règlement n'a pas changé ?\n\n" +
        "Sans retour de votre part avant le 22, nous clôturerons le trimestre avec les deux écritures en suspens.\n\n" +
        "Cordialement,\n" +
        "Comptabilité Atlas",
    },
    {
      key: "C",
      label: "C · Weekly market note (EN, newsletter)",
      language: "en",
      itemId: owaId("newsletter-week38"),
      conversationId: "conv-newsletter-week38",
      internetMessageId: "<market-note-w38@research.northbridge-research.example>",
      subject: "Northbridge Research — weekly market note, week 38",
      from: { displayName: "Northbridge Research", emailAddress: "newsletter@northbridge-research.example" },
      to: [ME],
      cc: [],
      dateTimeCreated: "2026-09-16T05:03:00.000Z",
      importance: "normal",
      categories: [],
      attachments: [],
      body:
        "WEEKLY MARKET NOTE — WEEK 38\n\n" +
        "Rates: policy rates held steady; the short end of the curve barely moved.\n" +
        "Credit: investment-grade spreads tightened by 4 bp, high yield was flat.\n" +
        "Equities: the energy complex lagged, industrials led on order-book data.\n" +
        "FX: the trade-weighted index closed the week 0.3 % lower.\n\n" +
        "Read the full note: https://research.northbridge-research.example/notes/w38?utm_source=email&utm_campaign=weekly\n\n" +
        "You are receiving this email because you subscribed to the weekly market note. " +
        "Unsubscribe or manage your preferences at any time.",
    },
    {
      key: "D",
      label: "D · Absence du bureau (FR, OOO)",
      language: "fr",
      itemId: owaId("out-of-office"),
      conversationId: "conv-atlas-onboarding",
      internetMessageId: "<ooo-0916@atlas-partners.example>",
      subject: "Réponse automatique : Atlas — relevé trimestriel à valider",
      from: { displayName: "Yann Leclerc", emailAddress: "yann.leclerc@atlas-partners.example" },
      to: [ME],
      cc: [],
      dateTimeCreated: "2026-09-16T06:12:00.000Z",
      importance: "normal",
      categories: [],
      attachments: [],
      body:
        "Bonjour,\n\n" +
        "Je suis actuellement absent du bureau et de retour le 24 septembre 2026.\n" +
        "Pour toute urgence concernant le projet Atlas, merci de contacter le service opérations.\n\n" +
        "Cordialement,\n" +
        "Yann Leclerc",
    },
    {
      key: "E",
      label: "E · Merci ! (FR, court)",
      language: "fr",
      itemId: owaId("merci"),
      conversationId: "conv-atlas-releve",
      internetMessageId: "<merci-0916@atlas-partners.example>",
      subject: "RE : Atlas — relevé trimestriel à valider",
      from: { displayName: "Claire Fontaine", emailAddress: "claire.fontaine@northbridge.example" },
      to: [ME],
      cc: [],
      dateTimeCreated: "2026-09-16T07:02:00.000Z",
      importance: "normal",
      categories: [],
      attachments: [],
      body: "Merci !",
    },
    {
      key: "F",
      label: "F · Coordonnées de règlement (IBAN, externe)",
      language: "fr",
      itemId: owaId("iban-external"),
      conversationId: "conv-atlas-paiement",
      internetMessageId: "<iban-change-0916@atlas-partners.example>",
      subject: "Atlas — nouvelles coordonnées de règlement pour la facture 2026-0431",
      from: { displayName: "Comptabilité Atlas", emailAddress: "compta@atlas-partners.example" },
      to: [ME, { displayName: "Broker Desk", emailAddress: "desk@brokerline-markets.example" }],
      cc: [],
      dateTimeCreated: "2026-09-16T08:35:00.000Z",
      importance: "high",
      categories: ["Atlas"],
      attachments: [
        { id: "att-iban", name: "Facture 2026-0431.pdf", size: 128441, contentType: "application/pdf", isInline: false },
      ],
      body:
        "Bonjour,\n\n" +
        "Suite au changement de notre banque, merci de régler la facture 2026-0431 (18 400 EUR) sur le nouveau compte :\n\n" +
        "IBAN : FR76 3000 6000 0112 3456 7890 189\n" +
        "BIC : ATLPFRPPXXX\n" +
        "Titulaire : Atlas Partners SAS\n\n" +
        "Le règlement doit être effectué avant le 25 septembre 2026, faute de quoi des pénalités de retard s'appliqueront.\n" +
        "Merci de confirmer l'exécution du virement par retour de message.\n\n" +
        "Cordialement,\n" +
        "Comptabilité Atlas",
    },
    {
      key: "G",
      label: "G · Salle réservée (FR, note courte)",
      language: "fr",
      itemId: owaId("salle-reservee"),
      conversationId: "conv-atlas-onboarding",
      internetMessageId: "<salle-atlas-0916@northbridge.example>",
      subject: "Atlas — salle réservée jeudi",
      from: { displayName: "Claire Fontaine", emailAddress: "claire.fontaine@northbridge.example" },
      to: [ME],
      cc: [],
      dateTimeCreated: "2026-09-16T07:40:00.000Z",
      importance: "normal",
      categories: [],
      attachments: [],
      // A real conversation (so the model is called) that genuinely contains no
      // decision, no task and no risk — the "None detected" state.
      body: "Bonjour Alex,\n\nLa salle Atlas est réservée jeudi de 9h à 11h pour la répétition de bascule.\n\nBonne journée,\nClaire",
    },
  ];

  /** Draft used by the compose surface (`__oaoSim.compose()`). */
  var drafts = {
    issues: {
      key: "issues",
      label: "Draft with compliance issues",
      itemId: owaId("draft-issues"),
      from: ME,
      to: [{ displayName: "Broker Desk", emailAddress: "desk@brokerline-markets.example" }],
      cc: [],
      bcc: [],
      subject: "Atlas — Q3 performance report and settlement details",
      body:
        "Hi,\n\n" +
        "Please find attached the Q3 performance report for the Atlas project (portfolio no. CH-4471-889).\n" +
        "Settlement account IBAN FR76 3000 6000 0112 3456 7890 189, client reference 884-113.\n\n" +
        "Alex",
      attachments: [
        { id: "att-draft-q3", name: "Atlas – Q3 performance report.pdf", size: 1204331, isInline: false },
      ],
      sensitivityLabelId: null,
    },
    clean: {
      key: "clean",
      label: "Clean internal draft",
      itemId: owaId("draft-clean"),
      from: ME,
      to: [{ displayName: "Operations Desk", emailAddress: "operations@northbridge.example" }],
      cc: [],
      bcc: [],
      subject: "Atlas cutover — internal check-in",
      body: "Hi team,\n\nQuick check-in on the Atlas cutover rehearsal tomorrow at 09:00. No client data attached.\n\nAlex",
      attachments: [],
      // Already classified by the user, so the policy's label rule is satisfied
      // — the draft that must come back with *no* compliance issue at all.
      sensitivityLabelId: "lbl-internal",
    },
  };

  window.__oaoSimFixtures = {
    userProfile: {
      displayName: ME.displayName,
      emailAddress: ME.emailAddress,
      timeZone: "W. Europe Standard Time",
      accountType: "office365",
    },
    items: items,
    drafts: drafts,
    byKey: function (key) {
      for (var i = 0; i < items.length; i++) if (items[i].key === key || items[i].itemId === key) return items[i];
      return undefined;
    },
  };
})();
