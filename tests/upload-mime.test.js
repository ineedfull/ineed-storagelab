import test from "node:test";
import assert from "node:assert/strict";
import { inferUploadContentType } from "../electron/transfers/upload.js";
test("native upload infers conservative metadata from filename without content claim", () => {
  for (const [name, type] of [
    ["a.TXT", "text/plain"],
    ["a.json", "application/json"],
    ["a.png", "image/png"],
    ["a.jpeg", "image/jpeg"],
    ["a.gif", "image/gif"],
    ["a.webp", "image/webp"],
    ["a.svg", "application/octet-stream"],
    ["a.html", "application/octet-stream"],
    ["no-extension", "application/octet-stream"],
  ])
    assert.equal(inferUploadContentType(name), type);
});
