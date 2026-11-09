import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { watchDownloadIdle } from "../electron/providers/download-idle.js";
test("late body close cannot disable the idle guard of a reused keep-alive socket", () => {
  const socket = new EventEmitter();
  socket.setTimeout = (value) => {
    socket.timeout = value;
  };
  const firstTimeout = () => assert.fail("retired download must not time out");
  const first = watchDownloadIdle({ socket }, 400, firstTimeout);
  first(); // end
  const second = watchDownloadIdle({ socket }, 500, () => {});
  first(); // later close from the old response
  assert.equal(socket.timeout, 500);
  assert.equal(socket.listenerCount("timeout"), 1);
  second();
  assert.equal(socket.listenerCount("timeout"), 0);
});
