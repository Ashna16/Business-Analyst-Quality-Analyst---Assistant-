#!/usr/bin/env node
import { mkdirSync, readdirSync, watch } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config, mockMode } from "./config.js";
import { runPipeline } from "./pipeline.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const MEET_GENERATED_DIR = resolve(root, "..", "google-meet-replica", "generated");

const rawArgs = process.argv.slice(2);
const wantsHelp = rawArgs.includes("--help") || rawArgs.includes("-h");
const wantsWatch = rawArgs.includes("--watch");
const transcriptPath = rawArgs.find((a) => !a.startsWith("--"));

async function printResult(result: Awaited<ReturnType<typeof runPipeline>>) {
  console.log("\n--- Parsed items ---");
  for (const i of result.items) {
    console.log(`- [${i.kind}] ${i.title}`);
  }
  console.log("\n--- Output files ---");
  for (const f of result.writtenFiles) {
    console.log(f);
  }
}

async function runWatchMode() {
  try {
    mkdirSync(MEET_GENERATED_DIR, { recursive: true });
  } catch {
    /* ignore */
  }

  const knownMd = new Set<string>();
  for (const name of readdirSync(MEET_GENERATED_DIR)) {
    if (name.endsWith(".md")) {
      knownMd.add(resolve(MEET_GENERATED_DIR, name));
    }
  }

  console.log("[baqa] watch: OpenClaw URL:", config.openclawGatewayUrl);
  console.log("[baqa] watch: mockMode:", mockMode);
  console.log("[baqa] watch: scanning:", MEET_GENERATED_DIR);
  console.log("[baqa] watch: baseline", knownMd.size, "existing .md file(s) (skipped)");

  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleScan = () => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      void handleNewFiles();
    }, 250);
  };

  async function handleNewFiles() {
    let names: string[];
    try {
      names = readdirSync(MEET_GENERATED_DIR);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".md")) {
        continue;
      }
      const abs = resolve(MEET_GENERATED_DIR, name);
      if (knownMd.has(abs)) {
        continue;
      }
      knownMd.add(abs);
      console.log("🚀 New Meeting Segment Detected! Processing...");
      try {
        const result = await runPipeline(abs);
        await printResult(result);
      } catch (err) {
        console.error("[baqa] pipeline error:", err);
      }
    }
  }

  try {
    watch(MEET_GENERATED_DIR, { persistent: true }, () => scheduleScan());
  } catch (err) {
    console.warn("[baqa] fs.watch failed, using poll only:", err);
  }

  setInterval(() => scheduleScan(), 5000);

  scheduleScan();
}

if (wantsHelp) {
  console.log(`Usage:
  One-shot:  pnpm run start -- <path-to-transcript.txt|md>
  Watch:     pnpm run start -- --watch
             (or omit the path to watch ${MEET_GENERATED_DIR})`);
  process.exit(0);
}

if (transcriptPath && !wantsWatch) {
  const abs = resolve(transcriptPath);
  console.log("[baqa] OpenClaw URL:", config.openclawGatewayUrl);
  console.log("[baqa] mockMode:", mockMode);
  console.log("[baqa] transcript:", abs);

  const result = await runPipeline(abs);
  await printResult(result);
} else if (transcriptPath && wantsWatch) {
  console.error("[baqa] Pass either a transcript file or --watch, not both.");
  process.exit(1);
} else {
  await runWatchMode();
}
