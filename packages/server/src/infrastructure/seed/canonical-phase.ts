import { randomUUID } from 'node:crypto';
import {
  createPostgresAnnotationMutationUnitOfWork,
  createPostgresRelationMutationUnitOfWork,
} from '../collections/index.js';
import type { DatabaseRuntime } from '../database/runtime.js';
import {
  createAnnotation,
  createRelation,
  materializeCollectionPayload,
  materializeNodePayload,
  RESOURCE_PAYLOAD_SCHEMA_VERSION,
  type CreateAnnotationInput,
  type CreateRelationInput,
} from '../../modules/collections/index.js';
import { SeedError } from './manifest.js';
import { seedCollectionId, seedNodeId } from './seed-opaque-id.js';

/**
 * PERIPH-P1-b：data.sql 不再 INSERT operations / annotations / relations。
 * 集合与 1151 节点仍是手塑 SQL（CreateOwnedCollection 无法表达公开 slug、
 * 嵌套 folder 与事后 reparent）；写路径历史由本阶段经现有 Canonical 门面写入，
 * 使 collections.commit_ordinal 与 operations 对齐。
 *
 * resource_id_ledger 不可变：撤回不能删账本行，因此也不能硬删后再用预定 ID
 * 走 reserve()。撤回把 annotations/relations 墓碑化并复活；operations 等
 * Canonical 副作用保留，活行 skip 保证重跑不重复 bump commit_ordinal。
 */

export const FLAGSHIP_COLLECTION_ID = seedCollectionId('col-u01-01');

const U01 = {
  principalId: 'acc-u01wWA7gVl069uG0Vg',
  subjectId: 'sub-u01',
  name: '林一晨',
} as const;
const U03 = {
  principalId: 'acc-u0358_5Vn9Oq2Fj-Bg',
  subjectId: 'sub-u03',
  name: '陈嘉怡',
} as const;
const U09 = {
  principalId: 'acc-u09b6xugE8sfqNxj-Q',
  subjectId: 'sub-u09',
  name: '高子墨',
} as const;
const U11 = {
  principalId: 'acc-u11FAzOtK5G136MEWg',
  subjectId: 'sub-u11',
  name: '刘雨桐',
} as const;

type SeedOwner = {
  readonly principalId: string;
  readonly subjectId: string;
  readonly name: string;
};

const OWNERS: Readonly<Record<string, SeedOwner>> = {
  [seedCollectionId('col-u01-01')]: U01,
  [seedCollectionId('col-u01-03')]: U01,
  [seedCollectionId('col-u03-01')]: U03,
  [seedCollectionId('col-u09-01')]: U09,
  [seedCollectionId('col-u11-01')]: U11,
};

function mintAnnotation(spec: SeedAnnotationSpec): SeedAnnotationSpec {
  return {
    ...spec,
    collectionId: seedCollectionId(spec.collectionId),
    subject: {
      ...spec.subject,
      id: spec.subject.type === 'collection'
        ? seedCollectionId(spec.subject.id)
        : seedNodeId(spec.subject.id),
    },
  };
}

function mintRelation(spec: SeedRelationSpec): SeedRelationSpec {
  return {
    ...spec,
    collectionId: seedCollectionId(spec.collectionId),
    fromNodeId: seedNodeId(spec.fromNodeId),
    toNodeId: seedNodeId(spec.toNodeId),
  };
}

interface SeedAnnotationSpec {
  readonly id: string;
  readonly collectionId: string;
  readonly subject: { readonly type: 'collection' | 'node'; readonly id: string };
  readonly type: 'note' | 'summary' | 'tldr' | 'highlight';
  readonly value: string;
}

interface SeedRelationSpec {
  readonly id: string;
  readonly collectionId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly type: NonNullable<CreateRelationInput['relation']['type']>;
  readonly label?: string | null;
}

