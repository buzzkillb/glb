// ---------------------------------------------------------------------------
// Risk gate helpers (pure)
// ---------------------------------------------------------------------------
// The engine's hard-stop logic used to short-circuit on `paused`, which made the
// UNREALIZED draw-down pause a permanent latch: once a single one-off underwater
// mark (or a bad price print) tripped it, the bot never re-evaluated and stayed
// frozen forever, forfeiting every future fill.
//
// The unrealized pause is a TRANSIENT market condition, not a banked loss, so it
// must clear when the open book recovers. The realized stop is a banked loss and
// stays latched. These helpers keep that distinction pure and unit-testable so
// it can't regress back into a permanent freeze.
// ---------------------------------------------------------------------------

/** The pause reason string written by the unrealized draw-down guard. */
export const UNREALIZED_PAUSE_PREFIX = 'unrealized loss';

/** Compute the USD loss threshold, or null when the guard is disabled. */
export function unrealizedThresholdUsd(maxUsdcPosition: number, unrealizedHardStopPct: number): number | null {
  if (!(maxUsdcPosition > 0) || !(unrealizedHardStopPct > 0)) return null;
  return maxUsdcPosition * unrealizedHardStopPct;
}

/** True when the open book is underwater past the unrealized threshold. */
export function unrealizedTriggered(
  unrealizedPnlUsd: number,
  maxUsdcPosition: number,
  unrealizedHardStopPct: number
): boolean {
  const t = unrealizedThresholdUsd(maxUsdcPosition, unrealizedHardStopPct);
  if (t === null) return false;
  return unrealizedPnlUsd <= -t;
}

/**
 * Decide whether an EXISTING unrealized-drawdown pause should be CLEARED.
 *
 * Returns true only when the bot is currently paused for the unrealized reason
 * AND the open book is now back within the threshold (or the guard is disabled).
 * A realized-loss pause is never cleared here.
 */
export function unrealizedPauseCleared(
  paused: boolean,
  pauseReason: string,
  unrealizedPnlUsd: number,
  maxUsdcPosition: number,
  unrealizedHardStopPct: number
): boolean {
  if (!paused || !pauseReason.startsWith(UNREALIZED_PAUSE_PREFIX)) return false;
  return !unrealizedTriggered(unrealizedPnlUsd, maxUsdcPosition, unrealizedHardStopPct);
}
