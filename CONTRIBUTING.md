# Contributing

Thanks for improving RecallTube.

## Before you start

1. Open an issue before a large architectural or product change.
2. RecallTube is deliberately narrow: it finds the moment you remember in the video you are
   watching. Features that turn it into a general YouTube AI assistant will be declined, however
   well built.

## Non-negotiables

- Nothing leaves the device: no transcript, query, embedding or answer is ever uploaded.
- No cloud backend, account system, analytics or mandatory API key.
- No remotely hosted executable code. Model weights are data, downloaded only after explicit
  consent. `npm run build` enforces this and will fail your PR if you break it.
- No mechanism that bypasses YouTube authorization, access controls or Proof-of-Origin
  protections, and no video or audio stream downloads.
- Transcript content is untrusted input. Never render it as HTML; never let it reach a model as
  instructions.

## Working on retrieval

Retrieval changes must be measured:

```bash
npm run bench        # before and after
npm run bench:perf   # per-keystroke budget is 50 ms
```

Include both sets of numbers in the pull request. A change that improves one metric at the cost of
another needs an argument, not just a table — the 0.2 release rejected two retrieval changes on
exactly these grounds, and the reasoning is written up in
[docs/RETRIEVAL_BENCHMARK.md](docs/RETRIEVAL_BENCHMARK.md).

Do not describe a retrieval change as "state of the art" without a reproducible benchmark,
baselines and published metrics. The current dataset is small enough that most differences are not
significant; growing it is itself a welcome contribution.

## Checks

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e   # needs a display; CI runs it under xvfb
```

- Do not weaken the TypeScript configuration.
- Do not silence a failing test. If a test exposes a bug, fix the bug — the property tests in this
  repository have caught four real Unicode defects, and they only work if they are trusted.
- Add tests near the behaviour you changed. Parsers get fixtures, text handling gets property
  tests, security boundaries get hostile inputs.

## Pull requests

Describe the impact on privacy, model size, latency and browser compatibility. If you touched
caption acquisition, say which cases from [docs/TESTING.md](docs/TESTING.md) you ran against real
YouTube, and on which Chrome version.

## Security

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md).