/** Wave 6–15 的确定性 Canonical 注释；operation_id 走 seed-op-* 前缀。 */
const RAW_CANONICAL_ANNOTATIONS: readonly SeedAnnotationSpec[] = [
  { id: 'seed-ann-01', collectionId: 'col-u01-01', subject: { type: 'collection', id: 'col-u01-01' }, type: 'tldr', value: '从直觉到 Transformer 的工程师路线，先基础再论文。' },
  { id: 'seed-ann-02', collectionId: 'col-u01-01', subject: { type: 'node', id: 'nd-col-u01-01-001' }, type: 'note', value: '001 是 f01「基础与课程」里的课程入口，不是随便收藏的视频。建议先从这里开始，按文件夹从上到下顺序读：3Blue1Brown 建立梯度与注意力的直觉，Karpathy 的 micrograd 再补手写链，读完 f01 再进 f04 的论文对照，不要在根列表里随机跳。' },
  { id: 'seed-ann-03', collectionId: 'col-u01-01', subject: { type: 'node', id: 'nd-col-u01-01-003' }, type: 'highlight', value: 'Attention 论文是后续条目的前置。' },
  { id: 'seed-ann-04', collectionId: 'col-u03-01', subject: { type: 'collection', id: 'col-u03-01' }, type: 'summary', value: '灵感库按产品和组件分类收藏。' },
  { id: 'seed-ann-05', collectionId: 'col-u03-01', subject: { type: 'node', id: 'nd-col-u03-01-001' }, type: 'note', value: '从一个 UI 作品开始，分别记下布局、配色和交互线索，再把可借鉴的做法整理进自己的组件清单；不要只看缩略图。' },
  { id: 'seed-ann-06', collectionId: 'col-u09-01', subject: { type: 'collection', id: 'col-u09-01' }, type: 'tldr', value: '公开研究底稿，不构成投资建议。' },
  { id: 'seed-ann-07', collectionId: 'col-u01-01', subject: { type: 'node', id: 'nd-col-u01-01-004' }, type: 'highlight', value: 'GPT-4 技术报告在这条路径里扮演「能力上限对照」：读完 Attention 与开源权重页之后，用它确认闭源系统在推理、多模态与安全上的宣称边界，而不是当作教材逐节背诵。摘要里的 benchmark 表格扫一眼即可，把精读留给真正要复现或写评测的人；若时间不够，只读引言与结论，记住「上限参照」这四个字就够了。报告里的局限性与 red-team 段落尤其值得对照 LLaMA 等开源页一起看，避免把不同 license 下的结论混成同一句话。侧车里的 highlight quote 故意写长，用来验收资源详情页的两三行 clamp 与滚动，而不是和标题挤在同一行；平均书签仍然只有一句「GPT-4 报告当作能力上限的对照」。若你 fork 这条路径，不要把报告里的能力宣称直接抄进笔记标题，用一两句中文对照开源复现进度即可。通勤时只扫目录与图表，回到桌面再决定是否值得打印。' },
  { id: 'seed-ann-08', collectionId: 'col-u01-01', subject: { type: 'node', id: 'nd-col-u01-01-006' }, type: 'note', value: 'Hugging Face 模型页在这条路径里不是「再收藏一个门户」，而是对照论文实现的索引：看完 Attention 或 GPT-4 报告之后，到这里确认有没有对应权重、license 和推理示例。KnowNSeedLongNote 给搜索 annotation 过滤器与资源侧车回归用——长笔记应可滚动、snippet 高亮该标记，且不得把整段塞进标题行。\n\n第二段写给会 fork 的人：不要把私有微调数据链进公开夹；标签保持 paper/tool 这类粗粒度即可。若模型卡写了危险能力，在笔记里记一句，不要只收藏不读。\n\n第三段是通勤版：只看 trending 或自己 star 过的仓库，避免在模型海里迷路。这条笔记有意写长，用来验收侧车折行；平均书签仍然只有一句「开源模型与权重下载」。' },
  { id: 'seed-ann-09', collectionId: 'col-u01-01', subject: { type: 'node', id: 'nd-col-u01-01-010' }, type: 'tldr', value: 'B 站知识区当通勤复习，不当主路径。' },
  { id: 'seed-ann-10', collectionId: 'col-u01-03', subject: { type: 'collection', id: 'col-u01-03' }, type: 'summary', value: '先推理引擎，再实验平台，最后看中文踩坑。' },
  { id: 'seed-ann-11', collectionId: 'col-u01-03', subject: { type: 'node', id: 'nd-col-u01-03-001' }, type: 'note', value: '先跑通 Transformers 的最小加载示例，再按实际任务查对应 API 与生态组件文档；读完马上记下版本和关键参数。' },
  { id: 'seed-ann-12', collectionId: 'col-u11-01', subject: { type: 'collection', id: 'col-u11-01' }, type: 'tldr', value: '间隔重复 + 费曼，工具只是载体。' },
  { id: 'seed-ann-13', collectionId: 'col-u11-01', subject: { type: 'node', id: 'nd-col-u11-01-007' }, type: 'note', value: '先按课程顺序完成一节，把其中一个学习策略安排进下一次复习；课后用自己的话写三句总结，再决定是否继续下一节。' },
  { id: 'seed-ann-14', collectionId: 'col-u01-01', subject: { type: 'node', id: 'nd-col-u01-01-013' }, type: 'highlight', value: '每日 arXiv 列表用来保持触感，不求读完。' },
  { id: 'seed-ann-15', collectionId: 'col-u01-01', subject: { type: 'node', id: 'nd-col-u01-01-003' }, type: 'note', value: 'Attention Is All You Need 与 seed-ann-03 的高亮 quote 配套：高亮提醒「这是枢纽」，这条 note 写怎么读——先对照 Illustrated Transformer 或 3Blue1Brown 把 scaled dot-product 画出来，再回到摘要第 3 节；实验部分第一次可跳过。若侧车同时出现 highlight、note、tldr 三种类型，正是 Wave 12 要验收的资源详情布局。' },
  { id: 'seed-ann-16', collectionId: 'col-u01-01', subject: { type: 'node', id: 'nd-col-u01-01-003' }, type: 'tldr', value: '先读图解再读原论文。' },
  { id: 'seed-ann-17', collectionId: 'col-u01-01', subject: { type: 'node', id: 'nd-col-u01-01-016' }, type: 'note', value: '先选一篇与当前主题相关的文章，边操作交互图边写下自己的解释；把它当直觉补充，理解概念后再回到论文或实现。' },
  { id: 'seed-ann-18', collectionId: 'col-u01-01', subject: { type: 'node', id: 'nd-col-u01-01-001' }, type: 'tldr', value: '用动画建立神经网络与反向传播的直觉。' },
  { id: 'seed-ann-19', collectionId: 'col-u01-01', subject: { type: 'node', id: 'nd-col-u01-01-004' }, type: 'note', value: '先读摘要、引言和结论，再按需要回看 benchmark 表格；把它作为报告来核对，不按教程顺序通读。' },
  { id: 'seed-ann-20', collectionId: 'col-u01-01', subject: { type: 'node', id: 'nd-col-u01-01-004' }, type: 'tldr', value: 'GPT-4 技术报告用于了解模型能力与局限。' },
  { id: 'seed-ann-21', collectionId: 'col-u01-01', subject: { type: 'node', id: 'nd-col-u01-01-006' }, type: 'tldr', value: '开源模型与权重的检索入口。' },
  { id: 'seed-ann-22', collectionId: 'col-u01-01', subject: { type: 'node', id: 'nd-col-u01-01-007' }, type: 'note', value: '先跑通 README 的最小调用，再按当前项目需要查 API 参考；把可复用的初始化和错误处理记在自己的示例里。' },
  { id: 'seed-ann-23', collectionId: 'col-u01-01', subject: { type: 'node', id: 'nd-col-u01-01-013' }, type: 'tldr', value: '用来浏览每日新增的 AI 论文，不必追求读完。' },
  { id: 'seed-ann-24', collectionId: 'col-u01-03', subject: { type: 'node', id: 'nd-col-u01-03-001' }, type: 'tldr', value: 'Transformers 与生态工具的文档入口。' },
  { id: 'seed-ann-25', collectionId: 'col-u01-03', subject: { type: 'node', id: 'nd-col-u01-03-002' }, type: 'note', value: '先看安装和最小服务示例，再用一组固定请求比较吞吐与延迟；确认硬件和版本后再决定是否接入项目。' },
  { id: 'seed-ann-26', collectionId: 'col-u01-03', subject: { type: 'node', id: 'nd-col-u01-03-009' }, type: 'tldr', value: '数据集、竞赛与 Notebook 的实验入口。' },
  { id: 'seed-ann-27', collectionId: 'col-u03-01', subject: { type: 'node', id: 'nd-col-u03-01-001' }, type: 'tldr', value: '通过 UI 作品收集界面构图与视觉风格参考。' },
  { id: 'seed-ann-28', collectionId: 'col-u03-01', subject: { type: 'node', id: 'nd-col-u03-01-006' }, type: 'note', value: '先按界面类型筛一个文件，拆看组件、间距和状态，再把可借鉴的结构记录下来；不要只保存封面图。' },
  { id: 'seed-ann-29', collectionId: 'col-u03-01', subject: { type: 'node', id: 'nd-col-u03-01-010' }, type: 'note', value: '需要做 App 界面参考时，先按产品流程找连续页面，再记录导航、空状态和关键交互；单张截图只作索引。' },
  { id: 'seed-ann-30', collectionId: 'col-u09-01', subject: { type: 'node', id: 'nd-col-u09-01-004' }, type: 'note', value: '先按同一事件对照不同来源，再记录日期、原始引述和仍待核实的数字；不要只摘标题。' },
  { id: 'seed-ann-31', collectionId: 'col-u09-01', subject: { type: 'node', id: 'nd-col-u09-01-013' }, type: 'tldr', value: '查询上市公司申报文件与财报的原始入口。' },
  { id: 'seed-ann-32', collectionId: 'col-u11-01', subject: { type: 'node', id: 'nd-col-u11-01-007' }, type: 'tldr', value: '以课程形式梳理高效学习的基础方法。' },
];
export const SEED_CANONICAL_ANNOTATIONS: readonly SeedAnnotationSpec[] =
  RAW_CANONICAL_ANNOTATIONS.map(mintAnnotation);

