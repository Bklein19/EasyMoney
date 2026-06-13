import { expect, test } from "bun:test";
import { verify } from "./rebuild";

test("rebuild is independent of raw import file order", async () => {
  const result = await verify({ sampleSize: 32, permutations: 8 });

  expect(result.tx).toBeGreaterThan(0);
  expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(result.seed).toMatch(/^[a-f0-9]{32}$/);
}, 20_000);
