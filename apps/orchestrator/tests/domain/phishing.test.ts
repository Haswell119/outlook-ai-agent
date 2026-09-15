import { describe, expect, it } from "vitest";
import { assessPhishing } from "../../src/domain/compliance/phishing.js";
import { sampleEmail } from "../helpers.js";

const opts = { internalDomains: ["northbridge.example"] };
const codes = (e: Parameters<typeof assessPhishing>[0]) => assessPhishing(e, opts).indicators.map((i) => i.code);

describe("phishing heuristics", () => {
  it("clean business email scores low", () => {
    const r = assessPhishing(sampleEmail(), opts);
    expect(r.verdict).toBe("clean");
    expect(r.score).toBeLessThan(0.3);
  });

  it("detects display-name mismatch and lookalike sender domain", () => {
    const e = sampleEmail({ from: { name: "Northbridge IT Support", address: "it@northbridqe-capital.com" } });
    const c = codes(e);
    expect(c).toContain("display_name_mismatch");
    expect(c).toContain("lookalike_sender_domain");
    expect(codes(sampleEmail({ from: { name: "john@northbridge.example", address: "john@evil.com" } }))).toContain("display_name_mismatch");
  });

  it("detects reply-to mismatch, urgency, credentials and raw IP links → likely_phishing", () => {
    const e = sampleEmail({
      from: { name: "IT", address: "it@random-host.com" },
      subject: "URGENT: your mailbox password expires today",
      body: "Reply-To: hacker@evil.io\nVerify your account immediately at http://185.203.116.42/owa/login and confirm your password. This is your final notice.",
    });
    const r = assessPhishing(e, opts);
    expect(r.indicators.map((i) => i.code)).toEqual(expect.arrayContaining(["reply_to_mismatch", "urgent_language", "credential_request", "raw_ip_link"]));
    expect(r.verdict).toBe("likely_phishing");
    expect(r.score).toBeLessThanOrEqual(1);
  });

  it("detects shorteners, punycode, anchor/href mismatch", () => {
    expect(codes(sampleEmail({ body: "see https://bit.ly/abc" }))).toContain("url_shortener");
    expect(codes(sampleEmail({ body: "see https://xn--lngbow-9ya.ch/login" }))).toContain("punycode_link");
    expect(codes(sampleEmail({ body: '<a href="https://evil.com/x">https://northbridge.example/portal</a>' }))).toContain("anchor_href_mismatch");
  });

  it("detects payment change requests and dangerous attachments from unknown senders", () => {
    expect(codes(sampleEmail({ body: "Please note our new bank account details for the next invoice." }))).toContain("payment_change_request");
    const r = assessPhishing(sampleEmail({ attachments: [{ name: "invoice.exe" }] }), opts);
    const ind = r.indicators.find((i) => i.code === "dangerous_attachment");
    expect(ind?.weight).toBe(0.45);
    const known = assessPhishing(sampleEmail({ attachments: [{ name: "macro.xlsm" }] }), { ...opts, knownSenders: ["sarah.johnson@vendorco.com"] });
    expect(known.indicators.find((i) => i.code === "dangerous_attachment")?.weight).toBe(0.25);
  });
});
