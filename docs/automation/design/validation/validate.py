#!/usr/bin/env python3
"""Offline artifact validation, not a production rule engine or deployment test.

Run from any directory. Requires only PyYAML and jsonschema. No network, model,
webhook, database, repository write, or runtime implementation is invoked.
"""
from __future__ import annotations
import copy
import importlib.metadata
import json
from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlsplit

try:
    import yaml
    from jsonschema import Draft202012Validator, FormatChecker
except ImportError as exc:
    raise SystemExit('Install validation/requirements.txt before running this script.') from exc

ROOT = Path(__file__).resolve().parents[1]
CHECKS: list[dict] = []
FAILURES: list[str] = []

class UniqueLoader(yaml.SafeLoader):
    pass

def unique_mapping(loader, node, deep=False):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in result:
            raise ValueError(f'Duplicate YAML key: {key!r}')
        result[key] = loader.construct_object(value_node, deep=deep)
    return result
UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, unique_mapping)

def load(path: Path):
    if path.suffix == '.json':
        def pairs(items):
            d = {}
            for k, v in items:
                if k in d:
                    raise ValueError(f'Duplicate JSON key: {k}')
                d[k] = v
            return d
        return json.loads(path.read_text(encoding='utf-8'), object_pairs_hook=pairs)
    return yaml.load(path.read_text(encoding='utf-8'), Loader=UniqueLoader)

def check(name, action):
    try:
        detail = action()
        CHECKS.append({'name':name,'status':'passed','detail':detail})
    except Exception as exc:
        msg=f'{name}: {type(exc).__name__}: {exc}'
        FAILURES.append(msg)
        CHECKS.append({'name':name,'status':'failed','detail':str(exc)})

def walk(x):
    yield x
    if isinstance(x,dict):
        for v in x.values(): yield from walk(v)
    elif isinstance(x,list):
        for v in x: yield from walk(v)

def pointer(doc, value):
    assert value.startswith('#/'), f'Unexpected non-local ref: {value}'
    cur=doc
    for k in value[2:].split('/'):
        cur=cur[k.replace('~1','/').replace('~0','~')]
    return cur

def inspect_openapi(path):
    d=load(path)
    assert d['openapi']=='3.1.0'
    assert d['info']['version']=='0.2.1-design'
    assert isinstance(d['paths'],dict) and d['paths']
    ids=[]; references=0
    for x in walk(d):
        if isinstance(x,dict) and '$ref' in x:
            pointer(d,x['$ref']); references+=1
    count=0
    for section in ['paths','webhooks']:
        for p,item in d.get(section,{}).items():
            for method,op in item.items():
                if method not in {'get','post','put','patch','delete','head','options','trace'}:continue
                count+=1; ids.append(op['operationId'])
                assert op.get('responses'), f'{p} missing responses'
                assert any(re.fullmatch(r'2\d\d', str(c)) for c in op['responses']), f'{p} no success status'
                parameters=[pointer(d,q['$ref']) if '$ref' in q else q for q in op.get('parameters',[])]
                expected=set(re.findall(r'{([^}]+)}',p)) if section=='paths' else set()
                actual={q['name'] for q in parameters if q['in']=='path' and q.get('required') is True}
                assert expected==actual, (p, expected, actual)
                assert len({(q['in'],q['name']) for q in parameters})==len(parameters), f'duplicate parameter {p}'
                for requirement in op.get('security',d.get('security',[])):
                    for scheme in requirement: assert scheme in d['components']['securitySchemes']
    assert len(ids)==len(set(ids)), 'Duplicate operationId'
    for name,sch in d['components']['schemas'].items(): Draft202012Validator.check_schema(sch)
    return {'operations_including_webhooks':count,'schemas':len(d['components']['schemas']),'resolved_local_refs':references}

def v_schema(doc,name,data):
    # OAS root is used as a local ref container. Schema extraction does not
    # validate the complete OAS specification against an external OAS metaschema.
    root={**doc, '$ref':'#/components/schemas/'+name}
    Draft202012Validator(root,format_checker=FormatChecker()).validate(data)

DOC=load(ROOT/'api/automation.openapi.yaml')
MCP=load(ROOT/'api/mcp-events.openapi.yaml')
for p in (ROOT/'api').glob('*.yaml'):check('OpenAPI structure/refs: '+p.name,lambda p=p:inspect_openapi(p))

