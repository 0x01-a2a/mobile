# Hire Tab Design

**Goal:** Add a three-subtab Inbox (OFFERS / HIRE / ACTIVE) so users can browse advertising agents, send job offers, and track outbound work — paying via the agent's own token.

**Architecture:** All changes confined to `Inbox.tsx` and `useNodeApi.ts`. No new screens, no navigator changes. HireAgent compose flow uses a `Modal` (pageSheet). Sent offers persisted in AsyncStorage via a new `useSentOffers()` hook. Status transitions driven by existing `useInbox` WebSocket. `useSentOffers` lives in `useNodeApi.ts` (alongside other AsyncStorage hooks) to avoid a new file, even though it makes no network calls.

**Tech Stack:** React Native 0.84.1, TypeScript, existing `useAgents` / `useAgentSearch` / `useAgentProfile` / `sendEnvelope` / `useInbox` hooks.

**Known limitation:** If the user navigates away from Inbox while an offer is pending, ACCEPT/DELIVER/REJECT envelopes arriving during that time are missed (tab navigator unmounts the component). This is accepted as-is for v1 — status updates will apply correctly when Inbox is next visited if the messages are replayed from the pending FCM queue.

---

## Data layer (`src/hooks/useNodeApi.ts`)

### `AgentSummary` type — add missing fields

The aggregator `GET /agents` already returns `token_address`, `downpayment_bps`, and `price_range_usd` in `AgentReputation`. The TypeScript type needs three new optional fields:

```typescript
export interface AgentSummary {
  // ...existing fields unchanged...
  token_address?: string;             // Solana base58 mint; present if agent has launched a token
  downpayment_bps?: number;           // basis points required upfront (1000 = 10%); 0 or absent = none
  price_range_usd?: [number, number]; // [min, max] job price in USD; absent if agent hasn't set one
}
```

### `useSentOffers()` hook — new

Manages AsyncStorage key `zerox1:sent_offers`. Exposes:

```typescript
interface SentOffer {
  conversation_id: string;
  agent_id: string;
  agent_name: string;
  token_address: string;              // agent's token mint — needed to execute payment
  description: string;
  price_range_usd?: [number, number];
  status: 'pending' | 'accepted' | 'delivered' | 'rejected' | 'completed';
  sent_at: number;                    // unix ms
  delivered_payload?: string;         // set when DELIVER arrives
  rejected_at?: number;               // unix ms; used for 24h auto-prune
}

export function useSentOffers(): {
  offers: SentOffer[];
  addOffer: (offer: SentOffer) => void;
  updateStatus: (conversation_id: string, status: SentOffer['status'], extra?: Partial<SentOffer>) => void;
}
```

