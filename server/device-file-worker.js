import { readFileSync } from "node:fs";

// Serialized with the fixed Node launcher for paired hosts; never supplied by a client.
export const deviceFilePrograms = {
  posix: readFileSync(new URL("./device-file-posix.py", import.meta.url), "utf8"),
  windows: readFileSync(new URL("./device-file-windows.py", import.meta.url), "utf8"),
};

export async function deviceFileOperation(input) {
  const os = await import("node:os");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const platform = os.platform();
  if (!["darwin", "linux"].includes(platform)) {
    return {
      ok: false,
      statusCode: 501,
      error: "Hardened file sharing is not available on this operating system.",
    };
  }
  // WSL's Windows drives re-resolve held folders by pathname, so Windows folders there are read
  // by the Windows handle-based helper through interop; Linux paths stay with the POSIX helper.
  const wsl = platform === "linux" && /microsoft/i.test(os.release());
  const isWindowsPath = (root) => /^[A-Za-z]:[\\/]/.test(root.path);
  async function helper(windows, request) {
    try {
      const pending = promisify(execFile)(
        windows ? "python.exe" : platform === "darwin" ? "/usr/bin/python3" : "python3",
        [
          "-I",
          "-S",
          "-B",
          // Windows receives the program on stdin; interop would otherwise re-quote it.
          ...(windows ? ["-"] : ["-c", deviceFilePrograms.posix]),
          Buffer.from(JSON.stringify(request)).toString("base64"),
        ],
        { timeout: 18_000, maxBuffer: 160 * 1024, encoding: "utf8" },
      );
      pending.child.stdin.on("error", () => {});
      pending.child.stdin.end(windows ? deviceFilePrograms.windows : undefined);
      const { stdout } = await pending;
      return JSON.parse(stdout);
    } catch (error) {
      if (error.signal === "SIGALRM" || error.killed || error.code === 124) {
        return {
          ok: false,
          statusCode: 504,
          error: windows
            ? "The file operation timed out on Windows. Try again."
            : "The file operation timed out. On macOS, check Files and Folders permissions for the Orion server or OpenClaw Node host, then try again.",
        };
      }
      // Missing runtimes, unsupported APIs and helper failures never enable pathname access.
      return {
        ok: false,
        statusCode: 503,
        error: windows
          ? "Sharing Windows folders from WSL requires Python 3.8 or newer for Windows (python.exe on the Node host's PATH) and WSL interop."
          : "Hardened file sharing requires Python 3.8 or newer and descriptor-relative filesystem support on this device.",
      };
    }
  }
  const { roots } = input;
  if (!wsl) return helper(false, roots ? { ...input, roots: roots.filter((root) => !isWindowsPath(root)) } : input);
  const sides = [true, false].map((windows) => ({
    windows,
    request: roots ? { ...input, roots: roots.filter((root) => isWindowsPath(root) === windows) } : input,
  }));
  if (input.operation === "roots") {
    const shared = [];
    for (const side of sides) {
      if (side.request.roots?.length === 0) continue;
      const result = await helper(side.windows, side.request);
      if (result?.ok !== true) return result;
      shared.push(...result.roots);
    }
    return { ok: true, roots: shared };
  }
  // Defaults: the POSIX helper shares only "linux-home" on WSL; everything else is Windows.
  const owner = roots ? roots.find((root) => root.id === input.rootId) : null;
  const windows = roots ? !owner || isWindowsPath(owner) : input.rootId !== "linux-home";
  return helper(windows, sides.find((side) => side.windows === windows).request);
}
