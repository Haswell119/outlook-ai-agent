import { describe, expect, it } from "vitest";
import {
  deltaTone,
  formatConfidence,
  formatDateRange,
  formatDateTime,
  formatDelta,
  formatDuration,
  formatLatency,
  formatNumber,
  formatPercent,
  hitRate,
  safeTimeZone,
} from "@/lib/format";

describe("KPI delta formatting", () => {
  it("renders a signed percentage with one decimal", () => {
    expect(formatDelta(12.4)).toBe("+12.4%");
    expect(formatDelta(9.7)).toBe("+9.7%");
    expect(formatDelta(18.6)).toBe("+18.6%");
    expect(formatDelta(-3)).toBe("-3.0%");
    expect(formatDelta(0)).toBe("0.0%");
    expect(formatDelta(0.049)).toBe("0.0%");
    expect(formatDelta(undefined)).toBe("—");
    expect(formatDelta(Number.NaN)).toBe("—");
  });

  it("keeps the mock-up semantics: rising compliance alerts are red", () => {
    expect(deltaTone(12.4)).toBe("positive");
    expect(deltaTone(-12.4)).toBe("negative");
    expect(deltaTone(8.3, true)).toBe("negative");
    expect(deltaTone(-8.3, true)).toBe("positive");
    expect(deltaTone(0)).toBe("neutral");
    expect(deltaTone(undefined)).toBe("neutral");
  });

  it("formats numbers per language", () => {
    expect(formatNumber(8642, "en")).toBe("8,642");
    expect(formatNumber(8642, "fr").replace(/ | /g, " ")).toBe("8 642");
  });

  it("formats shares, latency and confidence", () => {
    expect(formatPercent(63.8)).toBe("63.8%");
    expect(formatLatency(420)).toBe("420 ms");
    expect(formatLatency(2500)).toBe("2.50 s");
    expect(formatLatency(undefined)).toBe("—");
    expect(formatConfidence(0.92)).toBe("92%");
    expect(formatConfidence(undefined)).toBe("—");
  });

  it("renders the reference date range of the mock-up", () => {
    expect(
      formatDateRange("2025-05-12T00:00:00.000Z", "2025-05-18T23:59:59.000Z", "en", "UTC"),
    ).toBe("12 May – 18 May 2025");
  });

  it("renders dates in the configured timezone and falls back on a bad zone", () => {
    // 23:30 UTC is already the next day in Zurich (UTC+2 in May).
    expect(formatDateTime("2025-05-18T23:30:00.000Z", "en", "Europe/Zurich")).toContain("19 May");
    expect(formatDateTime("2025-05-18T23:30:00.000Z", "en", "UTC")).toContain("18 May");
    expect(safeTimeZone("Not/AZone")).toBe("UTC");
    expect(safeTimeZone("Europe/Zurich")).toBe("Europe/Zurich");
    expect(safeTimeZone(undefined)).toBe("UTC");
  });

  it("formats uptime and cache hit rates", () => {
    expect(formatDuration(0)).toBe("0 min");
    expect(formatDuration(90)).toBe("1 min");
    expect(formatDuration(3_600 * 5 + 120)).toBe("5 h 2 min");
    expect(formatDuration(86_400 * 4 + 3_600 * 14 + 60 * 23)).toBe("4 d 14 h 23 min");
    expect(formatDuration(86_400, "fr").startsWith("1 j")).toBe(true);
    expect(hitRate(75, 25)).toBe(75);
    expect(hitRate(0, 0)).toBeNull();
  });
});
