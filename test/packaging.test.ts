import { describe, expect, it } from "vitest";
import {
  homePageUrl,
  patchManifest,
  renderChangelog,
  renderCitationCff,
  renderContributing,
  renderEditorConfig,
  renderMitLicense,
  renderPullRequestTemplate,
  type PackageSpec,
} from "../src/composition/packaging.js";

const spec: PackageSpec = {
  pipelineName: "customqc",
  author: "Dr. Ada Lovelace",
  homePage: "alovelace/customqc",
  year: 2026,
  description: "Custom QC pipeline.",
};

describe("renderMitLicense", () => {
  it("is an MIT license with the year and holder", () => {
    const lic = renderMitLicense(spec);
    expect(lic).toContain("MIT License");
    expect(lic).toContain("Copyright (c) 2026 Dr. Ada Lovelace");
    expect(lic).toContain("WITHOUT WARRANTY OF ANY KIND");
  });

  it("falls back the holder to the author", () => {
    expect(renderMitLicense({ ...spec, licenseHolder: "ACME Lab" })).toContain(
      "Copyright (c) 2026 ACME Lab",
    );
  });
});

describe("homePageUrl", () => {
  it("expands owner/repo to a github URL", () => {
    expect(homePageUrl("alovelace/customqc")).toBe("https://github.com/alovelace/customqc");
  });
  it("passes through a full URL", () => {
    expect(homePageUrl("https://example.org/x")).toBe("https://example.org/x");
  });
  it("returns empty for nothing", () => {
    expect(homePageUrl(undefined)).toBe("");
  });
});

describe("renderChangelog", () => {
  it("names the pipeline and an initial dev version", () => {
    const cl = renderChangelog(spec);
    expect(cl).toContain("customqc: Changelog");
    expect(cl).toContain("v1.0.0dev");
  });
});

describe("standard nf-core files", () => {
  it("renders an .editorconfig with a root marker", () => {
    expect(renderEditorConfig()).toMatch(/^root = true/);
  });
  it("names the pipeline and author in CITATION.cff", () => {
    const cff = renderCitationCff(spec);
    expect(cff).toMatch(/cff-version:/);
    expect(cff).toContain("customqc");
    expect(cff).toContain("Dr. Ada Lovelace");
    expect(cff).toContain("github.com/alovelace/customqc");
  });
  it("renders CONTRIBUTING and a PR template naming the pipeline", () => {
    expect(renderContributing(spec)).toContain("Contributing to customqc");
    expect(renderPullRequestTemplate(spec)).toMatch(/PR checklist/);
  });
});

describe("patchManifest", () => {
  const config = `manifest {
    name            = 'customqc'
    description     = "Custom QC pipeline."
    nextflowVersion = '!>=23.04.0'
    version         = '0.1.0'
}
`;

  it("inserts author and homePage after the name line", () => {
    const out = patchManifest(config, spec);
    expect(out).toContain("author          = \"Dr. Ada Lovelace\"");
    expect(out).toContain("homePage        = 'https://github.com/alovelace/customqc'");
    // order: author/homePage come right after name, before description
    expect(out.indexOf("author")).toBeLessThan(out.indexOf("description"));
  });

  it("is idempotent — doesn't duplicate an existing author", () => {
    const once = patchManifest(config, spec);
    const twice = patchManifest(once, spec);
    expect(twice).toBe(once);
  });

  it("omits homePage when none is given", () => {
    const out = patchManifest(config, { ...spec, homePage: undefined });
    expect(out).toContain("author");
    expect(out).not.toContain("homePage");
  });
});
