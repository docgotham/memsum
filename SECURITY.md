# Security

Mem·Sum holds people's shared memory; reports that protect it are welcome and
taken seriously.

## Reporting

Email **docgotham@gmail.com** with "SECURITY" in the subject. Include what you
found, how to reproduce it, and what you believe the impact is. You will get a
human reply — this is a small operation, so response time is measured in days,
not hours. Please give us reasonable time to fix an issue before disclosing it
publicly.

Do not test against sums you are not a member of: the hosted service is real
people's data. If you need a target, self-host the kernel or use your own
account — the free beta is enough to exercise every surface.

## What counts

Especially interesting: anything that lets one account read or write another
account's sums (row-level security is the product's spine), authentication or
token-handling flaws, ways to make the kernel send SMS without opt-in, and
ways to make the operator's admin surface read sum content (it is designed and
tested to be unable to).

## Scope notes

- Secrets are stored as hashes; connector and invite tokens are shown once.
- Rate limiting is fail-open by design — its absence under counter outage is a
  known trade, not a finding.
- Tool schemas are intentionally public (they also appear in the server card).
