/**
 * dot-agentd has one build (the image builder's agentdBuildCommand, AGENTD_BUILD_SHELL as a shell line) and one Go
 * (go.mod's `toolchain`): the same source then gives the same bytes, so the same runtime disk, wherever it is built.
 * These checks keep every place that builds it or tells a person how from drifting to another spelling or another Go.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTD_BUILD_SHELL } from "@invisible-dots/image-builder";
import { describe, expect, it } from "vitest";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const text = (path: string) => readFileSync(join(repo, path), "utf8").replace(/\r\n/g, "\n");

/** Every file that builds dot-agentd, or tells how. */
const BUILDERS = [
  ".github/workflows/tests.yml",
  ".github/workflows/golden-image.yml",
  "guest/dot-agentd/README.md",
  "guest/image-builder/README.md",
  "guest/image-builder/test/smoke/run.sh",
  "tests/e2e/README.md",
];
/** Those that run it with the environment on the same line, so quote the whole shell line. */
const WHOLE_LINE = [".github/workflows/tests.yml", ".github/workflows/golden-image.yml", "guest/dot-agentd/README.md", "guest/image-builder/README.md", "tests/e2e/README.md"];
/** The flags, as a line that passes the environment another way (docker's -e) still spells them. */
const FLAGS = AGENTD_BUILD_SHELL.slice(AGENTD_BUILD_SHELL.indexOf("go build"), AGENTD_BUILD_SHELL.indexOf(" -o ") + 4);

describe("the one build of dot-agentd", () => {
  const toolchain = /^toolchain go(\d+\.\d+\.\d+)$/m.exec(text("guest/dot-agentd/go.mod"))?.[1];

  it("go.mod names the Go that builds it", () => {
    expect(toolchain).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.each(BUILDERS)("%s builds it with the same flags, and nothing else that builds it", (path) => {
    const builds = text(path)
      .split("\n")
      .filter((line) => /\bgo (-C \S+ )?build\b/.test(line));
    expect(builds.length, path).toBeGreaterThan(0);
    for (const line of builds) expect(line, path).toContain(FLAGS);
  });

  it.each(WHOLE_LINE)("%s quotes the whole shell line", (path) => {
    expect(text(path)).toContain(AGENTD_BUILD_SHELL);
  });

  it.each(BUILDERS)("%s uses the Go of go.mod's toolchain", (path) => {
    const content = text(path);
    for (const image of content.match(/golang:[\w.-]+/g) ?? []) expect(image, path).toBe(`golang:${toolchain}`);
    // setup-go takes the toolchain line from go.mod (v6 reads `toolchain`, v5 read only the `go` line).
    for (const use of content.match(/actions\/setup-go@\S+/g) ?? []) expect(use, path).toBe("actions/setup-go@v6");
    for (const pin of content.match(/go-version(-file)?:.*/g) ?? []) expect(pin, path).toBe("go-version-file: guest/dot-agentd/go.mod");
  });
});
