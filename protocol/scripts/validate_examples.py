#!/usr/bin/env python3
"""Validate repository examples against the wire schema and snapshot semantics."""

from __future__ import annotations

import copy
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import SchemaError, ValidationError
from referencing import Registry, Resource


ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = ROOT / "schemas" / "collection-protocol.schema.json"
SCHEMA_V02_PATH = ROOT / "schemas" / "collection-protocol-0.2.schema.json"
EXAMPLES_DIR = ROOT / "examples"
EXAMPLE_CONTRACTS = {
    "access-policy.json": "accessPolicy",
    "change-plan.json": "changePlan",
    "change-plan-request.json": "changePlanRequest",
    "collection-directory.json": "collectionDirectory",
    "collection-metadata.json": "collectionMetadata",
    "collection-snapshot.json": "snapshot",
    "global-resource-identity.json": "canonicalResourceUri",
    "mcp-tools-list.json": "mcpToolsList",
    "local-bookmark-node.json": "node",
    "node-detail.json": "nodeDetail",
    "problem.json": "problem",
    "protected-publication-snapshot.json": "snapshot",
    "public-feed.json": "feed",
    "public-manifest.json": "manifest",
    "publisher-annotation-create.json": "annotationCreate",
    "publisher-collection-create.json": "collectionCreateRequest",
    "publisher-collection-create-result.json": "collectionCreateResult",
    "publisher-node-move.json": "nodeMoveRequest",
    "release-directory.json": "releaseDirectory",
    "release-result.json": "releaseResult",
    "sync-pull.json": "syncPull",
    "sync-push.json": "syncPush",
    "sync-push-result.json": "syncPushResult",
    "sync-session-request.json": "syncSessionRequest",
    "sync-session-result.json": "syncSessionResult",
    "sync-snapshot.json": "snapshot",
    "sync-update-operation.json": "operation",
}
EXAMPLE_CONTRACTS_V02 = {
    "sync-pull-v02.json": "syncPullV02",
}
EXPECTED_EXAMPLES = frozenset(EXAMPLE_CONTRACTS) | frozenset(EXAMPLE_CONTRACTS_V02)
DEFAULT_PUBLIC_SAFE_EXTENSIONS: frozenset[str] = frozenset()
REQUIRED_CONTRACT_DEFS = frozenset(
    {
        "manifest",
        "globalResourceType",
        "globalResourceIdentity",
        "canonicalResourceUri",
        "globalResourceReference",
        "bookmarkUrl",
        "directoryQuery",
        "collectionDirectory",
        "collectionMetadata",
        "snapshotQuery",
        "nodeDetailQuery",
        "nodeDeleteQuery",
        "snapshot",
        "nodeDetail",
        "problem",
        "collectionCreateRequest",
        "collectionCreateResult",
        "collectionMergePatch",
        "nodeCreateRequest",
        "nodeMergePatch",
        "nodeMoveRequest",
        "nodeMoveResult",
        "annotationCreate",
        "annotationMergePatch",
        "attachmentCreate",
        "attachmentMergePatch",
        "relationCreate",
        "relationMergePatch",
        "deleteResult",
        "releaseCreate",
        "releaseResult",
        "releaseDirectory",
        "syncSessionRequest",
        "syncSessionResult",
        "syncPush",
        "syncPushResult",
        "syncPullQuery",
        "syncSnapshotQuery",
        "syncPull",
        "syncAckRequest",
        "syncAckResult",
        "conflict",
        "conflictResolutionRequest",
        "conflictResolutionResult",
        "accessPolicy",
        "apiKeyMetadata",
        "rateLimitPolicy",
        "auditEvent",
        "changePlanRequest",
        "changePlan",
        "changeCommitRequest",
        "changeCommitResult",
        "feedQuery",
        "feed",
        "mcpToolsList",
    }
)
URI_TEMPLATE_EXPRESSION = re.compile(r"\{([^{}]*)\}")
URI_TEMPLATE_VARIABLES = frozenset(
    {
        "collectionId",
        "nodeId",
        "annotationId",
        "attachmentId",
        "relationId",
        "releaseId",
        "conflictId",
        "keyId",
    }
)
ENDPOINT_TEMPLATE_VARIABLES = {
    "collection": frozenset({"collectionId"}),
    "snapshot": frozenset({"collectionId"}),
    "node": frozenset({"collectionId", "nodeId"}),
    "nodes": frozenset({"collectionId"}),
    "nodeMove": frozenset({"collectionId", "nodeId"}),
    "annotations": frozenset({"collectionId"}),
    "annotation": frozenset({"collectionId", "annotationId"}),
    "attachments": frozenset({"collectionId"}),
    "attachment": frozenset({"collectionId", "attachmentId"}),
    "relations": frozenset({"collectionId"}),
    "relation": frozenset({"collectionId", "relationId"}),
    "release": frozenset({"collectionId"}),
    "releases": frozenset({"collectionId"}),
    "releaseItem": frozenset({"collectionId", "releaseId"}),
    "releaseSnapshot": frozenset({"collectionId", "releaseId"}),
    "collectionFeed": frozenset({"collectionId"}),
    "collectionAccess": frozenset({"collectionId"}),
    "syncConflict": frozenset({"conflictId"}),
    "adminKey": frozenset({"keyId"}),
    "adminKeyRotate": frozenset({"keyId"}),
}


