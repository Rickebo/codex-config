## Summary

- replace ambiguous Bash default expansion for `RETIRED_CANDIDATES_JSON`
- treat only unset/empty input as `{}`
- reject malformed and non-object JSON before release planning
- add regression coverage for workflow wiring and runtime input cases

## Validation

- `make test-release-flow`
- `./hack/validate-repository.sh`
- `actionlint`
- Python/Node syntax checks
- `git diff --check`
- independent Luna review: GO at `91080852320997f19ff268b65b85fb7f0d0ef5bc`

Closes #158
