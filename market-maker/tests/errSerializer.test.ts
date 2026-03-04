import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, http } from "viem";
import { hardhat } from "viem/chains";
import { perpsSimpleAbi } from "../src/abi.ts";
import { trimmedErrSerializer } from "../src/errSerializer.ts";

describe("trimmedErrSerializer", () => {
  it("passes through a short error unchanged", () => {
    const err = new Error("short");
    err.stack = "Error: short\n    at Object.<anonymous> (test.ts:1:1)";
    const out = trimmedErrSerializer(err);

    assert.equal(out.message, "short");
    assert.equal(out.stack, "Error: short\n    at Object.<anonymous> (test.ts:1:1)");
    assert.ok(!(out.stack as string).includes("trimmed"));
  });

  it("preserves fields at exactly 100 chars", () => {
    const msg = "x".repeat(100);
    const err = new Error(msg);
    const out = trimmedErrSerializer(err);

    assert.equal(out.message, msg);
    assert.ok(!(out.message as string).includes("trimmed"));
  });

  it("truncates stack exceeding 100 chars", () => {
    const err = new Error("boom");
    err.stack = "Error: boom\n" + "    at fn (file.ts:1:1)\n".repeat(10);
    const out = trimmedErrSerializer(err);

    const stack = out.stack as string;
    assert.ok(stack.length < (err.stack as string).length);
    assert.ok(stack.startsWith("Error: boom"));
    assert.ok(stack.includes("chars trimmed)"));
    assert.ok(stack.slice(0, stack.lastIndexOf("\n")).length <= 100);
  });

  it("truncates long message", () => {
    const err = new Error("a".repeat(200));
    const out = trimmedErrSerializer(err);

    const msg = out.message as string;
    assert.ok(msg.includes("(100 chars trimmed)"));
    assert.ok(msg.slice(0, msg.lastIndexOf("\n")).length === 100);
  });

  it("truncates details field when present", () => {
    const err = new Error("contract revert");
    (err as unknown as Record<string, unknown>).details = "d".repeat(300);
    const out = trimmedErrSerializer(err);

    const details = out.details as string;
    assert.ok(details.includes("(200 chars trimmed)"));
    assert.ok(details.slice(0, details.lastIndexOf("\n")).length === 100);
  });

  it("recursively trims nested cause", () => {
    const inner = new Error("root cause");
    inner.stack = "Error: root cause\n" + "    at fn (file.ts:1:1)\n".repeat(40);
    const outer = new Error("wrapper", { cause: inner });
    const out = trimmedErrSerializer(outer);

    assert.ok(out.cause);
    const cause = out.cause as Record<string, unknown>;
    const causeStack = cause.stack as string;
    assert.ok(causeStack.includes("chars trimmed)"));
  });

  it("handles deeply nested cause chain", () => {
    const deep = new Error("deep");
    deep.stack = "Error: deep\n" + "    at fn (file.ts:1:1)\n".repeat(40);
    const mid = new Error("mid", { cause: deep });
    const top = new Error("top", { cause: mid });
    const out = trimmedErrSerializer(top);

    const midCause = out.cause as Record<string, unknown>;
    assert.ok(midCause);
    const deepCause = midCause.cause as Record<string, unknown>;
    assert.ok(deepCause);
    assert.ok((deepCause.stack as string).includes("chars trimmed)"));
  });

  it("handles non-Error input gracefully", () => {
    const out = trimmedErrSerializer("not an error");
    assert.equal(out.raw, "not an error");
  });

  it("handles null input gracefully", () => {
    const out = trimmedErrSerializer(null);
    assert.deepEqual(out, { raw: null });
  });

  it("truncates viem ContractFunctionExecutionError", async () => {
    const client = createPublicClient({
      chain: hardhat,
      transport: http("http://127.0.0.1:1"),
    });

    let viemErr: unknown;
    try {
      await client.readContract({
        address: "0x0000000000000000000000000000000000000001",
        abi: perpsSimpleAbi,
        functionName: "getOrder",
        args: ["0x" + "00".repeat(32)],
      });
    } catch (err) {
      viemErr = err;
    }

    assert.ok(viemErr instanceof Error);
    assert.ok(viemErr.message.length > 100, "raw message should exceed limit");

    const out = trimmedErrSerializer(viemErr);

    // message and stack are truncated
    assert.ok((out.message as string).includes("chars trimmed"));
    assert.ok((out.stack as string).includes("chars trimmed"));
    assert.ok((out.message as string).length < viemErr.message.length);

    // large viem-specific fields are stripped
    assert.equal(out.abi, undefined, "abi should be stripped");
    assert.equal(out.args, undefined, "args should be stripped");
    assert.equal(out.formattedArgs, undefined, "formattedArgs should be stripped");

    // useful context is preserved
    assert.ok(out.shortMessage, "shortMessage should be kept");
    assert.ok(out.contractAddress || out.functionName, "contract context should be kept");

    // cause chain is serialized
    assert.ok(out.cause, "cause should be serialized");

    // overall serialized size is bounded
    const json = JSON.stringify(out);
    assert.ok(json.length < 2000, `serialized JSON too large: ${json.length} chars`);
  });
});
