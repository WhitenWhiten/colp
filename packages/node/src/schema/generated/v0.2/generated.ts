/** Generated from the protocol JSON Schema; run npm run generate:types. */
const schema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://know-n.com/colp/schema/0.2",
  "title": "The Collection Protocol 0.2 Authoritative Pull Effects",
  "$defs": {
    "manifestV02": {
      "type": "object",
      "properties": {
        "protocol": {
          "const": "https://know-n.com/colp/spec/0.2"
        },
        "protocolVersions": {
          "type": "array",
          "minItems": 2,
          "items": {
            "type": "string",
            "pattern": "^[0-9]+\\.[0-9]+$",
            "not": {
              "pattern": "[^0-9.]"
            }
          },
          "allOf": [
            {
              "contains": {
                "const": "0.1"
              }
            },
            {
              "contains": {
                "const": "0.2"
              }
            }
          ],
          "uniqueItems": true
        },
        "serverId": {
          "$ref": "https://know-n.com/colp/schema/0.1#/$defs/serviceUrl"
        },
        "serverUuid": {
          "$ref": "https://know-n.com/colp/schema/0.1#/$defs/opaqueId"
        },
        "title": {
          "type": "string"
        },
        "mounts": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "https://know-n.com/colp/schema/0.1#/$defs/manifestMount"
          }
        },
        "signing": {
          "$ref": "https://know-n.com/colp/schema/0.1#/$defs/manifestSigning"
        },
        "syncEffectPages": {
          "$ref": "https://know-n.com/colp/schema/0.1#/$defs/httpsUriTemplate"
        }
      },
      "required": [
        "protocol",
        "protocolVersions",
        "serverId",
        "serverUuid",
        "title",
        "mounts",
        "syncEffectPages"
      ],
      "additionalProperties": false
    },
    "authoritativeDigest": {
      "type": "string",
      "pattern": "^sha-256=:[A-Za-z0-9+/]{43}=:$",
      "minLength": 54,
      "maxLength": 54
    },
    "effectBinding": {
      "type": "object",
      "properties": {
        "effectId": {
          "$ref": "https://know-n.com/colp/schema/0.1#/$defs/opaqueId"
        },
        "status": {
          "enum": [
            "applied",
            "rebased"
          ]
        },
        "opId": {
          "$ref": "https://know-n.com/colp/schema/0.1#/$defs/opaqueId"
        },
        "replicaId": {
          "$ref": "https://know-n.com/colp/schema/0.1#/$defs/opaqueId"
        },
        "sequence": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "collectionId": {
          "$ref": "https://know-n.com/colp/schema/0.1#/$defs/opaqueId"
        },
        "operationDigest": {
          "$ref": "#/$defs/authoritativeDigest"
        },
        "effectDigest": {
          "$ref": "#/$defs/authoritativeDigest"
        }
      },
      "required": [
        "effectId",
        "status",
        "opId",
        "replicaId",
        "sequence",
        "collectionId",
        "operationDigest",
        "effectDigest"
      ]
    },
    "placement": {
      "type": "object",
      "properties": {
        "parentId": {
          "$ref": "https://know-n.com/colp/schema/0.1#/$defs/opaqueId"
        },
        "afterId": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "https://know-n.com/colp/schema/0.1#/$defs/opaqueId"
            }
          ]
        },
        "beforeId": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "https://know-n.com/colp/schema/0.1#/$defs/opaqueId"
            }
          ]
        },
        "position": {
          "$ref": "https://know-n.com/colp/schema/0.1#/$defs/orderKey"
        }
      },
      "required": [
        "parentId",
        "afterId",
        "beforeId",
        "position"
      ],
      "additionalProperties": false
    },
    "parentRevision": {
      "type": "object",
      "properties": {
        "parentId": {
          "$ref": "https://know-n.com/colp/schema/0.1#/$defs/opaqueId"
        },
        "childrenRevision": {
          "$ref": "https://know-n.com/colp/schema/0.1#/$defs/opaqueId"
        }
      },
      "required": [
        "parentId",
        "childrenRevision"
      ],
      "additionalProperties": false
    },
    "syncSnapshotV02": {
      "type": "object",
      "properties": {
        "protocolVersion": {
          "const": "0.2"
        },
        "snapshotId": {
          "$ref": "https://know-n.com/colp/schema/0.1#/$defs/opaqueId"
        },
        "mode": {
          "const": "sync"
        },
        "complete": {
          "type": "boolean"
        },
        "collection": {
          "$ref": "https://know-n.com/colp/schema/0.1#/$defs/collection"
        },
        "nodes": {
          "type": "array",
          "items": {
            "$ref": "https://know-n.com/colp/schema/0.1#/$defs/node"
          }
        },
        "parentRevisions": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/parentRevision"
          }
        },
        "annotations": {
          "type": "array",
          "items": {
            "$ref": "https://know-n.com/colp/schema/0.1#/$defs/annotation"
          }
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "https://know-n.com/colp/schema/0.1#/$defs/attachment"
          }
        },
        "relations": {
          "type": "array",
          "items": {
            "$ref": "https://know-n.com/colp/schema/0.1#/$defs/relation"
          }
        },
        "tombstones": {
          "type": "array",
          "items": {
            "$ref": "https://know-n.com/colp/schema/0.1#/$defs/syncTombstone"
          }
        },
        "revision": {
          "$ref": "https://know-n.com/colp/schema/0.1#/$defs/opaqueId"
        },
        "syncCursor": {
          "$ref": "https://know-n.com/colp/schema/0.1#/$defs/opaqueId"
        },
        "recoveryCapability": {
          "$ref": "https://know-n.com/colp/schema/0.1#/$defs/opaqueId"
        },
        "generatedAt": {
          "$ref": "https://know-n.com/colp/schema/0.1#/$defs/dateTime"
        },
        "contentDigest": {
          "$ref": "#/$defs/authoritativeDigest"
        },
        "page": {
          "$ref": "https://know-n.com/colp/schema/0.1#/$defs/snapshotPage"
        },
        "warnings": {
          "type": "array",
          "items": {
            "$ref": "https://know-n.com/colp/schema/0.1#/$defs/warning"
          }
        }
      },
      "required": [
        "protocolVersion",
        "snapshotId",
        "mode",
        "complete",
        "collection",
        "nodes",
        "parentRevisions",
        "annotations",
        "attachments",
        "relations",
        "tombstones",
        "revision",
        "syncCursor",
        "generatedAt",
        "page",
        "warnings"
      ],
      "additionalProperties": false
    },
    "effectPageRef": {
      "type": "object",
      "properties": {
        "pageCount": {
          "type": "integer",
          "minimum": 1,
          "maximum": 1024
        },
        "memberCount": {
          "type": "integer",
          "minimum": 1,
          "maximum": 524288
        },
        "memberDigest": {
          "$ref": "#/$defs/authoritativeDigest"
        },
        "firstPageDigest": {
          "$ref": "#/$defs/authoritativeDigest"
        }
      },
      "required": [
        "pageCount",
        "memberCount",
        "memberDigest",
        "firstPageDigest"
      ],
      "additionalProperties": false
    },
    "authoritativeEffectPage": {
      "type": "object",
      "properties": {
        "effectId": {
          "$ref": "https://know-n.com/colp/schema/0.1#/$defs/opaqueId"
        },
        "pageNumber": {
          "type": "integer",
          "minimum": 1,
          "maximum": 1024
        },
        "pageCount": {
          "type": "integer",
          "minimum": 1,
          "maximum": 1024
        },
        "members": {
          "type": "array",
          "minItems": 1,
          "maxItems": 512,
          "items": {
            "$ref": "https://know-n.com/colp/schema/0.1#/$defs/opaqueId"
          },
          "uniqueItems": true
        },
        "memberCount": {
          "type": "integer",
          "minimum": 1,
          "maximum": 512
        },
        "pageDigest": {
          "$ref": "#/$defs/authoritativeDigest"
        },
        "previousPageDigest": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/authoritativeDigest"
            }
          ]
        }
      },
      "required": [
        "effectId",
        "pageNumber",
        "pageCount",
        "members",
        "memberCount",
        "pageDigest",
        "previousPageDigest"
      ],
      "additionalProperties": false
    },
    "nodeCreatedEffect": {
      "allOf": [
        {
          "$ref": "#/$defs/effectBinding"
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "node_created"
            },
            "node": {
              "$ref": "https://know-n.com/colp/schema/0.1#/$defs/node"
            },
            "placement": {
              "$ref": "#/$defs/placement"
            },
            "parentRevision": {
              "$ref": "#/$defs/parentRevision"
            },
            "nodeChildrenRevision": {
              "oneOf": [
                {
                  "type": "null"
                },
                {
                  "$ref": "https://know-n.com/colp/schema/0.1#/$defs/opaqueId"
                }
              ]
            }
          },
          "required": [
            "kind",
            "node",
            "placement",
            "parentRevision",
            "nodeChildrenRevision"
          ]
        }
      ],
      "unevaluatedProperties": false
    },
    "nodeContentUpdatedEffect": {
      "allOf": [
        {
          "$ref": "#/$defs/effectBinding"
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "node_content_updated"
            },
            "node": {
              "$ref": "https://know-n.com/colp/schema/0.1#/$defs/node"
            }
          },
          "required": [
            "kind",
            "node"
          ]
        }
      ],
      "unevaluatedProperties": false
    },
    "nodeMovedEffect": {
      "allOf": [
        {
          "$ref": "#/$defs/effectBinding"
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "node_moved"
            },
            "node": {
              "$ref": "https://know-n.com/colp/schema/0.1#/$defs/node"
            },
            "placement": {
              "$ref": "#/$defs/placement"
            },
            "parentRevisions": {
              "type": "array",
              "minItems": 1,
              "maxItems": 2,
              "items": {
                "$ref": "#/$defs/parentRevision"
              }
            }
          },
          "required": [
            "kind",
            "node",
            "placement",
            "parentRevisions"
          ]
        }
      ],
      "unevaluatedProperties": false
    },
    "nodeDeletedEffect": {
      "allOf": [
        {
          "$ref": "#/$defs/effectBinding"
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "node_deleted"
            },
            "deletion": {
              "$ref": "https://know-n.com/colp/schema/0.1#/$defs/syncTombstone"
            },
            "tombstone": {
              "$ref": "https://know-n.com/colp/schema/0.1#/$defs/syncTombstone"
            },
            "parentRevision": {
              "$ref": "#/$defs/parentRevision"
            }
          },
          "required": [
            "kind",
            "deletion",
            "tombstone",
            "parentRevision"
          ]
        }
      ],
      "unevaluatedProperties": false
    },
    "subtreeDeletedEffect": {
      "allOf": [
        {
          "$ref": "#/$defs/effectBinding"
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "subtree_deleted"
            },
            "rootTombstone": {
              "$ref": "https://know-n.com/colp/schema/0.1#/$defs/syncTombstone"
            },
            "members": {
              "type": "array",
              "minItems": 1,
              "maxItems": 512,
              "items": {
                "$ref": "https://know-n.com/colp/schema/0.1#/$defs/opaqueId"
              },
              "uniqueItems": true
            },
            "effectRef": {
              "$ref": "#/$defs/effectPageRef"
            },
            "memberCount": {
              "type": "integer",
              "minimum": 1,
              "maximum": 524288
            },
            "memberDigest": {
              "$ref": "#/$defs/authoritativeDigest"
            },
            "parentRevision": {
              "$ref": "#/$defs/parentRevision"
            }
          },
          "required": [
            "kind",
            "rootTombstone",
            "memberCount",
            "memberDigest",
            "parentRevision"
          ],
          "oneOf": [
            {
              "required": [
                "members"
              ],
              "not": {
                "required": [
                  "effectRef"
                ]
              }
            },
            {
              "required": [
                "effectRef"
              ],
              "not": {
                "required": [
                  "members"
                ]
              }
            }
          ]
        }
      ],
      "unevaluatedProperties": false
    },
    "nodeRestoredEffect": {
      "allOf": [
        {
          "$ref": "#/$defs/effectBinding"
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "node_restored"
            },
            "node": {
              "$ref": "https://know-n.com/colp/schema/0.1#/$defs/node"
            },
            "placement": {
              "$ref": "#/$defs/placement"
            },
            "parentRevision": {
              "$ref": "#/$defs/parentRevision"
            },
            "consumedTombstone": {
              "$ref": "https://know-n.com/colp/schema/0.1#/$defs/syncTombstone"
            }
          },
          "required": [
            "kind",
            "node",
            "placement",
            "parentRevision",
            "consumedTombstone"
          ]
        }
      ],
      "unevaluatedProperties": false
    },
    "authoritativePullEffect": {
      "oneOf": [
        {
          "$ref": "#/$defs/nodeCreatedEffect"
        },
        {
          "$ref": "#/$defs/nodeContentUpdatedEffect"
        },
        {
          "$ref": "#/$defs/nodeMovedEffect"
        },
        {
          "$ref": "#/$defs/nodeDeletedEffect"
        },
        {
          "$ref": "#/$defs/subtreeDeletedEffect"
        },
        {
          "$ref": "#/$defs/nodeRestoredEffect"
        }
      ]
    },
    "syncPullEventV02": {
      "type": "object",
      "properties": {
        "cursor": {
          "$ref": "https://know-n.com/colp/schema/0.1#/$defs/opaqueId"
        },
        "kind": {
          "enum": [
            "operation",
            "conflict"
          ]
        },
        "operation": {
          "$ref": "https://know-n.com/colp/schema/0.1#/$defs/operation"
        },
        "effect": {
          "$ref": "#/$defs/authoritativePullEffect"
        },
        "conflict": {
          "$ref": "https://know-n.com/colp/schema/0.1#/$defs/conflict"
        }
      },
      "required": [
        "cursor",
        "kind"
      ],
      "allOf": [
        {
          "if": {
            "properties": {
              "kind": {
                "const": "operation"
              }
            },
            "required": [
              "kind"
            ]
          },
          "then": {
            "required": [
              "operation",
              "effect"
            ],
            "not": {
              "required": [
                "conflict"
              ]
            }
          },
          "else": {
            "required": [
              "conflict"
            ],
            "not": {
              "anyOf": [
                {
                  "required": [
                    "operation"
                  ]
                },
                {
                  "required": [
                    "effect"
                  ]
                }
              ]
            }
          }
        },
        {
          "if": {
            "properties": {
              "operation": {
                "properties": {
                  "type": {
                    "const": "create_node"
                  }
                },
                "required": [
                  "type"
                ]
              }
            },
            "required": [
              "operation"
            ]
          },
          "then": {
            "properties": {
              "effect": {
                "$ref": "#/$defs/nodeCreatedEffect"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "operation": {
                "properties": {
                  "type": {
                    "const": "update_node_content"
                  }
                },
                "required": [
                  "type"
                ]
              }
            },
            "required": [
              "operation"
            ]
          },
          "then": {
            "properties": {
              "effect": {
                "$ref": "#/$defs/nodeContentUpdatedEffect"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "operation": {
                "properties": {
                  "type": {
                    "const": "move_node"
                  }
                },
                "required": [
                  "type"
                ]
              }
            },
            "required": [
              "operation"
            ]
          },
          "then": {
            "properties": {
              "effect": {
                "$ref": "#/$defs/nodeMovedEffect"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "operation": {
                "properties": {
                  "type": {
                    "const": "delete_node"
                  }
                },
                "required": [
                  "type"
                ]
              }
            },
            "required": [
              "operation"
            ]
          },
          "then": {
            "properties": {
              "effect": {
                "$ref": "#/$defs/nodeDeletedEffect"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "operation": {
                "properties": {
                  "type": {
                    "const": "delete_subtree"
                  }
                },
                "required": [
                  "type"
                ]
              }
            },
            "required": [
              "operation"
            ]
          },
          "then": {
            "properties": {
              "effect": {
                "$ref": "#/$defs/subtreeDeletedEffect"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "operation": {
                "properties": {
                  "type": {
                    "const": "restore_node"
                  }
                },
                "required": [
                  "type"
                ]
              }
            },
            "required": [
              "operation"
            ]
          },
          "then": {
            "properties": {
              "effect": {
                "$ref": "#/$defs/nodeRestoredEffect"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "kind": {
                "const": "operation"
              }
            },
            "required": [
              "kind"
            ]
          },
          "then": {
            "properties": {
              "operation": {
                "properties": {
                  "type": {
                    "enum": [
                      "create_node",
                      "update_node_content",
                      "move_node",
                      "delete_node",
                      "delete_subtree",
                      "restore_node"
                    ]
                  }
                }
              }
            }
          }
        }
      ],
      "additionalProperties": false
    },
    "syncPullV02": {
      "type": "object",
      "properties": {
        "events": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/syncPullEventV02"
          }
        },
        "nextCursor": {
          "$ref": "https://know-n.com/colp/schema/0.1#/$defs/opaqueId"
        },
        "hasMore": {
          "type": "boolean"
        },
        "collectionRevision": {
          "$ref": "https://know-n.com/colp/schema/0.1#/$defs/opaqueId"
        },
        "recommendedPullAfterSeconds": {
          "type": "integer",
          "minimum": 0
        }
      },
      "required": [
        "events",
        "nextCursor",
        "hasMore",
        "collectionRevision",
        "recommendedPullAfterSeconds"
      ],
      "additionalProperties": false
    },
    "syncSessionRequestV02": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "protocolVersion": {
              "const": "0.2"
            },
            "replica": {
              "$ref": "https://know-n.com/colp/schema/0.1#/$defs/replica"
            },
            "scope": {
              "const": "collection"
            },
            "collection": {
              "$ref": "https://know-n.com/colp/schema/0.1#/$defs/syncSessionCollectionRequest"
            },
            "clientTime": {
              "$ref": "https://know-n.com/colp/schema/0.1#/$defs/dateTime"
            }
          },
          "required": [
            "protocolVersion",
            "replica",
            "scope",
            "collection",
            "clientTime"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "protocolVersion": {
              "const": "0.2"
            },
            "replica": {
              "$ref": "https://know-n.com/colp/schema/0.1#/$defs/replica"
            },
            "scope": {
              "const": "instance"
            },
            "purpose": {
              "const": "create_collection"
            },
            "clientTime": {
              "$ref": "https://know-n.com/colp/schema/0.1#/$defs/dateTime"
            }
          },
          "required": [
            "protocolVersion",
            "replica",
            "scope",
            "purpose",
            "clientTime"
          ],
          "additionalProperties": false
        }
      ]
    },
    "syncSessionResultV02": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "sessionId": {
              "$ref": "https://know-n.com/colp/schema/0.1#/$defs/opaqueId"
            },
            "expiresAt": {
              "$ref": "https://know-n.com/colp/schema/0.1#/$defs/dateTime"
            },
            "serverTime": {
              "$ref": "https://know-n.com/colp/schema/0.1#/$defs/dateTime"
            },
            "clockSkewMilliseconds": {
              "type": "integer"
            },
            "acceptedProtocolVersion": {
              "const": "0.2"
            },
            "scope": {
              "const": "collection"
            },
            "maxBatchOperations": {
              "type": "integer",
              "minimum": 1
            },
            "tombstoneRetentionSeconds": {
              "type": "integer",
              "minimum": 1
            },
            "replicaLease": {
              "$ref": "https://know-n.com/colp/schema/0.1#/$defs/activeReplicaLease"
            },
            "collection": {
              "$ref": "https://know-n.com/colp/schema/0.1#/$defs/syncSessionCollectionResult"
            },
            "conversionPolicy": {
              "$ref": "https://know-n.com/colp/schema/0.1#/$defs/conversionPolicy"
            }
          },
          "required": [
            "sessionId",
            "expiresAt",
            "serverTime",
            "clockSkewMilliseconds",
            "acceptedProtocolVersion",
            "scope",
            "maxBatchOperations",
            "tombstoneRetentionSeconds",
            "replicaLease",
            "collection",
            "conversionPolicy"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "sessionId": {
              "$ref": "https://know-n.com/colp/schema/0.1#/$defs/opaqueId"
            },
            "expiresAt": {
              "$ref": "https://know-n.com/colp/schema/0.1#/$defs/dateTime"
            },
            "serverTime": {
              "$ref": "https://know-n.com/colp/schema/0.1#/$defs/dateTime"
            },
            "clockSkewMilliseconds": {
              "type": "integer"
            },
            "acceptedProtocolVersion": {
              "const": "0.2"
            },
            "scope": {
              "const": "instance"
            },
            "purpose": {
              "const": "create_collection"
            },
            "maxBatchOperations": {
              "const": 1
            },
            "tombstoneRetentionSeconds": {
              "type": "integer",
              "minimum": 1
            },
            "replicaLease": {
              "$ref": "https://know-n.com/colp/schema/0.1#/$defs/activeReplicaLease"
            },
            "conversionPolicy": {
              "$ref": "https://know-n.com/colp/schema/0.1#/$defs/conversionPolicy"
            }
          },
          "required": [
            "sessionId",
            "expiresAt",
            "serverTime",
            "clockSkewMilliseconds",
            "acceptedProtocolVersion",
            "scope",
            "purpose",
            "maxBatchOperations",
            "tombstoneRetentionSeconds",
            "replicaLease",
            "conversionPolicy"
          ],
          "additionalProperties": false
        }
      ]
    }
  }
};
export default schema;
