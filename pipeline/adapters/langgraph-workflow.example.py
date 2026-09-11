"""
LangGraph adapter example for the Codex pipeline FSM.

This is a template only. It is intentionally not wired to your local runtime.
"""

from typing import TypedDict, Optional


class PipelineState(TypedDict):
    run_dir: str
    stage: str
    done: bool
    awaiting_approval: bool
    report_path: Optional[str]


def code_node(state: PipelineState) -> PipelineState:
    # Delegate code stage work, then write report JSON to run_dir.
    return {**state, "stage": "review"}


def review_node(state: PipelineState) -> PipelineState:
    # Delegate review stage work, then route based on report status.
    return state


def test_node(state: PipelineState) -> PipelineState:
    # Delegate test stage work, then route based on report status.
    return state


def validation_node(state: PipelineState) -> PipelineState:
    # Delegate validation stage work, then route based on report status.
    return state


def approval_node(state: PipelineState) -> PipelineState:
    # Block until human approval is recorded; then continue.
    return {**state, "awaiting_approval": False}


def build_graph():
    """
    Pseudocode:
    - Add nodes: code, review, test, validation, approval, done
    - Add deterministic conditional edges by reading pipeline-controller output
    - Persist checkpoints so runs can resume after interruption
    """
    raise NotImplementedError("Wire this template into your LangGraph runtime")
