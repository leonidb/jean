# Milestone 2: Board CRUD, Event Queue, Reactive Sensei Loop

## Goal

The sensei (orchestrator) can manage tasks on the board via service endpoints, receive events reactively (no polling), and route work to agents — all through the infrastructure service.

## What changes from Milestone 1

Milestone 1 proved channel communication works. The service routes messages but has no intelligence about task state, no event buffering, and hardcoded routing.

Milestone 2 makes the service a proper coordination layer:
- Board operations are structured CRUD (not raw file access)
- Events are queued and delivered to the sensei when it's ready
- Routing is role-based, not name-based

## Components

### 1. Board CRUD endpoints

The service exposes structured operations. The sensei calls these — it never writes board.json directly.

| Endpoint | Method | What it does |
|----------|--------|-------------|
| `/tasks` | POST | Create a task (title, description, queue, playbook?) → returns task with ID, status: inbox |
| `/tasks` | GET | List all tasks, optionally filter by status or queue |
| `/tasks/:id` | GET | Get a single task |
| `/tasks/:id/status` | PATCH | Transition status (service validates the transition) |
| `/tasks/:id` | PATCH | Update fields (assign agent, add notes) |

The service enforces:
- Valid status transitions (inbox→active, not inbox→done)
- Required fields on create
- Atomic writes to board.json

### 2. Role-based agent registration

Agents register with a name and a role.

```typescript
type RegisterMsg = {
  type: 'register'
  agent: string     // e.g. "scratch", "orchestrator"
  role: 'worker' | 'sensei'
}
```

Replies from workers route to the agent with `role: 'sensei'`. Idle notifications also route to sensei. No hardcoded names.

If no sensei is connected, events queue up (see below). When a sensei connects, it gets a nudge if events are pending.

### 3. Event queue

Events are things that need the sensei's attention:
- Agent replied (worker sent a message via reply tool)
- Agent went idle (stop hook fired)
- New task created (via `/tasks` POST)

Instead of pushing events directly to the sensei's channel, the service queues them.

**Per-agent reply queue:** Replies from each agent are queued separately. When the sensei processes events, it sees "scratch has 2 pending messages" and can prioritize.

**Queue-level processing:** The sensei works at the queue level, not message level. It picks an agent's queue, reads all pending messages together, understands the full context, then acts. There is no requirement to process messages one by one — batch reading is the natural pattern.

**Delivery:** Events are delivered to the sensei only when:
1. The sensei is idle (detected via stop hook, same as any agent)
2. There are pending events

The delivered message is a generic nudge: "Events pending. Check the board." The sensei then pulls what it needs via HTTP (read board, read events).

**Endpoints:**

| Endpoint | Method | What it does |
|----------|--------|-------------|
| `/events/pending` | GET | List pending events for the sensei |
| `/events/pending?agent=scratch` | GET | All pending events for a specific agent |
| `/events/:id/ack` | POST | Acknowledge a single event |
| `/events/ack` | POST | Acknowledge events up to a given ID per agent (batch ack — avoids race with new arrivals) |
| `/events/agents` | GET | List agents with pending events and counts |

### 4. Sensei idle detection + nudge

The sensei's stop hook POSTs to `/agent-idle` just like any worker. When the service receives it:

1. Check if there are pending events
2. If yes → push a channel message to the sensei: `"Events pending. Check the board."`
3. If no → do nothing (sensei stays idle until something happens)

When a new event arrives and the sensei is known to be idle (last signal was idle, no active delivery):
- Push the nudge immediately

This creates the reactive loop:
```
Sensei idle → event arrives → nudge → sensei processes → sensei idle → ...
```

### 5. Cleanup: remove hardcoded routing

- Remove `deliverToAgent('orchestrator', ...)` from reply and idle handlers
- Replace with: find agent with `role: 'sensei'`, queue the event, nudge if idle
- If no sensei registered: events queue, nothing is lost

## What is NOT in this milestone

- Playbook parsing or skill extraction
- `jean init` command
- `jean kick` skill (use curl or `jean send` CLI)
- Auto-starting agents
- Sensei skill/instructions (test with manual prompting)

## Testing

All tests use the same pattern as milestone 1: spin up a real server, connect WS clients, make HTTP requests, assert behavior.

### Board CRUD tests (`board-api.test.ts`)

```
POST /tasks — creates task with ID, status inbox, timestamps
POST /tasks — rejects missing required fields (title, queue)
GET /tasks — returns all tasks
GET /tasks?status=active — filters by status
GET /tasks?queue=scratch — filters by queue
GET /tasks/:id — returns single task
PATCH /tasks/:id/status — valid transition (inbox→active) succeeds
PATCH /tasks/:id/status — invalid transition (inbox→done) returns 400
PATCH /tasks/:id — assigns agent, updates fields
PATCH /tasks/:id/status — updates updatedAt timestamp
Board persists — create task, restart server, task is still there
```

### Role-based routing tests (`routing.test.ts`)

```
Register with role — agent registers as {name: "orch", role: "sensei"}, ack contains role
Reply routes to sensei — worker sends reply, sensei receives it
Reply with no sensei — event is queued, not lost
Sensei connects after events — gets nudge with pending count
Multiple workers — replies from different workers all route to sensei
Role is unique — second sensei registration replaces the first (or rejects?)
```

### Event queue tests (`queue.test.ts`)

```
Reply queued — worker replies, event appears in GET /events/pending
Idle queued — worker idle notification creates event
Task created queued — POST /tasks creates event
Events are per-agent — worker A and B reply, events grouped correctly
GET /events/agents — returns {scratch: 2, review: 1}
ACK removes event — POST /events/:id/ack, event gone from pending
Events ordered FIFO — three events arrive, delivered in order
Queue persists across sensei disconnect/reconnect
```

### Nudge tests (`nudge.test.ts`)

```
Sensei idle + events pending → nudge delivered via channel
Sensei idle + no events → no nudge
Event arrives while sensei idle → immediate nudge
Event arrives while sensei busy → no nudge, delivered after next idle
Multiple events before idle → single nudge (not one per event)
Nudge content — message says "events pending" (generic, not the events themselves)
```

### Integration test (`flow.test.ts`)

Full cycle with board + queue + routing:
```
1. Sensei and scratch connected
2. Sensei creates task via POST /tasks (queue: scratch)
3. Sensei sends task to scratch via POST /send
4. Sensei updates task status to active via PATCH
5. Scratch replies via WS
6. Reply queued as event
7. Sensei goes idle (POST /agent-idle)
8. Nudge delivered to sensei
9. Sensei reads pending events
10. Sensei ACKs event
11. Sensei updates task status to review
12. Board reflects the full lifecycle
```
