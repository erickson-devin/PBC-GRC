---
description: Run every CI gate (typecheck, build, all test suites) and print the summary lines
allowed-tools: Bash
---

Run the repository's CI gates from the repo root, in this order, each as its own command so the exit codes are not lost. Node is on PATH (`node --version` is v24 here); CI uses Node 22, so also run the suite under Node 22 when `$ARGUMENTS` contains `node22` (it downloads Node 22 through npx the first time).

1. `npm run typecheck`
2. `npm run build`
3. `npm run test:all > /tmp/test-all.txt 2>&1; echo "test:all exit $?"` then summarise the file:
   - the number of `TEST RESULTS` lines (suites) and the total of passed / total assertions (`grep RESULTS /tmp/test-all.txt | awk '{s+=$4; t+=$6} END {print NR" suites, "s" of "t" assertions"}'`)
   - every line containing `✗` or `CRASH`
4. If `$ARGUMENTS` contains `node22`: `npx -y -p node@22 -- npm run test:all > /tmp/test-all-22.txt 2>&1; echo "node22 test:all exit $?"` and the same summary.

Print, verbatim, the exit code of each gate and the summary lines. Do not edit any file. There is no linter or formatter configured, so there is no lint gate; the Python `scanner-agent/` is a separate repository with its own CLAUDE.md and is not part of this command.