const RAW_CANONICAL_RELATIONS: readonly SeedRelationSpec[] = [
  { id: 'seed-rel-01', collectionId: 'col-u01-01', fromNodeId: 'nd-col-u01-01-001', toNodeId: 'nd-col-u01-01-002', type: 'precedes', label: '先视频后手写' },
  { id: 'seed-rel-02', collectionId: 'col-u01-01', fromNodeId: 'nd-col-u01-01-002', toNodeId: 'nd-col-u01-01-003', type: 'precedes' },
  { id: 'seed-rel-03', collectionId: 'col-u01-01', fromNodeId: 'nd-col-u01-01-003', toNodeId: 'nd-col-u01-01-013', type: 'related' },
  { id: 'seed-rel-04', collectionId: 'col-u01-01', fromNodeId: 'nd-col-u01-01-006', toNodeId: 'nd-col-u01-01-007', type: 'supports', label: 'Hugging Face 提供模型权重与推理接口，是 LangChain 等应用层框架的常用底座；先跑通 HF 再读 SDK 文档。' },
  { id: 'seed-rel-05', collectionId: 'col-u01-01', fromNodeId: 'nd-col-u01-01-004', toNodeId: 'nd-col-u01-01-005', type: 'precedes' },
  { id: 'seed-rel-06', collectionId: 'col-u01-01', fromNodeId: 'nd-col-u01-01-005', toNodeId: 'nd-col-u01-01-013', type: 'related' },
  { id: 'seed-rel-07', collectionId: 'col-u01-01', fromNodeId: 'nd-col-u01-01-007', toNodeId: 'nd-col-u01-01-008', type: 'related' },
  { id: 'seed-rel-08', collectionId: 'col-u01-01', fromNodeId: 'nd-col-u01-01-010', toNodeId: 'nd-col-u01-01-012', type: 'related' },
  { id: 'seed-rel-09', collectionId: 'col-u01-01', fromNodeId: 'nd-col-u01-01-013', toNodeId: 'nd-col-u01-01-014', type: 'follows' },
  { id: 'seed-rel-10', collectionId: 'col-u01-01', fromNodeId: 'nd-col-u01-01-001', toNodeId: 'nd-col-u01-01-015', type: 'derived_from' },
  { id: 'seed-rel-11', collectionId: 'col-u01-03', fromNodeId: 'nd-col-u01-03-001', toNodeId: 'nd-col-u01-03-002', type: 'related' },
  { id: 'seed-rel-12', collectionId: 'col-u01-03', fromNodeId: 'nd-col-u01-03-002', toNodeId: 'nd-col-u01-03-003', type: 'related' },
  { id: 'seed-rel-13', collectionId: 'col-u01-03', fromNodeId: 'nd-col-u01-03-008', toNodeId: 'nd-col-u01-03-009', type: 'related' },
  { id: 'seed-rel-14', collectionId: 'col-u11-01', fromNodeId: 'nd-col-u11-01-001', toNodeId: 'nd-col-u11-01-007', type: 'related' },
  { id: 'seed-rel-15', collectionId: 'col-u01-01', fromNodeId: 'nd-col-u01-01-004', toNodeId: 'nd-col-u01-01-005', type: 'contradicts', label: '闭源能力上限 vs 开源可复现，对照看不要混成同一结论。' },
  { id: 'seed-rel-16', collectionId: 'col-u01-01', fromNodeId: 'nd-col-u01-01-017', toNodeId: 'nd-col-u01-01-018', type: 'duplicate_of', label: '同一主题，图解文与视频。' },
  { id: 'seed-rel-17', collectionId: 'col-u01-01', fromNodeId: 'nd-col-u01-01-013', toNodeId: 'nd-col-u01-01-003', type: 'mentions', label: '每日列表里会反复出现的枢纽论文。' },
  { id: 'seed-rel-18', collectionId: 'col-u01-01', fromNodeId: 'nd-col-u01-01-016', toNodeId: 'nd-col-u01-01-001', type: 'custom', label: '视觉解释传统：期刊交互文与 3Blue1Brown 动画是同一类直觉工具。' },
  { id: 'seed-rel-19', collectionId: 'col-u03-01', fromNodeId: 'nd-col-u03-01-001', toNodeId: 'nd-col-u03-01-006', type: 'related', label: '社区气质对照设计文件。' },
  { id: 'seed-rel-20', collectionId: 'col-u03-01', fromNodeId: 'nd-col-u03-01-006', toNodeId: 'nd-col-u03-01-003', type: 'precedes', label: '先 Figma 文件，再看获奖整站叙事。' },
  { id: 'seed-rel-21', collectionId: 'col-u03-01', fromNodeId: 'nd-col-u03-01-003', toNodeId: 'nd-col-u03-01-001', type: 'derived_from', label: '获奖站的气质往往来自 Dribbble 那一类镜头。' },
  { id: 'seed-rel-22', collectionId: 'col-u03-01', fromNodeId: 'nd-col-u03-01-001', toNodeId: 'nd-col-u03-01-002', type: 'supports', label: 'Dribbble 找气质，Behance 看完整 case。' },
];
export const SEED_CANONICAL_RELATIONS: readonly SeedRelationSpec[] =
  RAW_CANONICAL_RELATIONS.map(mintRelation);

