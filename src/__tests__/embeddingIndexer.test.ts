import { describe, it, expect, vi } from "vitest";

// Mock obsidian module (not used by the tested utility functions, but imported by embeddingIndexer)
vi.mock("obsidian", () => ({
  App: class {},
  TFile: class {},
}));

import { splitIntoSections, stripFrontmatter } from "../embeddingIndexer";

describe("embeddingIndexer", () => {
  it("strips YAML frontmatter", () => {
    const content = "---\ntitle: Test\ntags: [a, b]\n---\n\n# Hello\n\nSome content.";
    const stripped = stripFrontmatter(content);
    expect(stripped).toBe("# Hello\n\nSome content.");
  });

  it("returns content unchanged if no frontmatter", () => {
    const content = "# Hello\n\nSome content.";
    expect(stripFrontmatter(content)).toBe(content);
  });

  it("splits content at ## and ### headings", () => {
    const content = [
      "# Main Title",
      "Intro paragraph that introduces the document and its main themes.",
      "",
      "## Section One",
      "Content for section one. This section covers the first major topic in detail.",
      "More content about the topic with enough words to meet the minimum threshold.",
      "",
      "### Subsection",
      "Subsection content. This subsection goes deeper into a specific aspect of section one.",
      "It contains additional detail and explanation to reach the required word count.",
      "",
      "## Section Two",
      "Content for section two. This section covers another major topic in the document.",
      "It also has enough words to be included when splitting into sections for indexing.",
    ].join("\n");

    const sections = splitIntoSections(content);
    expect(sections).toHaveLength(3);
    expect(sections[0].heading).toBe("## Section One");
    expect(sections[0].text).toContain("Content for section one.");
    expect(sections[1].heading).toBe("### Subsection");
    expect(sections[1].text).toContain("Subsection content.");
    expect(sections[2].heading).toBe("## Section Two");
    expect(sections[2].text).toContain("Content for section two.");
  });

  it("skips sections with fewer than 20 words", () => {
    const content = [
      "## Long Section",
      "This section has more than twenty words in it so it should be included in the results when we split the content into sections for embedding.",
      "",
      "## Short",
      "Too short.",
    ].join("\n");

    const sections = splitIntoSections(content);
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe("## Long Section");
  });
});