def standalone_schemas():
    n=0
    for p in (ROOT/'schemas').glob('*.json'):
        d=load(p); Draft202012Validator.check_schema(d)
        for item in walk(d):
            if isinstance(item,dict) and '$ref' in item:pointer(d,item['$ref'])
        n+=1
    return {'standalone_schemas':n}
check('Standalone JSON Schema validity/references',standalone_schemas)

EXAMPLES={
 'academic-intake.json':'RuleDefinition', 'academic-bindings.json':'BindingSetInput',
 'execution-policy.json':'ExecutionPolicyInput','rule-create.json':'RuleInput',
 'ten-bookmark-digest.json':'RuleDefinition','github-review.json':'RuleDefinition',
 'tag-review.json':'RuleDefinition','research-catalog.json':'RuleDefinition',
 'research-catalog-bindings.json':'BindingSetInput','weekly-digest.json':'RuleDefinition',
 'event-facts.json':'EventFacts','local-receipt.json':'LocalReceiptInput',
 'preview-request.json':'PreviewInput','paper-template.json':'TemplateInput',
 'broadcast-digest.json':'RuleDefinition','broadcast-bindings.json':'BindingSetInput',
 'broadcast-execution-policy.json':'ExecutionPolicyInput',
 'm1-placement.json':'RuleDefinition','m1-bindings.json':'BindingSetInput',
 'm1-rule-create.json':'RuleInput','m1-bundle-paused.json':'RuleBundle',
 'academic-summary-only.json':'RuleDefinition','worker-bootstrap-profile.json':'ConnectionProfileInput',
 'run-once-start.json':'RunOnceStartInput','m1-preview-current-state.json':'PreviewInput'}
for f,n in EXAMPLES.items():check('Example: '+f,lambda f=f,n=n:v_schema(DOC,n,load(ROOT/'examples'/f)))
check('MCP subscription fixture',lambda:v_schema(MCP,'SubscribeRequest',load(ROOT/'examples/mcp-subscribe.json')))
check('MCP occurrence fixture',lambda:v_schema(MCP,'Occurrence',load(ROOT/'examples/mcp-occurrence.json')))

for fixture in load(ROOT/'examples/contract-fixtures.json'):
    def run_fixture(f=fixture):
        x=copy.deepcopy(load(ROOT/'examples'/f['file']));x.update(f.get('mutation',{}))
        root={**DOC,'$ref':'#/components/schemas/'+f['schema']}
        valid=Draft202012Validator(root,format_checker=FormatChecker()).is_valid(x)
        assert valid==f['valid'], f"expected valid={f['valid']}, got {valid}"
        return {'expected_valid':f['valid']}
    check('Contract '+fixture['id']+': '+fixture['case'],run_fixture)

def semantic(definition):
    """Limited offline design checks. No CEL execution or external state lookup."""
    roles={r['key']:r for r in definition['roles']}
    assert len(roles)==len(definition['roles']), 'duplicate role'
    tasks=definition['tasks']; ids={t['id'] for t in tasks}
    assert len(ids)==len(tasks), 'duplicate task'
    graph={t['id']:t['after'] for t in tasks}
    visiting=set(); visited=set()
    def dfs(k):
        assert k in graph, 'unknown predecessor'
        assert k not in visiting, 'cycle'
        if k in visited:return
        visiting.add(k)
        for dep in graph[k]:dfs(dep)
        visiting.remove(k);visited.add(k)
    for k in ids:dfs(k)
    for t in tasks:
        assert t['executorRole'] in roles and roles[t['executorRole']]['kind']=='executor'
        for field,kind in [('folderRole','folder'),('entityMapRole','entityMap'),('vocabularyRole','vocabulary')]:
            if field in t:assert t[field] in roles and roles[t[field]]['kind']==kind
    if 'intake' in definition:
        assert definition['on']=='bookmark.intake' and definition['trigger']['mode']=='each'
        assert definition['intake']['folderRole'] in roles
    if definition['policy']['privacy']=='restricted':
        assert definition['policy']['broadcastAllowed'] is False
        assert definition['route']['mode']!='broadcast'
    if definition['route']['mode']=='broadcast':
        assert definition['route']['execution']!='single'
        assert definition['route'].get('audience')=='optedInAuthorizedTargets'
    if definition['route']['execution']=='perTarget':
        assert all(t['type'] not in ['classify.root','classify.refine'] for t in tasks), 'broadcast placement forbidden'

