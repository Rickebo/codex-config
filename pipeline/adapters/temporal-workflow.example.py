"""
Temporal adapter example for the Codex pipeline FSM.

This is a template only. It is intentionally not wired to your local runtime.
"""

from datetime import timedelta

from temporalio import workflow


@workflow.defn
class PipelineWorkflow:
    @workflow.run
    async def run(self, run_dir: str) -> str:
        stage = "code"
        done = False

        while not done:
            # In production, call an Activity that executes:
            #   node pipeline-controller.mjs status/advance/approve
            # and returns the next stage metadata.
            result = await workflow.execute_activity(
                "advance_stage_activity",
                args=[run_dir, stage],
                start_to_close_timeout=timedelta(minutes=30),
                retry_policy=workflow.RetryPolicy(maximum_attempts=3),
            )

            if result.get("approval_required"):
                await workflow.execute_activity(
                    "wait_for_human_approval_activity",
                    args=[run_dir],
                    start_to_close_timeout=timedelta(days=1),
                )
                result = await workflow.execute_activity(
                    "approve_and_advance_activity",
                    args=[run_dir],
                    start_to_close_timeout=timedelta(minutes=10),
                )

            stage = result["current_stage"]
            done = bool(result.get("done", False))

            # Consider continue-as-new for very long loop histories.
            if result.get("history_length", 0) > 5000:
                return workflow.continue_as_new(run_dir)

        return "done"
