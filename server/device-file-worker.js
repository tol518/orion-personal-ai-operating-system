import { readFileSync } from "node:fs";

// Serialized with the fixed Node launcher for paired hosts; never supplied by a client.
export const deviceFilePrograms = {
  posix: readFileSync(new URL("./device-file-posix.py", import.meta.url), "utf8"),
  windows: readFileSync(new URL("./device-file-windows.py", import.meta.url), "utf8"),
};

/**
 * Runs one file operation on this device. A `stream` operation hands the range's bytes to
 * `sink(body, length)` when the server runs it locally; a paired host has no sink and uploads
 * them to the one-time `input.upload` address instead.
 */
export async function deviceFileOperation(input, sink) {
  const os = await import("node:os");
  const { execFile, spawn } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { access, readFile } = await import("node:fs/promises");
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
  // The upload ticket never reaches a helper's command line.
  const { upload, ...request } = input;
  const unavailable = (windows) => ({
    ok: false,
    statusCode: 503,
    error: windows
      ? "Sharing Windows folders from WSL requires Python 3.8 or newer for Windows and WSL interop."
      : "Hardened file sharing requires Python 3.8 or newer and descriptor-relative filesystem support on this device.",
  });

  // A node started by systemd inside WSL has no Windows PATH. Windows still knows where its
  // Python is, so ask it through cmd.exe on the drive WSL mounted as C:.
  async function windowsPython() {
    for (const directory of (process.env.PATH ?? "").split(":")) {
      if (await access(`${directory}/python.exe`).then(() => true, () => false))
        return { command: "python.exe", prefix: [] };
    }
    const table = await readFile("/proc/self/mountinfo", "utf8").catch(() => "");
    const system = table
      .split("\n")
      .map((line) => line.split(" "))
      .find((fields) => {
        const tail = fields.indexOf("-");
        return tail > 0 && ["9p", "drvfs"].includes(fields[tail + 1]) && /^C:(\\134|\\)?$/i.test(fields[tail + 2] ?? "");
      });
    if (!system) return { command: "python.exe", prefix: [] };
    const mount = system[4].replace(/\\([0-7]{3})/g, (_, code) => String.fromCharCode(parseInt(code, 8)));
    return { command: `${mount}/Windows/System32/cmd.exe`, prefix: ["/d", "/c", "python.exe"], cwd: mount };
  }

  async function launch(windows, payload) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
    if (!windows) {
      return {
        command: platform === "darwin" ? "/usr/bin/python3" : "python3",
        args: ["-I", "-S", "-B", "-c", deviceFilePrograms.posix, encoded],
      };
    }
    // Windows receives the program on stdin; interop would otherwise re-quote it.
    const python = await windowsPython();
    return {
      command: python.command,
      args: [...python.prefix, "-I", "-S", "-B", "-", encoded],
      stdin: deviceFilePrograms.windows,
      cwd: python.cwd,
    };
  }

  async function helper(windows, payload) {
    const { command, args, stdin, cwd } = await launch(windows, payload);
    try {
      const pending = promisify(execFile)(command, args, {
        cwd,
        timeout: 18_000,
        maxBuffer: 160 * 1024,
        encoding: "utf8",
      });
      pending.child.stdin.on("error", () => {});
      pending.child.stdin.end(stdin);
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
      return unavailable(windows);
    }
  }

  async function send(body, length) {
    let sending = false;
    try {
      const response = await fetch(upload.url, {
        method: "POST",
        duplex: "half",
        headers: {
          authorization: `Bearer ${upload.ticket}`,
          "content-type": "application/octet-stream",
          "x-orion-stream-length": String(length),
        },
        body: (async function* () {
          sending = true;
          yield* body;
        })(),
      });
      await response.body?.cancel();
      if (!response.ok) throw Object.assign(new Error("Orion refused the file stream."), { statusCode: 502 });
    } catch (error) {
      if (error.statusCode || sending) throw error;
      throw Object.assign(new Error("This computer could not reach Orion to send the file."), {
        statusCode: 503,
        unreachable: true,
      });
    }
  }

  async function stream(windows, payload) {
    const { command, args, stdin, cwd } = await launch(windows, payload);
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise((resolve) => {
      child.once("error", () => resolve(-1));
      child.once("close", (code) => resolve(code));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
    child.stderr.resume();
    const chunks = child.stdout[Symbol.asyncIterator]();
    try {
      // One JSON header line, then exactly `length` raw bytes.
      let buffered = Buffer.alloc(0);
      while (!buffered.includes(10) && buffered.length < 4096) {
        const next = await chunks.next();
        if (next.done) break;
        buffered = Buffer.concat([buffered, next.value]);
      }
      const newline = buffered.indexOf(10);
      const header = newline === -1 ? null : JSON.parse(buffered.subarray(0, newline).toString("utf8"));
      if (header?.ok !== true) {
        child.kill();
        return header ?? unavailable(windows);
      }
      const rest = buffered.subarray(newline + 1);
      const body = (async function* () {
        if (rest.length) yield rest;
        for (;;) {
          const next = await chunks.next();
          if (next.done) break;
          yield next.value;
        }
        // The helper re-checks the file after the last byte; a failure there fails the transfer.
        if ((await exited) !== 0) throw new Error("The file changed while it was being sent.");
      })();
      await (sink ?? send)(body, header.length);
      return { ok: true, sentBytes: header.length };
    } catch (error) {
      child.kill();
      return {
        ok: false,
        statusCode: error.statusCode ?? 409,
        error: error.statusCode ? error.message : "The file changed or the transfer was interrupted.",
        ...(error.unreachable ? { streamUnavailable: true } : {}),
      };
    }
  }

  const run = request.operation === "stream" ? stream : helper;
  const { roots } = request;
  if (!wsl) return run(false, roots ? { ...request, roots: roots.filter((root) => !isWindowsPath(root)) } : request);
  const sides = [true, false].map((windows) => ({
    windows,
    payload: roots ? { ...request, roots: roots.filter((root) => isWindowsPath(root) === windows) } : request,
  }));
  if (request.operation === "roots") {
    const shared = [];
    for (const side of sides) {
      if (side.payload.roots?.length === 0) continue;
      const result = await helper(side.windows, side.payload);
      if (result?.ok !== true) return result;
      shared.push(...result.roots);
    }
    return { ok: true, roots: shared };
  }
  // Defaults: the POSIX helper shares only "linux-home" on WSL; everything else is Windows.
  const owner = roots ? roots.find((root) => root.id === request.rootId) : null;
  const windows = roots ? !owner || isWindowsPath(owner) : request.rootId !== "linux-home";
  return run(windows, sides.find((side) => side.windows === windows).payload);
}
