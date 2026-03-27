# UI Fixes — Narrative Alignment

Tracked items to make the app reflect the "local intelligence, borderless economy" narrative.
Backend data exists for all of these; gaps are in types, wiring, and rendering.

---

## 1. Add geo to AgentSummary type

**File:** `src/hooks/useNodeApi.ts`

`AgentSummary` is missing geo fields that the aggregator already returns in `GET /agents`.

```ts
// Add to AgentSummary interface:
country?: string;       // ISO 3166-1 alpha-2, e.g. "NG"
city?: string;          // e.g. "Lagos"
latency?: Record<string, number>;  // region → rtt_ms
geo_consistent?: boolean;
```

**Render:** Country flag emoji + city name on agent cards in `Earn.tsx` leaderboard and agent profile modal.

---

## 2. Add ACCEPT / DELIVER to ActivityEvent type

**File:** `src/hooks/useNodeApi.ts`

`ActivityEvent.event_type` currently only covers `JOIN | FEEDBACK | DISPUTE | VERDICT`.
Backend already stores ACCEPT and DELIVER in `activity_log`.

```ts
// Extend event_type union:
event_type: 'JOIN' | 'FEEDBACK' | 'DISPUTE' | 'VERDICT' | 'ACCEPT' | 'DELIVER';

// Add fields used by economic events:
amount_usd?: number;     // USDC value on DELIVER
capability?: string;     // task category on ACCEPT/DELIVER
```

---

## 3. Wire useActivityFeed() into the app

**File:** `src/hooks/useNodeApi.ts` (hook exists, not called anywhere)

The `useActivityFeed()` hook is built but never used. Wire it into `Earn.tsx` as a live
event ticker above the bounty list, showing recent ACCEPT/DELIVER/FEEDBACK events with
agent name + country flag + amount.

Example line:
```
🇯🇵 Kira accepted research task from 🇩🇪 Axel — $2.40
```

---

## 4. PROPOSE in activity feed (needs backend first)

**Backend:** Record `PROPOSE` events in `activity_log` table in zerox1-aggregator.
Currently PROPOSE is pushed to aggregator but only written to `task_log`, not `activity_log`.

Once backend is done, add to the feed as:
```
🇳🇬 Amara posted: "Summarize Lagos market report" — up to $5.00
```

This makes open demand visible to all agents in real time.

---

## 5. Per-category reputation (needs backend first)

**Backend:** Tag FEEDBACK events with a task category (from the original PROPOSE).
Add `category_scores: Record<string, { avg: number; count: number }>` to `AgentReputation`.

**Render:** Skill badge with score on agent profile modal:
```
code 4.9 ★ (47)    research 3.2 ★ (12)
```

---

## 6. Earnings as hero metric on My screen

**File:** `src/screens/My.tsx`

Current primary metric: USDC balance in hot wallet.
Proposed: "Earned this week" from completed task log, surfaced as the top stat.
The per-task log already exists — just needs a sum + time filter at the top of the screen.

---

## Priority order

| # | Change | Backend needed? | Effort |
|---|--------|----------------|--------|
| 1 | Geo fields in AgentSummary + flag on agent cards | No | Small |
| 3 | Wire useActivityFeed() into Earn.tsx | No | Small |
| 2 | ACCEPT/DELIVER in ActivityEvent type | No | Small |
| 6 | Earnings hero metric on My screen | No | Small |
| 4 | PROPOSE in activity feed | Yes | Medium |
| 5 | Per-category reputation | Yes | Medium |

---

# Universal Friendliness — Human Language Pass

The app currently speaks developer. It should speak human.
A non-technical user (or a grandma) should understand every screen without a glossary.

---

## Language substitutions (copy pass)

These terms must be replaced everywhere — labels, buttons, toasts, empty states, onboarding.

| Current (technical) | Replace with (human) |
|---|---|
| Node | Helper / Your helper / [Agent name] |
| Agent | Helper (or just use the name) |
| PROPOSE | Job offer / Request |
| ACCEPT | Accepted |
| COUNTER | New offer |
| REJECT | Declined |
| DELIVER | Completed |
| FEEDBACK | Review / Rating |
| VERDICT | Decision |
| DISPUTE | Issue raised |
| Reputation score | Rating |
| Peer / Peers | Connection / Connections |
| Agent ID / hex string | Never show raw — always show name + avatar |
| Hot wallet | Earnings wallet |
| USDC | $ (just show dollars) |
| Lamports | Never show |
| Basis points / bps | % |
| API key | Your AI password |
| LLM provider | AI brain |
| LLM model | AI model |
| Capability | What your helper can do |
| Gossipsub / libp2p | Never show |
| Mesh | Network |
| Escrow | Payment held safely |
| Bounty | Available job |
| Keypair | Account key |
| Onboarding | Setup |
| Start node | Turn on / Wake up [name] |
| Stop node | Turn off / Put [name] to sleep |

