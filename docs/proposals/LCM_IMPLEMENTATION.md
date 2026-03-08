# Proposal: Lossless Context Management (LCM) for BrowserForce Agent

> **Status**: Proposal  
> **Author**: AI-assisted analysis  
> **Date**: 2026-03-08  
> **References**:  
> - [LCM Paper](https://papers.voltropy.com/LCM) — Ehrlich & Blackman, Voltropy PBC, Feb 2026  
> - [Volt source](https://github.com/martian-engineering/volt) — open-source LCM reference implementation (OpenCode fork)

---

## Summary

Implement Lossless Context Management (LCM) on top of BrowserForce Agent's Codex-as-subprocess architecture. LCM is a deterministic, engine-managed memory system that compresses older context into a hierarchical summary DAG while retaining lossless pointers to every original message. This gives BrowserForce Agent effectively infinite session memory with zero overhead on short tasks.

## Motivation

BrowserForce Agent sessions that involve multi-step browser automation (login flows, data extraction across pages, form filling sequences) quickly accumulate context: DOM snapshots, accessibility trees, tool call results, and multi-turn conversation. Codex's native context window becomes the bottleneck for long-horizon tasks.

Current state:
- Sessions use `codex exec resume` for continuity — works until Codex's context fills up
- No mechanism to compress or summarize older context
- No way for the agent to search its own session history
- Large tool outputs (DOM trees, page content) consume disproportionate context
- Multi-tab workflows multiply the problem

LCM addresses all of these with a proven architecture that outperforms Claude Code on long-context benchmarks (OOLONG).

## The Fundamental Constraint

Volt implements LCM by controlling the LLM's context window directly — it calls the LLM API, assembles messages, manages tools. BrowserForce Agent uses **Codex as an opaque subprocess**: we spawn `codex exec --json`, get JSONL events back.

We control:
- The initial prompt
- Whether to `resume` or start fresh
- The MCP tools Codex can call

We do **not** control:
- Codex's internal context window assembly
- What Codex keeps in its conversation history
- How Codex handles tool call output accumulation

**A direct port of Volt's LCM is impossible.** Instead, we build LCM as an **External Memory Coordinator** that works *around* Codex's opacity.

## Architecture

### Core Design: LCM as External Memory Layer

Instead of managing Codex's context internally (like Volt manages the LLM API), we build LCM as a parallel memory system that:

1. **Captures everything** — all user messages, Codex responses, tool outputs flow into an immutable store
2. **Provides context preambles** — before each Codex run, assemble session history from the LCM summary DAG and inject it into the prompt
3. **Exposes retrieval via MCP tools** — Codex can call `lcm_grep`, `lcm_describe`, `lcm_expand` to recover any historical context
4. **Manages session continuity intelligently** — decides when to `resume` Codex vs. start a fresh run with compressed context

### Two-Mode Session Continuity

```
Short sessions (under soft threshold):
  User message → codex exec resume <sessionId> → zero overhead
  LCM passively logs everything, no summaries generated

Long sessions (over soft threshold):
  User message → LCM compaction triggers →
    assemble context preamble (summaries + recent raw messages) →
    codex exec (fresh run, with preamble as prompt) → new Codex session
  Old Codex session retired, new one starts with full history as summaries
```

**Zero-cost continuity**: for short tasks that fit in Codex's native context, the system adds zero overhead. LCM only activates when sessions grow beyond comfortable limits.

### Data Flow

```
┌─────────────────────────────────────────────────────┐
│ Side Panel / User                                    │
│   POST /v1/runs { sessionId, message }               │
└──────────────┬──────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────┐
│ LCM Context Coordinator (new: agent/src/lcm/)        │
│                                                      │
│ 1. Store user message in Immutable Store             │
│ 2. Check: is context over soft threshold?            │
│    NO → pass through, use codex exec resume          │
│    YES → run compaction, build context preamble      │
│ 3. Assemble prompt:                                  │
│    [system context preamble from DAG summaries]      │
│    [recent raw messages from fresh tail]             │
│    [user's new message]                              │
│ 4. Decide: resume existing Codex session             │
│    or fresh run with assembled prompt                │
└──────────────┬──────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────┐
│ Codex Runner (existing, modified)                    │
│   codex exec [resume <id>] --json <prompt>           │
│                                                      │
│   JSONL events → LCM: store each event               │
│   (assistant text, tool calls, reasoning)            │
│                                                      │
│   Large tool outputs → LCM: exploration summary      │
└──────────────┬──────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────┐
│ MCP Server (existing, extended with LCM tools)       │
│                                                      │
│ Existing: execute, reset                             │
│ New LCM tools (Codex can call these):                │
│   lcm_grep    — regex search full session history    │
│   lcm_describe — inspect any summary or file ref     │
│   lcm_expand  — recover original content             │
│   lcm_read    — read stored large file content       │
│   llm_map     — parallel processing via light model  │
└─────────────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────┐
│ LCM Immutable Store (new: SQLite via better-sqlite3) │
│                                                      │
│ messages       — every user/assistant/tool message    │
│ summaries      — sprig/bindle DAG nodes              │
│ summary_links  — message→summary relationships       │
│ context_items  — active context window state          │
│ large_files    — file refs with exploration summaries │
│ llm_map_runs   — parallel job tracking               │
└─────────────────────────────────────────────────────┘
```

### Why SQLite (Not Embedded PostgreSQL)

Volt uses embedded PostgreSQL. BrowserForce should use **better-sqlite3**:

| Factor | SQLite | Embedded PostgreSQL |
|--------|--------|-------------------|
| Process management | None (in-process) | Requires pg_ctl, init, port allocation |
| Full-text search | FTS5 built-in | Requires pg_trgm or tsquery setup |
| Concurrent reads during compaction | WAL mode | Native |
| Dependency weight | Single native addon | ~100MB binary + config |
| BrowserForce philosophy | Consistent with "just `ws`" minimal deps | Heavy |
| Migration path | Open (can move to PG later) | N/A |

## The Summary DAG

Adapted from Volt's three-tier hierarchy:

```
L0: Leaves (raw messages)
    │
    ├── Sprig Summary (L1) — compacts N oldest leaves
    │   ├── Contains: summary text + IDs of original messages
    │   └── Created when: leaf lane exceeds soft threshold
    │
    ├── Bindle Summary (L2) — condenses N sprigs
    │   ├── Contains: higher-order summary + IDs of child sprigs
    │   └── Created when: sprig lane exceeds soft threshold
    │
    └── Archive Stub — pointer to evicted bindle
        ├── Contains: ghost cue (minimal reminder)
        └── Created when: bindle lane exceeds capacity
```

### Active Context Assembly

The context sent to Codex at each fresh run:

```
[System] You are resuming a browser automation session.
Here is the session history:

[Archive Stub: sum_abc123] (early exploration of login flow)
[Bindle: sum_def456] (authentication + form filling work)
[Sprig: sum_ghi789] (recent page navigation and data extraction)
[Raw message 45] User: "now click the submit button"
[Raw message 46] Assistant: "I'll click the submit button..." [tool calls...]
[Raw message 47] User: "great, now extract the confirmation number"

You have tools to search and recover full session history:
  lcm_grep(pattern)    — regex search all past messages
  lcm_describe(id)     — inspect any summary or file reference
  lcm_expand(id)       — recover original messages from a summary
```

### Compaction Control Loop

Adapted from Volt's Algorithm 2 (Figure 2 in the paper):

```
on_message_stored(message):
  tokens = count_context_tokens(conversationId)

  if tokens < τ_soft:
    return  // zero-cost continuity — no action

  if tokens < τ_hard:
    schedule_async_compaction(conversationId)
    return

  compact_blocking(conversationId)  // must compact before next run

compact(conversationId):
  1. Select oldest leaf chunk (outside fresh tail of last 8 messages)
  2. Summarize → create sprig (L1) via three-level escalation
  3. Replace leaves with sprig in context_items
  4. If still over: condense sprigs → bindle (L2)
  5. If still over: evict oldest bindle → archive stub with ghost cue
```

### Three-Level Summarization Escalation

Guarantees convergence (from Volt's Algorithm 3):

```
Level 1 (Normal):    LLM summarize with "preserve details" mode
Level 2 (Aggressive): LLM summarize with "bullet points" mode, half token budget
Level 3 (Fallback):   Deterministic truncation to 512 tokens — no LLM involved
```

If a level fails to reduce token count, the system escalates. Level 3 always succeeds.

### Threshold Configuration

```javascript
const τ_soft = model.contextWindow * 0.60;  // start async compaction
const τ_hard = model.contextWindow * 0.85;  // block before next run
const FRESH_TAIL = 8;                        // protect last N raw messages
```

## Browser-Specific Adaptations

### DOM/Accessibility Tree Compression

Browser tool outputs are enormous. LCM's large file handling with type-aware exploration summaries:

```javascript
if (toolOutput.tokens > LARGE_FILE_THRESHOLD) {
  const summary = await explore({
    content: toolOutput.text,
    type: 'html',  // dispatches to HTML explorer
  });
  await lcmDb.insertLargeFile({
    fileId: generateId(),
    path: `browser://tab-${tabId}/snapshot`,
    explorationSummary: summary,
    tokenCount: toolOutput.tokens,
  });
}
```

### Tab State Compression

Per-tab summary chains prevent cross-tab context pollution:

```
Tab 1 (login page): [sprig: filled email/password, clicked login]
Tab 2 (dashboard):  [sprig: navigated to settings, changed theme]
Tab 3 (search):     [bindle: searched for "orders", extracted 5 results]
```

### `llm_map` for Multi-Tab Operations

Process multiple pages in parallel — the killer feature for browser automation:

```
User: "Check the status of all 20 orders in the table"

