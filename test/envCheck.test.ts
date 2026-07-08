import { describe, expect, it } from "vitest";
import { dockerStatus } from "../src/execution/envCheck.js";

describe("dockerStatus", () => {
  it("is available when the CLI is present and the daemon is reachable", () => {
    const s = dockerStatus({ ok: true, out: "Docker version 27.0" }, true);
    expect(s.available).toBe(true);
    expect(s.version).toBe("Docker version 27.0");
    expect(s.hint).toBeUndefined();
  });

  it("is unavailable with a daemon hint when the CLI is present but the daemon is down", () => {
    const s = dockerStatus({ ok: true, out: "Docker version 27.0" }, false);
    expect(s.available).toBe(false);
    expect(s.version).toBe("Docker version 27.0");
    expect(s.hint).toMatch(/daemon isn't reachable/);
  });

  it("is unavailable with an install hint when the CLI is missing", () => {
    const s = dockerStatus({ ok: false, out: "" }, false);
    expect(s.available).toBe(false);
    expect(s.hint).toMatch(/not on PATH/);
  });
});
