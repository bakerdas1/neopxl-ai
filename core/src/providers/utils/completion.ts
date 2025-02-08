import { CompletionArgs, CompletionResponse } from "../../types";

export interface Completion {
  getCompletion(args: CompletionArgs): Promise<CompletionResponse>;
}
