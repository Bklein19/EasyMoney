import { expect, test } from "bun:test";
import { verify } from "./rebuild";

test("rebuild is independent of raw import file order", async () => {
  const result = await verify({ sampleSize: 32, seed: "bun-test" });

  expect(result.tx).toBeGreaterThan(0);
  expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
}, 20_000);
