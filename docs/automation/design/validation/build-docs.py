#!/usr/bin/env python3
"""Regenerate the derived parts of the pack from the JSON sources and check the stories chapter.

Sources: tasks.json, user-stories.json, acceptance-tests.json.
Generated: 06-implementation-handbook.md (§4, §5), 07-acceptance-operations.md (§1),
10-module-file-map.md, traceability.json, COLP-Automations-Complete.md.
Checked: 03-user-stories.md index and per-story Tasks/Tests/Example lines; every
AU-/AW-/AC- identifier used in any chapter exists.

No network, model, database or repository write is involved. Exit code 1 on a
consistency failure after writing the generated files, so the diff is inspectable.
"""
from __future__ import annotations
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION = '0.2.1-design'
DATE = '2026-10-13'
MILESTONES = ['M0', 'M1', 'M2', 'M3', 'M4', 'Later']
MILESTONE_TITLES = {
    'M0': 'M0 — Gates and spikes',
    'M1': 'M1 — Rules without models',
    'M2': 'M2 — An agent finishes the job',
    'M3': 'M3 — Batches and run-once',
    'M4': 'M4 — Share the logic',
    'Later': 'Later',
}
CHAPTERS = [
    '01-architecture.md', '02-rule-contract.md', '03-user-stories.md', '04-api-guide.md',
    '05-mcp-events.md', '06-implementation-handbook.md', '07-acceptance-operations.md',
    '08-evidence-and-decisions.md', '09-data-model.md', '10-module-file-map.md',
    '11-execution-contract.md', '12-delivery-lanes.md', '13-backend-first.md', '14-review-findings.md',
]
COLP_ROOT = Path.home() / 'known' / 'colp'
KNOWN_ROOT = Path.home() / 'known' / 'Know-N'

errors: list[str] = []


def load(name: str):
    return json.loads((ROOT / name).read_text(encoding='utf-8'))


def num(identifier: str) -> int:
    return int(identifier.rsplit('-', 1)[1])


def ms_key(task: dict) -> tuple[int, int]:
    return (MILESTONES.index(task['milestone']), num(task['id']))


def joined(ids) -> str:
    return ', '.join(sorted(ids, key=num)) if ids else '—'


def render_task_index(tasks: list[dict]) -> str:
    lines = ['| ID | Milestone | Size | Task | Depends on | Stories |', '|---|---|---|---|---|---|']
    for t in sorted(tasks, key=ms_key):
        lines.append(f"| {t['id']} | {t['milestone']} | {t['size']} | {t['title']} | {joined(t['dependencies'])} | {joined(t['stories'])} |")
    return '\n'.join(lines)


def render_work_packets(tasks: list[dict]) -> str:
    out: list[str] = []
    for ms in MILESTONES:
        group = [t for t in tasks if t['milestone'] == ms]
        if not group:
            continue
        out.append(f'### {MILESTONE_TITLES[ms]}\n')
        for t in sorted(group, key=ms_key):
            out.append(f"#### {t['id']} — {t['title']} — {t['size']}\n")
            out.append(f"**Milestone:** {t['milestone']}. **Lane:** {t.get('lane', 'unassigned')}. **Depends on:** {joined(t['dependencies'])}. **Stories:** {joined(t['stories'])}.\n")
            out.append('**Handoff:** ' + '; '.join(t.get('handoffArtifacts', [])) + '\n')
            out.append('**Not in scope:** ' + '; '.join(t.get('nonGoals', [])) + '\n')
            out.append('**Read first:**')
            out.extend(f'- `{p}`' for p in t['readFirst'])
            out.append('')
            out.append('**Files (new or modified):**')
            out.extend(f'- `{p}`' for p in t['files'])
            out.append('')
            out.append('**Steps:**')
            out.extend(f'{i}. {s}' for i, s in enumerate(t['implementation'], 1))
            out.append('')
            out.append('**Done when:**')
            out.extend(f'- {a}' for a in t['acceptance'])
            out.append('')
    return '\n'.join(out).rstrip() + '\n'


def render_acceptance(tests: list[dict]) -> str:
    lines = ['| Test | Milestone | Scenario | Action | Required proof |', '|---|---|---|---|---|']
    for a in sorted(tests, key=lambda a: num(a['id'])):
        lines.append(f"| {a['id']} | {a['milestone']} | {a['scenario']} | {a['action']} | {a['assertion']} |")
    return '\n'.join(lines)


def exists_in_repo(path: str) -> bool:
    if '<' in path or '(' in path:
        return False
    if path.startswith('Known-Extension/'):
        return (KNOWN_ROOT / path).exists()
    return (COLP_ROOT / path).exists()


def render_file_map(tasks: list[dict]) -> str:
    rows: dict[str, dict] = {}
    for t in tasks:
        for p in t['files']:
            row = rows.setdefault(p, {'tasks': set(), 'milestones': set()})
            row['tasks'].add(t['id'])
            row['milestones'].add(t['milestone'])
    out: list[str] = []
    for repo, pred in (('Know-N (private)', lambda p: p.startswith('Known-Extension/')), ('colp (public)', lambda p: not p.startswith('Known-Extension/'))):
        paths = sorted(p for p in rows if pred(p))
        out.append(f'### {repo}\n')
        out.append('| Path | Packets | Milestones | State |')
        out.append('|---|---|---|---|')
        for p in paths:
            r = rows[p]
            ms = ', '.join(sorted(r['milestones'], key=MILESTONES.index))
            state = 'verify at AW-01 (not inferred from reviewer filesystem)'
            out.append(f"| `{p}` | {joined(r['tasks'])} | {ms} | {state} |")
        out.append('')
    return '\n'.join(out).rstrip() + '\n'


