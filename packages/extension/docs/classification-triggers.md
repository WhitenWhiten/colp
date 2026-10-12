# Classification dispatch in the browser extension

All entry points use `classification-intent.ts` for trigger eligibility and incoming-page request construction. Popup previews are admitted by `sw/classification-preview.ts` before either provider executes. Saved captures use the same eligibility policy before their existing durable local or cloud workflow advances.

| Intent | Eligibility | Result application |
| --- | --- | --- |
| Form opens with automatic suggestions enabled | A real toolbar popup, manual save mode, and a complete native existence check showing no exact bookmark match | Fill the form; the user confirms the save |
| User asks for a suggestion or another suggestion | Explicit action; an existing bookmark is allowed | Fill the form, or correct the saved capture through its existing edit workflow |
| A new capture finishes native save | This task created the bookmark, annotations are persisted, classification is pending, and no manual edit fenced it | Apply through the local or cloud capture workflow |

“Already saved” means the bookmark existed before this intent. A newly saved capture remains eligible, including an explicitly requested additional copy of a URL that already exists. Subscription exclusions, provider credentials, billing consent, execution controls, and live folder validation remain enforced by their existing execution/application boundaries.

## Command identity and reopening

`classification-preview-store.ts` retains form-open intents in `storage.session`, scoped by server, account, authority generation, collection, local provider generation, and the canonical request document. The key contains a digest rather than the page title or URL. Different inputs, requested tags, billing quotes, rejected folders, or provider/authority contexts produce different intents.

The command is persisted before dispatch. Reopening the same form returns the prior UI suggestion or uncertain outcome without dispatching again. An explicit cloud check replays the original command and body; an uncertain local call cannot replay its spent command. An explicit new request may replace the previous intent. The popup adopts the worker's command ID, and explicit retries carry an explicit trigger even when the original request came from form-open.

Retention lasts for the browser session and is capped at 100 implicit intents. At the cap, implicit dispatch stops and the explicit Suggest action remains available. Retained suggestions contain folder and tag choices plus candidate coverage, without provider probabilities, confidence scores, raw responses, request content, or credentials. Applying a retained folder still validates the live destination. Saved captures retain their existing task identities and recovery receipts; they never deduplicate solely by URL.

## Adding an entry point

Describe its intent through the shared trigger policy and use the shared document builder and provider-selection helper. Keep UI presentation and result application separate from dispatch eligibility. Do not infer existence from DOM attributes or substitute an incoming-page payload for a bookmark existence check.

Regression coverage lives in `classification-trigger.test.ts`, `popup-classification-auto.test.ts`, `capture-automatic.test.ts`, `capture-local-automatic.test.ts`, and the real-toolbar `mv3-manual-classification.spec.ts`. It covers saved-page suppression, delayed/unavailable existence checks, explicit reclassification, form reopening, worker restart with an uncertain result, command-preserving explicit retry, and classification after a new native save.
