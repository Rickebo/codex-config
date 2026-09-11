# Durable Runtime Adapters

This folder contains scaffolding templates for moving the local pipeline FSM into durable workflow runtimes.

## Files

1. `langgraph-workflow.example.py`
- outlines a LangGraph state model and node layout
- intended to map each stage (`code`, `review`, `test`, `validation`) to graph nodes
- use persistent checkpoints for resumability

2. `temporal-workflow.example.py`
- outlines a Temporal workflow loop
- intended to execute stage advancement as Activities
- includes approval wait handling and a `continue-as-new` pattern

## Integration Guidance

1. Keep `/home/rickebo/.codex/bin/pipeline-controller.mjs` as the source of transition truth initially.
2. Wrap controller calls in runtime Activities or tools.
3. Preserve these state invariants:
- single active stage
- deterministic policy transitions
- loop budget enforcement
- explicit approval checkpoint handling
4. Emit run metrics and alerts from runtime events or from periodic scans.