export const SEED_CANONICAL_MUTATION_COUNT =
  SEED_CANONICAL_ANNOTATIONS.length + SEED_CANONICAL_RELATIONS.length;

export const FLAGSHIP_CANONICAL_MUTATION_COUNT =
  SEED_CANONICAL_ANNOTATIONS.filter((item) => item.collectionId === FLAGSHIP_COLLECTION_ID).length
  + SEED_CANONICAL_RELATIONS.filter((item) => item.collectionId === FLAGSHIP_COLLECTION_ID).length;

function ownerFor(collectionId: string): SeedOwner {
  const owner = OWNERS[collectionId];
  if (!owner) {
    throw new SeedError('canonical_phase_failed', `Canonical seed 缺少收藏夹 ${collectionId} 的 owner 映射`);
  }
  return owner;
}

function actorOf(owner: SeedOwner): CreateAnnotationInput['actor'] {
  return {
    principalId: owner.principalId,
    subjectId: owner.subjectId,
    principalType: 'account',
    creator: {
      id: `https://known.test/profiles/${owner.principalId}`,
      name: owner.name,
    },
  };
}

function commandBinding(): { readonly commandId: string; readonly fingerprint: string } {
  return { commandId: randomUUID(), fingerprint: randomUUID() };
}

async function annotationLive(runtime: DatabaseRuntime, id: string): Promise<boolean> {
  const row = await runtime.db
    .selectFrom('annotations')
    .select('id')
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  return row !== undefined;
}