Storage: reads on mount, writes on every mutation. Caps at 100 entries (oldest pruned). Rejected offers older than 24 h are filtered out on read. Completed offers are filtered out on read (they appear in Today's task log instead).

### `useAgents` return shape

`useAgents(sort, limit)` returns `AgentSummary[]` directly (a bare array, not `{ agents, loading }`). This matches the existing implementation. The HIRE tab renders this array; loading state is not exposed by the hook and the list simply shows empty until data arrives.

### Status update wiring

In the `onEnvelope` callback inside `Inbox.tsx`, cross-reference incoming envelopes against `useSentOffers().offers`:

- `msg_type === 'ACCEPT'` + matching `conversation_id` → `updateStatus(id, 'accepted')`
- `msg_type === 'REJECT'` + matching `conversation_id` → `updateStatus(id, 'rejected', { rejected_at: Date.now() })`
- `msg_type === 'DELIVER'` + matching `conversation_id` → `updateStatus(id, 'delivered', { delivered_payload: decodedText })`

These checks run in addition to the existing PROPOSE handling — all in the same `onEnvelope` function.

---

## UI (`src/screens/Inbox.tsx`)

### Subtab selector

Replaces the current `<Text style={s.title}>Inbox</Text>` header with a three-pill selector:

```
[ OFFERS ]  [ HIRE ]  [ ACTIVE ]
```

Active pill: `backgroundColor: '#111', color: '#fff'`. Inactive: `backgroundColor: '#f3f4f6', color: '#6b7280'`. Controlled by `const [subtab, setSubtab] = useState<'offers'|'hire'|'active'>('offers')`.

The existing `ScrollView` content is wrapped in `{subtab === 'offers' && ...}`.

### HIRE tab

```
[ search bar: "Search by capability..." ]

─ agent rows ─
Nexus                               $1–$5
translation · code · summarization  ★ 94%  [10% down]

Bolt                                $2–$8
code review · debugging             ★ 88%
```

**Data:** `useAgents('active', 50)` when search bar is empty. `useAgentSearch(query)` when search bar is non-empty. Debounce: 400 ms applied via `useState` + `useEffect` + `setTimeout` in the component (not in the hook).

**Capability chips in list rows:** Capability chips are **not** shown in list rows (this avoids firing one `useAgentProfile` request per agent on render). They appear only in the HireAgent modal, which calls `useAgentProfile` on open.

**Agent row layout:**
- Left: agent name (`fontSize: 13, fontWeight: '600'`) + reputation % below (`fontSize: 11, color: '#6b7280'`)
- Right: price range (`"$X–$Y"` from `price_range_usd`; `"—"` if absent) + downpayment badge (`"X% down"` in amber `#d97706`, shown only if `downpayment_bps > 0`)
- `borderLeftWidth: 3, borderLeftColor: '#111'` for agents with `token_address` set (hireable); `borderLeftColor: '#e5e7eb'` for those without

Tapping a row opens the **HireAgent modal**.

**Empty state:** `"No agents advertising right now"` centred, grey.

### HireAgent modal (`<Modal animationType="slide" presentationStyle="pageSheet">`)

Contents top to bottom:

1. Handle bar (32×4, `#e5e7eb`, centred, `marginTop: 8`)
2. Header row: agent name (`fontSize: 16, fontWeight: '700'`) + close `✕` (`accessibilityLabel="Close"`, `accessibilityRole="button"`)
3. Stats row: reputation % · feedback count (label: `"FEEDBACK"`, value from `feedback_count`) · reputation score (label: `"SCORE"`, value from `average_score` formatted to 1 decimal)
4. Capability chips (from `useAgentProfile(agent.agent_id)`) — wrapping row of grey pills; shows `"Loading..."` in grey while `loading === true`
5. Divider
6. Task description `TextInput` multiline, `placeholder: "Describe what you need..."`, min height 80
7. Fee row (read-only): `"Agent charges $X–$Y"` (from `price_range_usd`); `"Agent hasn't set a price range"` if absent. `fontSize: 12, color: '#6b7280'`
8. Downpayment note (shown only if `downpayment_bps > 0`): `"Requires X% token downpayment"` in amber `#d97706`
9. `Send Offer` button: full-width, `backgroundColor: '#111'`, disabled + `opacity: 0.4` if description is empty or agent has no `token_address`

**`conversation_id` generation:** Use `Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)` to produce a 20–24 char alphanumeric string. No external package required.

**On Send Offer:**
1. Generate `conversationId` as above
2. Call `sendEnvelope({ msg_type: 'PROPOSE', recipient: agent.agent_id, conversation_id: conversationId, payload_b64: btoa(JSON.stringify({ message: description, payment_type: 'token', token_mint: agent.token_address })) })`
3. Call `addOffer({ conversation_id: conversationId, agent_id: agent.agent_id, agent_name: agent.name, token_address: agent.token_address!, description, price_range_usd: agent.price_range_usd, status: 'pending', sent_at: Date.now() })`
4. Close modal
5. Switch subtab to `'active'`

If agent has no `token_address`: button shows `"Can't hire — no token"` and is disabled.

### ACTIVE tab

Reads from `useSentOffers().offers`, sorted by `sent_at` descending. Filters out `completed` and 24h-expired `rejected` entries (handled in `useSentOffers` on read).

**Card states:**

`pending` — grey left border (`#d1d5db`):
```
[agent name]                    [description truncated]
Awaiting response               sent Xm ago
```

`accepted` — green left border (`#22c55e`):
```
[agent name]                    [description truncated]
Working on it…                  ✓ accepted
```

`delivered` — black left border (`#111`) + expanded:
```
[agent name]
[delivered_payload text, max 4 lines before truncating with "Show more"]

[ Pay & Accept ]   [ Dispute ]
```

**Pay & Accept flow:**
1. Attempt `POST /wallet/bags-buy` with `{ token_address: offer.token_address, amount_usd: offer.price_range_usd?.[1] ?? 1 }`. The `amount_usd` uses `price_range_usd[1]` (the max of the range) as the payment ceiling.
2. If the endpoint returns 404 (not yet implemented): show a toast `"Complete token purchase manually in your wallet"` and proceed to step 3.
3. Send `sendEnvelope({ msg_type: 'VERDICT', recipient: offer.agent_id, conversation_id: offer.conversation_id, payload_b64: btoa(JSON.stringify({ outcome: 'positive', message: 'Accepted' })) })`
4. Call `updateStatus(offer.conversation_id, 'completed')` — card disappears from ACTIVE on next read.

**Dispute flow:**
Send `sendEnvelope({ msg_type: 'DISPUTE', recipient: offer.agent_id, conversation_id: offer.conversation_id, payload_b64: btoa(JSON.stringify({ reason: 'Result not satisfactory' })) })`. Call `updateStatus(offer.conversation_id, 'rejected', { rejected_at: Date.now() })`.

`rejected` — dimmed (`opacity: 0.45`), red left border (`#ef4444`):
```
[agent name]                    [description truncated]
Declined                        [relative timestamp]
```
Auto-pruned after 24 h (filtered on read in `useSentOffers`).

**Empty state:** `"No active offers"` centred, grey.

---

## Payment note

`POST /wallet/bags-buy` does not currently exist on the node API. The Pay & Accept flow handles a 404 response gracefully (toast + proceed with VERDICT). When the endpoint is eventually added, the fallback toast stops appearing automatically.

---

## Testing (`src/screens/__tests__/Inbox.test.tsx`)

Extend (or create) `Inbox.test.tsx`. The existing mock pattern uses a top-level `const mockState` object to avoid jest.mock TDZ issues (same pattern as Today.test.tsx).

Mock `useNodeApi`:

```typescript
const mockAgents: AgentSummary[] = [];
const mockSentOffers: SentOffer[] = [];

jest.mock('../../hooks/useNodeApi', () => ({
  useInbox: (_cb: any) => {},
  sendEnvelope: jest.fn().mockResolvedValue(true),
  decodeBidPayload: jest.fn().mockReturnValue(null),
  useAgents: () => mockAgents,
  useAgentSearch: () => [],
  useAgentProfile: () => ({ profile: null, loading: false }),
  useSentOffers: () => ({ offers: mockSentOffers, addOffer: jest.fn(), updateStatus: jest.fn() }),
  useAgentBrain: () => ({ config: { minFeeUsdc: 1.0 } }),
}));
```

Test cases:

- Default subtab is OFFERS; bounty list renders (empty state)
- Tapping HIRE pill switches to HIRE tab; empty state text shown when `mockAgents` is empty
- Agent row with `token_address` present renders with dark left border testID
- Agent row without `token_address` renders with light left border testID
- Tapping an agent row opens the HireAgent modal (modal becomes visible)
- Send Offer button is disabled when description is empty
- Send Offer button is disabled when selected agent has no `token_address`
- Successful send: `sendEnvelope` called with `msg_type: 'PROPOSE'`, `addOffer` called, subtab switches to ACTIVE
- Tapping ACTIVE pill shows `"No active offers"` when `mockSentOffers` is empty
- ACTIVE tab renders a `pending` card when `mockSentOffers` has one pending entry
- ACTIVE tab renders `Pay & Accept` button when offer status is `delivered`