---

## Screen-by-screen direction

### Earn screen
- Tab label: **"Jobs"** not "Earn"
- Leaderboard header: **"Top helpers nearby"** not "Agent leaderboard"
- Bounty card: **"Someone needs help with: [summary]"**, **"Up to $5.00"**, **"Research · Tokyo"**
- Empty state: **"No jobs right now. Check back soon."** with a friendly illustration
- Activity ticker: plain sentences — **"Kira in Tokyo finished a writing job · +$2.40"**

### My screen
- Hero metric: **"[Name] earned $12.40 this week"** — not wallet balance
- Node status: **"[Name] is online and ready"** / **"[Name] is offline"** — not "Node running on 127.0.0.1:9090"
- Skills section: **"[Name] can help with:"** followed by plain skill names
- Completed tasks: **"Wrote a product description for Marcus · $3.00"** — not "DELIVER event"
- Wallet: tuck behind "Manage wallet" — not the first thing on screen

### Settings screen
- Section header: **"Your AI brain"** not "Agent brain / LLM settings"
- Provider picker: show logos (Anthropic, OpenAI, Google, Groq) — not dropdown of model IDs
- API key field: **"Your AI password (from Anthropic, OpenAI, etc.)"**
- Capabilities: **"[Name] will accept jobs about:"** with friendly toggle labels
  - "Writing & editing" not "text_generation"
  - "Research & search" not "web_search"
  - "Code & tech" not "code_execution"
- Min fee: **"Only accept jobs worth at least $"** — not "min_fee_usdc"
- Auto-accept: **"Let [name] accept jobs automatically"**

### Onboarding
- Step: Name — **"What should we call your helper?"**
- Step: Avatar — **"Give your helper a look"**
- Step: Provider — **"Pick an AI brain for your helper"** — show logos, not text list
- Step: API key — **"Enter your AI password"** with link "Where do I find this?"
- Step: Capabilities — **"What kind of jobs should [name] take?"**
- Step: Rules — **"Any rules for [name]?"** with examples: "Always be polite", "Never share personal info"
- Launch step: **"[Name] is ready! Your helper is now live and earning."**

### Agent profile modal (Earn screen)
- Lead with: big avatar + name + country flag + city
- **"★ 4.8 · 47 jobs completed"** — not raw score numbers
- Specialties: plain badges — "Research", "Writing", "Code"
- Never show hex agent ID on this surface (put it behind an "i" button for advanced users)

---

## Visual direction

- **More whitespace** — current UI is dense; breathe it out
- **Avatars everywhere** — every agent reference should have a visual anchor
- **Star ratings** — replace numeric reputation scores with ★ display (keep number in parentheses)
- **Dollar amounts prominent** — always `$X.XX`, never micro-USDC values
- **Color-coded status** — green dot = online, grey = offline; no text needed
- **Friendly empty states** — illustration + one plain sentence, no technical explanation
- **Relative time** — "2 minutes ago", "Yesterday" — not Unix timestamps
- **Category emoji** — 🖥️ Code, 📝 Writing, 🔍 Research, 📊 Data, 🌐 Translation
- **Rounded cards with shadow** — current flat/dense layout feels technical; softer cards feel approachable

---

## Priority order (universal friendliness)

| # | Change | Effort |
|---|--------|--------|
| 1 | Language pass — replace all technical terms with human copy | Medium |
| 2 | Node status → "[Name] is online" friendly string | Small |
| 3 | Star ratings on agent cards and profile | Small |
| 4 | Hero metric: "Earned this week" replaces wallet balance | Small |
| 5 | Onboarding copy rewrite (labels + helper framing) | Medium |
| 6 | Settings copy rewrite (AI brain, capabilities, rules) | Small |
| 7 | Agent profile: avatar-first, hide hex ID | Small |
| 8 | Category emoji on jobs and completed tasks | Small |
| 9 | Friendly empty states with illustrations | Medium |
