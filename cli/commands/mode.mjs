#!/usr/bin/env node
// openclaw-bridge mode              → prints current mode
// openclaw-bridge mode set <mode>   → switches "single" ↔ "multi"
//
// Switching to "multi" refuses unless at least one account is registered AND
// the user types an explicit confirmation, to mirror the installer guard.

import { loadRegistry, saveRegistry, die } from "./_common.mjs";
import readline from "node:readline";

const args = process.argv.slice(2);
const cmd = args[0];

if (!cmd) {
  const reg = loadRegistry();
  console.log(reg.mode || "single");
  process.exit(0);
}

if (cmd === "set") {
  const mode = args[1];
  if (!mode || !["single", "multi"].includes(mode)) {
    die("usage: openclaw-bridge mode set <single|multi>", 2);
  }
  const reg = loadRegistry();
  if (reg.mode === mode) {
    console.log(`mode already ${mode}`);
    process.exit(0);
  }
  if (mode === "multi") {
    if (reg.accounts.length === 0) {
      die("refusing to enable multi mode with zero accounts — run 'openclaw-bridge accounts add <label>' first.");
    }
    if (process.stdin.isTTY) {
      await confirmRisk(reg.accounts.length);
    } else {
      die("multi mode requires interactive confirmation; run this in a terminal.");
    }
  }
  reg.mode = mode;
  saveRegistry(reg);
  console.log(`mode set to ${mode}. Reload the proxy with: openclaw-bridge reload`);
  process.exit(0);
}

die(`unknown subcommand: ${cmd}`, 2);

async function confirmRisk(accountCount) {
  const msg = `
  MULTI-ACCOUNT ROTATION MODE
   This rotates calls across ${accountCount} Claude Max accounts to avoid
   rate/usage limits. Anthropic may treat this as abuse of the Services
   and terminate ALL linked accounts simultaneously, not just one.
   You are solely responsible for this choice.
   Type 'I accept the risk' to continue: `;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(msg, resolve));
  rl.close();
  if (answer.trim() !== "I accept the risk") {
    die("aborted — exact phrase not entered.");
  }
}
