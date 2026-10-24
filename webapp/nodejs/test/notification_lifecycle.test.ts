import assert from "node:assert/strict";
import { test } from "node:test";
import {
  beginReset,
  enterRequest,
  finishReset,
  isInitializing,
  isResetting,
  leaveRequest,
} from "../src/notification_lifecycle.js";

test("reset rejects concurrent execution and drains existing requests", async () => {
  enterRequest();
  const reset = beginReset();
  assert.equal(isInitializing(), true);
  assert.equal(isResetting(), true);
  await assert.rejects(beginReset(), /reset already running/);
  leaveRequest();
  await reset;
  finishReset();
  assert.equal(isInitializing(), false);
});

test("a failed drain keeps traffic stopped and permits a subsequent reset", async () => {
  enterRequest();
  try {
    await assert.rejects(beginReset(), /requests did not drain/);
  } finally {
    leaveRequest();
  }
  assert.equal(isInitializing(), true);
  assert.equal(isResetting(), false);
  await beginReset();
  finishReset();
  assert.equal(isInitializing(), false);
});
