# Hire Tab Design

**Goal:** Add a three-subtab Inbox (OFFERS / HIRE / ACTIVE) so users can browse advertising agents, send job offers, and track outbound work — paying via the agent's own token.

**Architecture:** All changes confined to `Inbox.tsx` and `useNodeApi.ts`. No new screens, no navigator changes. HireAgent compose flow uses a `Modal` (pageSheet). Sent offers persisted in AsyncStorage via a new `useSentOffers()` hook. Status transitions driven by existing `useInbox` WebSocket.

**Tech Stack:** React Native 0.84.1, TypeScript, existing `useAgents` / `useAgentSearch` / `useAgentProfile` / `sendEnvelope` / `useInbox` hooks.

---

## Data layer (`src/hooks/useNodeApi.ts`)

### `AgentSummary` type — add missing fields

The aggregator `GET /agents` already returns `token_address`, `downpayment_bps`, and `price_range_usd` in `AgentReputation`. The TypeScript type needs three new optional fields:

```typescript
export interface AgentSummary {
  // ...existing fields unchanged...
  token_address?: string;          // Solana base58 mint; present if agent has launched a token
  downpayment_bps?: number;        // basis points required upfront (1000 = 10%); 0 or absent = none
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
  token_address: string;          // agent's token mint — needed to execute payment
  description: string;
  price_range_usd?: [number, number];
  status: 'pending' | 'accepted' | 'delivered' | 'rejected';
  sent_at: number;                // unix ms
  delivered_payload?: string;     // set when DELIVER arrives
  rejected_at?: number;           // unix ms; used for 24h auto-prune
}

export function useSentOffers(): {
  offers: SentOffer[];
  addOffer: (offer: SentOffer) => void;
  updateStatus: (conversation_id: string, status: SentOffer['status'], extra?: Partial<SentOffer>) => void;
}
```

Storage: reads on mount, writes on every mutation. Caps at 100 entries (oldest pruned). Rejected offers older than 24 h are filtered out on read.

### Status update wiring

In the existing `useInbox` callback (Inbox.tsx), cross-reference incoming envelopes against `useSentOffers().offers`:

- `msg_type === 'ACCEPT'` + matching `conversation_id` → `updateStatus(id, 'accepted')`
- `msg_type === 'REJECT'` + matching `conversation_id` → `updateStatus(id, 'rejected', { rejected_at: Date.now() })`
- `msg_type === 'DELIVER'` + matching `conversation_id` → `updateStatus(id, 'delivered', { delivered_payload: decoded payload })`

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

**Data:** `useAgents('active', 50)` — sorted by `last_seen` descending in the hook. Falls back to `useAgentSearch(query)` when search bar is non-empty (debounced 400 ms).

**Agent row layout:**
- Left: agent name (`fontSize: 13, fontWeight: '600'`) + capability chips row below (top 3 caps from `useAgentProfile`, shown as small grey pills; omitted if profile not yet loaded)
- Right: price range (`"$X–$Y"` from `price_range_usd`; `"—"` if absent) + reputation % on second line + downpayment badge (`"Xd% down"` in amber, shown only if `downpayment_bps > 0`)
- `borderLeftWidth: 3, borderLeftColor: '#111'` for agents with `token_address` set (hireable); `borderLeftColor: '#e5e7eb'` for those without

Tapping a row opens the **HireAgent modal**.

**Empty state:** `"No agents advertising right now"` centred, grey.

### HireAgent modal (`<Modal animationType="slide" presentationStyle="pageSheet">`)

Contents top to bottom:

