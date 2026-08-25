import { describe, it, expect } from "vitest";
import { isTabletWidth, TABLET_BREAKPOINT } from "./use-mobile";

describe("Tablet Breakpoint Logic", () => {
  it("defines the tablet breakpoint constant", () => {
    expect(TABLET_BREAKPOINT).toBe(1024);
  });

  it("identifies tablet screen widths (768px - 1023px)", () => {
    expect(isTabletWidth(767)).toBe(false); // Phone
    expect(isTabletWidth(768)).toBe(true);  // iPad portrait boundary
    expect(isTabletWidth(834)).toBe(true);  // iPad Air
    expect(isTabletWidth(1023)).toBe(true); // Tablet upper boundary
    expect(isTabletWidth(1024)).toBe(false); // Desktop boundary
    expect(isTabletWidth(1440)).toBe(false); // Desktop
  });
});