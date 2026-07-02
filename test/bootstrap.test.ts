import { describe, expect, it } from "vitest";
import {
  condaBinDirs,
  miniforgeInstallerUrl,
  prependPath,
} from "../src/execution/environment.js";

describe("miniforgeInstallerUrl", () => {
  it("maps linux/mac and x64/arm64 to the right asset", () => {
    expect(miniforgeInstallerUrl("linux", "x64")).toContain("Miniforge3-Linux-x86_64.sh");
    expect(miniforgeInstallerUrl("linux", "arm64")).toContain("Miniforge3-Linux-aarch64.sh");
    expect(miniforgeInstallerUrl("darwin", "arm64")).toContain("Miniforge3-MacOSX-arm64.sh");
    expect(miniforgeInstallerUrl("darwin", "x64")).toContain("Miniforge3-MacOSX-x86_64.sh");
  });

  it("returns null for unsupported platforms/arches", () => {
    expect(miniforgeInstallerUrl("win32", "x64")).toBeNull();
    expect(miniforgeInstallerUrl("linux", "ppc64")).toBeNull();
  });
});

describe("condaBinDirs", () => {
  it("returns the bin and condabin dirs under the prefix", () => {
    expect(condaBinDirs("/home/u/miniforge3")).toEqual([
      "/home/u/miniforge3/bin",
      "/home/u/miniforge3/condabin",
    ]);
  });
});

describe("prependPath", () => {
  it("prepends new dirs before the existing PATH", () => {
    expect(prependPath("/usr/bin:/bin", ["/opt/x/bin"])).toBe("/opt/x/bin:/usr/bin:/bin");
  });
  it("de-duplicates, keeping the prepended position", () => {
    expect(prependPath("/usr/bin:/opt/x/bin", ["/opt/x/bin"])).toBe("/opt/x/bin:/usr/bin");
  });
  it("handles an empty current PATH", () => {
    expect(prependPath("", ["/a", "/b"])).toBe("/a:/b");
  });
});
