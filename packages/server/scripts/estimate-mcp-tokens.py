#!/usr/bin/env python3
"""Optional local tokenizer estimate, not provider usage or a loading observation."""
import argparse
import importlib.metadata
import json
import re
from pathlib import Path

import tiktoken

parser = argparse.ArgumentParser(description=__doc__)
source = parser.add_mutually_exclusive_group(required=True)
source.add_argument('--static', action='store_true', help='generated Automation contracts')
source.add_argument('--catalog', type=Path, help='sanitized tools/list JSON or tool array')
parser.add_argument('--encoding', default='cl100k_base', help='installed tiktoken encoding name')
parser.add_argument('--contracts-file', type=Path, help='optional generated contract file for --static, for example from git show')
args = parser.parse_args()
encoding = tiktoken.get_encoding(args.encoding)

def estimate(tools):
    definitions = [{key: tool[key] for key in ('name', 'description', 'inputSchema') if key in tool} for tool in tools]
    payload = json.dumps(definitions, ensure_ascii=False, separators=(',', ':'))
    return {'count': len(tools), 'inputTokenEstimate': len(encoding.encode(payload, disallowed_special=()))}

if args.static:
    path = args.contracts_file or Path(__file__).resolve().parent.parent / 'src/modules/mcp/automation-tool-contracts.generated.ts'
    content = path.read_text()
    contracts = json.loads(re.search(r'AUTOMATION_TOOL_CONTRACTS = (.*) as const;', content).group(1))
    sets_match = re.search(r'TASK_TOOLSETS = (.*) as const;', content)
    sets = json.loads(sets_match.group(1)) if sets_match else {}
    results = {'automation': estimate(contracts),
               'manager': estimate([tool for tool in contracts if tool['profile'] == 'automationManager']),
               'worker': estimate([tool for tool in contracts if tool['profile'] == 'automationWorker'])}
    results.update({name + ' (Automation only)': estimate([tool for tool in contracts if tool['name'] in value['members']])
                    for name, value in sets.items()})
else:
    captured = json.loads(args.catalog.read_text())
    tools = captured if isinstance(captured, list) else captured.get('tools', captured.get('result', {}).get('tools'))
    if not isinstance(tools, list) or any('name' not in tool or 'inputSchema' not in tool for tool in tools):
        parser.error('catalog must be a sanitized tools/list result or tool array')
    results = {'catalog': estimate(tools)}
print(json.dumps({'kind': 'local tokenizer estimate, not provider usage or model loading',
                  'tokenizer': 'tiktoken', 'version': importlib.metadata.version('tiktoken'),
                  'encoding': args.encoding, 'results': results}, ensure_ascii=False, indent=2))