for f,n in EXAMPLES.items():
    if n=='RuleDefinition':check('Offline graph/role/policy checks: '+f,lambda f=f:semantic(load(ROOT/'examples'/f)))

def negative_semantics():
    count=0
    base=load(ROOT/'examples/academic-intake.json')
    variants=[]
    d=copy.deepcopy(base);d['tasks'][0]['after']=['refine'];variants.append(d)
    d=copy.deepcopy(base);d['tasks'][0]['executorRole']='missingRole';variants.append(d)
    d=copy.deepcopy(base);d['policy']['privacy']='restricted';d['policy']['broadcastAllowed']=True;variants.append(d)
    d=copy.deepcopy(base);d['route']={'mode':'broadcast','execution':'perTarget','audience':'optedInAuthorizedTargets'};variants.append(d)
    for d in variants:
        try:semantic(d)
        except AssertionError: count+=1
        else: raise AssertionError('Invalid semantic fixture unexpectedly passed')
    return {'negative_semantic_cases':count}
check('Negative graph/role/privacy fixtures',negative_semantics)

def schema_equivalence():
    expected=DOC['components']['schemas']
    def local(x):
        if isinstance(x,dict):return {k:(v.replace('#/components/schemas/','#/$defs/') if k=='$ref' else local(v)) for k,v in x.items()}
        if isinstance(x,list):return [local(i) for i in x]
        return x
    for p in (ROOT/'schemas').glob('*.json'):
        if p.name=='mcp-events.schema.json':continue
        assert load(p)['$defs']==local(expected), f'drift in {p.name}'
    return {'shared_component_definitions':len(expected)}
check('OpenAPI / standalone schema drift',schema_equivalence)

def references_and_traces():
    stories=load(ROOT/'user-stories.json');tasks=load(ROOT/'tasks.json');tests=load(ROOT/'acceptance-tests.json');traces=load(ROOT/'traceability.json')
    sid={s['id'] for s in stories}; tid={t['id'] for t in tasks}; aid={a['id'] for a in tests}
    assert len(sid)==len(stories) and len(tid)==len(tasks) and len(aid)==len(tests)
    graph={t['id']:t['dependencies'] for t in tasks}; seen=set(); active=set()
    def dfs(k):
        assert k not in active, 'task dependency cycle'
        if k in seen:return
        active.add(k)
        for d in graph[k]: assert d in tid;dfs(d)
        active.remove(k);seen.add(k)
    for t in tasks:
        dfs(t['id']); assert set(t['stories'])<=sid
        assert t['implementation'] and t['acceptance'] and t['files']
    for s in stories:
        assert set(s['tests'])<=aid
        assert (ROOT/'examples'/s['example']).exists()
        assert any(s['id'] in t['stories'] for t in tasks)
    assert {x['storyId'] for x in traces}==sid
    for tr in traces:
        assert set(tr['tasks'])<=tid and set(tr['tests'])<=aid
        s=next(s for s in stories if s['id']==tr['storyId'])
        assert s['example']==tr['example']
    ops=load(ROOT/'api/operations.json')
    actual={op['operationId'] for item in DOC['paths'].values() for method,op in item.items() if method in ['get','post','put','patch','delete','head']}
    assert actual=={o['id'] for o in ops}
    return {'stories':len(sid),'tasks':len(tid),'acceptance_tests_planned':len(aid),'http_operations':len(actual)}
check('Plan IDs / DAG / traceability / operation inventory',references_and_traces)

def markdown_links():
    checked=0
    for p in ROOT.glob('*.md'):
        text=p.read_text(encoding='utf-8')
        assert text.count('```')%2==0, f'unclosed fence in {p.name}'
        for target in re.findall(r'\]\(([^)]+)\)',text):
            if target.startswith(('http:','https:','mailto:','#')):continue
            path=unquote(target.split('#')[0])
            assert (p.parent/path).exists(),f'broken link {p.name} -> {target}'
            checked+=1
    return {'local_markdown_links':checked}
check('Markdown local links / code fences',markdown_links)

