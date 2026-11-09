import test from "node:test";
import assert from "node:assert/strict";
import { formatDateTime } from "../src/domain/datetime.js";
test("missing and invalid dates differ from epoch zero", () => {
  for (const d of [null, undefined, "", "bad"])
    assert.equal(formatDateTime(d), "--");
  assert.match(formatDateTime(0), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/);
});
