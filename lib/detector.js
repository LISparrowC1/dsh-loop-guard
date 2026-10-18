/**
 * Pure repetition detection over streamed model output.
 *
 * Two independent detectors run over the same rolling tail, because they fail
 * on opposite inputs:
 *
 * - the periodic detector finds an exact unit repeated at the very end of the
 *   tail (any unit length, so a short unit like "。（输出。）" is caught), but it
 *   only sees repeats that reach the tail boundary;
 * - the shingle detector finds one fixed-width shingle covering a large share
 *   of the window, so a repeated span buried mid-window or separated by a
 *   drifting suffix is still caught, at the cost of a coverage requirement
 *   that keeps ordinary prose and tables below the threshold.
 *
 * Both are bounded: no input makes either scan grow with anything but the
 * configured window.
 *
 * @module dsh-loop-guard/detector
 */

/** Fixed shingle width; also the reported unit length of a shingle hit. */
const SHINGLE_LENGTH = 64
/** Distance between sampled shingle starts. */
const SHINGLE_STRIDE = 32

/**
 * Default detector thresholds. Conservative on purpose: a false positive
 * discards a model response, so the bar is "most of the window is the same
 * text", not "some text repeats".
 */
export const DETECTOR_DEFAULTS = Object.freeze({
  minUnitChars: 6,
  maxUnitChars: 80,
  minRepeats: 8,
  minSpanChars: 400,
  windowChars: 4096,
  maxCopies: 64,
  minShingleOccurrences: 4,
  minShingleCoverage: 0.5,
})

/**
 * Find a unit that repeats to the very end of `tail`.
 * @param tail - rolling text window.
 * @param bounds - detector thresholds.
 * @returns the hit, or `null` when no unit reaches the repeat count.
 */
function detectPeriodic(tail, bounds) {
  const { minUnitChars, maxUnitChars, minRepeats, minSpanChars, maxCopies } = bounds
  const maxUnit = Math.min(maxUnitChars, Math.floor(tail.length / minRepeats))
  const lastChar = tail.charCodeAt(tail.length - 1)
  for (let unitLength = minUnitChars; unitLength <= maxUnit; unitLength++) {
    const start = tail.length - unitLength
    // A repeat of this period must agree in its final character; rejecting on
    // that one comparison keeps the scan from slicing a unit per candidate.
    if (tail.charCodeAt(start - 1) !== lastChar) continue
    const unit = tail.slice(start)
    let copies = 1
    let cursor = start
    while (copies < maxCopies && cursor - unitLength >= 0 && tail.startsWith(unit, cursor - unitLength)) {
      copies++
      cursor -= unitLength
    }
    if (copies >= minRepeats && copies * unitLength >= minSpanChars) {
      return { kind: 'periodic', unit, unitLength, copies, spanChars: copies * unitLength }
    }
  }
  return null
}

/** Rolling-hash base for shingle counting. */
const SHINGLE_BASE = 131

/**
 * Count every fixed-width shingle over all offsets with a rolling hash, then
 * verify the best candidates by exact substring search.
 *
 * Counting at *every* offset (not a stride) is what makes the check
 * period-agnostic: a repeated unit of any length re-appears at a matching
 * offset one unit later. Coverage is the share of the window spanned by the
 * union of the winning shingle's occurrences, so a block repeated a few times
 * saturates the window while a phrase that merely recurs stays far below the
 * bar. The hash only proposes candidates; the exact search decides, so a
 * collision cannot invent a hit.
 * @param tail - rolling text window.
 * @param bounds - detector thresholds.
 * @returns the hit, or `null` when no shingle is common enough.
 */