Agent uses llm_map:
  input: orders.jsonl (20 order URLs)
  prompt: "Navigate to {url}, extract order status and shipping date"
  output_schema: { status: string, shipping_date: string }
  concurrency: 4
```

Each item gets its own lightweight LLM call (Haiku-class model), results aggregated outside context.

## LCM Tools (MCP Extensions)

### lcm_grep(pattern, summary_id?)

Regex search across full immutable message history. Returns matches grouped by covering summary, paginated.

### lcm_describe(id)

Returns metadata for any LCM identifier (file or summary): kind, level, token count, exploration summary, parent pointers.

### lcm_expand(summary_id)

Expands a summary node into its constituent original messages. **Restricted to sub-agents only** — prevents uncontrolled context flooding in the main interaction loop.

### lcm_read(file_id)

Read stored large file content by LCM file ID.

### llm_map(input_path, prompt, output_schema, ...)

Parallel stateless LLM processing. Database-backed job tracking with exactly-once semantics, schema-validated output, automatic retries.

### agentic_map(input_path, prompt, output_schema, ...)

Like `llm_map` but spawns full sub-agent sessions per item. For when per-item processing requires multi-step reasoning or tool access.

## Implementation Phases

### Phase 1: Immutable Store + Context Preamble

**Effort**: ~3-4 days  
**Value**: Session history persistence + basic long-session support

New files:
- `agent/src/lcm/store.js` — SQLite-backed immutable store
- `agent/src/lcm/context.js` — Context threshold checking, preamble assembly
- `agent/src/lcm/tokens.js` — Token counting

Modified files:
- `agent/src/chatd.js` — Intercept runExecutor to store messages + check thresholds
- `agent/src/codex-runner.js` — Store Codex events in LCM store
- `agent/src/session-store.js` — Add `providerState.lcm` for conversation tracking

Behavior:
- All messages stored in immutable store
- When context exceeds soft threshold, build preamble from recent messages
- Switch from `codex exec resume` to `codex exec` with preamble
- Below threshold: pure pass-through (zero-cost continuity)

### Phase 2: Summary DAG + Compaction Engine

**Effort**: ~3-4 days  
**Value**: Hierarchical compression with lossless retrieval

New files:
- `agent/src/lcm/summarize.js` — Three-level escalation summarizer
- `agent/src/lcm/condense.js` — Sprig→bindle condensation
- `agent/src/lcm/compaction.js` — Lane-based compaction orchestrator
- `agent/src/lcm/explore/` — File type dispatchers (HTML, JSON, code, text)

Behavior:
- Async compaction when soft threshold exceeded
- Blocking compaction at hard threshold
- Three-level escalation guarantees convergence
- Browser-specific explorers for DOM trees, accessibility snapshots

### Phase 3: LCM Tools as MCP Extensions

**Effort**: ~2-3 days  
**Value**: Agent can search and recover its own history

New MCP tools:
- `lcm_grep` — Regex search across session history
- `lcm_describe` — Metadata for any summary/file ref
- `lcm_expand` — Recover original content (sub-agent only)
- `lcm_read` — Read stored large file content

### Phase 4: Operator-Level Recursion

**Effort**: ~3-4 days  
**Value**: Parallel multi-page processing

New MCP tools:
- `llm_map` — Parallel stateless LLM processing
- `agentic_map` — Parallel sub-agent sessions with tool access

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Storage backend | SQLite + better-sqlite3 | Minimal deps, no process management, FTS5 for search |
| Summarization model | Codex's own model (or Haiku-class) | Same provider, lightweight fallback for bulk work |
| Soft threshold | 60% of context window | Matches Volt defaults, leaves room for tool definitions |
| Hard threshold | 85% of context window | Buffer for tool outputs and system prompt |
| Fresh tail protection | Last 8 messages | Keep recent context raw for highest fidelity |
| Preamble format | Structured markdown with summary IDs | Codex can reference IDs in lcm_grep/lcm_expand calls |
| Compaction timing | Async between turns, blocking at hard limit | Zero user-facing latency in normal flow |
| llm_map concurrency | Default 8 | Browser tasks are heavier than text classification |

## Why This Is Not "Just RAG"

The LCM paper explicitly addresses this distinction:

1. **Hierarchical navigation** — Summaries give the agent a multi-resolution map of session history. It can see "we did authentication work" at bindle level, then drill into specifics via `lcm_expand`.

2. **Lossless** — Every original message is preserved verbatim. RAG returns decontextualized fragments.

3. **Deterministic** — The engine controls compaction, not the model. No stochastic memory management.

4. **Zero-cost continuity** — Short sessions pay nothing. RAG always has retrieval latency.

5. **Conversational structure preserved** — Summaries maintain who-said-what-when. RAG strips this.

6. **Guaranteed convergence** — Three-level escalation ensures compaction always makes progress. RAG has no such guarantee.

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Codex resume breaks when switching to fresh runs with preamble | Medium | Gradual transition: only switch at high thresholds; test both modes |
| Summary quality degrades with browser-specific content | Medium | Custom summarization prompts for DOM/accessibility tree content |
| SQLite performance under heavy browser sessions | Low | WAL mode + periodic vacuuming; migrate to PG if needed |
| LCM tools add latency to MCP server | Low | Tools query local SQLite (sub-ms reads); only lcm_expand is heavy |
| Token counting accuracy for Codex context estimation | Medium | Use tiktoken for exact counts; conservative thresholds with buffer |
| New dependency (better-sqlite3) | Low | Well-maintained, single native addon, used by thousands of projects |

## New Dependencies

- `better-sqlite3` — SQLite binding for the immutable store
- `tiktoken` (or `gpt-tokenizer`) — accurate token counting for threshold decisions

## Open Questions

1. **Summarization model**: Should compaction summaries use the same model as the session, or a dedicated lightweight model? Volt uses the session model for summaries and Haiku for `llm_map`.

2. **Preamble injection point**: Should the preamble be part of the user message, or injected via a system-level mechanism (e.g., Codex's `AGENTS.md` or a custom system prompt)?

3. **Cross-session search**: Should `lcm_grep` be scoped to the current session only, or allow searching across all sessions?

4. **UI indicators**: Should the side panel show compaction state (e.g., "Session memory: 3 summaries, 12 raw messages")?

5. **Codex context window detection**: How do we reliably determine Codex's current context usage to decide resume vs. fresh run? Token counting from stored events is an approximation.