def tool_catalog():
    cat=load(ROOT/'api/mcp-tool-catalog.json')
    names=[]
    for item in walk(cat):
        if isinstance(item,dict) and '$ref' in item:pointer(cat,item['$ref'])
    for sch in cat['$defs'].values():Draft202012Validator.check_schema(sch)
    for t in cat['tools']:
        names.append(t['name'])
        assert t['profile'] in ['automationManager','automationWorker']
        assert t['requiredScopes']
        assert t['inputSchema'] and t['outputSchema']
    assert len(names)==len(set(names))==15
    assert all('automation' in t['profile'] for t in cat['tools'])
    return {'typed_tool_descriptors':len(names)}
check('MCP design tool catalog references/profiles',tool_catalog)


def reviewed_contract_boundaries():
    def valid(name,value):
        return Draft202012Validator({**DOC,'$ref':'#/components/schemas/'+name},format_checker=FormatChecker()).is_valid(value)
    checked=0
    r=load(ROOT/'examples/m1-rule-create.json')
    assert valid('RuleInput',r) and 'executionPolicyId' not in r and r['definition']['tasks']==[]
    checked+=1
    rec=load(ROOT/'examples/local-receipt.json')
    assert valid('LocalReceiptInput',rec)
    bad=copy.deepcopy(rec);bad['nativeObservation']={'nativeId':'123'}
    assert not valid('LocalReceiptInput',bad)
    bad=copy.deepcopy(rec);bad['satisfiedTaskTypes']=['summary.generate']
    assert not valid('LocalReceiptInput',bad)
    bad=copy.deepcopy(rec);del bad['committedNode']['serverUuid']
    assert not valid('LocalReceiptInput',bad)
    checked+=4
    bundle=load(ROOT/'examples/m1-bundle-paused.json')
    assert valid('RuleBundle',bundle)
    for field in ['paused','settingsRevision']:
        bad=copy.deepcopy(bundle);del bad[field];assert not valid('RuleBundle',bad)
    checked+=3
    rule=load(ROOT/'examples/academic-intake.json')
    assert len(rule['tasks'])==3
    rule['tasks']=[copy.deepcopy(rule['tasks'][0]) for _ in range(9)]
    assert not valid('RuleDefinition',rule)
    assert len(load(ROOT/'examples/academic-summary-only.json')['tasks'])==1
    checked+=3
    once=load(ROOT/'examples/run-once-start.json')
    assert valid('RunOnceStartInput',once)
    bad=copy.deepcopy(once);bad['folder']={'nodeId':'changed'}
    assert not valid('RunOnceStartInput',bad)
    checked+=2
    current=load(ROOT/'examples/m1-preview-current-state.json')
    assert valid('PreviewInput',current)
    bad=copy.deepcopy(current);bad['events']=[]
    assert not valid('PreviewInput',bad)
    bad=copy.deepcopy(current);bad['mode']='supplied'
    assert not valid('PreviewInput',bad)
    checked+=3
    return {'positive_and_negative_shape_assertions':checked,'scope':'design schemas, not backend runtime validation'}
check('Reviewed M1 / receipt / pause / preview / run-once boundaries',reviewed_contract_boundaries)

def bootstrap_contract():
    cat=load(ROOT/'api/mcp-tool-catalog.json'); tools={t['name']:t for t in cat['tools']}
    pair=tools['automation.targets.pair'];queue=tools['automation.jobs.list']
    assert pair['profile']=='automationWorker'
    assert 'automation:work' in pair['requiredScopes'] and 'automation:manage' not in pair['requiredScopes']
    assert queue['profile']=='automationWorker' and queue.get('availability')=='pairedOnly'
    assert sum(t['profile']=='automationManager' for t in cat['tools'])==7
    assert sum(t['profile']=='automationWorker' for t in cat['tools'])==8
    return {'manager_tools':7,'worker_tools':8,'scope':'catalog metadata, not credential isolation proof'}
check('Worker bootstrap and queue contract',bootstrap_contract)