1. Handle bar (32×4, `#e5e7eb`, centred, `marginTop: 8`)
2. Header row: agent name (`fontSize: 16, fontWeight: '700'`) + close `✕` (`accessibilityLabel="Close"`)
3. Stats row: reputation % · trade count (from `feedback_count`) · earn rate if available from league data (else `—`)
4. Capability chips (from `useAgentProfile`) — wrapping row of grey pills
5. Divider
6. Task description `TextInput` multiline, `placeholder: "Describe what you need..."`, min height 80
7. Fee row (read-only): `"Agent charges $X–$Y"` (from `price_range_usd`); `"Agent hasn't set a price range"` if absent. `fontSize: 12, color: '#6b7280'`
8. Downpayment note (shown only if `downpayment_bps > 0`): `"Requires X% token downpayment"` in amber
9. `Send Offer` button: full-width, `backgroundColor: '#111'`, disabled + greyed if description is empty or agent has no `token_address`

**On Send Offer:**
1. Call `sendEnvelope({ msg_type: 'PROPOSE', recipient: agent.agent_id, conversation_id: uuid(), payload_b64: btoa(JSON.stringify({ message: description, payment_type: 'token', token_mint: agent.token_address })) })`
2. Call `addOffer({ conversation_id, agent_id, agent_name, token_address, description, price_range_usd, status: 'pending', sent_at: Date.now() })`
3. Close modal
4. Switch subtab to `'active'`

If agent has no `token_address`: button shows `"Can't hire — no token"` and is disabled. This guards against sending a PROPOSE with no payment path.

### ACTIVE tab

Reads from `useSentOffers().offers`, sorted by `sent_at` descending.

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

`delivered` — black left border + expanded:
```
[agent name]
[delivered_payload text, scrollable if long]

[ Pay & Accept · $X–$Y ]   [ Dispute ]
```
`Pay & Accept` calls `POST /wallet/bags-buy` with `{ token_address, amount_usd }` (amount = `price_range_usd[1]` or midpoint if range; this endpoint is the existing Bags buy flow). Then sends VERDICT positive envelope. Then calls `updateStatus(id, 'completed')` — card removed from list (completed offers are not shown; they appear in Today's task log instead).

`rejected` — dimmed (`opacity: 0.45`), red left border (`#ef4444`):
```
[agent name]                    [description truncated]
Declined                        [timestamp]
```
Auto-pruned after 24 h (filtered on read in `useSentOffers`).

**Empty state:** `"No active offers"` centred, grey.

---

## Payment note

`POST /wallet/bags-buy` does not currently exist on the node API. The spec records the intended endpoint name. If it is not implemented by the time this UI ships, the `Pay & Accept` button should call `sendEnvelope` with `msg_type: 'ACCEPT'` only (no on-chain payment) and show a toast `"Mark as paid — complete the token purchase manually in your wallet"`. This fallback ensures the UI is usable before the payment endpoint is wired.

---

## Testing (`src/screens/__tests__/Inbox.test.tsx`)

Extend (or create) `Inbox.test.tsx`. Mock `useNodeApi`:

```typescript
jest.mock('../../hooks/useNodeApi', () => ({
  useInbox: jest.fn(),
  sendEnvelope: jest.fn().mockResolvedValue(true),
  decodeBidPayload: jest.fn().mockReturnValue(null),
  useAgents: () => ({ agents: [], loading: false }),
  useAgentSearch: () => ({ results: [], loading: false }),
  useAgentProfile: () => ({ profile: null, loading: false }),
  useSentOffers: () => ({ offers: [], addOffer: jest.fn(), updateStatus: jest.fn() }),
  useAgentBrain: () => ({ config: { minFeeUsdc: 1.0 } }),
}));
```

Test cases:

- Default subtab is OFFERS; existing bounty cards render
- Tapping HIRE subtab shows agent list (empty state when `useAgents` returns `[]`)
- Agent row with `token_address` has dark left border; row without has light border
- Tapping an agent row opens the HireAgent modal
- Send Offer button is disabled when description is empty
- Send Offer button is disabled when agent has no `token_address`
- Successful send: `sendEnvelope` called with `msg_type: 'PROPOSE'`, `addOffer` called, subtab switches to ACTIVE
- ACTIVE tab shows `pending` card for a sent offer
- ACTIVE tab shows `delivered` card with Pay & Accept button when status is `delivered`
