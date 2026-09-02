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

/** How much of `fork` is a copy of `candidate`, by (role, created) from index 0. */
function sharedPrefixLength(fork: ForkMessage[], candidate: ForkMessage[]): number {
  const max = Math.min(fork.length, candidate.length)
  let n = 0
  while (n < max && fork[n]!.role === candidate[n]!.role && fork[n]!.created === candidate[n]!.created) n++
  return n
}

/**
 * The session `fork` was forked from, with the journal's anchor (the last *shared*
 * message in the parent, inclusive). `candidates` should be scoped to the same directory;
 * the fork's own age and `parentID` are re-checked here.
 *
 * Only the *copied* head of the fork can match: everything it said after the fork has a
 * `created` of its own, so a fork is adoptable long after it has moved on. Matching on the
 * longest common prefix (≥1 message, starting at index 0) is what makes that work.
 */
export function findForkParent(fork: ForkCandidate, candidates: ForkCandidate[]): ForkParent | undefined {
  if (fork.messages.length === 0) return undefined
  const expected = expectedParentTitle(fork.title)
  const matches: { candidate: ForkCandidate; shared: number }[] = []
  for (const candidate of candidates) {
    if (candidate.id === fork.id || candidate.parentID || candidate.created > fork.created) continue
    const shared = sharedPrefixLength(fork.messages, candidate.messages)
    if (shared > 0) matches.push({ candidate, shared })
  }
  if (matches.length === 0) return undefined
  const titled = (m: { candidate: ForkCandidate }) => (expected !== undefined && m.candidate.title === expected ? 1 : 0)
  // a fork of a fork copies its grandparent's messages too, but only through its parent —
  // so the longest shared prefix is the closest ancestor; two forks of one session share a
  // title, so the title expectation and then creation time break the ties
  matches.sort((a, b) => b.shared - a.shared || titled(b) - titled(a) || b.candidate.created - a.candidate.created)
  const best = matches[0]!
  return { parentID: best.candidate.id, anchorMessageID: best.candidate.messages[best.shared - 1]!.id }
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