def lane_ownership():
    tasks=load(ROOT/'tasks.json');by={t['id']:t for t in tasks};rows=load(ROOT/'file-ownership.json')
    owners={};blocked={'web','extension','integration'}
    for t in tasks:
        assert t['lane'] in {'contracts','shared-core','backend','web','extension','worker-reference','integration'}
        assert t['handoffArtifacts'] and t['nonGoals']
        if t['lane'] in {'contracts','shared-core','backend','worker-reference'}:
            stack=list(t['dependencies']);seen=set()
            while stack:
                d=stack.pop()
                if d in seen:continue
                seen.add(d);assert by[d]['lane'] not in blocked,(t['id'],d)
                stack+=by[d]['dependencies']
        for f in t['files']:
            if f.startswith('packages/web/'):assert t['lane']=='web',(t['id'],f)
            if f.startswith('Known-Extension/'):assert t['lane']=='extension',(t['id'],f)
            owner=owners.setdefault(f,{'lane':t['lane'],'tasks':set()})
            assert owner['lane']==t['lane'],(f,owner['lane'],t['lane'])
            owner['tasks'].add(t['id'])
    assert len(rows)==len(owners)
    for row in rows:
        assert row['lane']==owners[row['path']]['lane']
        assert set(row['tasks'])==owners[row['path']]['tasks']
    return {'tasks':len(tasks),'single_lane_files':len(rows),'backend_transitive_frontend_dependencies':0}
check('Single-lane files and no backend-to-frontend dependency',lane_ownership)

def backend_batches():
    doc=load(ROOT/'backend-batches.json');by={t['id']:t for t in load(ROOT/'tasks.json')}
    all_done=set();batch_ids=set();total=0
    for batch in doc['batches']:
        assert set(batch['requiresBatches'])<=batch_ids
        assert len(batch['tasks'])==len(set(batch['tasks']))
        for tid in batch['tasks']:
            assert tid not in all_done,tid
            t=by[tid];assert t['lane'] in {'contracts','shared-core','backend','worker-reference'}
            assert set(t['dependencies'])<=all_done,(tid,set(t['dependencies'])-all_done)
            all_done.add(tid);total+=1
        batch_ids.add(batch['id'])
    first=doc['batches'][0]['tasks']
    assert 'AW-02' not in first and set(first)=={'AW-01','AW-03','AW-04','AW-05','AW-06','AW-07','AW-08','AW-09','AW-10','AW-11'}
    assert 'AW-29' not in by['AW-64']['dependencies']
    return {'dependency_closed_batches':len(batch_ids),'scheduled_tasks':total,'first_batch_tasks':len(first)}
check('Local backend batch order is dependency-closed',backend_batches)

def formal_examples():
    banned=re.compile(r'\bperformer\b|\badult\s+av\b|\bporn(?:ography)?\b|成人电影|成人av',re.I)
    for p in list(ROOT.glob('*.md'))+list((ROOT/'examples').glob('*.json')):
        assert not banned.search(p.read_text()),p.name
    rule=load(ROOT/'examples/research-catalog.json')
    assert rule['policy']['privacy']=='restricted' and rule['policy']['broadcastAllowed'] is False
    for t in rule['tasks']:
        if t['type'] in ['classify.refine','tags.generate']:
            assert 'metadata' in t['inputFields'] and t['after'],t['id']
    return {'formal_research_example':True,'no_informal_example_residue':True}
check('Formal research example and predecessor contract',formal_examples)

report={'status':'passed' if not FAILURES else 'failed','scope':'Offline artifact structure, JSON Schema, example, selected semantic and planning checks only. No production execution or external OpenAPI linter.','checks':CHECKS,'failures':FAILURES,'dependencies':{n:importlib.metadata.version(n) for n in ['PyYAML','jsonschema']},'not_executed':['Full external OpenAPI linter/metaschema validation','Production CEL evaluator tests','PostgreSQL transaction/fault tests','Actual browser extension lifecycle','Actual hosted-bot (ChatGPT dot) Events subscription/delivery/execution','Chrome Web Store review','Repository code changes or CI execution']}
(ROOT/'validation/report.json').write_text(json.dumps(report,indent=2)+'\n')
lines=['# Artifact Validation Report','',f"**Result:** {report['status'].upper()}. **Checks:** {len(CHECKS)}. **Failures:** {len(FAILURES)}.",'',report['scope'],'','| Check | Result |','|---|---|']
lines += [f"| {c['name']} | {c['status']} |" for c in CHECKS]
lines += ['','## Not executed','']+['- '+x for x in report['not_executed']]
if FAILURES: lines+=['','## Failures','']+['- '+f for f in FAILURES]
(ROOT/'validation/report.md').write_text('\n'.join(lines)+'\n')
print(json.dumps({'status':report['status'],'checks':len(CHECKS),'failures':FAILURES},indent=2))
sys.exit(1 if FAILURES else 0)
