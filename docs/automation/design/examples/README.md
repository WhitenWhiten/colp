# Example usage and topology

These are synthetic design fixtures, not real user data, valid credentials or recorded runtime output.

M1 uses m1-placement.json, m1-bindings.json and m1-rule-create.json with no target or execution policy. academic-summary-only.json is the deliberately one-worker-job M2 release fixture. academic-intake.json and rule-create.json are the broader three-task M2 example; they are not the one-job proof. The supplied bundle digest is a shape placeholder and is not a claimed computed production digest.

research-catalog.json models an internal institutional research dataset archive. Its stable entity keys denote research groups, not people. In the fixture hierarchy, n_catalog_root contains n_materials_group and n_climate_group. The executor exec_archive is bound to target_archive with a dedicated restricted credential, no broadcast, and grants only the declared fields. Dataset accession, source evidence and accepted predecessor metadata drive mapping; missing or ambiguous identities require review. Every identifier is invented for testing.

Portable templates use symbolic collectionSlot and targetSlots. Folder paths in a private export may still be confidential and must be scrubbed before publication. Imported templates never authorize themselves or activate automatically.