def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON object member {key!r}")
        result[key] = value
    return result


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle, object_pairs_hook=reject_duplicate_keys)


def json_path(parts: Iterable[Any]) -> str:
    result = "$"
    for part in parts:
        if isinstance(part, int):
            result += f"[{part}]"
        elif isinstance(part, str) and part.isidentifier():
            result += f".{part}"
        else:
            result += f"[{json.dumps(part, ensure_ascii=True)}]"
    return result


def validation_message(path: Path, error: ValidationError) -> str:
    message = f"{path.name}:{json_path(error.absolute_path)}: {error.message}"
    leaves = [item for item in error.context if not item.context]
    if leaves:
        details = "; ".join(
            f"{json_path(item.absolute_path)}: {item.message}" for item in leaves[:4]
        )
        message += f" ({details})"
    return message


def validator_for_definition(
    schema: dict[str, Any], definition_name: str
) -> Draft202012Validator:
    return Draft202012Validator(
        {
            "$schema": schema["$schema"],
            "$defs": schema["$defs"],
            "$ref": f"#/$defs/{definition_name}",
        },
        format_checker=FormatChecker(),
    )


def validator_for_v02_definition(
    schema: dict[str, Any], schema_v02: dict[str, Any], definition_name: str
) -> Draft202012Validator:
    registry = Registry().with_resources(
        (document["$id"], Resource.from_contents(document))
        for document in (schema, schema_v02)
    )
    return Draft202012Validator(
        {
            "$schema": schema_v02["$schema"],
            "$ref": f"{schema_v02['$id']}#/$defs/{definition_name}",
        },
        registry=registry,
        format_checker=FormatChecker(),
    )


def find_cycles(edges: dict[str, str], label: str) -> list[str]:
    state: dict[str, int] = {}
    stack: list[str] = []
    stack_index: dict[str, int] = {}
    reported: set[frozenset[str]] = set()
    errors: list[str] = []

    def visit(node_id: str) -> None:
        state[node_id] = 1
        stack_index[node_id] = len(stack)
        stack.append(node_id)

        target_id = edges.get(node_id)
        if target_id in edges:
            target_state = state.get(target_id, 0)
            if target_state == 0:
                visit(target_id)
            elif target_state == 1:
                cycle = stack[stack_index[target_id] :] + [target_id]
                key = frozenset(cycle)
                if key not in reported:
                    reported.add(key)
                    errors.append(f"{label} cycle: {' -> '.join(cycle)}")

        stack.pop()
        stack_index.pop(node_id)
        state[node_id] = 2

    for node_id in edges:
        if state.get(node_id, 0) == 0:
            visit(node_id)

    return errors


