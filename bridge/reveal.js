#!/usr/bin/env node

import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const requestedPath = String(process.argv[2] || "");
if (!requestedPath) process.exit(0);
const path = resolve(requestedPath);

const uri = pathToFileURL(path).href;
const parent = dirname(path);

// org.freedesktop.FileManager1 is the cross-desktop reveal contract used by
// Nautilus, Dolphin, Nemo, and other file managers. It asks the user's file
// manager to show and select an item without knowing which manager they use.
execFile("gdbus", [
  "call", "--session",
  "--dest", "org.freedesktop.FileManager1",
  "--object-path", "/org/freedesktop/FileManager1",
  "--method", "org.freedesktop.FileManager1.ShowItems",
  `[${JSON.stringify(uri)}]`, "",
], { timeout: 2500 }, (error) => {
  if (!error) return;
  // A minimal file manager may not implement ShowItems. Opening the parent is
  // the portable fallback; unlike opening the item, it cannot launch a viewer
  // for the selected file's data type.
  execFile("xdg-open", [parent], { timeout: 2500 }, () => {});
});
