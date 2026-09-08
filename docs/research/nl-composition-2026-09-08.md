# Requirement composition evaluation — 2026-09-08

The final implementation matched 59/60 expected results across three passes
of 20 English/German cases. The baseline matched 49/60, with one timeout.
The remaining final miss was an unnecessary clarification for “Zugang ohne
Stufen”; it returned no needs rather than an inverted access requirement.

| Implementation | Correct | Request failures | Median end-to-end latency | Reported cost |
|---|---:|---:|---:|---:|
| Baseline | 49/60 | 1 | 6.03 s | $0.05296 |
| Definitions, prompt and coverage checks | 58/60 | 0 | 4.30 s | $0.04233 |
| Final, with known-qualifier mapping checks | 59/60 | 0 | 4.25 s | $0.03151 |

## What changed

- All 17 vocabulary entries have shared meaning/limit definitions. The route
  prompt receives the 15 boolean attribute definitions; cuisine and budget
  keep their separate concept paths. The schema enumerates attribute keys.
- Polarity refers to normalized meaning. “No stairs” means step-free access
  is required. A feature that is “not required” is not an exclusion.
- Source words and explicit `unrepresented` clauses detect incomplete model
  interpretations. Both model and deterministic paths preserve concept counts
  until overflow is checked. A detected omission returns clarification and no
  partial needs. Plan preview also honors reported omissions.
- Each alternative operator must be represented in a quality or multi-value
  kind. A malformed OR split cannot be repaired by discarding independent
  hard/soft choices. Known/unknown cuisine alternatives stay one text condition.
- Known contextual qualifiers survive even when the model chooses the wrong
  role. The intermediate run's two errors were bare attributes for “quiet
  tonight” and “step-free entry without staff help”; both are now regression
  cases for the mapping fallback.

## Method and limits

[Fixture](../../tests/fixtures/nl-composition.jsonl),
[runner](../../scripts/nl-composition-bench.mts), and
[raw results](./nl-composition-2026-09-08.json).

All runs used `openai/gpt-5.6-luna` through OpenRouter at `xhigh`, default
service tier, strict structured output, and the normal 30-second route
deadline/output-budget policy. The baseline source was archived from
`bccdfa216d7cf633ddb9591e259ad1c809106c89` with the current reasoning configuration
copied in so effort remained constant. It was not a comparison of reasoning
levels. The six-quantity case is deterministic and makes no provider call.

The standalone transport sends real provider requests through production
request shaping, response parsing and retry handling, without reading or
writing room data or PostgreSQL admission records. Each corpus pass is
sequential; separate experimental runs partly overlapped. Provider routing
was unpinned. Costs are provider-reported successful-response usage totals;
charges for timed-out requests may be absent. Cache effects and provider
variation prevent attributing cost/latency differences solely to these edits.

This is a small development regression set, with several examples also present
in the prompt. The intermediate failures informed the mapping checks. It is
not a held-out estimate of general language accuracy. Full need counts,
attribute truth expectations, selected hardness choices, and clarification are
checked; need order and display wording are not. The five-clause case's truth
and hardness assertions were strengthened after capture and verified against
all saved results without changing their scores.

Source coverage proves that words were retained, not that their meaning was
correctly represented. Its English/German framing allowlist can cause extra
clarification. Known-qualifier checks are intentionally conservative and do not
cover every phrasing. More diverse held-out paraphrases remain useful future
validation.

## Local validation

All 879 unit tests passed across 65 files. Contracts, server and web TypeScript
checks passed. No deployment was performed.
