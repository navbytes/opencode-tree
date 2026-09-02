/**
 * Matching OpenCode's *native* forks (`/fork`, `session.fork`) back to the session
 * they came from, so the tree can adopt them as `branch.opened { kind: "native" }`.
 *
 * `session.fork` sets no `parentID` and copies the prefix with fresh message ids but
 * identical `time.created`, so the only proof of a fork is that prefix; the
 * `"… (fork #n)"` title is a hint used for ranking, never for matching.
 *
 * Pure, no OpenCode/opentui/solid-js imports — see test/core-purity.test.ts. The IO
 * half lives in ../shared/adopt.ts.
 */

export type ForkMessage = { id: string; role: string; created: number }

/** OpenCode's `Session`, reduced to the fields adoption needs. */
export type SessionInfo = {
  id: string
  title: string
  created: number
  /** Set only on subagent children — never on a fork, and never adoptable. */
  parentID?: string
  directory?: string
}

export type ForkCandidate = SessionInfo & { messages: ForkMessage[] }

export type ForkParent = { parentID: string; anchorMessageID: string }

const FORK_TITLE = /^(.+) \(fork #(\d+)\)$/

/** `"Fix the bug (fork #2)"` → `{ base: "Fix the bug", n: 2 }`. */
export function parseForkTitle(title: string): { base: string; n: number } | undefined {
  const match = FORK_TITLE.exec(title)
  if (!match) return undefined
  const n = Number(match[2])
  if (!Number.isInteger(n) || n < 1) return undefined
  return { base: match[1]!, n }
}

/** The title `getForkedTitle` must have read to produce `title`, if it still follows the pattern. */
export function expectedParentTitle(title: string): string | undefined {
  const parsed = parseForkTitle(title)
  if (!parsed) return undefined
  return parsed.n === 1 ? parsed.base : `${parsed.base} (fork #${parsed.n - 1})`
}

function isCopiedPrefix(prefix: ForkMessage[], messages: ForkMessage[]): boolean {
  if (messages.length < prefix.length) return false
  return prefix.every((m, i) => messages[i]!.role === m.role && messages[i]!.created === m.created)
}

/**
 * The session `fork` was forked from, with the journal's anchor (the last *shared*
 * message in the parent, inclusive). `candidates` must already be scoped to the same
 * directory and to sessions created no later than the fork.
 */
export function findForkParent(fork: ForkCandidate, candidates: ForkCandidate[]): ForkParent | undefined {
  const n = fork.messages.length
  if (n === 0) return undefined
  const expected = expectedParentTitle(fork.title)
  const matches = candidates.filter((c) => c.id !== fork.id && !c.parentID && isCopiedPrefix(fork.messages, c.messages))
  if (matches.length === 0) return undefined
  const titled = (c: ForkCandidate) => (expected !== undefined && c.title === expected ? 1 : 0)
  // two forks of one session share a title, so prefer the expected title, then the closest
  // ancestor by creation time (a fork of a fork also matches its grandparent's prefix)
  matches.sort((a, b) => titled(b) - titled(a) || b.created - a.created)
  const best = matches[0]!
  return { parentID: best.id, anchorMessageID: best.messages[n - 1]!.id }
}

/**
 * Sessions worth testing for adoption, oldest first so a parent that is itself an
 * un-adopted fork joins the tree before its children. Only `"… (fork #n)"` titles
 * qualify: matching every untitled session costs one round-trip each and mis-adopts
 * strangers, so a fork the user renamed is simply not adopted automatically.
 */
export function pickAdoptables(sessions: SessionInfo[], registered: Set<string>): SessionInfo[] {
  return sessions
    .filter((s) => !s.parentID && !registered.has(s.id) && parseForkTitle(s.title) !== undefined)
    .sort((a, b) => a.created - b.created)
}
