# Contributing

Issues are welcome — bug reports, confusing behavior, places where the
documentation and the code disagree. The drift tests exist so that public
claims and code cannot quietly diverge; if you find a divergence anyway,
that's a good issue.

Pull requests are welcome too, with honest expectations: this is a small
operation with strong opinions about the kernel staying thin (the server
performs no inference; judgment belongs to agents), so PRs that add
server-side cleverness will likely be declined kindly. Small fixes, tests,
and self-hosting ergonomics are the easiest yes.

Replies may take days. Run `npm test` before sending anything — the suite is
the contract.
