# Personal Ops Assistant

## Purpose

NanoClaw's personal-ops mode is meant to become a high-trust personal operations assistant for Jerry.

The goal is not just to sync email, calendar, Jira, Slack, and git activity. The goal is to build an assistant that understands:

- Jerry's roles across clients
- how clients, subclients, and projects relate to each other
- which people, channels, and repositories matter
- what work is active, blocked, overdue, or at risk
- what deserves attention now versus what is only background awareness

Over time, this should reduce context switching, missed follow-ups, and manual status reconstruction.

## North Star

The assistant should feel like a strong chief-of-staff and operator aide:

- aware of Jerry's real responsibilities
- careful with noise
- good at grouping work by client and project
- able to infer what matters from weak signals across systems
- easy to correct when wrong
- increasingly useful as more context accumulates

The product should help Jerry answer:

- What matters today?
- What do I owe each client?
- What changed since yesterday?
- What am I waiting on?
- What should I say in my standup?
- What did I actually get done this week?

## Current Main Surfaces

Primary daily surfaces:

- `Today`: curated daily cockpit
- `Inbox`: triage new inbound
- `Work`: durable open loops and workstreams
- `Review`: approvals, questions, memory, improvements, and noise controls

Secondary support surfaces:

- `Calendar`
- `Reports`
- `History`
- `Connections`

The intended usage model is:

1. start with `Today`
2. process new inbound in `Inbox`
3. manage durable obligations in `Work`
4. teach or approve the assistant in `Review`

## Current Product Model

### Attention model

The assistant currently reasons about more than client/project attribution. It also tracks:

- `awarenessOnly`
- `actionRequired`
- `operationalRisk`
- `reportWorthy`
- directness
- importance reason
- confidence
- thread state

This is what lets the assistant try to separate:

- what needs action
- what is important awareness
- what is low signal noise

### Open loops and workstreams

The system derives durable work from source evidence across:

- email
- Slack
- Jira
- calendar
- git/repos
- manual notes and tasks

It represents this as:

- open loops
- work items
- workstreams

Those are intentionally derived from raw evidence, so they can be recomputed when the assistant learns something new.

### Review and approval

The assistant does not just silently infer. It also creates:

- queued approvals
- review suggestions
- memory facts
- assistant questions
- internal improvement tickets
- noise-control rules such as ignore-similar-message patterns

The goal is to keep human correction central while still letting the assistant get better over time.

## How It Should Think

### 1. Context-aware, not brittle

The assistant should use role and account context as soft guidance, not as a rigid rule engine.

Example:

- `jerry@bettymills.com` is a Betty Mills COO account.
- Shared aliases such as support, merchandising, and accounting often generate awareness traffic.
- Those messages are usually lower priority unless Jerry is directly addressed, explicitly mentioned, or the topic is a COO-level issue such as pricing changes, MAP violations, outages, or major operational alerts.

This should shape classification and prioritization, but the model must still be allowed to conclude that an exception matters.

### 2. Learn the operating graph

The assistant should continuously improve its understanding of:

- clients
- subclients
- projects
- roles
- common contacts
- recurring repositories
- recurring Jira keys
- recurring Slack workspaces and channels

The system should increasingly map people and signals into stable client/project context with less manual cleanup.

### 3. Prefer high trust over false confidence

The assistant should surface why something was mapped or prioritized:

- connection default
- domain match
- workspace or account match
- Jira key match
- repository alias
- account-scoped contact hint
- model-guided role/context judgment

When uncertain, it should preserve ambiguity rather than pretend certainty.

### 4. Keep human correction central

Jerry must be able to teach the system through lightweight correction:

- this belongs to Betty Mills, not Dynecom
- this is Wabash, not General
- this is awareness only, not a task
- this is high priority
- this is blocked
- ignore messages like this in the future

Those corrections should remain more important than future inference.

## Main Context Layers

### Operator profile

The operator profile holds Jerry's global working context, such as:

- work hours
- role summary
- escalation posture
- reporting preferences
- assistant style defaults

### Client context

Each client can store:

- parent client relationship
- roles
- notes
- communication preferences
- status

Examples:

- `Dynecom`: roles such as `CTO`, `Main Developer`
- `Betty Mills`: role `COO`
- `Ezidia`: child client of `Dynecom`
- `TagSmart` and `Jameco`: prospects under `Dynecom`

### Project context

Each project can store:

- owning client
- status
- priority
- notes
- tags

Examples:

- `Betty Mills` -> `General / COO`
- `Dynecom` -> `General / CTO`
- `Ezidia` -> `Wabash`, `Zuhne`
- `Knox Design` -> `Patent UI`

### Connection context

Each connected account can store:

- default client
- optional default project
- client-only-by-default behavior
- scope settings
- soft triage guidance

This is the right place for instructions like:

- how to interpret a mailbox
- what kind of work the account represents
- what typically matters to Jerry in that account
- what kinds of messages are usually awareness-only
- what kinds of situations should break through as high priority

This is model context, not a deterministic filter.

### Contacts and account-scoped hints

The assistant currently maintains lightweight contacts, identities, and account-scoped hints.

This matters especially for shared vendors and service senders such as:

- AWS
- Figma
- monitoring systems
- billing systems

Those senders should not automatically harden into one global client/project mapping just because they appeared in one account. Account context should outrank global sender memory for email-derived learning.

### Repository context

Repositories should anchor technical work to the right client and project.

They should help the assistant:

- see which codebases are active
- connect commits to projects and Jira keys
- generate better standups and change summaries
- estimate effort more credibly than email/calendar alone

## Current 2.6 Direction

The current system supports:

- Google, Microsoft, Jira, and Slack connections
- client and project registry
- repository attachment and discovery
- workstream grouping and open-loop derivation
- attribution diagnostics
- morning, standup, wrap, and report generation
- assistant questions and in-UI coaching
- review queues and approvals
- durable memory facts
- internal improvement tickets
- noise controls such as ignore-similar-message patterns
- retroactive recomputation when corrections or learned state change

This is the right direction because it lets the assistant behave more intelligently without hardcoding every edge case.

## What "Learning" Should Mean Here

This assistant should become more useful as its operational memory improves.

That means:

- better mapping of recurring contacts to clients and projects
- better understanding of which senders and channels usually matter
- better grouping of related work across email, Slack, Jira, meetings, and code
- better prioritization based on Jerry's actual role in a client relationship
- fewer low-value follow-up tasks
- fewer repeated questions after the same ambiguity has been answered

It does not mean silent autonomy or unreviewed action-taking.

## Principles For Future Work

When extending personal-ops behavior, prefer:

- soft model context before hard rules
- explainability before cleverness
- correction loops before automation
- account-aware email learning before global sender assumptions
- workstream synthesis before adding more raw feeds
- lower noise before higher volume

The assistant should become more accurate and more useful without becoming more intrusive.
