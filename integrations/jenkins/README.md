# Non-production automatic deployment integration

This directory provides an **offline gate**, not a replacement deployment pipeline. Existing GitLab master merges trigger existing Jenkins jobs; do not trigger builds again.

## Current implementation

- `nightshift-gate.py`: HMAC-signed, exact project/job/source/destination/test-or-preprod capability. Single-use durable nonce + operation/job claims. Validate at the existing deployment write boundary after build/queue delay. Rejects expired/frozen/ambiguous/replayed capabilities. It does not stop an already-admitted write, guarantee completion before expiry, or provide automatic rollback.
- `observer-inventory.groovy`: read-only current Jenkins authorization inventory. Prints typed ACL metadata and a stable digest; no credentials, user configuration or global XML. Handles a named administrator without a configured local login as unverified, not by resetting its password.
- Host `jenkins-observer.ts`: read-only exact-SHA existing webhook build lookup with stable queue identity and exact release artifact verification. It never sends a build/cancel/retry/config request.

## Activation prerequisites

1. Reviewed/pinned current publisher, job mappings and exact non-production destinations for all sibling jobs.
2. Authenticated webhook actor preserved from GenericCause, exact project→bot mapping; human routes unchanged, missing actor not silently classified human.
3. Signed ticket available before FF merge; exact candidate SHA equals master event SHA. Ticket retrieval must not expose signing key to build code.
4. Gate module/private key/durable replay state mounted only into trusted deployment workers; check immediately before existing Kubernetes patch, not at build start or read-only preflight.
5. Observer identity with Overall/Read and only exact authorized Job/Read. Never grant Build/Configure/Administer or use the onboarding admin as runtime identity.
6. If moving GlobalMatrix to ProjectMatrix, inventory **all** existing job/folder/node ACL properties first so dormant grants cannot silently activate. Preserve typed global grants and existing admins. Back up only affected ACL objects, use exact pre/post hashes and targeted rollback.
7. No capability activation until exact live hashes, identities, routes and deadline admission proof are verified. Missing attestation yields unknown/blocked, not inferred success.

## Actual inspected state on 2026-11-10

- Jenkins 2.568.2, matrix-auth3.2.10, GlobalMatrixAuthorizationStrategy, private realm, signup disabled.
- Explicit global grants: EITHER admin/Administer, EITHER wyy/Administer, EITHER authenticated/Overall Read. admin local login and effective Administer verified; wyy local password absent, its grant is preserved.
- 27 items, no item/folder/node matrix properties; proposed observer absent. No Jenkins settings were changed by inventory.
- 17 scoped GitLab bots and FF-only project settings were prepared separately under explicit authorization. Publication runtime remains disabled until these prerequisites are complete.

Source references: [Jenkins access control](https://www.jenkins.io/doc/book/security/access-control/), [matrix-auth](https://plugins.jenkins.io/matrix-auth/), [config-file-provider](https://plugins.jenkins.io/config-file-provider/). Pin installed versions and verify actual form/API contracts before any update; no global security migration based on guessed payloads.