async function relationLive(runtime: DatabaseRuntime, id: string): Promise<boolean> {
  const row = await runtime.db
    .selectFrom('relations')
    .select('id')
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  return row !== undefined;
}

function assertCreated(
  kind: string,
  resourceLabel: string,
  resultKind: string,
): void {
  if (resultKind === 'created' || resultKind === 'replay') return;
  throw new SeedError(
    'canonical_phase_failed',
    `${resourceLabel} Canonical ${kind} 未提交（outcome=${resultKind}）`,
  );
}

function catalogFromPayload(payload: unknown): { readonly tags: unknown; readonly language: string } {
  const root = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const extensions = root.extensions && typeof root.extensions === 'object' && !Array.isArray(root.extensions)
    ? root.extensions as Record<string, unknown>
    : {};
  const tags = Array.isArray(root.tags) ? root.tags : (Array.isArray(extensions.tags) ? extensions.tags : []);
  const language = typeof root.language === 'string'
    ? root.language
    : (typeof extensions.language === 'string' ? extensions.language : 'zh');
  return { tags, language };
}

/**
 * Canonical lock dual-reads payload_json against materialize*. Every live seed
 * collection/node must carry a full payload; catalog tags/language stay in extensions.
 */
async function prepareCanonicalCollectionPayloads(runtime: DatabaseRuntime): Promise<void> {
  const rows = await runtime.db
    .selectFrom('collections')
    .selectAll()
    .where((eb) => eb.or([
      eb('id', 'like', 'col-u%'),
      eb('id', 'like', 'col-ce%'),
    ]))
    .where('deleted_at', 'is', null)
    .execute();
  if (rows.length === 0) {
    throw new SeedError('canonical_phase_failed', 'Canonical seed 缺少活收藏夹');
  }
  for (const row of rows) {
    const catalog = catalogFromPayload(row.payload_json);
    const materialized = materializeCollectionPayload({
      id: row.id,
      ownerSubjectId: row.owner_subject_id,
      title: row.title,
      summary: row.summary,
      kind: row.kind,
      visibility: row.visibility,
      allowSearchIndexing: row.allow_search_indexing,
      rootNodeId: row.root_node_id,
      resourceRevision: row.resource_revision,
      contentRevision: row.content_revision,
      policyRevision: row.policy_revision,
      commitOrdinal: row.commit_ordinal,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
    });
    if (!materialized.ok) {
      throw new SeedError(
        'canonical_phase_failed',
        `${row.id} 无法物化 Canonical payload：${materialized.reason}`,
      );
    }
    await runtime.db
      .updateTable('collections')
      .set({
        payload_json: {
          ...materialized.payload,
          extensions: { tags: catalog.tags, language: catalog.language },
        },
        payload_schema_version: RESOURCE_PAYLOAD_SCHEMA_VERSION,
        payload_authority_status: 'backfilled',
      })
      .where('id', '=', row.id)
      .execute();
  }
}

