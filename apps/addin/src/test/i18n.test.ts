import { describe, expect, it } from "vitest";
import { flattenKeys, resources, translate } from "@/i18n";

describe("i18n", () => {
  it("has exactly the same keys in FR and EN", () => {
    const en = flattenKeys(resources.en).sort();
    const fr = flattenKeys(resources.fr).sort();
    expect(fr).toEqual(en);
    expect(en.length).toBeGreaterThan(100);
  });

  it("interpolates parameters and falls back to EN", () => {
    expect(translate("en", "approval.approveSelected", { count: 3 })).toBe("Approve selected actions (3)");
    expect(translate("fr", "approval.approveSelected", { count: 3 })).toBe("Approuver les actions sélectionnées (3)");
    expect(translate("fr", "does.not.exist")).toBe("does.not.exist");
  });
});
