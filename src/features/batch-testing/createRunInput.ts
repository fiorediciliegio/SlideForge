import type { CreateBatchTestRunInput } from "../../api/pptBackend";
import type { BatchTestCaseInput } from "../../api/types";
import type { BatchTestInput } from "./types";

export function prepareBatchTestRunCreationInput(input: BatchTestInput, cases: BatchTestCaseInput[]): CreateBatchTestRunInput {
  return { target_stage: input.target_stage, ...(input.test_id ? { test_id: input.test_id } : {}), cases };
}
