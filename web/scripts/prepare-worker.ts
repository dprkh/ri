import { runPrepareChapterWorker } from "./prepare.ts";

function workerErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function workerErrorStack(error: unknown) {
  return error instanceof Error ? error.stack : undefined;
}

runPrepareChapterWorker().catch((error) => {
  postMessage({
    type: "prepare-chapter-bootstrap-error",
    message: workerErrorMessage(error),
    stack: workerErrorStack(error),
  });
});
