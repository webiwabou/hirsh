import { describe, expect, it } from "vitest";
import { projectDataDir, resolveWorkspace } from "../src/cli/workspace.js";

const CWD = "/home/sci";

describe("resolveWorkspace", () => {
  it("defaults to the current directory", () => {
    expect(resolveWorkspace([], {}, CWD)).toEqual({ path: "/home/sci", source: "cwd" });
  });

  it("ignores Hirsh's own flags when defaulting", () => {
    expect(resolveWorkspace(["--auto"], {}, CWD)).toEqual({ path: "/home/sci", source: "cwd" });
  });

  it("takes a bare positional path (relative resolved against cwd)", () => {
    expect(resolveWorkspace(["study-a"], {}, CWD)).toEqual({ path: "/home/sci/study-a", source: "positional" });
    expect(resolveWorkspace(["/data/study-b", "--auto"], {}, CWD)).toEqual({
      path: "/data/study-b",
      source: "positional",
    });
  });

  it("honors --workdir/-C over a positional and env", () => {
    expect(resolveWorkspace(["--workdir", "/data/w"], { HIRSH_WORKSPACE: "/e" }, CWD)).toEqual({
      path: "/data/w",
      source: "flag",
    });
    expect(resolveWorkspace(["-C", "rel"], {}, CWD)).toEqual({ path: "/home/sci/rel", source: "flag" });
    expect(resolveWorkspace(["--workdir=/data/x"], {}, CWD)).toEqual({ path: "/data/x", source: "flag" });
  });

  it("does not treat the --workdir value as a positional path", () => {
    // "/data/w" is consumed as the flag value, so no positional remains.
    expect(resolveWorkspace(["--workdir", "/data/w"], {}, CWD).source).toBe("flag");
  });

  it("falls back to HIRSH_WORKSPACE before cwd", () => {
    expect(resolveWorkspace([], { HIRSH_WORKSPACE: "/env/ws" }, CWD)).toEqual({
      path: "/env/ws",
      source: "env",
    });
  });
});

describe("projectDataDir", () => {
  it("is the .hirsh directory inside the workspace", () => {
    expect(projectDataDir("/home/sci/study-a")).toBe("/home/sci/study-a/.hirsh");
  });
});
