import { describe, expect, it } from "vitest";
import { runCli, type CliIo } from "./cli.js";

function mockIo(files: Record<string, Buffer> = {}): CliIo & {
  logs: string[];
  errors: string[];
} {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
    readFileSync: (path) => {
      const buf = files[path];
      if (!buf) throw new Error(`ENOENT: ${path}`);
      return buf;
    },
  };
}

describe("runCli", () => {
  it("prints usage and exits 2 when payload file is missing", () => {
    const io = mockIo();
    expect(runCli([], io)).toBe(2);
    expect(io.errors[0]).toMatch(/Usage: ntnkit-scan/);
  });

  it("exits 0 on --help", () => {
    const io = mockIo();
    expect(runCli(["--help"], io)).toBe(0);
  });

  it("rejects invalid --max-bytes", () => {
    const io = mockIo();
    expect(runCli(["--payload-file", "p.bin", "--max-bytes", "0"], io)).toBe(
      2,
    );
    expect(io.errors[0]).toMatch(/max-bytes/);
  });

  it("exits 1 on critical payload-size finding", () => {
    const io = mockIo({
      "big.bin": Buffer.alloc(2000, 1),
    });
    expect(
      runCli(["--payload-file", "big.bin", "--max-bytes", "100"], io),
    ).toBe(1);
    expect(io.logs.join("\n")).toMatch(/payload-size/);
  });

  it("exits 0 for a small payload", () => {
    const io = mockIo({
      "ok.bin": Buffer.from("hi"),
    });
    expect(runCli(["--payload-file", "ok.bin", "--json"], io)).toBe(0);
    expect(JSON.parse(io.logs[0])).toEqual({ findings: [] });
  });

  it("exits 2 on unknown argument", () => {
    const io = mockIo();
    expect(runCli(["--nope"], io)).toBe(2);
  });
});
