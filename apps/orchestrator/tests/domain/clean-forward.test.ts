import { describe, expect, it } from "vitest";
import { cleanBody } from "../../src/domain/prompts/clean.js";

const quoted = `De : Alice Martin <alice@partner.example>
Envoyé : mardi 2 juin 2026 09:25
À : jane@northbridge.example
Objet : [RELANCE] Points ouverts projet Atlas

Bonjour Jane,
Nous attendons encore une confirmation sur plusieurs sujets avant de clôturer le dossier :
1. Date cible de mise en production. 2. Périmètre de la phase initiale. 3. Version finale du pricing.
Peux-tu nous envoyer un statut consolidé d'ici demain 11h00 ?
Bien cordialement,
Alice`;

describe("cleanBody — forwards", () => {
  it("keeps the quoted message when the author's own text is empty (pure forward)", () => {
    const r = cleanBody(quoted);
    expect(r.text).toContain("statut consolidé");
    expect(r.text).toContain("Date cible");
  });

  it("keeps the quoted message after a short forwarding note", () => {
    const r = cleanBody(`FYI, voir ci-dessous — à traiter avant le comité.\n\n${quoted}`);
    expect(r.text).toContain("FYI, voir ci-dessous");
    expect(r.text).toContain("statut consolidé");
  });

  it("still drops the history behind a substantial reply", () => {
    const own = "Merci Alice pour ce récapitulatif détaillé. ".repeat(6) + "Voici nos réponses point par point : la date cible est confirmée au 30 juin, le périmètre initial couvre les trois flux, le pricing v3 est validé par le comité, la synthèse des risques est jointe et aucune validation interne supplémentaire n'est nécessaire.";
    const r = cleanBody(`${own}\n\n${quoted}`);
    expect(r.text).toContain("Voici nos réponses");
    expect(r.text).not.toContain("Envoyé : mardi");
    expect(r.removed.quoted).toBe(true);
  });
});
