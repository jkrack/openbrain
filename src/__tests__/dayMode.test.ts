import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getDayMode } from "../dayMode";

describe("getDayMode", () => {
  let getDay: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getDay = vi.spyOn(Date.prototype, "getDay");
  });

  afterEach(() => {
    getDay.mockRestore();
  });

  it("returns 'work' on Monday (day 1) with default work days [1,2,3,4,5]", () => {
    getDay.mockReturnValue(1);
    expect(getDayMode([1, 2, 3, 4, 5])).toBe("work");
  });

  it("returns 'work' on Friday (day 5) with default work days [1,2,3,4,5]", () => {
    getDay.mockReturnValue(5);
    expect(getDayMode([1, 2, 3, 4, 5])).toBe("work");
  });

  it("returns 'weekend' on Saturday (day 6) with default work days [1,2,3,4,5]", () => {
    getDay.mockReturnValue(6);
    expect(getDayMode([1, 2, 3, 4, 5])).toBe("weekend");
  });

  it("returns 'weekend' on Sunday (day 0) with default work days [1,2,3,4,5]", () => {
    getDay.mockReturnValue(0);
    expect(getDayMode([1, 2, 3, 4, 5])).toBe("weekend");
  });

  it("returns 'work' on Saturday when custom work days include Saturday", () => {
    getDay.mockReturnValue(6);
    expect(getDayMode([1, 2, 3, 4, 5, 6])).toBe("work");
  });

  it("returns 'work' on Sunday when custom work days include Sunday", () => {
    getDay.mockReturnValue(0);
    expect(getDayMode([0, 1, 2, 3, 4, 5, 6])).toBe("work");
  });

  it("returns 'weekend' for every day when work days array is empty", () => {
    for (let day = 0; day <= 6; day++) {
      getDay.mockReturnValue(day);
      expect(getDayMode([])).toBe("weekend");
    }
  });

  it("returns 'work' for every day when all 7 days are work days", () => {
    for (let day = 0; day <= 6; day++) {
      getDay.mockReturnValue(day);
      expect(getDayMode([0, 1, 2, 3, 4, 5, 6])).toBe("work");
    }
  });

  it("returns 'weekend' on Wednesday when only Mon/Tue are work days", () => {
    getDay.mockReturnValue(3); // Wednesday
    expect(getDayMode([1, 2])).toBe("weekend");
  });
});