async function prepareCanonicalNodePayloads(runtime: DatabaseRuntime): Promise<void> {
  const rows = await runtime.db
    .selectFrom('nodes')
    .selectAll()
    .where('id', 'like', 'nd-col-%')
    .where('deleted_at', 'is', null)
    .execute();
  if (rows.length === 0) {
    throw new SeedError('canonical_phase_failed', 'Canonical seed 缺少活节点');
  }
  for (const row of rows) {
    const materialized = materializeNodePayload({
      id: row.id,
      collectionId: row.collection_id,
      parentId: row.parent_id,
      kind: row.kind,
      isRoot: row.is_root,
      title: row.title,
      url: row.url,
      description: row.description,
      tags: row.tags,
      visibility: row.visibility,
      positionToken: row.position_token,
      resourceRevision: row.resource_revision,
      childrenRevision: row.children_revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
      deletedCommitOrdinal: row.deleted_commit_ordinal,
    });
    if (!materialized.ok) {
      throw new SeedError(
        'canonical_phase_failed',
        `${row.id} 无法物化 Canonical node payload：${materialized.reason}`,
      );
    }
    await runtime.db
      .updateTable('nodes')
      .set({
        payload_json: materialized.payload,
        payload_schema_version: RESOURCE_PAYLOAD_SCHEMA_VERSION,
        payload_authority_status: 'backfilled',
      })
      .where('id', '=', row.id)
      .execute();
  }
}