def render_template(name: str, replacements: dict[str, str]) -> None:
    text = (ROOT / 'validation' / 'templates' / name).read_text(encoding='utf-8')
    for marker, value in replacements.items():
        token = '{{' + marker + '}}'
        if token not in text:
            errors.append(f'template {name} lacks marker {token}')
        text = text.replace(token, value)
    (ROOT / name).write_text(text, encoding='utf-8')


def check_stories_chapter(stories: list[dict], trace: list[dict]) -> None:
    text = (ROOT / '03-user-stories.md').read_text(encoding='utf-8')
    by_id = {s['id']: s for s in stories}
    trace_tasks = {t['storyId']: set(t['tasks']) for t in trace}
    headers = re.findall(r'^### (AU-\d\d) (.+?) — (M\d|Later)$', text, flags=re.M)
    seen = set()
    for sid, title, ms in headers:
        seen.add(sid)
        s = by_id.get(sid)
        if not s:
            errors.append(f'03: story {sid} not in user-stories.json'); continue
        if s['title'] != title:
            errors.append(f'03: {sid} title differs: md "{title}" vs json "{s["title"]}"')
        if s['milestone'] != ms:
            errors.append(f'03: {sid} milestone differs: md {ms} vs json {s["milestone"]}')
        section = text.split(f'### {sid} ')[1].split('\n### ')[0]
        m = re.search(r'^Tasks: (.+?)\. Tests: (.+?)\. Example: \[(.+?)\]\(examples/(.+?)\)', section, flags=re.M)
        if not m:
            errors.append(f'03: {sid} has no "Tasks: … Tests: … Example: …" line'); continue
        md_tasks = set(x.strip() for x in m.group(1).split(','))
        md_tests = set(x.strip() for x in m.group(2).split(','))
        if md_tasks != trace_tasks.get(sid, set()):
            errors.append(f'03: {sid} tasks differ: md {joined(md_tasks)} vs tasks.json {joined(trace_tasks.get(sid, set()))}')
        if md_tests != set(s['tests']):
            errors.append(f'03: {sid} tests differ: md {joined(md_tests)} vs json {joined(s["tests"])}')
        if m.group(3) != m.group(4) or m.group(4) != s['example']:
            errors.append(f'03: {sid} example differs: md {m.group(4)} vs json {s["example"]}')
    for sid in by_id:
        if sid not in seen:
            errors.append(f'03: story {sid} missing from the chapter')
    for sid, title, ms, tests in re.findall(r'^\| (AU-\d\d) \| (.+?) \| (M\d|Later) \| (.+?) \|$', text, flags=re.M):
        s = by_id.get(sid)
        if not s:
            errors.append(f'03 index: unknown {sid}'); continue
        if s['milestone'] != ms or set(x.strip() for x in tests.split(',')) != set(s['tests']) or s['title'] != title:
            errors.append(f'03 index: row for {sid} disagrees with json')


def check_identifiers(stories, tasks, tests) -> None:
    known = {s['id'] for s in stories} | {t['id'] for t in tasks} | {a['id'] for a in tests}
    for chapter in CHAPTERS + ['README.md']:
        text = (ROOT / chapter).read_text(encoding='utf-8')
        for ident in set(re.findall(r'\b(?:AU|AW|AC)-\d\d\b', text)):
            if ident not in known:
                errors.append(f'{chapter}: unknown identifier {ident}')


def build_complete_book() -> None:
    parts = [f'# COLP Automations — Complete Design Book\n\nVersion {VERSION} | {DATE} | English Markdown\n\n'
             'This combined edition is generated from the chapters by `validation/build-docs.py`. Machine-readable OpenAPI, schemas and examples remain companion files. This is a design pack, not implemented software.\n\n## Chapters\n']
    for c in CHAPTERS:
        title = c[3:-3].replace('-', ' ').title().replace('Mcp', 'MCP').replace('Api', 'API')
        parts.append(f'- [{title}]({c})\n')
    for c in CHAPTERS:
        parts.append(f'\n---\n\n<!-- Source chapter: {c} -->\n\n')
        parts.append((ROOT / c).read_text(encoding='utf-8').rstrip() + '\n')
    (ROOT / 'COLP-Automations-Complete.md').write_text(''.join(parts), encoding='utf-8')


def main() -> int:
    stories = load('user-stories.json'); tasks = load('tasks.json'); tests = load('acceptance-tests.json')
    trace = [{'storyId': s['id'], 'tests': s['tests'],
              'tasks': sorted((t['id'] for t in tasks if s['id'] in t['stories']), key=num),
              'example': s['example']} for s in stories]
    (ROOT / 'traceability.json').write_text(json.dumps(trace, indent=2) + '\n', encoding='utf-8')
    render_template('06-implementation-handbook.md', {'TASK_INDEX': render_task_index(tasks), 'WORK_PACKETS': render_work_packets(tasks)})
    render_template('07-acceptance-operations.md', {'ACCEPTANCE_MATRIX': render_acceptance(tests)})
    render_template('10-module-file-map.md', {'FILE_MAP': render_file_map(tasks)})
    check_stories_chapter(stories, trace)
    check_identifiers(stories, tasks, tests)
    build_complete_book()
    summary = {'stories': len(stories), 'tasks': len(tasks), 'acceptance_tests': len(tests), 'errors': errors}
    print(json.dumps(summary, indent=2))
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
