/** Generated from the protocol JSON Schema; run npm run generate:types. */
const schema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://know-n.com/colp/schema/0.1",
  "title": "The Collection Protocol 0.1 Draft",
  "type": "object",
  "$defs": {
    "opaqueId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128,
      "pattern": "^[A-Za-z0-9._~-]+$",
      "not": {
        "pattern": "[^A-Za-z0-9._~-]"
      }
    },
    "globalResourceType": {
      "type": "string",
      "enum": [
        "collection",
        "node",
        "annotation",
        "attachment",
        "relation",
        "operation",
        "event"
      ]
    },
    "globalResourceIdentity": {
      "type": "object",
      "properties": {
        "serverUuid": {
          "$ref": "#/$defs/opaqueId"
        },
        "resourceType": {
          "$ref": "#/$defs/globalResourceType"
        },
        "id": {
          "$ref": "#/$defs/opaqueId"
        }
      },
      "required": [
        "serverUuid",
        "resourceType",
        "id"
      ],
      "additionalProperties": false
    },
    "canonicalResourceUri": {
      "type": "string",
      "minLength": 26,
      "maxLength": 304,
      "format": "uri",
      "pattern": "^colp:/resources/~[A-Za-z0-9._~-]{1,128}/(?:collection|node|annotation|attachment|relation|operation|event)/~[A-Za-z0-9._~-]{1,128}$"
    },
    "globalResourceReference": {
      "description": "A bare opaqueId is local and requires an enclosing same-server resourceType context; a cross-server reference is a canonicalResourceUri.",
      "oneOf": [
        {
          "$ref": "#/$defs/opaqueId"
        },
        {
          "$ref": "#/$defs/canonicalResourceUri"
        }
      ]
    },
    "orderKey": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128,
      "pattern": "^[0-9A-Za-z_-]+$",
      "not": {
        "pattern": "[^0-9A-Za-z_-]"
      }
    },
    "principalId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 512,
      "pattern": "^[\\x21-\\x7E]+$",
      "not": {
        "pattern": "[^\\x21-\\x7E]"
      }
    },
    "dateTime": {
      "type": "string",
      "format": "date-time"
    },
    "absoluteUri": {
      "type": "string",
      "minLength": 3,
      "maxLength": 4096,
      "format": "uri",
      "pattern": "^[A-Za-z][A-Za-z0-9+.-]*:[^\\u0000-\\u0020\\u007F]*$",
      "not": {
        "pattern": "^(?:[Jj][Aa][Vv][Aa][Ss][Cc][Rr][Ii][Pp][Tt]|[Vv][Bb][Ss][Cc][Rr][Ii][Pp][Tt]|[Dd][Aa][Tt][Aa]|[Ff][Ii][Ll][Ee]):"
      }
    },
    "httpUrl": {
      "allOf": [
        {
          "$ref": "#/$defs/absoluteUri"
        },
        {
          "pattern": "^[Hh][Tt][Tt][Pp][Ss]?://[^/?#\\s]+(?:[/?#]|$)",
          "not": {
            "pattern": "^[Hh][Tt][Tt][Pp][Ss]?://[^/?#]*@"
          }
        }
      ]
    },
    "bookmarkUrl": {
      "type": "string",
      "minLength": 3,
      "maxLength": 4096,
      "format": "uri",
      "pattern": "^[A-Za-z][A-Za-z0-9+.-]*:[^\\u0000-\\u0020\\u007F]*$",
      "not": {
        "pattern": "^(?:[Jj][Aa][Vv][Aa][Ss][Cc][Rr][Ii][Pp][Tt]|[Vv][Bb][Ss][Cc][Rr][Ii][Pp][Tt]|[Dd][Aa][Tt][Aa]):"
      }
    },
    "urlHash": {
      "description": "SHA-256 over the exact UTF-8 octets of the preserved bookmark url; a matching value is only a deduplication candidate signal and is never an object ID.",
      "type": "string",
      "pattern": "^sha-256=:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=:$",
      "minLength": 54,
      "maxLength": 54
    },
    "httpsUrl": {
      "allOf": [
        {
          "$ref": "#/$defs/httpUrl"
        },
        {
          "pattern": "^[Hh][Tt][Tt][Pp][Ss]://"
        }
      ]
    },
    "loopbackHttpUrl": {
      "allOf": [
        {
          "$ref": "#/$defs/httpUrl"
        },
        {
          "pattern": "^[Hh][Tt][Tt][Pp]://(?:localhost|127\\.0\\.0\\.1|\\[::1\\])(?::[0-9]+)?(?:[/?#]|$)"
        }
      ]
    },
    "serviceUrl": {
      "oneOf": [
        {
          "$ref": "#/$defs/httpsUrl"
        },
        {
          "$ref": "#/$defs/loopbackHttpUrl"
        }
      ]
    },
    "httpsUriTemplate": {
      "type": "string",
      "minLength": 9,
      "maxLength": 4096,
      "format": "uri-template",
      "not": {
        "pattern": "[\\u0000-\\u0020\\u007F]"
      },
      "oneOf": [
        {
          "pattern": "^[Hh][Tt][Tt][Pp][Ss]://[^/?#@\\s]+(?:[/?#]|$)"
        },
        {
          "pattern": "^[Hh][Tt][Tt][Pp]://(?:localhost|127\\.0\\.0\\.1|\\[::1\\])(?::[0-9]+)?(?:[/?#]|$)"
        }
      ]
    },
    "visibility": {
      "type": "string",
      "enum": [
        "public",
        "unlisted",
        "protected",
        "private"
      ]
    },
    "nodeVisibility": {
      "type": "string",
      "enum": [
        "inherit",
        "protected",
        "private"
      ]
    },
    "folderRole": {
      "type": "string",
      "enum": [
        "root",
        "bookmarks-bar",
        "other-bookmarks",
        "mobile-bookmarks",
        "managed-bookmarks",
        "archive",
        "inbox",
        "recovered",
        "custom"
      ]
    },
    "extensions": {
      "type": "object",
      "propertyNames": {
        "type": "string",
        "format": "uri",
        "pattern": "^[Hh][Tt][Tt][Pp][Ss]://(?:\\[[^\\]]+\\]|[^:/?#@]+)(?::[0-9]+)?(?:[/?#]|$)"
      },
      "additionalProperties": true
    },
    "formattedText": {
      "type": "object",
      "properties": {
        "format": {
          "type": "string",
          "enum": [
            "plain",
            "markdown",
            "html"
          ]
        },
        "value": {
          "type": "string"
        }
      },
      "required": [
        "format",
        "value"
      ],
      "additionalProperties": false
    },
    "actor": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "#/$defs/absoluteUri"
        },
        "name": {
          "type": "string"
        },
        "url": {
          "$ref": "#/$defs/httpUrl"
        },
        "avatar": {
          "$ref": "#/$defs/httpUrl"
        }
      },
      "required": [
        "id",
        "name"
      ],
      "additionalProperties": false
    },
    "media": {
      "type": "object",
      "properties": {
        "url": {
          "$ref": "#/$defs/httpUrl"
        },
        "mimeType": {
          "type": "string",
          "minLength": 1
        },
        "width": {
          "type": "integer",
          "minimum": 1
        },
        "height": {
          "type": "integer",
          "minimum": 1
        }
      },
      "required": [
        "url"
      ],
      "additionalProperties": false
    },
    "publication": {
      "type": "object",
      "properties": {
        "feedMode": {
          "type": "string",
          "enum": [
            "live",
            "release",
            "disabled"
          ]
        },
        "includeNodeContent": {
          "type": "string",
          "enum": [
            "metadata",
            "summary",
            "full"
          ]
        },
        "includeRelations": {
          "type": "boolean"
        }
      },
      "required": [
        "feedMode"
      ],
      "additionalProperties": false
    },
    "collection": {
      "type": "object",
      "properties": {
        "schemaVersion": {
          "const": "0.1"
        },
        "id": {
          "$ref": "#/$defs/opaqueId"
        },
        "canonicalUrl": {
          "$ref": "#/$defs/httpUrl"
        },
        "slug": {
          "type": "string"
        },
        "kind": {
          "type": "string",
          "enum": [
            "bookmarks",
            "reading_path",
            "knowledge_collection",
            "mixed"
          ]
        },
        "title": {
          "type": "string"
        },
        "summary": {
          "type": "string"
        },
        "description": {
          "$ref": "#/$defs/formattedText"
        },
        "language": {
          "type": "string"
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "uniqueItems": true
        },
        "icon": {
          "$ref": "#/$defs/media"
        },
        "cover": {
          "$ref": "#/$defs/media"
        },
        "creators": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/actor"
          },
          "maxItems": 512,
          "uniqueItems": true
        },
        "rootNodeId": {
          "$ref": "#/$defs/opaqueId"
        },
        "visibility": {
          "$ref": "#/$defs/visibility"
        },
        "publication": {
          "$ref": "#/$defs/publication"
        },
        "createdAt": {
          "$ref": "#/$defs/dateTime"
        },
        "updatedAt": {
          "$ref": "#/$defs/dateTime"
        },
        "revision": {
          "$ref": "#/$defs/opaqueId"
        },
        "eventCursor": {
          "$ref": "#/$defs/opaqueId"
        },
        "extensions": {
          "$ref": "#/$defs/extensions"
        }
      },
      "required": [
        "schemaVersion",
        "id",
        "kind",
        "title",
        "rootNodeId",
        "visibility",
        "createdAt",
        "updatedAt",
        "revision"
      ],
      "additionalProperties": false
    },
    "sourceRef": {
      "type": "object",
      "properties": {
        "system": {
          "type": "string",
          "minLength": 1
        },
        "adapterVersion": {
          "type": "string",
          "minLength": 1
        },
        "replicaId": {
          "$ref": "#/$defs/opaqueId"
        },
        "profileId": {
          "$ref": "#/$defs/opaqueId"
        },
        "nativeId": {
          "type": "string",
          "minLength": 1
        },
        "nativeParentId": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "type": "string",
              "minLength": 1
            }
          ]
        },
        "nativeIndex": {
          "type": [
            "integer",
            "null"
          ],
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "nativeCreatedAt": {
          "type": [
            "integer",
            "null"
          ],
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "nativeModifiedAt": {
          "type": [
            "integer",
            "null"
          ],
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "nativeType": {
          "type": [
            "string",
            "null"
          ]
        },
        "rootRole": {
          "type": [
            "string",
            "null"
          ]
        },
        "syncing": {
          "type": [
            "boolean",
            "null"
          ]
        },
        "capturedAt": {
          "$ref": "#/$defs/dateTime"
        }
      },
      "required": [
        "system",
        "replicaId",
        "nativeId",
        "capturedAt"
      ],
      "additionalProperties": false
    },
    "provenance": {
      "type": "object",
      "properties": {
        "kind": {
          "type": "string",
          "enum": [
            "human",
            "ai",
            "imported",
            "derived"
          ]
        },
        "provider": {
          "type": "string",
          "minLength": 1
        },
        "model": {
          "type": "string",
          "minLength": 1
        },
        "generatedAt": {
          "$ref": "#/$defs/dateTime"
        },
        "editedByHuman": {
          "type": "boolean"
        },
        "sourceNodeIds": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/opaqueId"
          },
          "uniqueItems": true
        }
      },
      "required": [
        "kind"
      ],
      "allOf": [
        {
          "if": {
            "properties": {
              "kind": {
                "const": "ai"
              }
            },
            "required": [
              "kind"
            ]
          },
          "then": {
            "required": [
              "generatedAt"
            ]
          }
        }
      ],
      "additionalProperties": false
    },
    "subject": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "enum": [
            "collection",
            "node"
          ]
        },
        "id": {
          "$ref": "#/$defs/opaqueId"
        }
      },
      "required": [
        "type",
        "id"
      ],
      "additionalProperties": false
    },
    "readingStateValue": {
      "type": "object",
      "properties": {
        "status": {
          "type": "string",
          "enum": [
            "unread",
            "in_progress",
            "completed",
            "archived"
          ]
        },
        "progress": {
          "type": "number",
          "minimum": 0,
          "maximum": 1
        },
        "completedAt": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/dateTime"
            }
          ]
        }
      },
      "required": [
        "status",
        "progress",
        "completedAt"
      ],
      "additionalProperties": false
    },
    "highlightValue": {
      "type": "object",
      "properties": {
        "quote": {
          "type": "string",
          "minLength": 1
        },
        "sourceUrl": {
          "$ref": "#/$defs/httpUrl"
        },
        "selector": {
          "type": "object",
          "properties": {
            "type": {
              "const": "TextQuoteSelector"
            },
            "exact": {
              "type": "string",
              "minLength": 1
            },
            "prefix": {
              "type": "string"
            },
            "suffix": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "exact"
          ],
          "additionalProperties": false
        },
        "comment": {
          "type": "string"
        }
      },
      "required": [
        "quote"
      ],
      "additionalProperties": false
    },
    "annotation": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "#/$defs/opaqueId"
        },
        "collectionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "subject": {
          "$ref": "#/$defs/subject"
        },
        "type": {
          "type": "string",
          "enum": [
            "note",
            "summary",
            "tldr",
            "highlight",
            "reading_state",
            "rating",
            "custom"
          ]
        },
        "format": {
          "type": "string",
          "enum": [
            "plain",
            "markdown",
            "html",
            "json"
          ]
        },
        "value": true,
        "visibility": {
          "$ref": "#/$defs/visibility"
        },
        "creator": {
          "$ref": "#/$defs/actor"
        },
        "createdAt": {
          "$ref": "#/$defs/dateTime"
        },
        "updatedAt": {
          "$ref": "#/$defs/dateTime"
        },
        "revision": {
          "$ref": "#/$defs/opaqueId"
        },
        "provenance": {
          "$ref": "#/$defs/provenance"
        },
        "extensions": {
          "$ref": "#/$defs/extensions"
        }
      },
      "required": [
        "id",
        "collectionId",
        "subject",
        "type",
        "value",
        "visibility",
        "createdAt",
        "updatedAt",
        "revision"
      ],
      "allOf": [
        {
          "if": {
            "properties": {
              "type": {
                "enum": [
                  "note",
                  "summary",
                  "tldr"
                ]
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "properties": {
              "format": {
                "enum": [
                  "plain",
                  "markdown",
                  "html"
                ]
              },
              "value": {
                "type": "string"
              }
            },
            "required": [
              "format"
            ]
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "reading_state"
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "properties": {
              "format": {
                "const": "json"
              },
              "value": {
                "$ref": "#/$defs/readingStateValue"
              }
            },
            "required": [
              "format"
            ]
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "highlight"
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "properties": {
              "format": {
                "const": "json"
              },
              "value": {
                "$ref": "#/$defs/highlightValue"
              }
            },
            "required": [
              "format"
            ]
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "rating"
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "properties": {
              "format": {
                "const": "json"
              },
              "value": {
                "type": "number",
                "minimum": 0,
                "maximum": 5
              }
            },
            "required": [
              "format"
            ]
          }
        }
      ],
      "additionalProperties": false
    },
    "annotationCreate": {
      "type": "object",
      "properties": {
        "subject": {
          "$ref": "#/$defs/subject"
        },
        "type": {
          "type": "string",
          "enum": [
            "note",
            "summary",
            "tldr",
            "highlight",
            "reading_state",
            "rating",
            "custom"
          ]
        },
        "format": {
          "type": "string",
          "enum": [
            "plain",
            "markdown",
            "html",
            "json"
          ]
        },
        "value": true,
        "visibility": {
          "$ref": "#/$defs/visibility"
        },
        "creator": {
          "$ref": "#/$defs/actor"
        },
        "provenance": {
          "$ref": "#/$defs/provenance"
        },
        "extensions": {
          "$ref": "#/$defs/extensions"
        }
      },
      "required": [
        "subject",
        "type",
        "value",
        "visibility"
      ],
      "allOf": [
        {
          "if": {
            "properties": {
              "type": {
                "enum": [
                  "note",
                  "summary",
                  "tldr"
                ]
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "properties": {
              "format": {
                "enum": [
                  "plain",
                  "markdown",
                  "html"
                ]
              },
              "value": {
                "type": "string"
              }
            },
            "required": [
              "format"
            ]
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "reading_state"
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "properties": {
              "format": {
                "const": "json"
              },
              "value": {
                "$ref": "#/$defs/readingStateValue"
              }
            },
            "required": [
              "format"
            ]
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "highlight"
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "properties": {
              "format": {
                "const": "json"
              },
              "value": {
                "$ref": "#/$defs/highlightValue"
              }
            },
            "required": [
              "format"
            ]
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "rating"
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "properties": {
              "format": {
                "const": "json"
              },
              "value": {
                "type": "number",
                "minimum": 0,
                "maximum": 5
              }
            },
            "required": [
              "format"
            ]
          }
        }
      ],
      "additionalProperties": false
    },
    "attachment": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "#/$defs/opaqueId"
        },
        "collectionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "subject": {
          "$ref": "#/$defs/subject"
        },
        "rel": {
          "type": "string",
          "minLength": 1
        },
        "url": {
          "$ref": "#/$defs/httpUrl"
        },
        "mimeType": {
          "type": "string",
          "minLength": 1
        },
        "title": {
          "type": "string"
        },
        "size": {
          "type": "integer",
          "minimum": 0
        },
        "digest": {
          "type": "string",
          "minLength": 1
        },
        "visibility": {
          "$ref": "#/$defs/visibility"
        },
        "createdAt": {
          "$ref": "#/$defs/dateTime"
        },
        "updatedAt": {
          "$ref": "#/$defs/dateTime"
        },
        "revision": {
          "$ref": "#/$defs/opaqueId"
        },
        "extensions": {
          "$ref": "#/$defs/extensions"
        }
      },
      "required": [
        "id",
        "collectionId",
        "subject",
        "rel",
        "url",
        "visibility",
        "createdAt",
        "updatedAt",
        "revision"
      ],
      "additionalProperties": false
    },
    "attachmentCreate": {
      "type": "object",
      "properties": {
        "subject": {
          "$ref": "#/$defs/subject"
        },
        "rel": {
          "type": "string",
          "minLength": 1
        },
        "url": {
          "$ref": "#/$defs/httpUrl"
        },
        "mimeType": {
          "type": "string",
          "minLength": 1
        },
        "title": {
          "type": "string"
        },
        "size": {
          "type": "integer",
          "minimum": 0
        },
        "digest": {
          "type": "string",
          "minLength": 1
        },
        "visibility": {
          "$ref": "#/$defs/visibility"
        },
        "extensions": {
          "$ref": "#/$defs/extensions"
        }
      },
      "required": [
        "subject",
        "rel",
        "url",
        "visibility"
      ],
      "additionalProperties": false
    },
    "relation": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "#/$defs/opaqueId"
        },
        "collectionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "type": {
          "type": "string",
          "enum": [
            "related",
            "precedes",
            "follows",
            "supports",
            "contradicts",
            "duplicate_of",
            "derived_from",
            "mentions",
            "custom"
          ]
        },
        "fromNodeId": {
          "$ref": "#/$defs/opaqueId"
        },
        "toNodeId": {
          "$ref": "#/$defs/opaqueId"
        },
        "label": {
          "type": "string"
        },
        "visibility": {
          "$ref": "#/$defs/visibility"
        },
        "createdAt": {
          "$ref": "#/$defs/dateTime"
        },
        "updatedAt": {
          "$ref": "#/$defs/dateTime"
        },
        "revision": {
          "$ref": "#/$defs/opaqueId"
        },
        "extensions": {
          "$ref": "#/$defs/extensions"
        }
      },
      "required": [
        "id",
        "collectionId",
        "type",
        "fromNodeId",
        "toNodeId",
        "visibility",
        "createdAt",
        "updatedAt",
        "revision"
      ],
      "additionalProperties": false
    },
    "relationCreate": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "enum": [
            "related",
            "precedes",
            "follows",
            "supports",
            "contradicts",
            "duplicate_of",
            "derived_from",
            "mentions",
            "custom"
          ]
        },
        "fromNodeId": {
          "$ref": "#/$defs/opaqueId"
        },
        "toNodeId": {
          "$ref": "#/$defs/opaqueId"
        },
        "label": {
          "type": "string"
        },
        "visibility": {
          "$ref": "#/$defs/visibility"
        },
        "extensions": {
          "$ref": "#/$defs/extensions"
        }
      },
      "required": [
        "type",
        "fromNodeId",
        "toNodeId",
        "visibility"
      ],
      "additionalProperties": false
    },
    "nodeConstraints": {
      "type": "object",
      "properties": {
        "readOnly": {
          "type": "boolean"
        },
        "reason": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "readOnly"
      ],
      "additionalProperties": false
    },
    "node": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "#/$defs/opaqueId"
        },
        "collectionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "kind": {
          "type": "string",
          "enum": [
            "root",
            "folder",
            "bookmark",
            "separator",
            "alias"
          ]
        },
        "parentId": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/opaqueId"
            }
          ]
        },
        "position": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/orderKey"
            }
          ]
        },
        "folderRole": {
          "$ref": "#/$defs/folderRole"
        },
        "title": {
          "type": "string"
        },
        "url": {
          "$ref": "#/$defs/bookmarkUrl"
        },
        "canonicalUrl": {
          "$ref": "#/$defs/httpUrl"
        },
        "urlHash": {
          "$ref": "#/$defs/urlHash"
        },
        "targetNodeId": {
          "$ref": "#/$defs/opaqueId"
        },
        "description": {
          "type": "string"
        },
        "redacted": {
          "type": "boolean",
          "default": false
        },
        "accessUrl": {
          "$ref": "#/$defs/httpUrl"
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "uniqueItems": true
        },
        "visibility": {
          "$ref": "#/$defs/nodeVisibility"
        },
        "createdAt": {
          "$ref": "#/$defs/dateTime"
        },
        "updatedAt": {
          "$ref": "#/$defs/dateTime"
        },
        "childrenModifiedAt": {
          "$ref": "#/$defs/dateTime"
        },
        "lastUsedAt": {
          "$ref": "#/$defs/dateTime"
        },
        "revision": {
          "$ref": "#/$defs/opaqueId"
        },
        "constraints": {
          "$ref": "#/$defs/nodeConstraints"
        },
        "sourceRefs": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/sourceRef"
          },
          "maxItems": 512,
          "uniqueItems": true
        },
        "extensions": {
          "$ref": "#/$defs/extensions"
        }
      },
      "required": [
        "id",
        "collectionId",
        "kind",
        "createdAt",
        "updatedAt",
        "revision"
      ],
      "allOf": [
        {
          "if": {
            "properties": {
              "kind": {
                "const": "root"
              }
            },
            "required": [
              "kind"
            ]
          },
          "then": {
            "properties": {
              "parentId": {
                "type": "null"
              },
              "position": {
                "type": "null"
              },
              "folderRole": {
                "const": "root"
              }
            },
            "required": [
              "parentId",
              "position",
              "folderRole",
              "title"
            ],
            "not": {
              "anyOf": [
                {
                  "required": [
                    "url"
                  ]
                },
                {
                  "required": [
                    "canonicalUrl"
                  ]
                },
                {
                  "required": [
                    "urlHash"
                  ]
                },
                {
                  "required": [
                    "targetNodeId"
                  ]
                }
              ]
            }
          }
        },
        {
          "if": {
            "properties": {
              "kind": {
                "const": "folder"
              }
            },
            "required": [
              "kind"
            ]
          },
          "then": {
            "properties": {
              "parentId": {
                "$ref": "#/$defs/opaqueId"
              },
              "position": {
                "$ref": "#/$defs/orderKey"
              },
              "folderRole": {
                "not": {
                  "const": "root"
                }
              }
            },
            "required": [
              "parentId",
              "position",
              "title"
            ],
            "not": {
              "anyOf": [
                {
                  "required": [
                    "url"
                  ]
                },
                {
                  "required": [
                    "canonicalUrl"
                  ]
                },
                {
                  "required": [
                    "urlHash"
                  ]
                },
                {
                  "required": [
                    "targetNodeId"
                  ]
                }
              ]
            }
          }
        },
        {
          "if": {
            "properties": {
              "kind": {
                "const": "bookmark"
              }
            },
            "required": [
              "kind"
            ]
          },
          "then": {
            "properties": {
              "parentId": {
                "$ref": "#/$defs/opaqueId"
              },
              "position": {
                "$ref": "#/$defs/orderKey"
              }
            },
            "required": [
              "parentId",
              "position",
              "title"
            ],
            "not": {
              "anyOf": [
                {
                  "required": [
                    "targetNodeId"
                  ]
                },
                {
                  "required": [
                    "folderRole"
                  ]
                }
              ]
            }
          }
        },
        {
          "if": {
            "properties": {
              "kind": {
                "const": "bookmark"
              },
              "redacted": {
                "const": true
              }
            },
            "required": [
              "kind",
              "redacted"
            ]
          },
          "then": {
            "properties": {
              "visibility": {
                "type": "string",
                "enum": [
                  "protected",
                  "private"
                ]
              }
            },
            "required": [
              "visibility"
            ],
            "not": {
              "anyOf": [
                {
                  "required": [
                    "url"
                  ]
                },
                {
                  "required": [
                    "canonicalUrl"
                  ]
                },
                {
                  "required": [
                    "urlHash"
                  ]
                },
                {
                  "required": [
                    "sourceRefs"
                  ]
                }
              ]
            }
          },
          "else": {
            "if": {
              "properties": {
                "kind": {
                  "const": "bookmark"
                }
              },
              "required": [
                "kind"
              ]
            },
            "then": {
              "required": [
                "url"
              ]
            }
          }
        },
        {
          "if": {
            "properties": {
              "kind": {
                "const": "separator"
              }
            },
            "required": [
              "kind"
            ]
          },
          "then": {
            "properties": {
              "parentId": {
                "$ref": "#/$defs/opaqueId"
              },
              "position": {
                "$ref": "#/$defs/orderKey"
              }
            },
            "required": [
              "parentId",
              "position"
            ],
            "not": {
              "anyOf": [
                {
                  "required": [
                    "url"
                  ]
                },
                {
                  "required": [
                    "canonicalUrl"
                  ]
                },
                {
                  "required": [
                    "urlHash"
                  ]
                },
                {
                  "required": [
                    "targetNodeId"
                  ]
                },
                {
                  "required": [
                    "folderRole"
                  ]
                },
                {
                  "required": [
                    "title"
                  ]
                }
              ]
            }
          }
        },
        {
          "if": {
            "properties": {
              "kind": {
                "const": "alias"
              }
            },
            "required": [
              "kind"
            ]
          },
          "then": {
            "properties": {
              "parentId": {
                "$ref": "#/$defs/opaqueId"
              },
              "position": {
                "$ref": "#/$defs/orderKey"
              }
            },
            "required": [
              "parentId",
              "position",
              "title",
              "targetNodeId"
            ],
            "not": {
              "anyOf": [
                {
                  "required": [
                    "url"
                  ]
                },
                {
                  "required": [
                    "canonicalUrl"
                  ]
                },
                {
                  "required": [
                    "urlHash"
                  ]
                },
                {
                  "required": [
                    "folderRole"
                  ]
                }
              ]
            }
          }
        }
      ],
      "additionalProperties": false
    },
    "nodeCreate": {
      "type": "object",
      "properties": {
        "kind": {
          "type": "string",
          "enum": [
            "folder",
            "bookmark",
            "separator",
            "alias"
          ]
        },
        "title": {
          "type": "string"
        },
        "url": {
          "$ref": "#/$defs/bookmarkUrl"
        },
        "canonicalUrl": {
          "$ref": "#/$defs/httpUrl"
        },
        "urlHash": {
          "$ref": "#/$defs/urlHash"
        },
        "targetNodeId": {
          "$ref": "#/$defs/opaqueId"
        },
        "folderRole": {
          "$ref": "#/$defs/folderRole"
        },
        "description": {
          "type": "string"
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "uniqueItems": true
        },
        "visibility": {
          "$ref": "#/$defs/nodeVisibility"
        },
        "extensions": {
          "$ref": "#/$defs/extensions"
        }
      },
      "required": [
        "kind"
      ],
      "allOf": [
        {
          "if": {
            "properties": {
              "kind": {
                "const": "folder"
              }
            },
            "required": [
              "kind"
            ]
          },
          "then": {
            "properties": {
              "folderRole": {
                "not": {
                  "const": "root"
                }
              }
            },
            "required": [
              "title"
            ],
            "not": {
              "anyOf": [
                {
                  "required": [
                    "url"
                  ]
                },
                {
                  "required": [
                    "canonicalUrl"
                  ]
                },
                {
                  "required": [
                    "urlHash"
                  ]
                },
                {
                  "required": [
                    "targetNodeId"
                  ]
                }
              ]
            }
          }
        },
        {
          "if": {
            "properties": {
              "kind": {
                "const": "bookmark"
              }
            },
            "required": [
              "kind"
            ]
          },
          "then": {
            "required": [
              "title",
              "url"
            ],
            "not": {
              "anyOf": [
                {
                  "required": [
                    "targetNodeId"
                  ]
                },
                {
                  "required": [
                    "folderRole"
                  ]
                }
              ]
            }
          }
        },
        {
          "if": {
            "properties": {
              "kind": {
                "const": "separator"
              }
            },
            "required": [
              "kind"
            ]
          },
          "then": {
            "not": {
              "anyOf": [
                {
                  "required": [
                    "url"
                  ]
                },
                {
                  "required": [
                    "canonicalUrl"
                  ]
                },
                {
                  "required": [
                    "urlHash"
                  ]
                },
                {
                  "required": [
                    "targetNodeId"
                  ]
                },
                {
                  "required": [
                    "folderRole"
                  ]
                },
                {
                  "required": [
                    "title"
                  ]
                }
              ]
            }
          }
        },
        {
          "if": {
            "properties": {
              "kind": {
                "const": "alias"
              }
            },
            "required": [
              "kind"
            ]
          },
          "then": {
            "required": [
              "title",
              "targetNodeId"
            ],
            "not": {
              "anyOf": [
                {
                  "required": [
                    "url"
                  ]
                },
                {
                  "required": [
                    "canonicalUrl"
                  ]
                },
                {
                  "required": [
                    "urlHash"
                  ]
                },
                {
                  "required": [
                    "folderRole"
                  ]
                }
              ]
            }
          }
        }
      ],
      "additionalProperties": false
    },
    "warning": {
      "type": "object",
      "properties": {
        "code": {
          "type": "string",
          "minLength": 1
        },
        "message": {
          "type": "string"
        },
        "nodeId": {
          "$ref": "#/$defs/opaqueId"
        },
        "path": {
          "type": "string"
        },
        "lossy": {
          "type": "boolean"
        }
      },
      "required": [
        "code",
        "message"
      ],
      "additionalProperties": false
    },
    "deletionReceipt": {
      "type": "object",
      "properties": {
        "resourceType": {
          "type": "string",
          "enum": [
            "collection",
            "node",
            "annotation",
            "attachment",
            "relation"
          ]
        },
        "targetId": {
          "$ref": "#/$defs/opaqueId"
        },
        "collectionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "scope": {
          "type": "string",
          "enum": [
            "single",
            "subtree"
          ]
        },
        "deletedAt": {
          "$ref": "#/$defs/dateTime"
        },
        "deletedBy": {
          "$ref": "#/$defs/principalId"
        },
        "deleteRevision": {
          "$ref": "#/$defs/opaqueId"
        },
        "operationId": {
          "$ref": "#/$defs/opaqueId"
        },
        "affectedCount": {
          "type": "integer",
          "minimum": 1
        },
        "purgeAfter": {
          "$ref": "#/$defs/dateTime"
        }
      },
      "required": [
        "resourceType",
        "targetId",
        "collectionId",
        "scope",
        "deletedAt",
        "deleteRevision",
        "operationId",
        "affectedCount",
        "purgeAfter"
      ],
      "additionalProperties": false
    },
    "syncTombstone": {
      "type": "object",
      "properties": {
        "resourceType": {
          "type": "string",
          "enum": [
            "collection",
            "node",
            "annotation",
            "attachment",
            "relation"
          ]
        },
        "targetId": {
          "$ref": "#/$defs/opaqueId"
        },
        "collectionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "scope": {
          "type": "string",
          "enum": [
            "single",
            "subtree"
          ]
        },
        "deletedAt": {
          "$ref": "#/$defs/dateTime"
        },
        "deletedBy": {
          "$ref": "#/$defs/principalId"
        },
        "deleteRevision": {
          "$ref": "#/$defs/opaqueId"
        },
        "operationId": {
          "$ref": "#/$defs/opaqueId"
        },
        "deleteCursor": {
          "$ref": "#/$defs/opaqueId"
        },
        "affectedCount": {
          "type": "integer",
          "minimum": 1
        },
        "purgeAfter": {
          "$ref": "#/$defs/dateTime"
        }
      },
      "required": [
        "resourceType",
        "targetId",
        "collectionId",
        "scope",
        "deletedAt",
        "deleteRevision",
        "operationId",
        "deleteCursor",
        "affectedCount",
        "purgeAfter"
      ],
      "additionalProperties": false
    },
    "snapshotPage": {
      "type": "object",
      "properties": {
        "nextCursor": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/opaqueId"
            }
          ]
        },
        "hasMore": {
          "type": "boolean"
        },
        "sequence": {
          "type": "integer",
          "minimum": 1
        }
      },
      "required": [
        "nextCursor",
        "hasMore",
        "sequence"
      ],
      "allOf": [
        {
          "if": {
            "properties": {
              "hasMore": {
                "const": true
              }
            },
            "required": [
              "hasMore"
            ]
          },
          "then": {
            "properties": {
              "nextCursor": {
                "$ref": "#/$defs/opaqueId"
              }
            }
          },
          "else": {
            "properties": {
              "nextCursor": {
                "type": "null"
              }
            }
          }
        }
      ],
      "additionalProperties": false
    },
    "snapshot": {
      "type": "object",
      "properties": {
        "protocolVersion": {
          "const": "0.1"
        },
        "snapshotId": {
          "$ref": "#/$defs/opaqueId"
        },
        "mode": {
          "type": "string",
          "enum": [
            "publication",
            "sync"
          ]
        },
        "complete": {
          "type": "boolean"
        },
        "collection": {
          "$ref": "#/$defs/collection"
        },
        "nodes": {
          "type": "array",
          "items": {
            "oneOf": [
              {
                "$ref": "#/$defs/node"
              },
              {
                "type": "object",
                "properties": {
                  "id": {
                    "$ref": "#/$defs/opaqueId"
                  },
                  "collectionId": {
                    "$ref": "#/$defs/opaqueId"
                  },
                  "kind": {
                    "type": "string",
                    "enum": [
                      "root",
                      "folder",
                      "bookmark",
                      "separator",
                      "alias"
                    ]
                  },
                  "parentId": {
                    "oneOf": [
                      {
                        "type": "null"
                      },
                      {
                        "$ref": "#/$defs/opaqueId"
                      }
                    ]
                  },
                  "position": {
                    "oneOf": [
                      {
                        "type": "null"
                      },
                      {
                        "$ref": "#/$defs/orderKey"
                      }
                    ]
                  },
                  "folderRole": {
                    "$ref": "#/$defs/folderRole"
                  },
                  "title": {
                    "type": "string"
                  },
                  "url": {
                    "$ref": "#/$defs/bookmarkUrl"
                  },
                  "canonicalUrl": {
                    "$ref": "#/$defs/httpUrl"
                  },
                  "urlHash": {
                    "$ref": "#/$defs/urlHash"
                  },
                  "targetNodeId": {
                    "$ref": "#/$defs/opaqueId"
                  },
                  "description": {
                    "type": "string"
                  },
                  "redacted": {
                    "type": "boolean",
                    "default": false
                  },
                  "accessUrl": {
                    "$ref": "#/$defs/httpUrl"
                  },
                  "tags": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    },
                    "uniqueItems": true
                  },
                  "visibility": {
                    "$ref": "#/$defs/nodeVisibility"
                  },
                  "createdAt": {
                    "$ref": "#/$defs/dateTime"
                  },
                  "updatedAt": {
                    "$ref": "#/$defs/dateTime"
                  },
                  "childrenModifiedAt": {
                    "$ref": "#/$defs/dateTime"
                  },
                  "lastUsedAt": {
                    "$ref": "#/$defs/dateTime"
                  },
                  "revision": {
                    "$ref": "#/$defs/opaqueId"
                  },
                  "constraints": {
                    "$ref": "#/$defs/nodeConstraints"
                  },
                  "sourceRefs": {
                    "type": "array",
                    "items": {
                      "$ref": "#/$defs/sourceRef"
                    },
                    "maxItems": 512,
                    "uniqueItems": true
                  },
                  "extensions": {
                    "$ref": "#/$defs/extensions"
                  },
                  "index": {
                    "type": [
                      "integer",
                      "null"
                    ],
                    "minimum": 0,
                    "maximum": 9007199254740991,
                    "description": "Derived zero-based ordinal among the represented siblings ordered by position; never authoritative Sync state."
                  }
                },
                "required": [
                  "id",
                  "collectionId",
                  "kind",
                  "createdAt",
                  "updatedAt",
                  "revision",
                  "index"
                ],
                "allOf": [
                  {
                    "if": {
                      "properties": {
                        "kind": {
                          "const": "root"
                        }
                      },
                      "required": [
                        "kind"
                      ]
                    },
                    "then": {
                      "properties": {
                        "parentId": {
                          "type": "null"
                        },
                        "position": {
                          "type": "null"
                        },
                        "folderRole": {
                          "const": "root"
                        }
                      },
                      "required": [
                        "parentId",
                        "position",
                        "folderRole",
                        "title"
                      ],
                      "not": {
                        "anyOf": [
                          {
                            "required": [
                              "url"
                            ]
                          },
                          {
                            "required": [
                              "canonicalUrl"
                            ]
                          },
                          {
                            "required": [
                              "urlHash"
                            ]
                          },
                          {
                            "required": [
                              "targetNodeId"
                            ]
                          }
                        ]
                      }
                    }
                  },
                  {
                    "if": {
                      "properties": {
                        "kind": {
                          "const": "folder"
                        }
                      },
                      "required": [
                        "kind"
                      ]
                    },
                    "then": {
                      "properties": {
                        "parentId": {
                          "$ref": "#/$defs/opaqueId"
                        },
                        "position": {
                          "$ref": "#/$defs/orderKey"
                        },
                        "folderRole": {
                          "not": {
                            "const": "root"
                          }
                        }
                      },
                      "required": [
                        "parentId",
                        "position",
                        "title"
                      ],
                      "not": {
                        "anyOf": [
                          {
                            "required": [
                              "url"
                            ]
                          },
                          {
                            "required": [
                              "canonicalUrl"
                            ]
                          },
                          {
                            "required": [
                              "urlHash"
                            ]
                          },
                          {
                            "required": [
                              "targetNodeId"
                            ]
                          }
                        ]
                      }
                    }
                  },
                  {
                    "if": {
                      "properties": {
                        "kind": {
                          "const": "bookmark"
                        }
                      },
                      "required": [
                        "kind"
                      ]
                    },
                    "then": {
                      "properties": {
                        "parentId": {
                          "$ref": "#/$defs/opaqueId"
                        },
                        "position": {
                          "$ref": "#/$defs/orderKey"
                        }
                      },
                      "required": [
                        "parentId",
                        "position",
                        "title"
                      ],
                      "not": {
                        "anyOf": [
                          {
                            "required": [
                              "targetNodeId"
                            ]
                          },
                          {
                            "required": [
                              "folderRole"
                            ]
                          }
                        ]
                      }
                    }
                  },
                  {
                    "if": {
                      "properties": {
                        "kind": {
                          "const": "bookmark"
                        },
                        "redacted": {
                          "const": true
                        }
                      },
                      "required": [
                        "kind",
                        "redacted"
                      ]
                    },
                    "then": {
                      "properties": {
                        "visibility": {
                          "type": "string",
                          "enum": [
                            "protected",
                            "private"
                          ]
                        }
                      },
                      "required": [
                        "visibility"
                      ],
                      "not": {
                        "anyOf": [
                          {
                            "required": [
                              "url"
                            ]
                          },
                          {
                            "required": [
                              "canonicalUrl"
                            ]
                          },
                          {
                            "required": [
                              "urlHash"
                            ]
                          },
                          {
                            "required": [
                              "sourceRefs"
                            ]
                          }
                        ]
                      }
                    },
                    "else": {
                      "if": {
                        "properties": {
                          "kind": {
                            "const": "bookmark"
                          }
                        },
                        "required": [
                          "kind"
                        ]
                      },
                      "then": {
                        "required": [
                          "url"
                        ]
                      }
                    }
                  },
                  {
                    "if": {
                      "properties": {
                        "kind": {
                          "const": "separator"
                        }
                      },
                      "required": [
                        "kind"
                      ]
                    },
                    "then": {
                      "properties": {
                        "parentId": {
                          "$ref": "#/$defs/opaqueId"
                        },
                        "position": {
                          "$ref": "#/$defs/orderKey"
                        }
                      },
                      "required": [
                        "parentId",
                        "position"
                      ],
                      "not": {
                        "anyOf": [
                          {
                            "required": [
                              "url"
                            ]
                          },
                          {
                            "required": [
                              "canonicalUrl"
                            ]
                          },
                          {
                            "required": [
                              "urlHash"
                            ]
                          },
                          {
                            "required": [
                              "targetNodeId"
                            ]
                          },
                          {
                            "required": [
                              "folderRole"
                            ]
                          },
                          {
                            "required": [
                              "title"
                            ]
                          }
                        ]
                      }
                    }
                  },
                  {
                    "if": {
                      "properties": {
                        "kind": {
                          "const": "alias"
                        }
                      },
                      "required": [
                        "kind"
                      ]
                    },
                    "then": {
                      "properties": {
                        "parentId": {
                          "$ref": "#/$defs/opaqueId"
                        },
                        "position": {
                          "$ref": "#/$defs/orderKey"
                        }
                      },
                      "required": [
                        "parentId",
                        "position",
                        "title",
                        "targetNodeId"
                      ],
                      "not": {
                        "anyOf": [
                          {
                            "required": [
                              "url"
                            ]
                          },
                          {
                            "required": [
                              "canonicalUrl"
                            ]
                          },
                          {
                            "required": [
                              "urlHash"
                            ]
                          },
                          {
                            "required": [
                              "folderRole"
                            ]
                          }
                        ]
                      }
                    }
                  },
                  {
                    "if": {
                      "properties": {
                        "kind": {
                          "const": "root"
                        }
                      },
                      "required": [
                        "kind"
                      ]
                    },
                    "then": {
                      "properties": {
                        "index": {
                          "type": "null"
                        }
                      }
                    },
                    "else": {
                      "properties": {
                        "index": {
                          "type": "integer"
                        }
                      }
                    }
                  }
                ],
                "title": "SnapshotNode",
                "additionalProperties": false
              }
            ]
          }
        },
        "annotations": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/annotation"
          }
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          }
        },
        "relations": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/relation"
          }
        },
        "tombstones": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/syncTombstone"
          }
        },
        "revision": {
          "$ref": "#/$defs/opaqueId"
        },
        "syncCursor": {
          "$ref": "#/$defs/opaqueId"
        },
        "recoveryCapability": {
          "$ref": "#/$defs/opaqueId"
        },
        "generatedAt": {
          "$ref": "#/$defs/dateTime"
        },
        "contentDigest": {
          "type": "string",
          "pattern": "^sha-256=:[A-Za-z0-9+/]{43}=:$"
        },
        "page": {
          "$ref": "#/$defs/snapshotPage"
        },
        "warnings": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/warning"
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
        "annotations",
        "attachments",
        "relations",
        "tombstones",
        "revision",
        "generatedAt",
        "page",
        "warnings"
      ],
      "allOf": [
        {
          "if": {
            "properties": {
              "mode": {
                "const": "publication"
              }
            },
            "required": [
              "mode"
            ]
          },
          "then": {
            "not": {
              "anyOf": [
                {
                  "required": [
                    "syncCursor"
                  ]
                },
                {
                  "required": [
                    "recoveryCapability"
                  ]
                }
              ]
            },
            "properties": {
              "nodes": {
                "items": {
                  "not": {
                    "required": [
                      "sourceRefs"
                    ]
                  }
                }
              },
              "tombstones": {
                "maxItems": 0
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "mode": {
                "const": "sync"
              }
            },
            "required": [
              "mode"
            ]
          },
          "then": {
            "required": [
              "syncCursor"
            ],
            "properties": {
              "nodes": {
                "items": {
                  "properties": {
                    "redacted": {
                      "not": {
                        "const": true
                      }
                    }
                  }
                }
              }
            }
          }
        },
        {
          "if": {
            "required": [
              "contentDigest"
            ]
          },
          "then": {
            "properties": {
              "complete": {
                "const": true
              },
              "page": {
                "properties": {
                  "nextCursor": {
                    "type": "null"
                  },
                  "hasMore": {
                    "const": false
                  },
                  "sequence": {
                    "const": 1
                  }
                }
              }
            }
          }
        }
      ],
      "additionalProperties": false
    },
    "moveOperationPayload": {
      "type": "object",
      "properties": {
        "newParentId": {
          "$ref": "#/$defs/opaqueId"
        },
        "afterId": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/opaqueId"
            }
          ]
        },
        "beforeId": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/opaqueId"
            }
          ]
        },
        "baseSourceParentRevision": {
          "$ref": "#/$defs/opaqueId"
        },
        "baseTargetParentRevision": {
          "$ref": "#/$defs/opaqueId"
        }
      },
      "required": [
        "newParentId",
        "baseSourceParentRevision",
        "baseTargetParentRevision"
      ],
      "additionalProperties": false
    },
    "reorderOperationPayload": {
      "type": "object",
      "properties": {
        "parentId": {
          "$ref": "#/$defs/opaqueId"
        },
        "childIds": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/opaqueId"
          },
          "uniqueItems": true
        },
        "baseChildrenRevision": {
          "$ref": "#/$defs/opaqueId"
        }
      },
      "required": [
        "parentId",
        "childIds",
        "baseChildrenRevision"
      ],
      "additionalProperties": false
    },
    "collectionMetadataUpdateOperationPayload": {
      "type": "object",
      "properties": {
        "base": {
          "$ref": "#/$defs/collectionMergePatch"
        },
        "value": {
          "$ref": "#/$defs/collectionMergePatch"
        }
      },
      "required": [
        "base",
        "value"
      ],
      "additionalProperties": false
    },
    "nodeContentUpdateOperationPayload": {
      "type": "object",
      "properties": {
        "base": {
          "$ref": "#/$defs/nodeMergePatch"
        },
        "value": {
          "$ref": "#/$defs/nodeMergePatch"
        }
      },
      "required": [
        "base",
        "value"
      ],
      "additionalProperties": false
    },
    "annotationUpdateOperationPayload": {
      "type": "object",
      "properties": {
        "base": {
          "$ref": "#/$defs/annotationMergePatch"
        },
        "value": {
          "$ref": "#/$defs/annotationMergePatch"
        }
      },
      "required": [
        "base",
        "value"
      ],
      "additionalProperties": false
    },
    "attachmentUpdateOperationPayload": {
      "type": "object",
      "properties": {
        "base": {
          "$ref": "#/$defs/attachmentMergePatch"
        },
        "value": {
          "$ref": "#/$defs/attachmentMergePatch"
        }
      },
      "required": [
        "base",
        "value"
      ],
      "additionalProperties": false
    },
    "relationUpdateOperationPayload": {
      "type": "object",
      "properties": {
        "base": {
          "$ref": "#/$defs/relationMergePatch"
        },
        "value": {
          "$ref": "#/$defs/relationMergePatch"
        }
      },
      "required": [
        "base",
        "value"
      ],
      "additionalProperties": false
    },
    "createNodeOperationPayload": {
      "type": "object",
      "properties": {
        "parentId": {
          "$ref": "#/$defs/opaqueId"
        },
        "afterId": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/opaqueId"
            }
          ]
        },
        "beforeId": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/opaqueId"
            }
          ]
        },
        "node": {
          "$ref": "#/$defs/nodeCreate"
        }
      },
      "required": [
        "parentId",
        "node"
      ],
      "additionalProperties": false
    },
    "collectionCreate": {
      "type": "object",
      "properties": {
        "canonicalUrl": {
          "$ref": "#/$defs/httpUrl"
        },
        "slug": {
          "type": "string"
        },
        "kind": {
          "type": "string",
          "enum": [
            "bookmarks",
            "reading_path",
            "knowledge_collection",
            "mixed"
          ]
        },
        "title": {
          "type": "string"
        },
        "summary": {
          "type": "string"
        },
        "description": {
          "$ref": "#/$defs/formattedText"
        },
        "language": {
          "type": "string"
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "uniqueItems": true
        },
        "icon": {
          "$ref": "#/$defs/media"
        },
        "cover": {
          "$ref": "#/$defs/media"
        },
        "creators": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/actor"
          },
          "maxItems": 512,
          "uniqueItems": true
        },
        "visibility": {
          "$ref": "#/$defs/visibility"
        },
        "publication": {
          "$ref": "#/$defs/publication"
        },
        "extensions": {
          "$ref": "#/$defs/extensions"
        }
      },
      "required": [
        "kind",
        "title",
        "visibility"
      ],
      "additionalProperties": false
    },
    "rootCreate": {
      "type": "object",
      "properties": {
        "title": {
          "type": "string"
        },
        "folderRole": {
          "const": "root"
        },
        "extensions": {
          "$ref": "#/$defs/extensions"
        }
      },
      "required": [
        "title",
        "folderRole"
      ],
      "additionalProperties": false
    },
    "createCollectionOperationPayload": {
      "type": "object",
      "properties": {
        "collection": {
          "$ref": "#/$defs/collectionCreate"
        },
        "root": {
          "$ref": "#/$defs/rootCreate"
        }
      },
      "required": [
        "collection",
        "root"
      ],
      "additionalProperties": false
    },
    "createAnnotationOperationPayload": {
      "type": "object",
      "properties": {
        "annotation": {
          "$ref": "#/$defs/annotationCreate"
        }
      },
      "required": [
        "annotation"
      ],
      "additionalProperties": false
    },
    "createAttachmentOperationPayload": {
      "type": "object",
      "properties": {
        "attachment": {
          "$ref": "#/$defs/attachmentCreate"
        }
      },
      "required": [
        "attachment"
      ],
      "additionalProperties": false
    },
    "createRelationOperationPayload": {
      "type": "object",
      "properties": {
        "relation": {
          "$ref": "#/$defs/relationCreate"
        }
      },
      "required": [
        "relation"
      ],
      "additionalProperties": false
    },
    "collectionMergePatch": {
      "type": "object",
      "properties": {
        "canonicalUrl": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/httpUrl"
            }
          ]
        },
        "slug": {
          "type": [
            "string",
            "null"
          ]
        },
        "title": {
          "type": "string"
        },
        "summary": {
          "type": [
            "string",
            "null"
          ]
        },
        "description": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/formattedText"
            }
          ]
        },
        "language": {
          "type": [
            "string",
            "null"
          ]
        },
        "tags": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "type": "array",
              "items": {
                "type": "string"
              },
              "uniqueItems": true
            }
          ]
        },
        "icon": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/media"
            }
          ]
        },
        "cover": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/media"
            }
          ]
        },
        "creators": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "type": "array",
              "items": {
                "$ref": "#/$defs/actor"
              },
              "maxItems": 512,
              "uniqueItems": true
            }
          ]
        },
        "visibility": {
          "$ref": "#/$defs/visibility"
        },
        "publication": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/publication"
            }
          ]
        },
        "extensions": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/extensions"
            }
          ]
        }
      },
      "minProperties": 1,
      "additionalProperties": false
    },
    "nodeMergePatch": {
      "type": "object",
      "properties": {
        "title": {
          "type": [
            "string",
            "null"
          ]
        },
        "url": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/bookmarkUrl"
            }
          ]
        },
        "canonicalUrl": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/httpUrl"
            }
          ]
        },
        "urlHash": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/urlHash"
            }
          ]
        },
        "targetNodeId": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/opaqueId"
            }
          ]
        },
        "folderRole": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/folderRole"
            }
          ]
        },
        "description": {
          "type": [
            "string",
            "null"
          ]
        },
        "tags": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "type": "array",
              "items": {
                "type": "string"
              },
              "uniqueItems": true
            }
          ]
        },
        "visibility": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/nodeVisibility"
            }
          ]
        },
        "constraints": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/nodeConstraints"
            }
          ]
        },
        "extensions": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/extensions"
            }
          ]
        }
      },
      "minProperties": 1,
      "additionalProperties": false
    },
    "annotationMergePatch": {
      "type": "object",
      "properties": {
        "format": {
          "type": [
            "string",
            "null"
          ]
        },
        "value": true,
        "visibility": {
          "$ref": "#/$defs/visibility"
        },
        "provenance": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/provenance"
            }
          ]
        },
        "extensions": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/extensions"
            }
          ]
        }
      },
      "minProperties": 1,
      "additionalProperties": false
    },
    "attachmentMergePatch": {
      "type": "object",
      "properties": {
        "rel": {
          "type": "string",
          "minLength": 1
        },
        "url": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/httpUrl"
            }
          ]
        },
        "mimeType": {
          "type": [
            "string",
            "null"
          ]
        },
        "title": {
          "type": [
            "string",
            "null"
          ]
        },
        "size": {
          "type": [
            "integer",
            "null"
          ],
          "minimum": 0
        },
        "digest": {
          "type": [
            "string",
            "null"
          ]
        },
        "visibility": {
          "$ref": "#/$defs/visibility"
        },
        "extensions": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/extensions"
            }
          ]
        }
      },
      "minProperties": 1,
      "additionalProperties": false
    },
    "relationMergePatch": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "enum": [
            "related",
            "precedes",
            "follows",
            "supports",
            "contradicts",
            "duplicate_of",
            "derived_from",
            "mentions",
            "custom"
          ]
        },
        "label": {
          "type": [
            "string",
            "null"
          ]
        },
        "visibility": {
          "$ref": "#/$defs/visibility"
        },
        "extensions": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/extensions"
            }
          ]
        }
      },
      "minProperties": 1,
      "additionalProperties": false
    },
    "collectionLinks": {
      "type": "object",
      "properties": {
        "self": {
          "$ref": "#/$defs/httpUrl"
        },
        "canonical": {
          "$ref": "#/$defs/httpUrl"
        },
        "snapshot": {
          "$ref": "#/$defs/httpUrl"
        },
        "node": {
          "$ref": "#/$defs/httpUrl"
        },
        "nodes": {
          "$ref": "#/$defs/httpUrl"
        },
        "annotations": {
          "$ref": "#/$defs/httpUrl"
        },
        "attachments": {
          "$ref": "#/$defs/httpUrl"
        },
        "relations": {
          "$ref": "#/$defs/httpUrl"
        },
        "feed": {
          "$ref": "#/$defs/httpUrl"
        },
        "releases": {
          "$ref": "#/$defs/httpUrl"
        },
        "release": {
          "$ref": "#/$defs/httpUrl"
        },
        "access": {
          "$ref": "#/$defs/httpUrl"
        },
        "alternateJsonFeed": {
          "$ref": "#/$defs/httpUrl"
        },
        "alternateAtom": {
          "$ref": "#/$defs/httpUrl"
        }
      },
      "required": [
        "self",
        "canonical",
        "snapshot"
      ],
      "additionalProperties": false
    },
    "cursorPageQuery": {
      "type": "object",
      "properties": {
        "cursor": {
          "$ref": "#/$defs/opaqueId"
        },
        "limit": {
          "type": "integer",
          "minimum": 1
        }
      },
      "additionalProperties": false
    },
    "auditQuery": {
      "type": "object",
      "properties": {
        "cursor": {
          "$ref": "#/$defs/opaqueId"
        },
        "limit": {
          "type": "integer",
          "minimum": 1
        },
        "action": {
          "type": "string",
          "minLength": 1
        },
        "result": {
          "type": "string",
          "enum": [
            "success",
            "failure",
            "denied"
          ]
        },
        "from": {
          "$ref": "#/$defs/dateTime"
        },
        "to": {
          "$ref": "#/$defs/dateTime"
        }
      },
      "additionalProperties": false
    },
    "directoryQuery": {
      "type": "object",
      "properties": {
        "cursor": {
          "$ref": "#/$defs/opaqueId"
        },
        "limit": {
          "type": "integer",
          "minimum": 1
        },
        "tag": {
          "type": "string",
          "minLength": 1
        },
        "creator": {
          "type": "string",
          "minLength": 1
        },
        "kind": {
          "type": "string",
          "enum": [
            "bookmarks",
            "reading_path",
            "knowledge_collection",
            "mixed"
          ]
        },
        "updatedSince": {
          "$ref": "#/$defs/dateTime"
        },
        "q": {
          "type": "string",
          "minLength": 1
        }
      },
      "additionalProperties": false
    },
    "snapshotQuery": {
      "type": "object",
      "properties": {
        "pageCursor": {
          "$ref": "#/$defs/opaqueId"
        },
        "limit": {
          "type": "integer",
          "minimum": 1
        },
        "include": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "annotations",
              "attachments",
              "relations"
            ]
          },
          "uniqueItems": true
        },
        "depth": {
          "type": "integer",
          "minimum": 0
        },
        "root": {
          "$ref": "#/$defs/opaqueId"
        }
      },
      "additionalProperties": false
    },
    "nodeDetailQuery": {
      "type": "object",
      "properties": {
        "include": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "annotations",
              "attachments",
              "relations"
            ]
          },
          "uniqueItems": true
        }
      },
      "additionalProperties": false
    },
    "nodeDeleteQuery": {
      "type": "object",
      "properties": {
        "recursive": {
          "type": "boolean",
          "default": false
        }
      },
      "additionalProperties": false
    },
    "feedQuery": {
      "type": "object",
      "properties": {
        "cursor": {
          "$ref": "#/$defs/opaqueId"
        },
        "from": {
          "type": "string",
          "enum": [
            "now",
            "beginning"
          ]
        },
        "limit": {
          "type": "integer",
          "minimum": 1
        }
      },
      "not": {
        "required": [
          "cursor",
          "from"
        ]
      },
      "additionalProperties": false
    },
    "syncPullQuery": {
      "type": "object",
      "properties": {
        "sessionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "cursor": {
          "$ref": "#/$defs/opaqueId"
        },
        "limit": {
          "type": "integer",
          "minimum": 1
        }
      },
      "required": [
        "sessionId"
      ],
      "additionalProperties": false
    },
    "syncSnapshotQuery": {
      "type": "object",
      "properties": {
        "sessionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "pageCursor": {
          "$ref": "#/$defs/opaqueId"
        },
        "limit": {
          "type": "integer",
          "minimum": 1
        }
      },
      "required": [
        "sessionId"
      ],
      "additionalProperties": false
    },
    "directoryCollection": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "#/$defs/opaqueId"
        },
        "canonicalUrl": {
          "$ref": "#/$defs/httpUrl"
        },
        "title": {
          "type": "string"
        },
        "summary": {
          "type": "string"
        },
        "kind": {
          "type": "string",
          "enum": [
            "bookmarks",
            "reading_path",
            "knowledge_collection",
            "mixed"
          ]
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "uniqueItems": true
        },
        "language": {
          "type": "string"
        },
        "creators": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/actor"
          },
          "maxItems": 512,
          "uniqueItems": true
        },
        "nodeCount": {
          "type": "integer",
          "minimum": 0
        },
        "updatedAt": {
          "$ref": "#/$defs/dateTime"
        },
        "visibility": {
          "$ref": "#/$defs/visibility"
        },
        "links": {
          "$ref": "#/$defs/collectionLinks"
        },
        "extensions": {
          "$ref": "#/$defs/extensions"
        }
      },
      "required": [
        "id",
        "canonicalUrl",
        "title",
        "kind",
        "nodeCount",
        "updatedAt",
        "visibility",
        "links"
      ],
      "additionalProperties": false
    },
    "collectionDirectory": {
      "type": "object",
      "properties": {
        "protocolVersion": {
          "const": "0.1"
        },
        "collections": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/directoryCollection"
          }
        },
        "nextCursor": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/opaqueId"
            }
          ]
        }
      },
      "required": [
        "protocolVersion",
        "collections",
        "nextCursor"
      ],
      "additionalProperties": false
    },
    "collectionMetadata": {
      "type": "object",
      "properties": {
        "collection": {
          "$ref": "#/$defs/collection"
        },
        "links": {
          "$ref": "#/$defs/collectionLinks"
        }
      },
      "required": [
        "collection",
        "links"
      ],
      "additionalProperties": false
    },
    "nodeIncluded": {
      "type": "object",
      "properties": {
        "annotations": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/annotation"
          }
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          }
        },
        "relations": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/relation"
          }
        }
      },
      "additionalProperties": false
    },
    "nodeDetail": {
      "type": "object",
      "properties": {
        "node": {
          "$ref": "#/$defs/node"
        },
        "included": {
          "$ref": "#/$defs/nodeIncluded"
        },
        "links": {
          "$ref": "#/$defs/collectionLinks"
        }
      },
      "required": [
        "node",
        "included"
      ],
      "additionalProperties": false
    },
    "collectionCreateRequest": {
      "$ref": "#/$defs/createCollectionOperationPayload"
    },
    "collectionCreateResult": {
      "type": "object",
      "properties": {
        "collection": {
          "$ref": "#/$defs/collection"
        },
        "root": {
          "$ref": "#/$defs/node"
        },
        "links": {
          "$ref": "#/$defs/collectionLinks"
        }
      },
      "required": [
        "collection",
        "root",
        "links"
      ],
      "additionalProperties": false
    },
    "nodeCreateRequest": {
      "$ref": "#/$defs/createNodeOperationPayload"
    },
    "nodeMoveRequest": {
      "$ref": "#/$defs/moveOperationPayload"
    },
    "nodeMoveResult": {
      "type": "object",
      "properties": {
        "node": {
          "$ref": "#/$defs/node"
        },
        "sourceParentRevision": {
          "$ref": "#/$defs/opaqueId"
        },
        "targetParentRevision": {
          "$ref": "#/$defs/opaqueId"
        },
        "position": {
          "$ref": "#/$defs/orderKey"
        },
        "warnings": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/warning"
          }
        }
      },
      "required": [
        "node",
        "sourceParentRevision",
        "targetParentRevision",
        "position",
        "warnings"
      ],
      "additionalProperties": false
    },
    "deleteResult": {
      "type": "object",
      "properties": {
        "receipt": {
          "$ref": "#/$defs/deletionReceipt"
        }
      },
      "required": [
        "receipt"
      ],
      "additionalProperties": false
    },
    "releaseCreate": {
      "type": "object",
      "properties": {
        "title": {
          "type": "string"
        },
        "summary": {
          "type": "string"
        },
        "note": {
          "type": "string"
        },
        "extensions": {
          "$ref": "#/$defs/extensions"
        }
      },
      "additionalProperties": false
    },
    "release": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "#/$defs/opaqueId"
        },
        "collectionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "revision": {
          "$ref": "#/$defs/opaqueId"
        },
        "title": {
          "type": "string"
        },
        "summary": {
          "type": "string"
        },
        "note": {
          "type": "string"
        },
        "publishedAt": {
          "$ref": "#/$defs/dateTime"
        },
        "publishedBy": {
          "$ref": "#/$defs/actor"
        },
        "snapshotUrl": {
          "$ref": "#/$defs/httpUrl"
        },
        "contentDigest": {
          "type": "string",
          "minLength": 1
        },
        "changes": {
          "$ref": "#/$defs/changeCounts"
        },
        "extensions": {
          "$ref": "#/$defs/extensions"
        }
      },
      "required": [
        "id",
        "collectionId",
        "revision",
        "publishedAt",
        "snapshotUrl",
        "contentDigest",
        "changes"
      ],
      "additionalProperties": false
    },
    "releaseLinks": {
      "type": "object",
      "properties": {
        "self": {
          "$ref": "#/$defs/httpUrl"
        },
        "snapshot": {
          "$ref": "#/$defs/httpUrl"
        },
        "collection": {
          "$ref": "#/$defs/httpUrl"
        }
      },
      "required": [
        "self",
        "snapshot",
        "collection"
      ],
      "additionalProperties": false
    },
    "releaseResult": {
      "type": "object",
      "properties": {
        "release": {
          "$ref": "#/$defs/release"
        },
        "links": {
          "$ref": "#/$defs/releaseLinks"
        }
      },
      "required": [
        "release",
        "links"
      ],
      "additionalProperties": false
    },
    "releaseDirectory": {
      "type": "object",
      "properties": {
        "protocolVersion": {
          "const": "0.1"
        },
        "releases": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/release"
          }
        },
        "nextCursor": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/opaqueId"
            }
          ]
        }
      },
      "required": [
        "protocolVersion",
        "releases",
        "nextCursor"
      ],
      "additionalProperties": false
    },
    "problemFieldError": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "minLength": 1
        },
        "keyword": {
          "type": "string",
          "minLength": 1
        },
        "message": {
          "type": "string"
        }
      },
      "required": [
        "path",
        "keyword",
        "message"
      ],
      "additionalProperties": false
    },
    "problem": {
      "type": "object",
      "properties": {
        "type": {
          "$ref": "#/$defs/absoluteUri"
        },
        "title": {
          "type": "string"
        },
        "status": {
          "type": "integer",
          "minimum": 400,
          "maximum": 599
        },
        "code": {
          "type": "string",
          "oneOf": [
            {
              "enum": [
                "invalid_json",
                "invalid_query",
                "invalid_cursor_scope",
                "authentication_required",
                "insufficient_scope",
                "node_read_only",
                "origin_not_allowed",
                "csrf_failed",
                "resource_not_found",
                "method_not_allowed",
                "unsupported_version",
                "revision_conflict",
                "position_context_stale",
                "snapshot_expired",
                "idempotency_key_reused",
                "idempotency_in_progress",
                "sequence_gap",
                "sequence_blocked",
                "sequence_reuse",
                "op_id_reused",
                "dependency_failed",
                "folder_not_empty",
                "feed_cursor_expired",
                "sync_cursor_expired",
                "stale_replica",
                "replica_retired",
                "resource_purged",
                "precondition_failed",
                "payload_too_large",
                "unsupported_media_type",
                "unsupported_operation",
                "invalid_document",
                "precondition_required",
                "rate_limited",
                "internal_error",
                "service_unavailable"
              ]
            },
            {
              "format": "uri",
              "pattern": "^[Hh][Tt][Tt][Pp][Ss]://"
            }
          ]
        },
        "detail": {
          "type": "string"
        },
        "instance": {
          "type": "string"
        },
        "currentRevision": {
          "$ref": "#/$defs/opaqueId"
        },
        "currentEtag": {
          "type": "string",
          "minLength": 1
        },
        "expectedSequence": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "supportedVersions": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "uniqueItems": true
        },
        "retryAfterSeconds": {
          "type": "integer",
          "minimum": 0
        },
        "snapshotUrl": {
          "$ref": "#/$defs/httpUrl"
        },
        "conflictId": {
          "$ref": "#/$defs/opaqueId"
        },
        "retryable": {
          "type": "boolean"
        },
        "errors": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/problemFieldError"
          }
        },
        "links": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/httpUrl"
          }
        }
      },
      "required": [
        "type",
        "title",
        "status",
        "code"
      ],
      "additionalProperties": false
    },
    "deleteOperationPayload": {
      "type": "object",
      "properties": {
        "reason": {
          "type": "string"
        }
      },
      "additionalProperties": false
    },
    "restoreOperationPayload": {
      "type": "object",
      "properties": {
        "newParentId": {
          "$ref": "#/$defs/opaqueId"
        },
        "afterId": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/opaqueId"
            }
          ]
        },
        "beforeId": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/opaqueId"
            }
          ]
        },
        "reason": {
          "type": "string"
        }
      },
      "additionalProperties": false
    },
    "operationSource": {
      "type": "object",
      "properties": {
        "adapterProfile": {
          "type": "string",
          "minLength": 1
        },
        "nativeEvent": {
          "type": "string",
          "minLength": 1
        },
        "extensions": {
          "$ref": "#/$defs/extensions"
        }
      },
      "minProperties": 1,
      "additionalProperties": false
    },
    "operation": {
      "type": "object",
      "properties": {
        "opId": {
          "$ref": "#/$defs/opaqueId"
        },
        "replicaId": {
          "$ref": "#/$defs/opaqueId"
        },
        "sequence": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "collectionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "type": {
          "type": "string",
          "enum": [
            "create_collection",
            "update_collection_metadata",
            "delete_collection",
            "restore_collection",
            "publish_release",
            "create_node",
            "update_node_content",
            "move_node",
            "reorder_children",
            "delete_node",
            "delete_subtree",
            "restore_node",
            "create_annotation",
            "update_annotation",
            "delete_annotation",
            "create_attachment",
            "update_attachment",
            "delete_attachment",
            "create_relation",
            "update_relation",
            "delete_relation"
          ]
        },
        "targetId": {
          "$ref": "#/$defs/opaqueId"
        },
        "baseRevision": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/opaqueId"
            }
          ]
        },
        "occurredAt": {
          "$ref": "#/$defs/dateTime"
        },
        "dependencies": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/opaqueId"
          },
          "uniqueItems": true
        },
        "payload": {
          "type": "object"
        },
        "source": {
          "$ref": "#/$defs/operationSource"
        }
      },
      "required": [
        "opId",
        "replicaId",
        "sequence",
        "type",
        "occurredAt",
        "payload"
      ],
      "allOf": [
        {
          "if": {
            "properties": {
              "type": {
                "const": "create_collection"
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "properties": {
              "sequence": {
                "const": 1
              },
              "collectionId": false,
              "targetId": false
            }
          },
          "else": {
            "required": [
              "collectionId"
            ]
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "enum": [
                  "create_collection",
                  "create_node",
                  "create_annotation",
                  "create_attachment",
                  "create_relation"
                ]
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "properties": {
              "baseRevision": {
                "type": "null"
              },
              "targetId": false
            },
            "required": [
              "baseRevision"
            ]
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "create_collection"
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "properties": {
              "payload": {
                "$ref": "#/$defs/createCollectionOperationPayload"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "create_node"
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "properties": {
              "payload": {
                "$ref": "#/$defs/createNodeOperationPayload"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "create_annotation"
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "properties": {
              "payload": {
                "$ref": "#/$defs/createAnnotationOperationPayload"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "create_attachment"
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "properties": {
              "payload": {
                "$ref": "#/$defs/createAttachmentOperationPayload"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "create_relation"
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "properties": {
              "payload": {
                "$ref": "#/$defs/createRelationOperationPayload"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "update_collection_metadata"
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "properties": {
              "baseRevision": {
                "$ref": "#/$defs/opaqueId"
              },
              "payload": {
                "$ref": "#/$defs/collectionMetadataUpdateOperationPayload"
              }
            },
            "required": [
              "targetId",
              "baseRevision"
            ]
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "update_node_content"
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "properties": {
              "baseRevision": {
                "$ref": "#/$defs/opaqueId"
              },
              "payload": {
                "$ref": "#/$defs/nodeContentUpdateOperationPayload"
              }
            },
            "required": [
              "targetId",
              "baseRevision"
            ]
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "update_annotation"
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "properties": {
              "baseRevision": {
                "$ref": "#/$defs/opaqueId"
              },
              "payload": {
                "$ref": "#/$defs/annotationUpdateOperationPayload"
              }
            },
            "required": [
              "targetId",
              "baseRevision"
            ]
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "update_attachment"
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "properties": {
              "baseRevision": {
                "$ref": "#/$defs/opaqueId"
              },
              "payload": {
                "$ref": "#/$defs/attachmentUpdateOperationPayload"
              }
            },
            "required": [
              "targetId",
              "baseRevision"
            ]
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "update_relation"
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "properties": {
              "baseRevision": {
                "$ref": "#/$defs/opaqueId"
              },
              "payload": {
                "$ref": "#/$defs/relationUpdateOperationPayload"
              }
            },
            "required": [
              "targetId",
              "baseRevision"
            ]
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "move_node"
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "properties": {
              "baseRevision": {
                "$ref": "#/$defs/opaqueId"
              },
              "payload": {
                "$ref": "#/$defs/moveOperationPayload"
              }
            },
            "required": [
              "targetId",
              "baseRevision"
            ]
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "reorder_children"
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "properties": {
              "baseRevision": {
                "$ref": "#/$defs/opaqueId"
              },
              "payload": {
                "$ref": "#/$defs/reorderOperationPayload"
              }
            },
            "required": [
              "targetId",
              "baseRevision"
            ]
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "enum": [
                  "delete_collection",
                  "delete_node",
                  "delete_subtree",
                  "delete_annotation",
                  "delete_attachment",
                  "delete_relation"
                ]
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "properties": {
              "baseRevision": {
                "$ref": "#/$defs/opaqueId"
              },
              "payload": {
                "$ref": "#/$defs/deleteOperationPayload"
              }
            },
            "required": [
              "targetId",
              "baseRevision"
            ]
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "enum": [
                  "restore_collection",
                  "restore_node"
                ]
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "properties": {
              "baseRevision": {
                "$ref": "#/$defs/opaqueId"
              },
              "payload": {
                "$ref": "#/$defs/restoreOperationPayload"
              }
            },
            "required": [
              "targetId",
              "baseRevision"
            ]
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "publish_release"
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "properties": {
              "baseRevision": {
                "$ref": "#/$defs/opaqueId"
              },
              "payload": {
                "$ref": "#/$defs/releaseCreate"
              }
            },
            "required": [
              "targetId",
              "baseRevision"
            ]
          }
        }
      ],
      "additionalProperties": false
    },
    "syncCollectionPush": {
      "type": "object",
      "properties": {
        "sessionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "batchId": {
          "$ref": "#/$defs/opaqueId"
        },
        "atomic": {
          "type": "boolean"
        },
        "operations": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/operation"
          },
          "not": {
            "contains": {
              "type": "object",
              "properties": {
                "type": {
                  "const": "create_collection"
                }
              },
              "required": [
                "type"
              ]
            }
          }
        }
      },
      "required": [
        "sessionId",
        "batchId",
        "atomic",
        "operations"
      ],
      "additionalProperties": false
    },
    "syncInstanceCreatePush": {
      "type": "object",
      "properties": {
        "sessionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "batchId": {
          "$ref": "#/$defs/opaqueId"
        },
        "atomic": {
          "const": true
        },
        "operations": {
          "type": "array",
          "minItems": 1,
          "maxItems": 1,
          "items": {
            "allOf": [
              {
                "$ref": "#/$defs/operation"
              },
              {
                "type": "object",
                "properties": {
                  "type": {
                    "const": "create_collection"
                  }
                },
                "required": [
                  "type"
                ]
              }
            ]
          }
        }
      },
      "required": [
        "sessionId",
        "batchId",
        "atomic",
        "operations"
      ],
      "additionalProperties": false
    },
    "syncPush": {
      "oneOf": [
        {
          "$ref": "#/$defs/syncCollectionPush"
        },
        {
          "$ref": "#/$defs/syncInstanceCreatePush"
        }
      ]
    },
    "replicaAdapter": {
      "type": "object",
      "properties": {
        "profile": {
          "type": "string",
          "minLength": 1
        },
        "version": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "profile",
        "version"
      ],
      "additionalProperties": false
    },
    "replicaCapabilities": {
      "type": "object",
      "properties": {
        "read": {
          "type": "boolean"
        },
        "write": {
          "type": "boolean"
        },
        "events": {
          "type": "boolean"
        },
        "separator": {
          "type": "boolean"
        },
        "alias": {
          "type": "boolean"
        },
        "annotations": {
          "type": "string",
          "enum": [
            "native",
            "sidecar",
            "none"
          ]
        },
        "maxBatchOperations": {
          "type": "integer",
          "minimum": 1
        }
      },
      "required": [
        "read",
        "write",
        "events",
        "separator",
        "alias",
        "annotations",
        "maxBatchOperations"
      ],
      "additionalProperties": false
    },
    "replicaBinding": {
      "type": "object",
      "properties": {
        "browserProfileId": {
          "$ref": "#/$defs/opaqueId"
        },
        "mountMode": {
          "type": "string",
          "enum": [
            "whole-profile",
            "mounted-folder"
          ]
        },
        "mountNativeId": {
          "type": [
            "string",
            "null"
          ]
        },
        "generation": {
          "$ref": "#/$defs/opaqueId"
        }
      },
      "required": [
        "browserProfileId",
        "mountMode",
        "mountNativeId",
        "generation"
      ],
      "allOf": [
        {
          "if": {
            "properties": {
              "mountMode": {
                "const": "mounted-folder"
              }
            },
            "required": [
              "mountMode"
            ]
          },
          "then": {
            "properties": {
              "mountNativeId": {
                "type": "string",
                "minLength": 1
              }
            }
          }
        }
      ],
      "additionalProperties": false
    },
    "replica": {
      "type": "object",
      "properties": {
        "replicaId": {
          "$ref": "#/$defs/opaqueId"
        },
        "name": {
          "type": "string",
          "minLength": 1
        },
        "kind": {
          "type": "string",
          "enum": [
            "browser_extension",
            "desktop_client",
            "mobile_client",
            "server",
            "importer",
            "other"
          ]
        },
        "adapter": {
          "$ref": "#/$defs/replicaAdapter"
        },
        "capabilities": {
          "$ref": "#/$defs/replicaCapabilities"
        },
        "binding": {
          "$ref": "#/$defs/replicaBinding"
        },
        "extensions": {
          "$ref": "#/$defs/extensions"
        }
      },
      "required": [
        "replicaId",
        "name",
        "kind",
        "adapter",
        "capabilities"
      ],
      "allOf": [
        {
          "if": {
            "properties": {
              "kind": {
                "const": "browser_extension"
              }
            },
            "required": [
              "kind"
            ]
          },
          "then": {
            "required": [
              "binding"
            ]
          }
        }
      ],
      "additionalProperties": false
    },
    "syncSessionCollectionRequest": {
      "type": "object",
      "properties": {
        "collectionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "lastCursor": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/opaqueId"
            }
          ]
        },
        "lastRevision": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/opaqueId"
            }
          ]
        },
        "bootstrapMode": {
          "type": "string",
          "enum": [
            "download",
            "upload",
            "merge",
            "mirror"
          ]
        }
      },
      "required": [
        "collectionId",
        "lastCursor",
        "lastRevision",
        "bootstrapMode"
      ],
      "additionalProperties": false
    },
    "syncCollectionSessionRequest": {
      "type": "object",
      "properties": {
        "protocolVersion": {
          "const": "0.1"
        },
        "replica": {
          "$ref": "#/$defs/replica"
        },
        "scope": {
          "const": "collection"
        },
        "collection": {
          "$ref": "#/$defs/syncSessionCollectionRequest"
        },
        "clientTime": {
          "$ref": "#/$defs/dateTime"
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
    "syncInstanceSessionRequest": {
      "type": "object",
      "properties": {
        "protocolVersion": {
          "const": "0.1"
        },
        "replica": {
          "$ref": "#/$defs/replica"
        },
        "scope": {
          "const": "instance"
        },
        "purpose": {
          "const": "create_collection"
        },
        "clientTime": {
          "$ref": "#/$defs/dateTime"
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
    },
    "syncSessionRequest": {
      "oneOf": [
        {
          "$ref": "#/$defs/syncCollectionSessionRequest"
        },
        {
          "$ref": "#/$defs/syncInstanceSessionRequest"
        }
      ]
    },
    "conversionPolicy": {
      "type": "object",
      "properties": {
        "alias": {
          "type": "string",
          "enum": [
            "duplicate",
            "skip",
            "reject"
          ]
        },
        "separator": {
          "type": "string",
          "enum": [
            "native",
            "omit",
            "preserve_remote",
            "reject"
          ]
        },
        "unknownExtensions": {
          "type": "string",
          "enum": [
            "preserve_remote",
            "sidecar",
            "reject"
          ]
        }
      },
      "required": [
        "alias",
        "separator",
        "unknownExtensions"
      ],
      "additionalProperties": false
    },
    "syncSessionCollectionResult": {
      "type": "object",
      "properties": {
        "collectionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "snapshotRequired": {
          "type": "boolean"
        },
        "serverCursor": {
          "$ref": "#/$defs/opaqueId"
        },
        "serverRevision": {
          "$ref": "#/$defs/opaqueId"
        }
      },
      "required": [
        "collectionId",
        "snapshotRequired",
        "serverCursor",
        "serverRevision"
      ],
      "additionalProperties": false
    },
    "replicaLease": {
      "type": "object",
      "properties": {
        "leaseId": {
          "$ref": "#/$defs/opaqueId"
        },
        "generation": {
          "$ref": "#/$defs/opaqueId"
        },
        "state": {
          "type": "string",
          "enum": [
            "active",
            "expired",
            "recovery_required",
            "retired"
          ]
        },
        "lastSeenAt": {
          "$ref": "#/$defs/dateTime"
        },
        "expiresAt": {
          "$ref": "#/$defs/dateTime"
        },
        "acknowledgedCursor": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/opaqueId"
            }
          ]
        }
      },
      "required": [
        "leaseId",
        "generation",
        "state",
        "lastSeenAt",
        "expiresAt",
        "acknowledgedCursor"
      ],
      "additionalProperties": false
    },
    "activeReplicaLease": {
      "allOf": [
        {
          "$ref": "#/$defs/replicaLease"
        },
        {
          "type": "object",
          "properties": {
            "state": {
              "const": "active"
            }
          },
          "required": [
            "state"
          ]
        }
      ]
    },
    "syncCollectionSessionResult": {
      "type": "object",
      "properties": {
        "sessionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "expiresAt": {
          "$ref": "#/$defs/dateTime"
        },
        "serverTime": {
          "$ref": "#/$defs/dateTime"
        },
        "clockSkewMilliseconds": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "acceptedProtocolVersion": {
          "const": "0.1"
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
          "$ref": "#/$defs/activeReplicaLease"
        },
        "collection": {
          "$ref": "#/$defs/syncSessionCollectionResult"
        },
        "conversionPolicy": {
          "$ref": "#/$defs/conversionPolicy"
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
    "syncInstanceSessionResult": {
      "type": "object",
      "properties": {
        "sessionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "expiresAt": {
          "$ref": "#/$defs/dateTime"
        },
        "serverTime": {
          "$ref": "#/$defs/dateTime"
        },
        "clockSkewMilliseconds": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "acceptedProtocolVersion": {
          "const": "0.1"
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
          "$ref": "#/$defs/activeReplicaLease"
        },
        "conversionPolicy": {
          "$ref": "#/$defs/conversionPolicy"
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
    },
    "syncSessionResult": {
      "oneOf": [
        {
          "$ref": "#/$defs/syncCollectionSessionResult"
        },
        {
          "$ref": "#/$defs/syncInstanceSessionResult"
        }
      ]
    },
    "operationResult": {
      "type": "object",
      "properties": {
        "opId": {
          "$ref": "#/$defs/opaqueId"
        },
        "sequence": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "status": {
          "type": "string",
          "enum": [
            "applied",
            "rebased",
            "noop",
            "conflicted",
            "rejected",
            "deferred"
          ]
        },
        "targetId": {
          "$ref": "#/$defs/opaqueId"
        },
        "revision": {
          "$ref": "#/$defs/opaqueId"
        },
        "cursor": {
          "$ref": "#/$defs/opaqueId"
        },
        "conflictId": {
          "$ref": "#/$defs/opaqueId"
        },
        "code": {
          "type": "string",
          "minLength": 1
        },
        "retryAfterSeconds": {
          "type": "integer",
          "minimum": 0
        },
        "boundCollection": {
          "$ref": "#/$defs/syncSessionCollectionResult"
        },
        "transform": {
          "type": "object"
        },
        "warnings": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/warning"
          }
        }
      },
      "required": [
        "opId",
        "sequence",
        "status",
        "warnings"
      ],
      "allOf": [
        {
          "if": {
            "properties": {
              "status": {
                "enum": [
                  "applied",
                  "rebased"
                ]
              }
            },
            "required": [
              "status"
            ]
          },
          "then": {
            "properties": {
              "conflictId": false,
              "code": false,
              "retryAfterSeconds": false
            },
            "required": [
              "revision",
              "cursor"
            ]
          }
        },
        {
          "if": {
            "properties": {
              "status": {
                "const": "conflicted"
              }
            },
            "required": [
              "status"
            ]
          },
          "then": {
            "properties": {
              "revision": false,
              "boundCollection": false,
              "code": false,
              "retryAfterSeconds": false,
              "transform": false
            },
            "required": [
              "cursor",
              "conflictId"
            ]
          }
        },
        {
          "if": {
            "properties": {
              "status": {
                "const": "noop"
              }
            },
            "required": [
              "status"
            ]
          },
          "then": {
            "properties": {
              "cursor": false,
              "conflictId": false,
              "boundCollection": false,
              "code": false,
              "retryAfterSeconds": false,
              "transform": false
            }
          }
        },
        {
          "if": {
            "properties": {
              "status": {
                "const": "rejected"
              }
            },
            "required": [
              "status"
            ]
          },
          "then": {
            "properties": {
              "revision": false,
              "cursor": false,
              "conflictId": false,
              "boundCollection": false,
              "transform": false,
              "retryAfterSeconds": false
            },
            "required": [
              "code"
            ]
          }
        },
        {
          "if": {
            "properties": {
              "status": {
                "const": "deferred"
              }
            },
            "required": [
              "status"
            ]
          },
          "then": {
            "properties": {
              "revision": false,
              "cursor": false,
              "conflictId": false,
              "boundCollection": false,
              "transform": false
            },
            "required": [
              "code"
            ]
          }
        },
        {
          "if": {
            "required": [
              "boundCollection"
            ]
          },
          "then": {
            "properties": {
              "status": {
                "const": "applied"
              }
            },
            "required": [
              "revision",
              "cursor"
            ]
          }
        }
      ],
      "additionalProperties": false
    },
    "syncPushResult": {
      "type": "object",
      "properties": {
        "batchId": {
          "$ref": "#/$defs/opaqueId"
        },
        "results": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/operationResult"
          }
        },
        "serverCursor": {
          "$ref": "#/$defs/opaqueId"
        }
      },
      "required": [
        "batchId",
        "results",
        "serverCursor"
      ],
      "additionalProperties": false
    },
    "conflict": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "#/$defs/opaqueId"
        },
        "collectionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "targetId": {
          "$ref": "#/$defs/opaqueId"
        },
        "type": {
          "type": "string",
          "minLength": 1
        },
        "field": {
          "type": "string",
          "minLength": 1
        },
        "base": true,
        "server": true,
        "incoming": true,
        "incomingOpId": {
          "$ref": "#/$defs/opaqueId"
        },
        "createdAt": {
          "$ref": "#/$defs/dateTime"
        },
        "status": {
          "type": "string",
          "enum": [
            "open",
            "resolved"
          ]
        },
        "allowedResolutions": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "string",
            "enum": [
              "server",
              "incoming",
              "custom",
              "both"
            ]
          },
          "uniqueItems": true
        },
        "revision": {
          "$ref": "#/$defs/opaqueId"
        }
      },
      "required": [
        "id",
        "collectionId",
        "targetId",
        "type",
        "createdAt",
        "status",
        "allowedResolutions",
        "revision"
      ],
      "additionalProperties": false
    },
    "syncPullEvent": {
      "type": "object",
      "properties": {
        "cursor": {
          "$ref": "#/$defs/opaqueId"
        },
        "kind": {
          "type": "string",
          "enum": [
            "operation",
            "conflict"
          ]
        },
        "operation": {
          "$ref": "#/$defs/operation"
        },
        "conflict": {
          "$ref": "#/$defs/conflict"
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
              "operation"
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
              "required": [
                "operation"
              ]
            }
          }
        }
      ],
      "additionalProperties": false
    },
    "syncPull": {
      "type": "object",
      "properties": {
        "events": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/syncPullEvent"
          }
        },
        "nextCursor": {
          "$ref": "#/$defs/opaqueId"
        },
        "hasMore": {
          "type": "boolean"
        },
        "collectionRevision": {
          "$ref": "#/$defs/opaqueId"
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
    "syncAckRequest": {
      "type": "object",
      "properties": {
        "sessionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "cursor": {
          "$ref": "#/$defs/opaqueId"
        },
        "recoveryCapability": {
          "$ref": "#/$defs/opaqueId"
        },
        "warnings": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/warning"
          }
        }
      },
      "required": [
        "sessionId",
        "cursor",
        "warnings"
      ],
      "additionalProperties": false
    },
    "syncAckResult": {
      "type": "object",
      "properties": {
        "replicaId": {
          "$ref": "#/$defs/opaqueId"
        },
        "ackedCursor": {
          "$ref": "#/$defs/opaqueId"
        },
        "ackedAt": {
          "$ref": "#/$defs/dateTime"
        }
      },
      "required": [
        "replicaId",
        "ackedCursor",
        "ackedAt"
      ],
      "additionalProperties": false
    },
    "conflictResolutionRequest": {
      "type": "object",
      "properties": {
        "resolution": {
          "type": "string",
          "enum": [
            "server",
            "incoming",
            "custom",
            "both"
          ]
        },
        "value": true,
        "baseConflictRevision": {
          "$ref": "#/$defs/opaqueId"
        }
      },
      "required": [
        "resolution",
        "baseConflictRevision"
      ],
      "allOf": [
        {
          "if": {
            "properties": {
              "resolution": {
                "const": "custom"
              }
            },
            "required": [
              "resolution"
            ]
          },
          "then": {
            "required": [
              "value"
            ]
          },
          "else": {
            "not": {
              "required": [
                "value"
              ]
            }
          }
        }
      ],
      "additionalProperties": false
    },
    "conflictResolutionResult": {
      "type": "object",
      "properties": {
        "conflict": {
          "$ref": "#/$defs/conflict"
        },
        "operation": {
          "$ref": "#/$defs/operation"
        },
        "cursor": {
          "$ref": "#/$defs/opaqueId"
        }
      },
      "required": [
        "conflict",
        "operation",
        "cursor"
      ],
      "additionalProperties": false
    },
    "conversionPreview": {
      "type": "object",
      "properties": {
        "creates": {
          "type": "integer",
          "minimum": 0
        },
        "updates": {
          "type": "integer",
          "minimum": 0
        },
        "moves": {
          "type": "integer",
          "minimum": 0
        },
        "deletes": {
          "type": "integer",
          "minimum": 0
        },
        "sidecarOnly": {
          "type": "integer",
          "minimum": 0
        },
        "lossy": {
          "type": "integer",
          "minimum": 0
        },
        "warnings": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/warning"
          }
        }
      },
      "required": [
        "creates",
        "updates",
        "moves",
        "deletes",
        "sidecarOnly",
        "lossy",
        "warnings"
      ],
      "additionalProperties": false
    },
    "scopeName": {
      "type": "string",
      "enum": [
        "collections:list",
        "collections:read",
        "nodes:read",
        "annotations:read",
        "attachments:read",
        "relations:read",
        "source_refs:read",
        "feed:read",
        "audit:read",
        "collections:create",
        "collections:write",
        "collections:delete",
        "nodes:write",
        "nodes:delete",
        "annotations:write",
        "attachments:write",
        "relations:write",
        "release:publish",
        "sync:bootstrap",
        "sync:pull",
        "sync:push",
        "sync:resolve",
        "access:read",
        "access:write",
        "keys:read",
        "keys:write",
        "rate_limits:read",
        "rate_limits:write",
        "server:admin"
      ]
    },
    "principalRef": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "enum": [
            "user",
            "group",
            "oauth_client",
            "api_key",
            "service",
            "ai_agent",
            "public"
          ]
        },
        "id": {
          "$ref": "#/$defs/principalId"
        }
      },
      "required": [
        "type",
        "id"
      ],
      "additionalProperties": false
    },
    "accessEntry": {
      "type": "object",
      "properties": {
        "principal": {
          "$ref": "#/$defs/principalRef"
        },
        "effect": {
          "type": "string",
          "enum": [
            "allow",
            "deny"
          ]
        },
        "scopes": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/scopeName"
          },
          "uniqueItems": true
        }
      },
      "required": [
        "principal",
        "effect",
        "scopes"
      ],
      "additionalProperties": false
    },
    "accessPublicationPolicy": {
      "type": "object",
      "properties": {
        "listInDirectory": {
          "type": "boolean"
        },
        "allowSearchIndexing": {
          "type": "boolean"
        },
        "allowEmbedding": {
          "type": "boolean"
        }
      },
      "required": [
        "listInDirectory",
        "allowSearchIndexing",
        "allowEmbedding"
      ],
      "additionalProperties": false
    },
    "accessPolicy": {
      "type": "object",
      "properties": {
        "visibility": {
          "$ref": "#/$defs/visibility"
        },
        "entries": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/accessEntry"
          }
        },
        "publication": {
          "$ref": "#/$defs/accessPublicationPolicy"
        },
        "revision": {
          "$ref": "#/$defs/opaqueId"
        }
      },
      "required": [
        "visibility",
        "entries",
        "publication",
        "revision"
      ],
      "additionalProperties": false
    },
    "accessPolicyPatch": {
      "type": "object",
      "properties": {
        "visibility": {
          "$ref": "#/$defs/visibility"
        },
        "entries": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/accessEntry"
          }
        },
        "publication": {
          "$ref": "#/$defs/accessPublicationPolicy"
        }
      },
      "minProperties": 1,
      "additionalProperties": false
    },
    "apiKeyMetadata": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "#/$defs/opaqueId"
        },
        "name": {
          "type": "string",
          "minLength": 1
        },
        "type": {
          "type": "string",
          "enum": [
            "read_key",
            "sync_key",
            "publisher_key",
            "admin_key",
            "one_time_key"
          ]
        },
        "scopes": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/scopeName"
          },
          "uniqueItems": true
        },
        "collections": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/opaqueId"
          },
          "uniqueItems": true
        },
        "createdAt": {
          "$ref": "#/$defs/dateTime"
        },
        "expiresAt": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/dateTime"
            }
          ]
        },
        "lastUsedAt": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/dateTime"
            }
          ]
        },
        "lastUsedIp": {
          "type": [
            "string",
            "null"
          ]
        },
        "status": {
          "type": "string",
          "enum": [
            "active",
            "rotating",
            "revoked",
            "expired"
          ]
        }
      },
      "required": [
        "id",
        "name",
        "type",
        "scopes",
        "collections",
        "createdAt",
        "expiresAt",
        "lastUsedAt",
        "lastUsedIp",
        "status"
      ],
      "additionalProperties": false
    },
    "apiKeyCreateRequest": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "minLength": 1
        },
        "type": {
          "type": "string",
          "enum": [
            "read_key",
            "sync_key",
            "publisher_key",
            "admin_key",
            "one_time_key"
          ]
        },
        "scopes": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/scopeName"
          },
          "uniqueItems": true
        },
        "collections": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/opaqueId"
          },
          "uniqueItems": true
        },
        "expiresAt": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/dateTime"
            }
          ]
        }
      },
      "required": [
        "name",
        "type",
        "scopes",
        "collections",
        "expiresAt"
      ],
      "additionalProperties": false
    },
    "apiKeyCreateResult": {
      "type": "object",
      "properties": {
        "key": {
          "$ref": "#/$defs/apiKeyMetadata"
        },
        "secret": {
          "type": "string",
          "minLength": 16,
          "writeOnly": true
        }
      },
      "required": [
        "key",
        "secret"
      ],
      "additionalProperties": false
    },
    "apiKeyRotateRequest": {
      "type": "object",
      "properties": {
        "overlapSeconds": {
          "type": "integer",
          "minimum": 0
        }
      },
      "required": [
        "overlapSeconds"
      ],
      "additionalProperties": false
    },
    "apiKeyRotateResult": {
      "$ref": "#/$defs/apiKeyCreateResult"
    },
    "apiKeyRevokeResult": {
      "type": "object",
      "properties": {
        "key": {
          "$ref": "#/$defs/apiKeyMetadata"
        },
        "revokedAt": {
          "$ref": "#/$defs/dateTime"
        }
      },
      "required": [
        "key",
        "revokedAt"
      ],
      "additionalProperties": false
    },
    "apiKeyDirectory": {
      "type": "object",
      "properties": {
        "keys": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/apiKeyMetadata"
          }
        },
        "nextCursor": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/opaqueId"
            }
          ]
        }
      },
      "required": [
        "keys",
        "nextCursor"
      ],
      "additionalProperties": false
    },
    "rateLimitScope": {
      "type": "object",
      "properties": {
        "endpointClass": {
          "type": "string",
          "minLength": 1
        },
        "principalType": {
          "type": "string",
          "minLength": 1
        },
        "collectionId": {
          "$ref": "#/$defs/opaqueId"
        }
      },
      "minProperties": 1,
      "additionalProperties": false
    },
    "rateLimitPolicy": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "#/$defs/principalId"
        },
        "scope": {
          "$ref": "#/$defs/rateLimitScope"
        },
        "limit": {
          "type": "integer",
          "minimum": 1
        },
        "windowSeconds": {
          "type": "integer",
          "minimum": 1
        },
        "burst": {
          "type": "integer",
          "minimum": 0
        },
        "concurrency": {
          "type": "integer",
          "minimum": 1
        },
        "minIntervalMilliseconds": {
          "type": "integer",
          "minimum": 0
        },
        "action": {
          "type": "string",
          "enum": [
            "reject",
            "delay"
          ]
        },
        "revision": {
          "$ref": "#/$defs/opaqueId"
        }
      },
      "required": [
        "id",
        "scope",
        "limit",
        "windowSeconds",
        "burst",
        "concurrency",
        "minIntervalMilliseconds",
        "action",
        "revision"
      ],
      "additionalProperties": false
    },
    "rateLimitPolicyPatch": {
      "type": "object",
      "properties": {
        "scope": {
          "$ref": "#/$defs/rateLimitScope"
        },
        "limit": {
          "type": "integer",
          "minimum": 1
        },
        "windowSeconds": {
          "type": "integer",
          "minimum": 1
        },
        "burst": {
          "type": "integer",
          "minimum": 0
        },
        "concurrency": {
          "type": "integer",
          "minimum": 1
        },
        "minIntervalMilliseconds": {
          "type": "integer",
          "minimum": 0
        },
        "action": {
          "type": "string",
          "enum": [
            "reject",
            "delay"
          ]
        }
      },
      "minProperties": 1,
      "additionalProperties": false
    },
    "rateLimitPolicyUpdateRequest": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "#/$defs/principalId"
        },
        "patch": {
          "$ref": "#/$defs/rateLimitPolicyPatch"
        }
      },
      "required": [
        "id",
        "patch"
      ],
      "additionalProperties": false
    },
    "rateLimitDirectory": {
      "type": "object",
      "properties": {
        "policies": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/rateLimitPolicy"
          }
        }
      },
      "required": [
        "policies"
      ],
      "additionalProperties": false
    },
    "auditActor": {
      "type": "object",
      "properties": {
        "principalId": {
          "$ref": "#/$defs/principalId"
        },
        "clientId": {
          "$ref": "#/$defs/absoluteUri"
        },
        "agent": {
          "type": "string"
        }
      },
      "required": [
        "principalId"
      ],
      "additionalProperties": false
    },
    "auditConfirmation": {
      "type": "object",
      "properties": {
        "required": {
          "type": "boolean"
        },
        "method": {
          "type": "string"
        },
        "confirmedAt": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/dateTime"
            }
          ]
        }
      },
      "required": [
        "required",
        "method",
        "confirmedAt"
      ],
      "additionalProperties": false
    },
    "auditEvent": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "#/$defs/opaqueId"
        },
        "time": {
          "$ref": "#/$defs/dateTime"
        },
        "actor": {
          "$ref": "#/$defs/auditActor"
        },
        "action": {
          "type": "string",
          "minLength": 1
        },
        "target": {
          "type": "string",
          "minLength": 1
        },
        "result": {
          "type": "string",
          "enum": [
            "success",
            "failure",
            "denied"
          ]
        },
        "risk": {
          "type": "string",
          "enum": [
            "low",
            "medium",
            "high"
          ]
        },
        "confirmation": {
          "$ref": "#/$defs/auditConfirmation"
        },
        "metadata": {
          "type": "object"
        }
      },
      "required": [
        "id",
        "time",
        "actor",
        "action",
        "target",
        "result",
        "risk"
      ],
      "additionalProperties": false
    },
    "auditDirectory": {
      "type": "object",
      "properties": {
        "events": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/auditEvent"
          }
        },
        "nextCursor": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/opaqueId"
            }
          ]
        }
      },
      "required": [
        "events",
        "nextCursor"
      ],
      "additionalProperties": false
    },
    "visibilityPlanInput": {
      "type": "object",
      "properties": {
        "visibility": {
          "$ref": "#/$defs/visibility"
        }
      },
      "required": [
        "visibility"
      ],
      "additionalProperties": false
    },
    "deleteCollectionPlanOperation": {
      "type": "object",
      "properties": {
        "type": {
          "const": "delete_collection"
        },
        "collectionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "baseRevision": {
          "$ref": "#/$defs/opaqueId"
        }
      },
      "required": [
        "type",
        "collectionId",
        "baseRevision"
      ],
      "additionalProperties": false
    },
    "deleteSubtreePlanOperation": {
      "type": "object",
      "properties": {
        "type": {
          "const": "delete_subtree"
        },
        "collectionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "targetId": {
          "$ref": "#/$defs/opaqueId"
        },
        "baseRevision": {
          "$ref": "#/$defs/opaqueId"
        }
      },
      "required": [
        "type",
        "collectionId",
        "targetId",
        "baseRevision"
      ],
      "additionalProperties": false
    },
    "setVisibilityPlanOperation": {
      "type": "object",
      "properties": {
        "type": {
          "const": "set_visibility"
        },
        "collectionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "baseRevision": {
          "$ref": "#/$defs/opaqueId"
        },
        "input": {
          "$ref": "#/$defs/visibilityPlanInput"
        }
      },
      "required": [
        "type",
        "collectionId",
        "baseRevision",
        "input"
      ],
      "additionalProperties": false
    },
    "setAccessPolicyPlanOperation": {
      "type": "object",
      "properties": {
        "type": {
          "const": "set_access_policy"
        },
        "collectionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "baseRevision": {
          "$ref": "#/$defs/opaqueId"
        },
        "input": {
          "$ref": "#/$defs/accessPolicyPatch"
        }
      },
      "required": [
        "type",
        "collectionId",
        "baseRevision",
        "input"
      ],
      "additionalProperties": false
    },
    "createKeyPlanOperation": {
      "type": "object",
      "properties": {
        "type": {
          "const": "create_key"
        },
        "input": {
          "$ref": "#/$defs/apiKeyCreateRequest"
        }
      },
      "required": [
        "type",
        "input"
      ],
      "additionalProperties": false
    },
    "rotateKeyPlanOperation": {
      "type": "object",
      "properties": {
        "type": {
          "const": "rotate_key"
        },
        "targetId": {
          "$ref": "#/$defs/opaqueId"
        },
        "input": {
          "$ref": "#/$defs/apiKeyRotateRequest"
        }
      },
      "required": [
        "type",
        "targetId",
        "input"
      ],
      "additionalProperties": false
    },
    "revokeKeyPlanOperation": {
      "type": "object",
      "properties": {
        "type": {
          "const": "revoke_key"
        },
        "targetId": {
          "$ref": "#/$defs/opaqueId"
        }
      },
      "required": [
        "type",
        "targetId"
      ],
      "additionalProperties": false
    },
    "setRateLimitPlanOperation": {
      "type": "object",
      "properties": {
        "type": {
          "const": "set_rate_limit"
        },
        "targetId": {
          "$ref": "#/$defs/principalId"
        },
        "baseRevision": {
          "$ref": "#/$defs/opaqueId"
        },
        "input": {
          "$ref": "#/$defs/rateLimitPolicyPatch"
        }
      },
      "required": [
        "type",
        "targetId",
        "baseRevision",
        "input"
      ],
      "additionalProperties": false
    },
    "publishReleasePlanOperation": {
      "type": "object",
      "properties": {
        "type": {
          "const": "publish_release"
        },
        "collectionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "baseRevision": {
          "$ref": "#/$defs/opaqueId"
        },
        "input": {
          "$ref": "#/$defs/releaseCreate"
        }
      },
      "required": [
        "type",
        "collectionId",
        "baseRevision",
        "input"
      ],
      "additionalProperties": false
    },
    "syncMirrorPlanInput": {
      "type": "object",
      "properties": {
        "replicaId": {
          "$ref": "#/$defs/opaqueId"
        }
      },
      "required": [
        "replicaId"
      ],
      "additionalProperties": false
    },
    "syncMirrorPlanOperation": {
      "type": "object",
      "properties": {
        "type": {
          "const": "sync_mirror"
        },
        "collectionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "baseRevision": {
          "$ref": "#/$defs/opaqueId"
        },
        "input": {
          "$ref": "#/$defs/syncMirrorPlanInput"
        }
      },
      "required": [
        "type",
        "collectionId",
        "baseRevision",
        "input"
      ],
      "additionalProperties": false
    },
    "changePlanOperation": {
      "oneOf": [
        {
          "$ref": "#/$defs/deleteCollectionPlanOperation"
        },
        {
          "$ref": "#/$defs/deleteSubtreePlanOperation"
        },
        {
          "$ref": "#/$defs/setVisibilityPlanOperation"
        },
        {
          "$ref": "#/$defs/setAccessPolicyPlanOperation"
        },
        {
          "$ref": "#/$defs/createKeyPlanOperation"
        },
        {
          "$ref": "#/$defs/rotateKeyPlanOperation"
        },
        {
          "$ref": "#/$defs/revokeKeyPlanOperation"
        },
        {
          "$ref": "#/$defs/setRateLimitPlanOperation"
        },
        {
          "$ref": "#/$defs/publishReleasePlanOperation"
        },
        {
          "$ref": "#/$defs/syncMirrorPlanOperation"
        }
      ]
    },
    "changePlanRequest": {
      "type": "object",
      "properties": {
        "operations": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/changePlanOperation"
          }
        },
        "reason": {
          "type": "string",
          "minLength": 1
        },
        "dryRun": {
          "const": true
        }
      },
      "required": [
        "operations",
        "reason",
        "dryRun"
      ],
      "additionalProperties": false
    },
    "changePlanImpact": {
      "type": "object",
      "properties": {
        "collections": {
          "type": "integer",
          "minimum": 0
        },
        "nodes": {
          "type": "integer",
          "minimum": 0
        },
        "annotations": {
          "type": "integer",
          "minimum": 0
        },
        "attachments": {
          "type": "integer",
          "minimum": 0
        },
        "relations": {
          "type": "integer",
          "minimum": 0
        },
        "privateFieldsExcluded": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "uniqueItems": true
        }
      },
      "required": [
        "collections",
        "nodes",
        "annotations",
        "attachments",
        "relations",
        "privateFieldsExcluded"
      ],
      "additionalProperties": false
    },
    "changePlan": {
      "type": "object",
      "properties": {
        "planId": {
          "$ref": "#/$defs/opaqueId"
        },
        "expiresAt": {
          "$ref": "#/$defs/dateTime"
        },
        "risk": {
          "type": "string",
          "enum": [
            "low",
            "medium",
            "high"
          ]
        },
        "requiresApproval": {
          "type": "boolean"
        },
        "approvalMethod": {
          "type": "string"
        },
        "approvalUri": {
          "$ref": "#/$defs/httpUrl"
        },
        "approvedBy": {
          "type": "string",
          "enum": [
            "user",
            "policy"
          ]
        },
        "summary": {
          "type": "string"
        },
        "impact": {
          "$ref": "#/$defs/changePlanImpact"
        },
        "requiredScopes": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/scopeName"
          },
          "uniqueItems": true
        },
        "baseRevisions": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/opaqueId"
          }
        }
      },
      "required": [
        "planId",
        "expiresAt",
        "risk",
        "requiresApproval",
        "summary",
        "impact",
        "requiredScopes",
        "baseRevisions"
      ],
      "allOf": [
        {
          "if": {
            "properties": {
              "requiresApproval": {
                "const": true
              }
            },
            "required": [
              "requiresApproval"
            ]
          },
          "then": {
            "required": [
              "approvalMethod",
              "approvalUri"
            ]
          }
        }
      ],
      "additionalProperties": false
    },
    "changeCommitRequest": {
      "type": "object",
      "properties": {
        "planId": {
          "$ref": "#/$defs/opaqueId"
        }
      },
      "required": [
        "planId"
      ],
      "additionalProperties": false
    },
    "changeCommitResult": {
      "type": "object",
      "properties": {
        "planId": {
          "$ref": "#/$defs/opaqueId"
        },
        "committedAt": {
          "$ref": "#/$defs/dateTime"
        },
        "operations": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/operationResult"
          }
        }
      },
      "required": [
        "planId",
        "committedAt",
        "operations"
      ],
      "additionalProperties": false
    },
    "profileName": {
      "type": "string",
      "enum": [
        "core",
        "publication",
        "feed",
        "publisher",
        "sync",
        "mcp-read",
        "mcp-write"
      ]
    },
    "manifestEndpoints": {
      "type": "object",
      "properties": {
        "directory": {
          "$ref": "#/$defs/httpsUriTemplate"
        },
        "collection": {
          "$ref": "#/$defs/httpsUriTemplate"
        },
        "snapshot": {
          "$ref": "#/$defs/httpsUriTemplate"
        },
        "node": {
          "$ref": "#/$defs/httpsUriTemplate"
        },
        "nodes": {
          "$ref": "#/$defs/httpsUriTemplate"
        },
        "nodeMove": {
          "$ref": "#/$defs/httpsUriTemplate"
        },
        "annotations": {
          "$ref": "#/$defs/httpsUriTemplate"
        },
        "annotation": {
          "$ref": "#/$defs/httpsUriTemplate"
        },
        "attachments": {
          "$ref": "#/$defs/httpsUriTemplate"
        },
        "attachment": {
          "$ref": "#/$defs/httpsUriTemplate"
        },
        "relations": {
          "$ref": "#/$defs/httpsUriTemplate"
        },
        "relation": {
          "$ref": "#/$defs/httpsUriTemplate"
        },
        "release": {
          "$ref": "#/$defs/httpsUriTemplate"
        },
        "releases": {
          "$ref": "#/$defs/httpsUriTemplate"
        },
        "releaseItem": {
          "$ref": "#/$defs/httpsUriTemplate"
        },
        "releaseSnapshot": {
          "$ref": "#/$defs/httpsUriTemplate"
        },
        "collectionAccess": {
          "$ref": "#/$defs/httpsUriTemplate"
        },
        "instanceFeed": {
          "$ref": "#/$defs/httpsUriTemplate"
        },
        "collectionFeed": {
          "$ref": "#/$defs/httpsUriTemplate"
        },
        "syncSessions": {
          "$ref": "#/$defs/httpsUriTemplate"
        },
        "syncSnapshot": {
          "$ref": "#/$defs/httpsUriTemplate"
        },
        "syncPush": {
          "$ref": "#/$defs/httpsUriTemplate"
        },
        "syncPull": {
          "$ref": "#/$defs/httpsUriTemplate"
        },
        "syncAck": {
          "$ref": "#/$defs/httpsUriTemplate"
        },
        "syncConflict": {
          "$ref": "#/$defs/httpsUriTemplate"
        },
        "mcp": {
          "$ref": "#/$defs/httpsUriTemplate"
        },
        "adminAccess": {
          "$ref": "#/$defs/httpsUriTemplate"
        },
        "adminKeys": {
          "$ref": "#/$defs/httpsUriTemplate"
        },
        "adminKey": {
          "$ref": "#/$defs/httpsUriTemplate"
        },
        "adminKeyRotate": {
          "$ref": "#/$defs/httpsUriTemplate"
        },
        "adminRateLimits": {
          "$ref": "#/$defs/httpsUriTemplate"
        },
        "adminAudit": {
          "$ref": "#/$defs/httpsUriTemplate"
        }
      },
      "additionalProperties": false
    },
    "manifestFeatures": {
      "type": "object",
      "properties": {
        "feed": {
          "type": "object",
          "properties": {
            "modes": {
              "type": "array",
              "minItems": 1,
              "items": {
                "type": "string",
                "enum": [
                  "live",
                  "release"
                ]
              },
              "uniqueItems": true
            }
          },
          "required": [
            "modes"
          ],
          "additionalProperties": false
        },
        "patch": {
          "type": "object",
          "properties": {
            "mediaTypes": {
              "type": "array",
              "minItems": 1,
              "items": {
                "type": "string",
                "enum": [
                  "application/merge-patch+json",
                  "application/json-patch+json"
                ]
              },
              "uniqueItems": true
            }
          },
          "required": [
            "mediaTypes"
          ],
          "additionalProperties": false
        },
        "bookmarkUrls": {
          "type": "object",
          "properties": {
            "acceptedSchemes": {
              "type": "array",
              "minItems": 2,
              "items": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9+.-]*$"
              },
              "allOf": [
                {
                  "contains": {
                    "const": "http"
                  }
                },
                {
                  "contains": {
                    "const": "https"
                  }
                }
              ],
              "uniqueItems": true
            }
          },
          "required": [
            "acceptedSchemes"
          ],
          "additionalProperties": false
        },
        "sync": {
          "type": "object",
          "properties": {
            "multiCollectionSessions": {
              "type": "boolean"
            }
          },
          "required": [
            "multiCollectionSessions"
          ],
          "additionalProperties": false
        },
        "mcp": {
          "type": "object",
          "properties": {
            "protocolVersion": {
              "const": "2026-07-28"
            },
            "resources": {
              "type": "boolean"
            },
            "tools": {
              "type": "boolean"
            }
          },
          "required": [
            "protocolVersion",
            "resources",
            "tools"
          ],
          "additionalProperties": false
        },
        "admin": {
          "type": "object",
          "properties": {
            "access": {
              "type": "boolean"
            },
            "keys": {
              "type": "boolean"
            },
            "rateLimits": {
              "type": "boolean"
            },
            "audit": {
              "type": "boolean"
            }
          },
          "required": [
            "access",
            "keys",
            "rateLimits",
            "audit"
          ],
          "additionalProperties": false
        }
      },
      "additionalProperties": false
    },
    "manifestAuth": {
      "type": "object",
      "properties": {
        "anonymousRead": {
          "type": "boolean"
        },
        "apiKeys": {
          "type": "boolean"
        },
        "oauth": {
          "type": "boolean"
        },
        "protectedResourceMetadata": {
          "$ref": "#/$defs/serviceUrl"
        }
      },
      "required": [
        "anonymousRead",
        "apiKeys",
        "oauth"
      ],
      "allOf": [
        {
          "if": {
            "properties": {
              "oauth": {
                "const": true
              }
            },
            "required": [
              "oauth"
            ]
          },
          "then": {
            "required": [
              "protectedResourceMetadata"
            ]
          }
        }
      ],
      "additionalProperties": false
    },
    "manifestLimits": {
      "type": "object",
      "properties": {
        "maxPageSize": {
          "type": "integer",
          "minimum": 1
        },
        "maxSnapshotNodes": {
          "type": "integer",
          "minimum": 1
        },
        "minPollIntervalSeconds": {
          "type": "integer",
          "minimum": 0
        },
        "recommendedPollIntervalSeconds": {
          "type": "integer",
          "minimum": 0
        },
        "maxSyncBatchOperations": {
          "type": "integer",
          "minimum": 1
        },
        "idempotencyRetentionSeconds": {
          "type": "integer",
          "minimum": 1
        },
        "syncCursorRetentionSeconds": {
          "type": "integer",
          "minimum": 1
        }
      },
      "required": [
        "maxPageSize",
        "maxSnapshotNodes",
        "minPollIntervalSeconds",
        "recommendedPollIntervalSeconds"
      ],
      "additionalProperties": false
    },
    "manifestMount": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "#/$defs/opaqueId"
        },
        "baseUrl": {
          "allOf": [
            {
              "$ref": "#/$defs/serviceUrl"
            },
            {
              "pattern": "/$"
            }
          ]
        },
        "profiles": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/profileName"
          },
          "contains": {
            "const": "core"
          },
          "uniqueItems": true
        },
        "endpoints": {
          "$ref": "#/$defs/manifestEndpoints"
        },
        "features": {
          "$ref": "#/$defs/manifestFeatures"
        },
        "auth": {
          "$ref": "#/$defs/manifestAuth"
        },
        "limits": {
          "$ref": "#/$defs/manifestLimits"
        }
      },
      "required": [
        "id",
        "baseUrl",
        "profiles",
        "endpoints",
        "features",
        "auth",
        "limits"
      ],
      "allOf": [
        {
          "if": {
            "properties": {
              "profiles": {
                "contains": {
                  "const": "publication"
                }
              }
            },
            "required": [
              "profiles"
            ]
          },
          "then": {
            "properties": {
              "endpoints": {
                "required": [
                  "directory",
                  "collection",
                  "snapshot"
                ]
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "profiles": {
                "contains": {
                  "const": "feed"
                }
              }
            },
            "required": [
              "profiles"
            ]
          },
          "then": {
            "properties": {
              "profiles": {
                "contains": {
                  "const": "publication"
                }
              },
              "endpoints": {
                "required": [
                  "instanceFeed",
                  "collectionFeed"
                ]
              },
              "features": {
                "required": [
                  "feed"
                ]
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "profiles": {
                "contains": {
                  "const": "publisher"
                }
              }
            },
            "required": [
              "profiles"
            ]
          },
          "then": {
            "properties": {
              "profiles": {
                "contains": {
                  "const": "publication"
                }
              },
              "features": {
                "required": [
                  "patch"
                ]
              },
              "limits": {
                "required": [
                  "idempotencyRetentionSeconds"
                ]
              },
              "endpoints": {
                "required": [
                  "nodes",
                  "node",
                  "nodeMove",
                  "annotations",
                  "annotation",
                  "attachments",
                  "attachment",
                  "relations",
                  "relation",
                  "release",
                  "releases",
                  "releaseItem",
                  "releaseSnapshot"
                ]
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "profiles": {
                "contains": {
                  "const": "sync"
                }
              }
            },
            "required": [
              "profiles"
            ]
          },
          "then": {
            "properties": {
              "endpoints": {
                "required": [
                  "syncSessions",
                  "syncSnapshot",
                  "syncPush",
                  "syncPull",
                  "syncAck",
                  "syncConflict"
                ]
              },
              "features": {
                "required": [
                  "sync"
                ]
              },
              "limits": {
                "required": [
                  "maxSyncBatchOperations",
                  "syncCursorRetentionSeconds"
                ]
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "profiles": {
                "contains": {
                  "enum": [
                    "mcp-read",
                    "mcp-write"
                  ]
                }
              }
            },
            "required": [
              "profiles"
            ]
          },
          "then": {
            "properties": {
              "endpoints": {
                "required": [
                  "mcp"
                ]
              },
              "features": {
                "required": [
                  "mcp"
                ],
                "properties": {
                  "mcp": {
                    "properties": {
                      "resources": {
                        "const": true
                      }
                    }
                  }
                }
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "profiles": {
                "contains": {
                  "const": "mcp-write"
                }
              }
            },
            "required": [
              "profiles"
            ]
          },
          "then": {
            "properties": {
              "profiles": {
                "allOf": [
                  {
                    "contains": {
                      "const": "mcp-read"
                    }
                  },
                  {
                    "contains": {
                      "const": "publisher"
                    }
                  }
                ]
              },
              "features": {
                "required": [
                  "mcp"
                ],
                "properties": {
                  "mcp": {
                    "properties": {
                      "tools": {
                        "const": true
                      }
                    }
                  }
                }
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "features": {
                "required": [
                  "admin"
                ]
              }
            },
            "required": [
              "features"
            ]
          },
          "then": {
            "properties": {
              "endpoints": {
                "required": [
                  "adminAccess",
                  "adminKeys",
                  "adminKey",
                  "adminKeyRotate",
                  "adminRateLimits",
                  "adminAudit"
                ]
              }
            }
          }
        }
      ],
      "patternProperties": {
        "^https://[A-Za-z0-9.-]+(?:/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$": {}
      },
      "additionalProperties": false
    },
    "manifestSigning": {
      "type": "object",
      "properties": {
        "httpMessageSignatures": {
          "type": "boolean"
        },
        "jwksUrl": {
          "$ref": "#/$defs/serviceUrl"
        }
      },
      "required": [
        "httpMessageSignatures"
      ],
      "allOf": [
        {
          "if": {
            "properties": {
              "httpMessageSignatures": {
                "const": true
              }
            },
            "required": [
              "httpMessageSignatures"
            ]
          },
          "then": {
            "required": [
              "jwksUrl"
            ]
          }
        }
      ],
      "additionalProperties": false
    },
    "manifest": {
      "type": "object",
      "properties": {
        "protocol": {
          "const": "https://know-n.com/colp/spec/0.1"
        },
        "protocolVersions": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "string",
            "pattern": "^[0-9]+\\.[0-9]+$",
            "not": {
              "pattern": "[^0-9.]"
            }
          },
          "contains": {
            "const": "0.1"
          },
          "uniqueItems": true
        },
        "serverId": {
          "$ref": "#/$defs/serviceUrl"
        },
        "serverUuid": {
          "$ref": "#/$defs/opaqueId"
        },
        "title": {
          "type": "string"
        },
        "mounts": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/manifestMount"
          }
        },
        "signing": {
          "$ref": "#/$defs/manifestSigning"
        }
      },
      "required": [
        "protocol",
        "protocolVersions",
        "serverId",
        "serverUuid",
        "title",
        "mounts"
      ],
      "additionalProperties": false
    },
    "changeCounts": {
      "type": "object",
      "properties": {
        "created": {
          "type": "integer",
          "minimum": 0
        },
        "updated": {
          "type": "integer",
          "minimum": 0
        },
        "moved": {
          "type": "integer",
          "minimum": 0
        },
        "deleted": {
          "type": "integer",
          "minimum": 0
        }
      },
      "required": [
        "created",
        "updated",
        "moved",
        "deleted"
      ],
      "additionalProperties": false
    },
    "feedNode": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "#/$defs/opaqueId"
        },
        "kind": {
          "type": "string",
          "enum": [
            "folder",
            "bookmark",
            "separator",
            "alias"
          ]
        },
        "title": {
          "type": "string"
        },
        "url": {
          "$ref": "#/$defs/httpUrl"
        },
        "targetNodeId": {
          "$ref": "#/$defs/opaqueId"
        },
        "redacted": {
          "type": "boolean"
        }
      },
      "required": [
        "id",
        "kind"
      ],
      "additionalProperties": false,
      "allOf": [
        {
          "if": {
            "properties": {
              "kind": {
                "const": "bookmark"
              },
              "redacted": {
                "const": true
              }
            },
            "required": [
              "kind",
              "redacted"
            ]
          },
          "then": {
            "not": {
              "required": [
                "url"
              ]
            }
          }
        }
      ]
    },
    "collectionFeedEventData": {
      "type": "object",
      "properties": {
        "collectionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "revision": {
          "$ref": "#/$defs/opaqueId"
        },
        "summary": {
          "type": "string"
        }
      },
      "required": [
        "collectionId",
        "revision"
      ],
      "additionalProperties": false
    },
    "releasePublishedFeedEventData": {
      "type": "object",
      "properties": {
        "collectionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "revision": {
          "$ref": "#/$defs/opaqueId"
        },
        "summary": {
          "type": "string"
        },
        "changes": {
          "$ref": "#/$defs/changeCounts"
        },
        "releaseId": {
          "$ref": "#/$defs/opaqueId"
        },
        "snapshotUrl": {
          "$ref": "#/$defs/httpUrl"
        },
        "snapshotDigest": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "collectionId",
        "revision",
        "changes",
        "releaseId",
        "snapshotUrl",
        "snapshotDigest"
      ],
      "additionalProperties": false
    },
    "nodeChangedFeedEventData": {
      "type": "object",
      "properties": {
        "collectionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "revision": {
          "$ref": "#/$defs/opaqueId"
        },
        "node": {
          "$ref": "#/$defs/feedNode"
        }
      },
      "required": [
        "collectionId",
        "revision",
        "node"
      ],
      "additionalProperties": false
    },
    "nodeDeletedFeedEventData": {
      "type": "object",
      "properties": {
        "collectionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "revision": {
          "$ref": "#/$defs/opaqueId"
        },
        "nodeId": {
          "$ref": "#/$defs/opaqueId"
        },
        "summary": {
          "type": "string"
        }
      },
      "required": [
        "collectionId",
        "revision",
        "nodeId"
      ],
      "additionalProperties": false
    },
    "accessPublicationChangedFeedEventData": {
      "type": "object",
      "properties": {
        "collectionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "revision": {
          "$ref": "#/$defs/opaqueId"
        },
        "visibility": {
          "$ref": "#/$defs/visibility"
        }
      },
      "required": [
        "collectionId",
        "revision",
        "visibility"
      ],
      "additionalProperties": false
    },
    "extensionFeedEventData": {
      "type": "object",
      "properties": {
        "collectionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "extensions": {
          "$ref": "#/$defs/extensions"
        }
      },
      "required": [
        "collectionId",
        "extensions"
      ],
      "additionalProperties": false
    },
    "feedEventData": {
      "oneOf": [
        {
          "$ref": "#/$defs/collectionFeedEventData"
        },
        {
          "$ref": "#/$defs/releasePublishedFeedEventData"
        },
        {
          "$ref": "#/$defs/nodeChangedFeedEventData"
        },
        {
          "$ref": "#/$defs/nodeDeletedFeedEventData"
        },
        {
          "$ref": "#/$defs/accessPublicationChangedFeedEventData"
        },
        {
          "$ref": "#/$defs/extensionFeedEventData"
        }
      ]
    },
    "feedEvent": {
      "type": "object",
      "properties": {
        "specversion": {
          "const": "1.0"
        },
        "id": {
          "$ref": "#/$defs/opaqueId"
        },
        "source": {
          "$ref": "#/$defs/absoluteUri"
        },
        "type": {
          "oneOf": [
            {
              "type": "string",
              "enum": [
                "com.know-n.colp.collection.created.v1",
                "com.know-n.colp.collection.updated.v1",
                "com.know-n.colp.collection.deleted.v1",
                "com.know-n.colp.release.published.v1",
                "com.know-n.colp.node.created.v1",
                "com.know-n.colp.node.updated.v1",
                "com.know-n.colp.node.moved.v1",
                "com.know-n.colp.node.deleted.v1",
                "com.know-n.colp.annotation.published.v1",
                "com.know-n.colp.access.publication_changed.v1"
              ]
            },
            {
              "type": "string",
              "format": "uri",
              "pattern": "^[Hh][Tt][Tt][Pp][Ss]://"
            }
          ]
        },
        "subject": {
          "type": "string",
          "minLength": 1
        },
        "time": {
          "$ref": "#/$defs/dateTime"
        },
        "datacontenttype": {
          "const": "application/json"
        },
        "collectionprotocolversion": {
          "const": "0.1"
        },
        "data": {
          "type": "object"
        }
      },
      "required": [
        "specversion",
        "id",
        "source",
        "type",
        "subject",
        "time",
        "datacontenttype",
        "collectionprotocolversion",
        "data"
      ],
      "allOf": [
        {
          "if": {
            "properties": {
              "type": {
                "const": "com.know-n.colp.release.published.v1"
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "properties": {
              "data": {
                "$ref": "#/$defs/releasePublishedFeedEventData"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "enum": [
                  "com.know-n.colp.collection.created.v1",
                  "com.know-n.colp.collection.updated.v1",
                  "com.know-n.colp.collection.deleted.v1",
                  "com.know-n.colp.annotation.published.v1"
                ]
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "properties": {
              "data": {
                "$ref": "#/$defs/collectionFeedEventData"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "enum": [
                  "com.know-n.colp.node.created.v1",
                  "com.know-n.colp.node.updated.v1",
                  "com.know-n.colp.node.moved.v1"
                ]
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "properties": {
              "data": {
                "$ref": "#/$defs/nodeChangedFeedEventData"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "com.know-n.colp.node.deleted.v1"
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "properties": {
              "data": {
                "$ref": "#/$defs/nodeDeletedFeedEventData"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "com.know-n.colp.access.publication_changed.v1"
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "properties": {
              "data": {
                "$ref": "#/$defs/accessPublicationChangedFeedEventData"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "pattern": "^[Hh][Tt][Tt][Pp][Ss]://"
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "properties": {
              "data": {
                "$ref": "#/$defs/extensionFeedEventData"
              }
            }
          }
        }
      ],
      "additionalProperties": false
    },
    "pollHint": {
      "type": "object",
      "properties": {
        "notBefore": {
          "$ref": "#/$defs/dateTime"
        },
        "recommendedAfterSeconds": {
          "type": "integer",
          "minimum": 0
        }
      },
      "required": [
        "notBefore",
        "recommendedAfterSeconds"
      ],
      "additionalProperties": false
    },
    "webSubHub": {
      "type": "object",
      "properties": {
        "type": {
          "const": "WebSub"
        },
        "url": {
          "$ref": "#/$defs/httpsUrl"
        }
      },
      "required": [
        "type",
        "url"
      ],
      "additionalProperties": false
    },
    "feed": {
      "type": "object",
      "properties": {
        "protocolVersion": {
          "const": "0.1"
        },
        "feedUrl": {
          "$ref": "#/$defs/httpUrl"
        },
        "collectionUrl": {
          "$ref": "#/$defs/httpUrl"
        },
        "title": {
          "type": "string"
        },
        "events": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/feedEvent"
          }
        },
        "nextCursor": {
          "$ref": "#/$defs/opaqueId"
        },
        "hasMore": {
          "type": "boolean"
        },
        "poll": {
          "$ref": "#/$defs/pollHint"
        },
        "hubs": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/webSubHub"
          },
          "maxItems": 512,
          "uniqueItems": true
        }
      },
      "required": [
        "protocolVersion",
        "feedUrl",
        "collectionUrl",
        "title",
        "events",
        "nextCursor",
        "hasMore",
        "poll",
        "hubs"
      ],
      "additionalProperties": false
    },
    "nodesSearchInput": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "minLength": 1
        },
        "collectionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "cursor": {
          "$ref": "#/$defs/opaqueId"
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100
        }
      },
      "required": [
        "query"
      ],
      "additionalProperties": false
    },
    "nodesSearchHit": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "#/$defs/opaqueId"
        },
        "collectionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "folderPath": {
          "type": "string"
        },
        "linkStatus": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "type": "string",
              "enum": [
                "pending",
                "healthy",
                "redirect",
                "broken"
              ]
            }
          ]
        }
      },
      "required": [
        "id",
        "collectionId",
        "folderPath",
        "linkStatus"
      ],
      "additionalProperties": false
    },
    "nodesSearchResult": {
      "type": "object",
      "properties": {
        "nodes": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/nodesSearchHit"
          }
        },
        "cursor": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/opaqueId"
            }
          ]
        }
      },
      "required": [
        "nodes",
        "cursor"
      ],
      "additionalProperties": false
    },
    "nodesMoveInput": {
      "type": "object",
      "properties": {
        "collectionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "nodeId": {
          "$ref": "#/$defs/opaqueId"
        },
        "baseRevision": {
          "$ref": "#/$defs/opaqueId"
        },
        "newParentId": {
          "$ref": "#/$defs/opaqueId"
        },
        "afterId": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/opaqueId"
            }
          ]
        },
        "beforeId": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/opaqueId"
            }
          ]
        },
        "baseSourceParentRevision": {
          "$ref": "#/$defs/opaqueId"
        },
        "baseTargetParentRevision": {
          "$ref": "#/$defs/opaqueId"
        }
      },
      "required": [
        "collectionId",
        "nodeId",
        "baseRevision",
        "newParentId",
        "baseSourceParentRevision",
        "baseTargetParentRevision"
      ],
      "additionalProperties": false
    },
    "nodesDeleteSubtreeInput": {
      "type": "object",
      "properties": {
        "collectionId": {
          "$ref": "#/$defs/opaqueId"
        },
        "targetId": {
          "$ref": "#/$defs/opaqueId"
        },
        "baseRevision": {
          "$ref": "#/$defs/opaqueId"
        }
      },
      "required": [
        "collectionId",
        "targetId",
        "baseRevision"
      ],
      "additionalProperties": false
    },
    "mcpTool": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128,
          "pattern": "^[A-Za-z0-9_.-]+$",
          "not": {
            "pattern": "[^A-Za-z0-9_.-]"
          }
        },
        "title": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "inputSchema": {
          "type": "object"
        },
        "outputSchema": {
          "type": "object"
        },
        "_meta": {
          "type": "object"
        }
      },
      "required": [
        "name",
        "inputSchema"
      ],
      "additionalProperties": false
    },
    "mcpToolsList": {
      "type": "object",
      "properties": {
        "jsonrpc": {
          "const": "2.0"
        },
        "id": {
          "type": [
            "string",
            "integer"
          ]
        },
        "result": {
          "type": "object",
          "properties": {
            "resultType": {
              "const": "complete"
            },
            "ttlMs": {
              "type": "integer",
              "minimum": 0
            },
            "cacheScope": {
              "enum": [
                "public",
                "private"
              ]
            },
            "tools": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/mcpTool"
              }
            },
            "nextCursor": {
              "$ref": "#/$defs/opaqueId"
            }
          },
          "required": [
            "tools"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "jsonrpc",
        "id",
        "result"
      ],
      "additionalProperties": false
    }
  },
  "anyOf": [
    {
      "$ref": "#/$defs/manifest"
    },
    {
      "$ref": "#/$defs/collectionDirectory"
    },
    {
      "$ref": "#/$defs/collectionMetadata"
    },
    {
      "$ref": "#/$defs/snapshot"
    },
    {
      "$ref": "#/$defs/nodeDetail"
    },
    {
      "$ref": "#/$defs/collectionCreateResult"
    },
    {
      "$ref": "#/$defs/nodeMoveResult"
    },
    {
      "$ref": "#/$defs/deleteResult"
    },
    {
      "$ref": "#/$defs/releaseResult"
    },
    {
      "$ref": "#/$defs/releaseDirectory"
    },
    {
      "$ref": "#/$defs/syncSessionResult"
    },
    {
      "$ref": "#/$defs/syncPushResult"
    },
    {
      "$ref": "#/$defs/syncPull"
    },
    {
      "$ref": "#/$defs/syncAckResult"
    },
    {
      "$ref": "#/$defs/conflict"
    },
    {
      "$ref": "#/$defs/conflictResolutionResult"
    },
    {
      "$ref": "#/$defs/conversionPreview"
    },
    {
      "$ref": "#/$defs/feed"
    },
    {
      "$ref": "#/$defs/problem"
    },
    {
      "$ref": "#/$defs/accessPolicy"
    },
    {
      "$ref": "#/$defs/apiKeyMetadata"
    },
    {
      "$ref": "#/$defs/apiKeyCreateResult"
    },
    {
      "$ref": "#/$defs/apiKeyRotateResult"
    },
    {
      "$ref": "#/$defs/apiKeyDirectory"
    },
    {
      "$ref": "#/$defs/rateLimitPolicy"
    },
    {
      "$ref": "#/$defs/rateLimitDirectory"
    },
    {
      "$ref": "#/$defs/auditEvent"
    },
    {
      "$ref": "#/$defs/auditDirectory"
    },
    {
      "$ref": "#/$defs/changePlan"
    },
    {
      "$ref": "#/$defs/nodesSearchResult"
    },
    {
      "$ref": "#/$defs/changeCommitResult"
    },
    {
      "$ref": "#/$defs/mcpToolsList"
    },
    {
      "$ref": "#/$defs/collection"
    },
    {
      "$ref": "#/$defs/node"
    },
    {
      "$ref": "#/$defs/annotation"
    },
    {
      "$ref": "#/$defs/attachment"
    },
    {
      "$ref": "#/$defs/relation"
    },
    {
      "$ref": "#/$defs/operation"
    }
  ]
};
export default schema;
