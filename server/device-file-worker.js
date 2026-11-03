import { readFileSync } from "node:fs";

// Serialized with the fixed Node launcher for paired hosts; never supplied by a client.
export const deviceFileProgram = readFileSync(
  new URL("./device-file-posix.py", import.meta.url),
  "utf8",
);

export async function deviceFileOperation(input) {
  const os = await import("node:os");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  if (!["darwin", "linux"].includes(os.platform())) {
    return {
      ok: false,
      statusCode: 501,
      error: "Hardened file sharing is not available on this operating system.",
    };
  }
  try {
    const { stdout } = await promisify(execFile)(
      os.platform() === "darwin" ? "/usr/bin/python3" : "python3",
      [
        "-I",
        "-S",
        "-B",
        "-c",
        deviceFileProgram,
        Buffer.from(JSON.stringify(input)).toString("base64"),
      ],
      { timeout: 18_000, maxBuffer: 160 * 1024, encoding: "utf8" },
    );
    return JSON.parse(stdout);
  } catch (error) {
    if (error.signal === "SIGALRM" || error.killed) {
      return {
        ok: false,
        statusCode: 504,
        error:
          "The file operation timed out. On macOS, check Files and Folders permissions for the Orion server or OpenClaw Node host, then try again.",
      };
    }
    // Missing runtimes, unsupported APIs and helper failures never enable pathname access.
    return {
      ok: false,
      statusCode: 503,
      error:
        "Hardened file sharing requires Python 3.8 or newer and descriptor-relative filesystem support on this device.",
    };
  }
}
