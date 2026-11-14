# Pipeline reliability and dashboard update

The workspace changes are local. They have not been deployed to the running VM or tested against live Hugging Face storage.

## What the reported trace tells us

The previous uploader used `execFile` with a 10 MiB output limit, while Hugging Face wrote progress displays to stderr. Exceeding that limit can terminate a healthy transfer. Its error handler then returned only the first 300 characters of stderr, hiding exceptions, timeouts, or process termination details at the end.

This is a confirmed failure path in the code, not proof that buffer exhaustion caused job 3977's particular failure. Its supplied trace contains progress, not the underlying exception.

## Upload and recovery behavior

- Child-process output is continuously drained and only a bounded diagnostic tail is kept. Progress bars are disabled before Python imports. Credentials travel through stdin.
- A successful exit must include an explicit completion acknowledgement. Dependency setup is shared between local workers, and bootstrap failures cannot silently fall through as success.
- Transient transfers retry with exponential backoff. Authorization, missing bucket, permission, and full-disk errors stop the upload attempt loop early.
- VM conversion uses a persistent checkpoint keyed by source paths, sizes, modification times, track selection, and destination. Local output size and SHA-256 must match before reuse.
- The selected bucket is saved with the job. Account reordering or token rotation does not silently change a retry's destination.
- Each upload attempt lists the expected remote paths, skips matching sizes, sends missing/mismatched files, and verifies all expected paths and sizes afterward. This is presence/size verification, not a separate remote SHA-256 download check.
- Both VM and generated Kaggle upload code use the same remote verification function. Kaggle result checkpoints are replaced atomically.
- Processing failures retain staged source files. VM output/checkpoint directories also remain until durable completion or explicit job deletion. The original Kaggle runtime remains ephemeral; this does not persist its converted files after the notebook is destroyed.
- Completed jobs record pending callback delivery in the same database update as their results. Callback and cleanup failures cannot turn completed processing back into a failed/requeued upload.
- VM worker claims compare the current staged status before starting. Retry/delete actions refuse active jobs; individual retry/delete and bulk retry/delete also check state during mutation.
- All declared staged qualities must exist and be nonempty. An audio conversion failure no longer silently substitutes audio track zero.
- Orphan cleanup requires database ownership verification, protects retained failed jobs, and skips files modified within the last ten minutes. Retained failed jobs consume storage by design; inspect/retry/delete them explicitly when space is needed.

## Dashboard

The overview uses a warm ivory, terracotta, and serif visual theme. It separates queue health, delivery stages, worker capacity, and recent activity. Full episode search/filtering and pagination happen on the server rather than searching only the first 100 jobs.

Logs, processing history, accounts, and operations have separate views. Requests reject HTTP failures instead of displaying success, queue refreshes are cancelled on view/filter changes, and stale data is labeled. Dialogs support Escape, keyboard focus containment, and return focus. Secondary panels load on demand. Production builds explicitly set NODE_ENV=production even if the local .env is configured for development.

## Validation

- `npm test`: isolated regression suite; database access is disabled and staging uses a temporary directory.
- Set `KIRA_TEST_PYTHON` to an installed Python executable to enable the mocked Python bucket verification and generated-worker syntax tests.
- `npm run typecheck`
- `npm run build`: optimized frontend plus backend compilation.
- `scripts/ui-smoke.cjs`: prepared browser checks against mocked local API data. Start the frontend on port 3000; provide Playwright via `PLAYWRIGHT_MODULE` and an installed browser via `BROWSER_CHANNEL` (defaults to msedge). These checks were not completed in this session because browser launch required permission that was declined.

No live jobs, callbacks, uploads, credentials, or deployment state were changed during validation. After deployment, retry an affected VM job and inspect its new diagnostic tail if it still fails. Jobs whose staged files were deleted by the previous code will need discovery/download again.

## Reference behavior

Hugging Face documents that bucket batches can partially succeed: [Bucket upload guide](https://huggingface.co/docs/huggingface_hub/guides/buckets). Remote inspection uses [get_bucket_paths_info](https://huggingface.co/docs/huggingface_hub/en/package_reference/hf_api#get_bucket_paths_info). Progress display configuration follows the [environment variable reference](https://huggingface.co/docs/huggingface_hub/package_reference/environment_variables).
