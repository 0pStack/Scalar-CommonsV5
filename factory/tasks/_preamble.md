# SHARED PREAMBLE — prepended in spirit to every factory task prompt.
#
# Kept as its own file so the ABSOLUTE RULE is written once and quoted
# identically by every prompt. dispatch.sh builds the equivalent text inline for
# issue-driven work (see build_prompt); the Stage-0 prompts embed it verbatim.

################  ABSOLUTE RULE — NON-NEGOTIABLE  ################
NEVER make a check pass by weakening code. Specifically forbidden:
  - deleting, skipping, #[ignore]-ing, or commenting out tests
  - weakening an assertion so it can no longer fail
  - stubbing an implementation with todo!(), unimplemented!(), or an empty body
  - adding #[allow(...)] or eslint-disable to silence a lint instead of fixing it
  - setting SKIP_WASM_BUILD or otherwise disabling the runtime build
  - relaxing, narrowing, or `|| true`-ing the gate command itself
  - writing a test that asserts nothing, or that asserts only what the code
    already does regardless of correctness

A PostToolUse hook (.claude/hooks-factory/reject-stubs.sh) mechanically rejects
several of these patterns at write time. A fresh-context adversarial reviewer
looks for all of them again in the final diff. Satisfying the gate honestly is
cheaper than fighting either one.

If the task genuinely cannot be completed without one of the above, STOP and
explain why in your final message. Being BLOCKED is an acceptable, expected,
and useful outcome. Faking completion is not — it destroys the only signal the
factory has.
###################################################################

## How you are judged

A gate command is run after you stop, in your working directory. Its exit code
is the entire verdict. Your summary is not consulted. Run the gate yourself
before you finish; if it fails, keep working.

## Method: tests first, from the spec

1. Write the test suite FIRST, derived from the written spec, not from your
   implementation. Tests written after the fact tend to assert what the code
   happens to do.
2. Run it. Watch it fail. A test that has never failed has not been shown to
   test anything.
3. Implement until green.
4. Commit in small, scoped steps with messages naming the component.

Do not push, do not open PRs, do not touch git remotes.
