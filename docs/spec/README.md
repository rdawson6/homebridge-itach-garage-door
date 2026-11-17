# Specification

The requirements, design and task breakdown this plugin was built from.

| File | Contents |
|---|---|
| `requirements.md` | Acceptance criteria in EARS form, grouped by requirement |
| `design.md` | Architecture, component responsibilities, state model, correctness properties |
| `tasks.md` | Implementation plan and task breakdown |

These are kept in the repository so that the reasoning behind the plugin's
behaviour has version history alongside the code that implements it. When a
requirement is amended, the change should be visible here and summarised in
`CHANGELOG.md`.

## Relationship to `.kiro/specs/`

These documents originated in the author's Kiro workspace at
`.kiro/specs/itach-garage-door-plugin/`, which is outside this repository. That
copy is what the Kiro IDE's spec tooling reads.

**Treat the copy in this repository as authoritative for published behaviour.**
It is the version that passed review and shipped. If the two diverge, this one
describes what the released plugin actually does.

## Amendment history

Requirement amendments that changed shipped behaviour:

- **2026-11-16** — Requirements 5.4, 6.11 and 7.8 were narrowed to cover a
  device error response only, and new criteria (3.14–3.16, 5.11–5.13, 6.12)
  were added for connection-loss cases. Previously any failed relay command had
  to be reported to HomeKit as a communication failure, which made the Apple
  Home app latch an accessory at "No Response" after a momentary TCP drop, even
  though the client reconnected within about a second. The 30-second connection
  grace period is now the boundary: a transient drop completes the HomeKit write
  and logs a warning, while a genuinely persistent fault still reports a
  communication failure. Device error responses (`ERR_nnn`), command queue
  overflow and relay-release lockout remain hard failures. Released in 1.1.0.
