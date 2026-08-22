# Security policy

## Reporting a vulnerability

Please report privately through GitHub's private vulnerability reporting for this repository rather
than opening a public issue. Include the extension version, your browser version, and a
reproduction. If the report involves a specific video, a public URL is enough — please do not send
transcript content.

We aim to acknowledge within 7 days.

## Security model

RecallTube's security model is built around four boundaries:

- **Transcript text is untrusted data, never instructions.** It is rendered as React text nodes,
  never as HTML, and Ask mode fences it, labels it untrusted, and validates every citation against
  the evidence actually supplied.
- **The page is untrusted.** The main-world bridge holds no privileges; its payload is validated
  field by field and caption URLs are allowlisted to YouTube's timed-text endpoint before any
  credentialed request.
- **No remote code.** All executable code ships inside the package. The ONNX Runtime is bundled,
  not fetched. `npm run build` fails if the artifact references any host outside
  `youtube.com`, `huggingface.co` or `*.hf.co`.
- **Model weights are data**, downloaded only after explicit consent, and parsed by ONNX Runtime.
- **Extension messages are untrusted.** Every cross-context payload is checked for its expected
  shape, sender tab, video identity, and generation before it can affect the active panel.
- **Storage is local and erasable.** Transcript and embedding caches are content-addressed,
  bounded, and removable from the extension's privacy dialog.

Residual risks remain: YouTube can change its undocumented page structures, a browser or ONNX
Runtime vulnerability is outside RecallTube's trust boundary, and a malicious model file could
exercise defects in its parser. Build-time host checks, runtime validation, pinned model revisions,
and browser sandboxing reduce those risks; they cannot eliminate them.

## Dependency advisories

`npm audit` currently reports 4 high-severity advisories, all reached through
`@huggingface/transformers`' Node-only optional dependencies:

| Package | Path | Reachable in the browser artifact? |
| --- | --- | --- |
| `sharp` | `@huggingface/transformers` → `sharp` | **No** |
| `onnxruntime-node` | `@huggingface/transformers` → `onnxruntime-node` | **No** |
| `adm-zip` | `onnxruntime-node` → `adm-zip` | **No** |

These are image decoding and Node inference paths that RecallTube never imports. Their absence from
`.output/chrome-mv3` is asserted by `src/build/artifact.test.ts` and by
`scripts/harden-artifact.mjs`, which fails the build. They are **not** dismissed as harmless in
general — they are build-tree only for this project, they are re-checked every release, and they
will be resolved by an upstream release rather than by suppression.

Verify yourself:

```bash
npm run build          # fails on any unexpected host or Node-only dependency
npm audit              # see the advisories in full
```

## Scope

In scope: the extension's own code, its handling of untrusted caption and page input, its storage,
and its network behaviour.

Out of scope: vulnerabilities in YouTube, in the browser, or in a third-party model's weights.
RecallTube does not attempt to bypass YouTube authorization, access controls or Proof-of-Origin
protections; reports asking us to add such a capability will be declined.