/**
 * 在 data.sql 提交之后、seed_rows 登记之前执行。
 * 每个注解/关联走独立 UoW（门面契约：一事务一 mutation）。
 * 已存在的活行跳过，便于撤回后重跑与部分失败重试。
 */
export async function runCanonicalSeedPhase(runtime: DatabaseRuntime): Promise<void> {
  const annotations = createPostgresAnnotationMutationUnitOfWork(runtime.db);
  const relations = createPostgresRelationMutationUnitOfWork(runtime.db);
  try {
    await prepareCanonicalCollectionPayloads(runtime);
    await prepareCanonicalNodePayloads(runtime);
    for (const spec of SEED_CANONICAL_ANNOTATIONS) {
      if (await annotationLive(runtime, spec.id)) continue;
      const owner = ownerFor(spec.collectionId);
      const input: CreateAnnotationInput = {
        actor: actorOf(owner),
        command: commandBinding(),
        collectionId: spec.collectionId,
        annotation: {
          subject: spec.subject,
          type: spec.type,
          format: spec.type === 'highlight' ? 'json' : 'plain',
          value: spec.type === 'highlight' ? { quote: spec.value } : spec.value,
          visibility: 'public',
          extensions: {},
        },
        annotationId: spec.id,
        operationId: `seed-op-${spec.id}`,
      };
      const result = await annotations.execute((ports) => createAnnotation(ports, input));
      assertCreated('annotation', spec.id, result.kind);
    }
    for (const spec of SEED_CANONICAL_RELATIONS) {
      if (await relationLive(runtime, spec.id)) continue;
      const owner = ownerFor(spec.collectionId);
      const input: CreateRelationInput = {
        actor: {
          principalId: owner.principalId,
          subjectId: owner.subjectId,
          principalType: 'account',
        },
        command: commandBinding(),
        collectionId: spec.collectionId,
        relation: {
          type: spec.type,
          fromNodeId: spec.fromNodeId,
          toNodeId: spec.toNodeId,
          visibility: 'public',
          extensions: {},
          ...(spec.label ? { label: spec.label } : {}),
        },
        relationId: spec.id,
        operationId: `seed-op-${spec.id}`,
      };
      const result = await relations.execute((ports) => createRelation(ports, input));
      assertCreated('relation', spec.id, result.kind);
    }
  } catch (error) {
    if (error instanceof SeedError) throw error;
    throw new SeedError(
      'canonical_phase_failed',
      `Canonical seed 写入失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
