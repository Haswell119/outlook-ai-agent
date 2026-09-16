import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, EmailContextSchema, PolicySchema, isInternalAddress } from "./index.js";

describe("shared contracts", () => {
  it("parses a minimal email context with defaults", () => {
    const parsed = EmailContextSchema.parse({ id: "abc" });
    expect(parsed.to).toEqual([]);
    expect(parsed.body).toBe("");
  });

  it("DEFAULT_POLICY is valid", () => {
    expect(() => PolicySchema.parse(DEFAULT_POLICY)).not.toThrow();
  });

  it("detects internal addresses incl. sub-domains", () => {
    expect(isInternalAddress("jane@northbridge.example", ["northbridge.example"])).toBe(true);
    expect(isInternalAddress("jane@mail.northbridge.example", ["northbridge.example"])).toBe(true);
    expect(isInternalAddress("jane@notnorthbridge.example", ["northbridge.example"])).toBe(false);
    expect(isInternalAddress("jane@clientco.com", ["northbridge.example"])).toBe(false);
  });
});
