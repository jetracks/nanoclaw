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
- model-guided role/context judgment

When uncertain, it should preserve ambiguity rather than pretend certainty.

### 4. Keep human correction central

Jerry must be able to teach the system through lightweight correction:

- this belongs to Betty Mills, not Dynecom
- this is Wabash, not General
- this is awareness only, not a task
- this is high priority
- this is blocked

Those corrections should remain more important than future inference.

## Main Context Layers

The assistant currently has several places where operational context can live.

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

Each connected account can store soft triage guidance.

This is the right place for instructions like:

- how to interpret a mailbox
- what kind of work the account represents
- what typically matters to Jerry in that account
- what kinds of messages are usually awareness-only
- what kinds of situations should break through as high priority

This is model context, not a deterministic filter.

### Repository context

Repositories should anchor technical work to the right client and project.

They should help the assistant:

- see which codebases are active
- connect commits to projects and Jira keys
- generate better standups and change summaries
- estimate effort more credibly than email/calendar alone

## Desired Behaviors

### Morning

The assistant should produce a clear, low-noise morning view:

- today's meetings
- top priorities
- follow-ups that actually require Jerry
- blockers
- active workstreams
- draft standup

### During the day

The assistant should help triage new inbound and track work in motion:

- distinguish awareness from action
- link emails, Slack, Jira, and repo activity into the same workstream
- surface things that slipped or changed
- preserve client/project attribution

### End of day

The assistant should help Jerry close the loop:

- what moved forward
- what remains open
- what is blocked
- what should carry into tomorrow

## Current Product Direction

Today the system already supports:

- Google, Microsoft, Jira, and Slack connections
- client and project registry
- client roles and notes
- connection-level triage guidance
- repository attachment and discovery
- workstream grouping
- attribution diagnostics
- morning, standup, and wrap reporting

The current model-guided triage path uses:

- source content
- account identity
- connection guidance
- client roles and notes
- communication preferences
- project context

This is the right direction because it lets the assistant behave more intelligently without hardcoding every edge case.

## What "Learning" Should Mean Here

This assistant should become more useful as its operational memory improves.

That means:

- better mapping of recurring contacts to clients and projects
- better understanding of which senders and channels usually matter
- better grouping of related work across email, Slack, Jira, meetings, and code
- better prioritization based on Jerry's actual role in a client relationship
- fewer low-value follow-up tasks

It does not mean silent autonomy or unreviewed action-taking.

## Principles For Future Work

When extending personal-ops behavior, prefer:

- soft model context before hard rules
- explainability before cleverness
- correction loops before automation
- workstream synthesis before adding more raw feeds
- lower noise before higher volume

The assistant should become more accurate and more useful without becoming more intrusive.

## Examples Of Good Assistant Judgments

### Betty Mills

If a message lands in a shared alias mailbox and Jerry is not directly addressed, it is often awareness-only.

But the assistant should still escalate if the content suggests:

- vendor pricing changes
- MAP violations
- website or system outages
- company-level operational risk

### Dynecom

The assistant should understand that Dynecom work often spans platform, client delivery, Jira, Slack, and multiple repositories. It should not treat those as unrelated simply because they arrive through different systems.

### Subclients

The assistant should preserve parent-child relationships:

- `Ezidia` is under `Dynecom`
- `TagSmart` and `Jameco` are prospects under `Dynecom`

That should help planning and reporting reflect the real business structure.

## Practical Maintenance Guidance

To keep the assistant useful:

- keep client roles current
- add or refine client notes when a relationship changes
- add connection triage guidance when an account has special semantics
- attach active repositories to projects
- correct bad mappings quickly
- keep project status and priorities realistic

The assistant should not depend on perfect data entry, but it becomes materially better when the registry and connection guidance stay current.
