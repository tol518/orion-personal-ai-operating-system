import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createCvHtml } from "./cv-html-template.js";

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export async function createCvPdf({ content, sourceName = null, links = [] }) {
  const chrome = await findChrome();
  if (!chrome) {
    throw new Error("Locked CV rendering requires Google Chrome or Chromium on the JARVIS host");
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-cv-render-"));
  const htmlPath = path.join(directory, "cv.html");
  const pdfPath = path.join(directory, "cv.pdf");
  const profilePath = path.join(directory, "chrome-profile");
  try {
    await fs.writeFile(htmlPath, createCvHtml({ content, sourceName, links }), {
      encoding: "utf8",
      mode: 0o600,
    });
    await runChrome(chrome, [
      "--headless",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-pdf-header-footer",
      "--run-all-compositor-stages-before-draw",
      `--user-data-dir=${profilePath}`,
      `--print-to-pdf=${pdfPath}`,
      pathToFileURL(htmlPath).href,
    ], pdfPath);
    const pdf = await fs.readFile(pdfPath);
    if (pdf.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new Error("Locked CV renderer returned an invalid PDF");
    }
    return pdf;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Keep looking for the next supported system browser.
    }
  }
  return null;
}

function runChrome(executable, args, pdfPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    let pdfReady = false;
    let previousSize = 0;
    let stablePolls = 0;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      child.stderr.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        return;
      }
      finish(new Error("Locked CV rendering timed out"));
    }, 30_000);
    const poll = setInterval(async () => {
      try {
        const { size } = await fs.stat(pdfPath);
        stablePolls = size > 0 && size === previousSize ? stablePolls + 1 : 0;
        previousSize = size;
        if (stablePolls >= 2 && !pdfReady) {
          pdfReady = true;
          if (child.exitCode === null) child.kill("SIGKILL");
        }
      } catch {
        stablePolls = 0;
      }
    }, 100);
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2_000);
    });
    child.once("error", (error) => {
      finish(error);
    });
    child.once("exit", (code) => {
      if (pdfReady || code === 0) finish();
      else finish(new Error(`Locked CV renderer failed${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}
