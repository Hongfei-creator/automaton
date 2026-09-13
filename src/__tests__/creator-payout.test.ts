/**
 * Creator Payout Task Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  creatorPayoutTask,
  PAYOUT_FRACTION,
  SAFETY_MULTIPLE,
} from "../heartbeat/creator-payout.js";
import {
  MockConwayClient,
  createTestDb,
  createTestIdentity,
  createTestConfig,
} from "./mocks.js";
import type {
  AutomatonDatabase,
  TickContext,
  HeartbeatLegacyContext,
} from "../types.js";
import { DEFAULT_TREASURY_POLICY } from "../types.js";

function createMockTickContext(
  db: AutomatonDatabase,
  overrides?: Partial<TickContext>,
): TickContext {
  return {
    tickId: "test-tick-1",
    startedAt: new Date(),
    creditBalance: 10_000,
    usdcBalance: 0,
    survivalTier: "normal",
    lowComputeMultiplier: 4,
    config: { entries: [], defaultIntervalMs: 60_000, lowComputeMultiplier: 4 },
    db: db.raw,
    ...overrides,
  };
}

describe("creator_payout task", () => {
  let db: AutomatonDatabase;
  let conway: MockConwayClient;

  beforeEach(() => {
    db = createTestDb();
    conway = new MockConwayClient();
  });

  afterEach(() => {
    db.close();
  });

  it("does nothing below the trigger balance", async () => {
    const tickCtx = createMockTickContext(db, { creditBalance: 1000 }); // $10
    const taskCtx: HeartbeatLegacyContext = {
      identity: createTestIdentity(),
      config: createTestConfig({ treasuryPolicy: DEFAULT_TREASURY_POLICY }),
      db,
      conway,
    };

    conway.creditsCents = 1000;
    const result = await creatorPayoutTask(tickCtx, taskCtx);

    expect(result.shouldWake).toBe(false);
    expect(db.getKV("last_creator_payout")).toBeUndefined();
  });

  it("pays out a fraction of surplus once above the trigger, leaving runway behind", async () => {
    const treasuryPolicy = { ...DEFAULT_TREASURY_POLICY, minimumReserveCents: 1000 };
    const balance = 10_000; // $100
    const tickCtx = createMockTickContext(db, { creditBalance: balance });
    const taskCtx: HeartbeatLegacyContext = {
      identity: createTestIdentity(),
      config: createTestConfig({ treasuryPolicy }),
      db,
      conway,
    };
    conway.creditsCents = balance;

    const result = await creatorPayoutTask(tickCtx, taskCtx);

    const floor = treasuryPolicy.minimumReserveCents * (SAFETY_MULTIPLE - 1);
    const expectedPayout = Math.floor((balance - floor) * PAYOUT_FRACTION);

    expect(result.message).toContain("Sent scheduled creator payout");
    expect(conway.creditsCents).toBe(balance - expectedPayout);

    const record = JSON.parse(db.getKV("last_creator_payout")!);
    expect(record.amountCents).toBe(expectedPayout);
    expect(record.toAddress).toBe(taskCtx.config.creatorAddress);

    // Runway left behind must be at least the pre-payout floor.
    expect(conway.creditsCents).toBeGreaterThanOrEqual(floor);
  });

  it("never pays out more than half the balance (mirrors transfer_credits self-preservation guard)", async () => {
    const treasuryPolicy = {
      ...DEFAULT_TREASURY_POLICY,
      minimumReserveCents: 100, // tiny reserve so the fraction alone would exceed 50%
      maxSingleTransferCents: 1_000_000, // effectively uncapped, to isolate the 50% guard
    };
    const balance = 5_000;
    const tickCtx = createMockTickContext(db, { creditBalance: balance });
    const taskCtx: HeartbeatLegacyContext = {
      identity: createTestIdentity(),
      config: createTestConfig({ treasuryPolicy }),
      db,
      conway,
    };
    conway.creditsCents = balance;

    await creatorPayoutTask(tickCtx, taskCtx);

    expect(conway.creditsCents).toBeGreaterThanOrEqual(balance / 2);
  });

  it("respects maxSingleTransferCents", async () => {
    const treasuryPolicy = {
      ...DEFAULT_TREASURY_POLICY,
      minimumReserveCents: 100,
      maxSingleTransferCents: 50, // very tight cap
    };
    const balance = 50_000;
    const tickCtx = createMockTickContext(db, { creditBalance: balance });
    const taskCtx: HeartbeatLegacyContext = {
      identity: createTestIdentity(),
      config: createTestConfig({ treasuryPolicy }),
      db,
      conway,
    };
    conway.creditsCents = balance;

    await creatorPayoutTask(tickCtx, taskCtx);

    expect(conway.creditsCents).toBe(balance - 50);
  });

  it("does not pay out again before the minimum gap has elapsed", async () => {
    const treasuryPolicy = { ...DEFAULT_TREASURY_POLICY, minimumReserveCents: 1000 };
    const balance = 10_000;
    const taskCtx: HeartbeatLegacyContext = {
      identity: createTestIdentity(),
      config: createTestConfig({ treasuryPolicy }),
      db,
      conway,
    };
    conway.creditsCents = balance;

    const first = await creatorPayoutTask(
      createMockTickContext(db, { creditBalance: conway.creditsCents }),
      taskCtx,
    );
    expect(first.message).toContain("Sent scheduled creator payout");

    const balanceAfterFirst = conway.creditsCents;
    const second = await creatorPayoutTask(
      createMockTickContext(db, { creditBalance: conway.creditsCents }),
      taskCtx,
    );

    expect(second.shouldWake).toBe(false);
    expect(second.message).toBeUndefined();
    expect(conway.creditsCents).toBe(balanceAfterFirst); // unchanged
  });

  it("does nothing when no creator address is configured", async () => {
    const tickCtx = createMockTickContext(db, { creditBalance: 100_000 });
    const taskCtx: HeartbeatLegacyContext = {
      identity: createTestIdentity(),
      config: createTestConfig({
        treasuryPolicy: DEFAULT_TREASURY_POLICY,
        creatorAddress: "" as any,
      }),
      db,
      conway,
    };
    conway.creditsCents = 100_000;

    const result = await creatorPayoutTask(tickCtx, taskCtx);

    expect(result.shouldWake).toBe(false);
    expect(conway.creditsCents).toBe(100_000);
  });
});