def validate_manifest(manifest: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    for mount in manifest["mounts"]:
        for endpoint_name, template in mount["endpoints"].items():
            expressions = URI_TEMPLATE_EXPRESSION.findall(template)
            remainder = URI_TEMPLATE_EXPRESSION.sub("", template)
            if "{" in remainder or "}" in remainder:
                errors.append(
                    f"mount {mount['id']!r} endpoint {endpoint_name!r} has "
                    "unclosed URI template braces"
                )
                continue
            for expression in expressions:
                variables = expression.split(",")
                if not expression or any(
                    variable not in URI_TEMPLATE_VARIABLES for variable in variables
                ):
                    errors.append(
                        f"mount {mount['id']!r} endpoint {endpoint_name!r} uses "
                        f"non-Level-1 or unknown template expression "
                        f"{{{expression}}}"
                    )
            actual_variables = frozenset(
                variable
                for expression in expressions
                for variable in expression.split(",")
                if variable
            )
            expected_variables = ENDPOINT_TEMPLATE_VARIABLES.get(endpoint_name)
            if expected_variables is not None and expected_variables != actual_variables:
                errors.append(
                    f"mount {mount['id']!r} endpoint {endpoint_name!r} uses "
                    f"variables {sorted(actual_variables)!r}, expected "
                    f"{sorted(expected_variables or ())!r}"
                )
    return errors


def validate_snapshot(
    snapshot: dict[str, Any],
    public_safe_extensions: frozenset[str] = DEFAULT_PUBLIC_SAFE_EXTENSIONS,
    extension_validators: dict[str, Draft202012Validator] | None = None,
) -> list[str]:
    errors: list[str] = []
    extension_validators = extension_validators or {}
    collection = snapshot["collection"]
    collection_id = collection["id"]
    nodes = snapshot["nodes"]
    annotations = snapshot["annotations"]
    attachments = snapshot["attachments"]
    relations = snapshot["relations"]
    tombstones = snapshot["tombstones"]
    complete = snapshot["complete"]
    page = snapshot["page"]
    is_single_page_complete = (
        complete and page["sequence"] == 1 and not page["hasMore"]
    )

    if page["hasMore"] and page["nextCursor"] is None:
        errors.append("page.hasMore=true requires a non-null page.nextCursor")
    roots = [node for node in nodes if node["kind"] == "root"]
    if is_single_page_complete and len(roots) != 1:
        errors.append(f"expected exactly one root node, found {len(roots)}")
    elif len(roots) > 1:
        errors.append(f"snapshot page contains multiple root nodes: {len(roots)}")
    elif roots and roots[0]["id"] != collection["rootNodeId"]:
        errors.append(
            "collection.rootNodeId does not identify the included root node"
        )

    live_ids: dict[str, str] = {}
    live_objects = [("collection", collection)]
    live_objects.extend(("node", item) for item in nodes)
    live_objects.extend(("annotation", item) for item in annotations)
    live_objects.extend(("attachment", item) for item in attachments)
    live_objects.extend(("relation", item) for item in relations)
    for resource_type, resource in live_objects:
        resource_id = resource["id"]
        previous_type = live_ids.get(resource_id)
        if previous_type is not None:
            errors.append(
                f"live id {resource_id!r} is reused by {previous_type} and "
                f"{resource_type}"
            )
        else:
            live_ids[resource_id] = resource_type

    tombstone_ids: set[str] = set()
    for tombstone in tombstones:
        target_id = tombstone["targetId"]
        if target_id in tombstone_ids:
            errors.append(f"duplicate tombstone targetId {target_id!r}")
        tombstone_ids.add(target_id)
        if target_id in live_ids:
            errors.append(f"tombstone targetId {target_id!r} is still live")

    for resource_type, resources in (
        ("node", nodes),
        ("annotation", annotations),
        ("attachment", attachments),
        ("relation", relations),
        ("tombstone", tombstones),
    ):
        for resource in resources:
            if resource["collectionId"] != collection_id:
                identifier = resource.get("id", resource.get("targetId", "?"))
                errors.append(
                    f"{resource_type} {identifier!r} has collectionId "
                    f"{resource['collectionId']!r}, expected {collection_id!r}"
                )

    node_by_id = {node["id"]: node for node in nodes}
    for node in nodes:
        if node["kind"] == "root":
            continue
        parent_id = node["parentId"]
        parent = node_by_id.get(parent_id)
        if parent is None and is_single_page_complete:
            errors.append(
                f"node {node['id']!r} references missing parent {parent_id!r}"
            )
        elif parent is not None and parent["kind"] not in {"root", "folder"}:
            errors.append(
                f"node {node['id']!r} parent {parent_id!r} has invalid kind "
                f"{parent['kind']!r}"
            )

    parent_edges = {
        node["id"]: node["parentId"]
        for node in nodes
        if node["kind"] != "root" and node["parentId"] in node_by_id
    }
    errors.extend(find_cycles(parent_edges, "parent"))

    alias_edges: dict[str, str] = {}
    for node in nodes:
        if node["kind"] != "alias":
            continue
        target_id = node["targetNodeId"]
        if target_id not in node_by_id:
            if is_single_page_complete:
                errors.append(
                    f"alias {node['id']!r} references missing target {target_id!r}"
                )
        else:
            alias_edges[node["id"]] = target_id
    errors.extend(find_cycles(alias_edges, "alias"))

    sibling_positions: dict[str, dict[str, str]] = defaultdict(dict)
    for node in nodes:
        if node["kind"] == "root":
            continue
        parent_id = node["parentId"]
        position = node["position"]
        if not position:
            errors.append(f"node {node['id']!r} has an empty position")
            continue
        previous_id = sibling_positions[parent_id].get(position)
        if previous_id is not None:
            errors.append(
                f"siblings {previous_id!r} and {node['id']!r} reuse position "
                f"{position!r}"
            )
        else:
            sibling_positions[parent_id][position] = node["id"]

    for resource_type, resources in (
        ("annotation", annotations),
        ("attachment", attachments),
    ):
        for resource in resources:
            subject = resource["subject"]
            if subject["type"] == "collection":
                if subject["id"] != collection_id:
                    errors.append(
                        f"{resource_type} {resource['id']!r} references missing "
                        f"collection subject {subject['id']!r}"
                    )
            elif subject["id"] not in node_by_id and is_single_page_complete:
                errors.append(
                    f"{resource_type} {resource['id']!r} references missing node "
                    f"subject {subject['id']!r}"
                )

            provenance = resource.get("provenance", {})
            for source_id in provenance.get("sourceNodeIds", []):
                if source_id not in node_by_id and is_single_page_complete:
                    errors.append(
                        f"{resource_type} {resource['id']!r} provenance references "
                        f"missing node {source_id!r}"
                    )

    for relation in relations:
        for field in ("fromNodeId", "toNodeId"):
            node_id = relation[field]
            if node_id not in node_by_id and is_single_page_complete:
                errors.append(
                    f"relation {relation['id']!r} {field} references missing node "
                    f"{node_id!r}"
                )

    snapshot_objects = [("collection", collection)]
    snapshot_objects.extend(("node", item) for item in nodes)
    snapshot_objects.extend(("annotation", item) for item in annotations)
    snapshot_objects.extend(("attachment", item) for item in attachments)
    snapshot_objects.extend(("relation", item) for item in relations)
    for resource_type, resource in snapshot_objects:
        for namespace, value in resource.get("extensions", {}).items():
            extension_validator = extension_validators.get(namespace)
            if extension_validator is None:
                continue
            extension_errors = list(extension_validator.iter_errors(value))
            if extension_errors:
                errors.append(
                    f"{resource_type} {resource['id']!r} has invalid extension "
                    f"{namespace!r}: {extension_errors[0].message}"
                )

    if snapshot["mode"] == "publication":
        if snapshot.get("syncCursor") is not None:
            errors.append("publication snapshot leaks syncCursor")
        if tombstones:
            errors.append("publication snapshot contains tombstones")
        for node in nodes:
            if "sourceRefs" in node:
                errors.append(f"publication node {node['id']!r} leaks sourceRefs")
        for resource_type, resource in snapshot_objects:
            unsafe_extensions = (
                set(resource.get("extensions", {})) - public_safe_extensions
            )
            if unsafe_extensions:
                resource_id = resource["id"]
                errors.append(
                    f"publication {resource_type} {resource_id!r} contains unsafe "
                    f"extensions {sorted(unsafe_extensions)!r}"
                )
        public_actors = list(collection.get("creators", []))
        public_actors.extend(
            annotation["creator"]
            for annotation in annotations
            if "creator" in annotation
        )
        for actor in public_actors:
            actor_id = actor["id"].lower()
            if actor_id.startswith(("user:", "principal:", "internal:")):
                errors.append(
                    f"publication snapshot leaks internal actor id {actor['id']!r}"
                )

    if snapshot["mode"] == "sync":
        for node in nodes:
            if node.get("redacted") is True:
                errors.append(f"sync node {node['id']!r} is redacted")

    return errors


def validate_snapshot_assembly(
    pages: list[dict[str, Any]],
    public_safe_extensions: frozenset[str] = DEFAULT_PUBLIC_SAFE_EXTENSIONS,
    extension_validators: dict[str, Draft202012Validator] | None = None,
) -> list[str]:
    errors: list[str] = []
    if not pages:
        return ["snapshot assembly has no pages"]

    first = pages[0]
    expected_snapshot_id = first["snapshotId"]
    expected_revision = first["revision"]
    expected_mode = first["mode"]
    expected_collection = first["collection"]
    seen_live_ids: set[str] = set()

    for expected_sequence, page in enumerate(pages, start=1):
        if page["snapshotId"] != expected_snapshot_id:
            errors.append("snapshotId changed during page assembly")
        if page["revision"] != expected_revision:
            errors.append("revision changed during page assembly")
        if page["mode"] != expected_mode:
            errors.append("mode changed during page assembly")
        if page["collection"] != expected_collection:
            errors.append("collection projection changed during page assembly")
        if page["complete"] is not True:
            errors.append("cropped projection cannot be assembled as complete snapshot")
        if page["page"]["sequence"] != expected_sequence:
            errors.append(
                f"expected page sequence {expected_sequence}, found "
                f"{page['page']['sequence']}"
            )
        should_have_more = expected_sequence < len(pages)
        if page["page"]["hasMore"] != should_have_more:
            errors.append(
                f"page {expected_sequence} hasMore does not match assembly boundary"
            )
        for resources in (
            page["nodes"],
            page["annotations"],
            page["attachments"],
            page["relations"],
        ):
            for resource in resources:
                resource_id = resource["id"]
                if resource_id in seen_live_ids:
                    errors.append(f"live id {resource_id!r} repeats across pages")
                seen_live_ids.add(resource_id)

    if not errors:
        assembled = copy.deepcopy(first)
        for field in ("nodes", "annotations", "attachments", "relations", "tombstones"):
            assembled[field] = [
                resource for page in pages for resource in page[field]
            ]
        assembled["page"] = {
            "nextCursor": None,
            "hasMore": False,
            "sequence": 1,
        }
        errors.extend(
            f"assembled snapshot: {message}"
            for message in validate_snapshot(
                assembled,
                public_safe_extensions=public_safe_extensions,
                extension_validators=extension_validators,
            )
        )

    return errors


def assert_valid(
    validator: Draft202012Validator, label: str, instance: dict[str, Any]
) -> None:
    errors = list(validator.iter_errors(instance))
    if errors:
        raise AssertionError(
            f"negative-test baseline {label!r} is invalid: {errors[0].message}"
        )


def assert_invalid(
    validator: Draft202012Validator, label: str, instance: dict[str, Any]
) -> None:
    if not list(validator.iter_errors(instance)):
        raise AssertionError(f"negative case {label!r} unexpectedly validated")


def run_negative_assertions(
    schema: dict[str, Any], examples: dict[str, Any]
) -> None:
    node_validator = validator_for_definition(schema, "node")
    annotation_validator = validator_for_definition(schema, "annotation")
    collection_validator = validator_for_definition(schema, "collection")
    sync_push_validator = validator_for_definition(schema, "syncPush")
    manifest_validator = validator_for_definition(schema, "manifest")
    snapshot_validator = validator_for_definition(schema, "snapshot")
    change_plan_request_validator = validator_for_definition(schema, "changePlanRequest")
    timestamp = "2026-07-16T00:00:00Z"
    folder = {
        "id": "folder-1",
        "collectionId": "collection-1",
        "kind": "folder",
        "parentId": "root-1",
        "position": "a",
        "title": "Folder",
        "createdAt": timestamp,
        "updatedAt": timestamp,
        "revision": "r-1",
    }
    assert_valid(node_validator, "folder", folder)
    folder_with_url = copy.deepcopy(folder)
    folder_with_url["url"] = "https://example.com/"
    assert_invalid(node_validator, "folder_with_url", folder_with_url)

    separator = {
        "id": "separator-1",
        "collectionId": "collection-1",
        "kind": "separator",
        "parentId": "root-1",
        "position": "b",
        "createdAt": timestamp,
        "updatedAt": timestamp,
        "revision": "r-1",
    }
    assert_valid(node_validator, "separator", separator)
    separator_with_url = copy.deepcopy(separator)
    separator_with_url["url"] = "https://example.com/"
    assert_invalid(node_validator, "separator_with_url", separator_with_url)

    sync_push = copy.deepcopy(examples["sync-push.json"])
    sync_push["operations"][0]["sequence"] = 0
    assert_invalid(sync_push_validator, "sequence0", sync_push)

    annotation = {
        "id": "annotation-1",
        "collectionId": "collection-1",
        "subject": {"type": "node", "id": "node-1"},
        "type": "note",
        "format": "plain",
        "value": "Text",
        "visibility": "private",
        "createdAt": timestamp,
        "updatedAt": timestamp,
        "revision": "r-1",
    }
    assert_valid(annotation_validator, "annotation", annotation)
    annotation_without_subject = copy.deepcopy(annotation)
    del annotation_without_subject["subject"]
    assert_invalid(
        annotation_validator, "annotation_without_subject", annotation_without_subject
    )

    malformed_collection = {
        "title": "This is a patch, not a Collection representation"
    }
    assert_invalid(
        collection_validator, "malformed_collection_representation", malformed_collection
    )

    redacted_bookmark = {
        "id": "node-locked",
        "collectionId": "collection-1",
        "kind": "bookmark",
        "parentId": "root-1",
        "position": "c",
        "title": "Member resource",
        "visibility": "protected",
        "redacted": True,
        "accessUrl": "https://example.com/subscribe",
        "createdAt": timestamp,
        "updatedAt": timestamp,
        "revision": "r-2",
    }
    assert_valid(node_validator, "redacted_bookmark", redacted_bookmark)
    redacted_with_url = copy.deepcopy(redacted_bookmark)
    redacted_with_url["url"] = "https://secret.example/"
    assert_invalid(node_validator, "redacted_bookmark_with_url", redacted_with_url)

    local_bookmark = copy.deepcopy(examples["local-bookmark-node.json"])
    assert_valid(node_validator, "local_file_bookmark", local_bookmark)
    unsafe_bookmark = copy.deepcopy(local_bookmark)
    unsafe_bookmark["url"] = "javascript:alert(1)"
    assert_invalid(node_validator, "javascript_bookmark", unsafe_bookmark)

    incomplete_publisher_manifest = copy.deepcopy(examples["public-manifest.json"])
    del incomplete_publisher_manifest["mounts"][0]["endpoints"]["nodeMove"]
    assert_invalid(
        manifest_validator,
        "publisher_manifest_without_node_move",
        incomplete_publisher_manifest,
    )

    wrong_endpoint_variables = copy.deepcopy(examples["public-manifest.json"])
    wrong_endpoint_variables["mounts"][0]["endpoints"]["nodeMove"] = (
        "https://alice.example/collections/c/{collectionId}/nodes/"
        "{annotationId}/move"
    )
    assert_valid(
        manifest_validator, "wrong_endpoint_variables_baseline", wrong_endpoint_variables
    )
    if not any(
        "expected" in message
        for message in validate_manifest(wrong_endpoint_variables)
    ):
        raise AssertionError("wrong endpoint template variables escaped validation")

    missing_endpoint_variables = copy.deepcopy(examples["public-manifest.json"])
    missing_endpoint_variables["mounts"][0]["endpoints"]["node"] = (
        "https://alice.example/collections/node"
    )
    if not any(
        "expected" in message
        for message in validate_manifest(missing_endpoint_variables)
    ):
        raise AssertionError("missing endpoint template variables escaped validation")

    incomplete_publication_manifest = copy.deepcopy(examples["public-manifest.json"])
    incomplete_publication_manifest["mounts"][0]["profiles"] = ["core", "publication"]
    del incomplete_publication_manifest["mounts"][0]["endpoints"]["snapshot"]
    assert_invalid(
        manifest_validator,
        "publication_manifest_without_snapshot",
        incomplete_publication_manifest,
    )

    invalid_template_literal = copy.deepcopy(examples["public-manifest.json"])
    invalid_template_literal["mounts"][0]["endpoints"]["node"] = (
        "https://alice.example/collections/c/{collectionId}/bad path/{nodeId}"
    )
    assert_invalid(
        manifest_validator, "uri_template_with_space", invalid_template_literal
    )

    loopback_manifest = json.loads(
        json.dumps(examples["public-manifest.json"]).replace(
            "https://alice.example", "http://localhost:3000"
        )
    )
    assert_valid(manifest_validator, "loopback_http_manifest", loopback_manifest)

    insecure_remote_manifest = json.loads(
        json.dumps(examples["public-manifest.json"]).replace(
            "https://alice.example", "http://insecure.example"
        )
    )
    assert_invalid(
        manifest_validator, "insecure_remote_http_manifest", insecure_remote_manifest
    )

    legacy_change_plan_request = {
        "operations": [
            {
                "type": "set_visibility",
                "collectionId": "collection-1",
                "baseRevision": "acl-17",
                "visibility": "public",
            }
        ],
        "reason": "legacy shape",
        "dryRun": True,
    }
    assert_invalid(
        change_plan_request_validator,
        "legacy_change_plan_operation_shape",
        legacy_change_plan_request,
    )

    unsafe_publication = copy.deepcopy(examples["collection-snapshot.json"])
    unsafe_publication["collection"].setdefault("extensions", {})[
        "https://unsafe.example/ns/private/v1"
    ] = {"secret": True}
    assert_valid(
        snapshot_validator, "unsafe_extension_structural_baseline", unsafe_publication
    )
    if not any(
        "unsafe extensions" in message
        for message in validate_snapshot(unsafe_publication)
    ):
        raise AssertionError("unsafe publication extension escaped semantic validation")

    first_page = copy.deepcopy(examples["collection-snapshot.json"])
    second_page = copy.deepcopy(examples["collection-snapshot.json"])
    first_page["nodes"] = first_page["nodes"][:1]
    first_page["annotations"] = []
    first_page["page"] = {
        "nextCursor": "page_2",
        "hasMore": True,
        "sequence": 1,
    }
    second_page["nodes"] = second_page["nodes"][1:]
    second_page["page"] = {
        "nextCursor": None,
        "hasMore": False,
        "sequence": 2,
    }
    assembly_errors = validate_snapshot_assembly([first_page, second_page])
    if assembly_errors:
        raise AssertionError(
            f"valid paginated snapshot did not assemble: {assembly_errors[0]}"
        )

    duplicate_page = copy.deepcopy(second_page)
    duplicate_page["nodes"].append(copy.deepcopy(first_page["nodes"][0]))
    if not any(
        "repeats across pages" in message
        for message in validate_snapshot_assembly([first_page, duplicate_page])
    ):
        raise AssertionError("duplicate snapshot page object escaped assembly validation")

    wrong_sequence_page = copy.deepcopy(second_page)
    wrong_sequence_page["page"]["sequence"] = 3
    if not any(
        "expected page sequence" in message
        for message in validate_snapshot_assembly([first_page, wrong_sequence_page])
    ):
        raise AssertionError("snapshot page sequence gap escaped assembly validation")


def main() -> int:
    try:
        schema = load_json(SCHEMA_PATH)
        Draft202012Validator.check_schema(schema)
        schema_v02 = load_json(SCHEMA_V02_PATH)
        Draft202012Validator.check_schema(schema_v02)
        missing_contract_defs = REQUIRED_CONTRACT_DEFS - set(schema.get("$defs", {}))
        if missing_contract_defs:
            raise ValueError(
                f"required contract definitions are missing: "
                f"{sorted(missing_contract_defs)!r}"
            )
    except (OSError, ValueError, SchemaError) as error:
        print(f"Schema error: {error}", file=sys.stderr)
        return 1

    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    contract_validators = {
        definition_name: validator_for_definition(schema, definition_name)
        for definition_name in set(EXAMPLE_CONTRACTS.values())
    }
    example_validators = {
        name: contract_validators[definition_name]
        for name, definition_name in EXAMPLE_CONTRACTS.items()
    } | {
        name: validator_for_v02_definition(schema, schema_v02, definition_name)
        for name, definition_name in EXAMPLE_CONTRACTS_V02.items()
    }
    example_paths = sorted(EXAMPLES_DIR.glob("*.json"))
    example_names = {path.name for path in example_paths}
    examples: dict[str, Any] = {}
    failures: list[str] = []

    for missing_name in sorted(EXPECTED_EXAMPLES - example_names):
        failures.append(f"{missing_name}: required example is missing")

    for path in example_paths:
        try:
            instance = load_json(path)
        except (OSError, ValueError) as error:
            failures.append(f"{path.name}: cannot read JSON: {error}")
            continue
        examples[path.name] = instance
        example_validator = example_validators.get(path.name)
        if example_validator is None:
            failures.append(f"{path.name}: example has no explicit contract mapping")
            continue
        structural_errors = sorted(
            example_validator.iter_errors(instance),
            key=lambda error: tuple(str(item) for item in error.absolute_path),
        )
        failures.extend(
            validation_message(path, error) for error in structural_errors
        )
        if not structural_errors and {
            "mode",
            "collection",
            "nodes",
            "annotations",
            "attachments",
            "relations",
            "tombstones",
        }.issubset(instance):
            failures.extend(
                f"{path.name}: semantic: {message}"
                for message in validate_snapshot(instance)
            )
        elif not structural_errors and {
            "protocol",
            "protocolVersions",
            "mounts",
        }.issubset(instance):
            failures.extend(
                f"{path.name}: semantic: {message}"
                for message in validate_manifest(instance)
            )

    if not failures:
        try:
            run_negative_assertions(schema, examples)
        except AssertionError as error:
            failures.append(str(error))

    if failures:
        print("Validation failed:", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return 1

    snapshot_count = sum(
        1 for instance in examples.values() if isinstance(instance, dict) and "mode" in instance
    )
    print(
        f"Validated {len(examples)} examples, {len(REQUIRED_CONTRACT_DEFS)} "
        f"required contracts, {snapshot_count} snapshot semantic checks, and "
        "17 negative assertions."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
