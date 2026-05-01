import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, http } from "viem";
import { hardhat } from "viem/chains";
import { HashPowerPerpsDEXAbi as hashPowerPerpsDexAbi } from "../../contracts/abi/HashPowerPerpsDEX.ts";
import { serializeError } from "../src/errSerializer.ts";

describe("serializeError", () => {
  it("passes through a short error with message and stack", () => {
    const err = new Error("short");
    err.stack = "Error: short\n    at Object.<anonymous> (test.ts:1:1)";
    const out = serializeError(err);

    assert.equal(out.message, "short");
    assert.equal(out.stack, "Error: short\n    at Object.<anonymous> (test.ts:1:1)");
  });

  it("preserves long message without truncation", () => {
    const msg = "x".repeat(200);
    const err = new Error(msg);
    const out = serializeError(err);

    assert.equal(out.message, msg);
  });

  it("preserves full stack without truncation", () => {
    const err = new Error("boom");
    err.stack = "Error: boom\n" + "    at fn (file.ts:1:1)\n".repeat(10);
    const out = serializeError(err);

    assert.equal(out.stack, err.stack);
  });

  it("includes cause via errWithCause", () => {
    const inner = new Error("root cause");
    inner.stack = "Error: root cause\n    at fn (file.ts:1:1)";
    const outer = new Error("wrapper", { cause: inner });
    const out = serializeError(outer);

    assert.ok(out.cause);
    const cause = out.cause as Record<string, unknown>;
    assert.equal(cause.message, "root cause");
    assert.ok(cause.stack);
  });

  it("handles non-Error input gracefully", () => {
    const out = serializeError("not an error");
    assert.equal(out.raw, "not an error");
  });

  it("handles null input gracefully", () => {
    const out = serializeError(null);
    assert.deepEqual(out, { raw: null });
  });

  it("strips abi from viem ContractFunctionExecutionError", async () => {
    const client = createPublicClient({
      chain: hardhat,
      transport: http("http://127.0.0.1:1"),
    });

    let viemErr: unknown;
    try {
      await client.readContract({
        address: "0x0000000000000000000000000000000000000001",
        abi: hashPowerPerpsDexAbi,
        functionName: "getOrder",
        args: ["0x" + "00".repeat(32) as `0x${string}`],
      });
    } catch (err) {
      viemErr = err;
    }

    assert.ok(viemErr instanceof Error);

    const out = serializeError(viemErr);

    assert.equal(out.abi, undefined, "abi should be stripped");
    assert.ok(out.shortMessage, "shortMessage should be kept");
    assert.ok(out.contractAddress || out.functionName, "contract context should be kept");
    assert.ok(out.cause, "cause should be serialized");
  });
});
