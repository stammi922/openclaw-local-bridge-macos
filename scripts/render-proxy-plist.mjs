#!/usr/bin/env node
// Render the proxy plist template, substituting placeholders with
// XML-escaped values. Output is written to stdout.
//
// Usage: node render-proxy-plist.mjs --template <path> \
//          --home <path> --node <path> --proxy-home <path> \
//          --port <int> --path <PATH-string>

import fs from "node:fs";
import process from "node:process";

function getArg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i === process.argv.length - 1) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return process.argv[i + 1];
}

const template   = getArg("template");
const home       = getArg("home");
const nodeBin    = getArg("node");
const proxyHome  = getArg("proxy-home");
const port       = getArg("port");
const pathValue  = getArg("path");

if (!fs.existsSync(template)) {
  console.error(`template not found: ${template}`);
  process.exit(1);
}

function xmlEscape(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const subs = {
  HOME:        xmlEscape(home),
  NODE_BIN:    xmlEscape(nodeBin),
  PROXY_HOME:  xmlEscape(proxyHome),
  PORT:        xmlEscape(port),
  PATH:        xmlEscape(pathValue),
};

let body = fs.readFileSync(template, "utf8");
for (const [k, v] of Object.entries(subs)) {
  body = body.replaceAll(`{{${k}}}`, v);
}

// Sanity: any leftover placeholders mean we missed a substitution.
const leftover = body.match(/\{\{[A-Z_]+\}\}/g);
if (leftover) {
  console.error(`template has un-substituted placeholders: ${[...new Set(leftover)].join(", ")}`);
  process.exit(1);
}

process.stdout.write(body);