function detectShingle(tail, bounds) {
  const { minShingleOccurrences, minShingleCoverage } = bounds
  const length = tail.length
  if (length < SHINGLE_LENGTH * minShingleOccurrences) return null

  const counts = new Map()
  const firstSeen = new Map()
  let power = 1
  for (let index = 0; index < SHINGLE_LENGTH - 1; index++) power = Math.imul(power, SHINGLE_BASE) >>> 0
  let hash = 0
  for (let index = 0; index < SHINGLE_LENGTH; index++) hash = (Math.imul(hash, SHINGLE_BASE) + tail.charCodeAt(index)) >>> 0
  counts.set(hash, 1)
  firstSeen.set(hash, 0)
  for (let start = 1; start + SHINGLE_LENGTH <= length; start++) {
    const outgoing = tail.charCodeAt(start - 1)
    const incoming = tail.charCodeAt(start + SHINGLE_LENGTH - 1)
    hash = (Math.imul((hash - Math.imul(outgoing, power)) >>> 0, SHINGLE_BASE) + incoming) >>> 0
    const seen = counts.get(hash)
    if (seen === undefined) {
      counts.set(hash, 1)
      firstSeen.set(hash, start)
    } else {
      counts.set(hash, seen + 1)
    }
  }

  // Hash counts overstate a candidate (collisions), so the leading few are
  // confirmed against the real substring before any of them can fire. Ranking
  // by repeated selection keeps the scan linear in the window.
  const rejected = new Set()
  for (let attempt = 0; attempt < 3; attempt++) {
    let candidateHash = null
    let hashCount = 0
    for (const [candidate, count] of counts) {
      if (count > hashCount && !rejected.has(candidate)) {
        candidateHash = candidate
        hashCount = count
      }
    }
    if (candidateHash === null || hashCount < minShingleOccurrences) break
    rejected.add(candidateHash)
    const start = firstSeen.get(candidateHash)
    const unit = tail.slice(start, start + SHINGLE_LENGTH)
    let copies = 0
    let covered = 0
    let cursor = 0
    for (let at = tail.indexOf(unit); at >= 0; at = tail.indexOf(unit, at + 1)) {
      copies++
      const from = Math.max(at, cursor)
      const to = at + SHINGLE_LENGTH
      if (to > from) covered += to - from
      cursor = Math.max(cursor, to)
    }
    if (copies < minShingleOccurrences) continue
    const coverage = Math.min(1, covered / length)
    if (coverage < minShingleCoverage) continue
    return { kind: 'shingle', unit, unitLength: SHINGLE_LENGTH, copies, spanChars: covered, coverage }
  }
  return null
}

/**
 * One rolling repetition detector bound to a single model attempt. State is
 * the tail only: callers reset it between attempts by creating a new one.
 * @param overrides - detector threshold overrides.
 * @returns a detector whose `push` reports a hit for the text appended so far.
 */
export function createRepetitionDetector(overrides = {}) {
  const bounds = { ...DETECTOR_DEFAULTS, ...overrides }
  const windowChars = Math.max(bounds.windowChars, bounds.minSpanChars * 2)
  let tail = ''
  let sinceShingleScan = 0

  return {
    /**
     * Append one delta and test the resulting tail.
     * @param text - streamed text delta.
     * @returns the first hit found, or `null`.
     */
    push(text) {
      if (typeof text !== 'string' || text.length === 0) return null
      const joined = tail + text
      tail = joined.length > windowChars ? joined.slice(-windowChars) : joined
      const periodic = detectPeriodic(tail, bounds)
      if (periodic !== null) return periodic
      // The shingle scan walks the whole window, so run it only once a full
      // stride of new text has arrived. Counting pushed characters (not window
      // growth) keeps the scan alive after the window saturates.
      sinceShingleScan += text.length
      if (sinceShingleScan < SHINGLE_STRIDE) return null
      sinceShingleScan = 0
      return detectShingle(tail, bounds)
    },
    /** Drop the accumulated tail, keeping the configured window. */
    reset() {
      tail = ''
      sinceShingleScan = 0
    },
    /** Current rolling window; exposed for tests and diagnostics. */
    peek() {
      return tail
    },
  }
}
