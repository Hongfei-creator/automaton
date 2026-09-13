/**
 * Creator Payout Task
 *
 * Deterministic, code-enforced profit sharing. This does NOT ask the agent's
 * LLM loop to "decide" whether to pay its creator — that decision is a
 * judgment call the agent could rationalize its way out of forever, since
 * Law II ("earn your existence") and its own survival pressure both push it
 * toward hoarding/reinvesting instead. This task removes that discretion for
 * a fixed slice of profit: on schedule, plain code computes a payout and
 * calls the same transferCredits API the agent's own transfer_credits tool
 * uses, no LLM turn involved.
 *
 * Tunable via the constants below. Defaults:
 *   - Only pays out once balance clears (minimumReserveCents * SAFETY_MULTIPLE).
 *   - Pays PAYOUT_FRACTION of the amount above (minimumReserveCents * SAFETY_MULTIPLE - 1)*,
 *     i.e. it always leaves at least (minimumReserveCents * (SAFETY_MULTIPLE - 1)) cents
 *     of runway behind after paying out.
 *   - Capped at the creator's own configured maxSingleTransferCents.
 *   - Minimum gap between payouts enforced independently of the cron schedule,
 *     as a safety net.
 */

import type { TickContext, HeartbeatLegacyContext } from "../types.js";
import { createLogger } from "../observability/logger.js";
import { ulid } from "ulid";

const logger = createLogger("heartbeat.creator-payout");

// ── Tunables ────────────────────────────────────────────────────
/** Fraction of eligible surplus paid to the creator each time this runs. */
export const PAYOUT_FRACTION = 0.3;
/** Balance must exceed reserve * this multiple before any payout triggers. */
export const SAFETY_MULTIPLE = 3;
/** Floor below which we never trigger, even if minimumReserveCents is 0. */
export const MIN_TRIGGER_BALANCE_CENTS = 1500; // $15
/** Don't pay out more often than this, regardless of cron schedule. */
export const MIN_PAYOUT_GAP_MS = 6 * 24 * 60 * 60 * 1000; // 6 days

export async function creatorPayoutTask(
  ctx: TickContext,
  taskCtx: HeartbeatLegacyContext,
): Promise<{ shouldWake: boolean; message?: string }> {
  const creatorAddress = taskCtx.config.creatorAddress;
  if (!creatorAddress) {
    return { shouldWake: false };
  }

  const policy = taskCtx.config.treasuryPolicy;
  const reserveCents = Math.max(
    policy?.minimumReserveCents ?? 1000,
    MIN_TRIGGER_BALANCE_CENTS / SAFETY_MULTIPLE,
  );
  const triggerBalanceCents = Math.max(
    reserveCents * SAFETY_MULTIPLE,
    MIN_TRIGGER_BALANCE_CENTS,
  );

  const balance = ctx.creditBalance;

  if (balance < triggerBalanceCents) {
    return { shouldWake: false };
  }

  // Independent cooldown, in case the cron schedule ever fires more often
  // than intended (e.g. misconfiguration, manual re-trigger).
  const lastPayoutAt = taskCtx.db.getKV("last_creator_payout_at");
  if (lastPayoutAt) {
    const elapsed = Date.now() - new Date(lastPayoutAt).getTime();
    if (elapsed < MIN_PAYOUT_GAP_MS) {
      return { shouldWake: false };
    }
  }

  const floor = reserveCents * (SAFETY_MULTIPLE - 1);
  const surplus = balance - floor;
  if (surplus <= 0) {
    return { shouldWake: false };
  }

  let payoutCents = Math.floor(surplus * PAYOUT_FRACTION);

  const maxSingle = policy?.maxSingleTransferCents;
  if (typeof maxSingle === "number" && maxSingle > 0) {
    payoutCents = Math.min(payoutCents, maxSingle);
  }

  // transfer_credits' own self-preservation guard blocks >50% of balance;
  // mirror that here so we never even attempt a blocked transfer.
  payoutCents = Math.min(payoutCents, Math.floor(balance / 2));

  if (payoutCents <= 0) {
    return { shouldWake: false };
  }

  try {
    const transfer = await taskCtx.conway.transferCredits(
      creatorAddress,
      payoutCents,
      "Scheduled creator payout (automated, code-enforced)",
    );

    taskCtx.db.insertTransaction({
      id: ulid(),
      type: "transfer_out",
      amountCents: payoutCents,
      balanceAfterCents:
        transfer.balanceAfterCents ?? Math.max(balance - payoutCents, 0),
      description: `Scheduled creator payout to ${creatorAddress}`,
      timestamp: new Date().toISOString(),
    });

    taskCtx.db.setKV("last_creator_payout_at", new Date().toISOString());
    taskCtx.db.setKV(
      "last_creator_payout",
      JSON.stringify({
        amountCents: payoutCents,
        toAddress: creatorAddress,
        status: transfer.status,
        transferId: transfer.transferId,
        timestamp: new Date().toISOString(),
      }),
    );

    logger.info("Creator payout sent", {
      amountCents: payoutCents,
      toAddress: creatorAddress,
      status: transfer.status,
    });

    return {
      shouldWake: false,
      message: `Sent scheduled creator payout: $${(payoutCents / 100).toFixed(2)} to ${creatorAddress}.`,
    };
  } catch (err: any) {
    logger.warn("Creator payout failed", { error: err?.message || String(err) });
    // Don't set last_creator_payout_at on failure — retry next tick.
    return { shouldWake: false };
  }
}
