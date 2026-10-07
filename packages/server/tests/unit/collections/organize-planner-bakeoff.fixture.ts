/**
 * Frozen bake-off corpus for OG-H4 (§7.3). Test-only: gold annotations and
 * scenes are not imported by runtime planners.
 */
import type {
  OrganizePlannerBookmark,
  OrganizePlannerFolder,
  OrganizePlannerInput,
} from '../../../src/modules/collections/application/organize-planner.js';

export const ROOT_ID = 'root';
export const UNSORTED_ID = 'folder-unsorted';
export const READING_LATER_ID = 'folder-reading-later';
export const GITHUB_FOLDER_ID = 'folder-github';
export const WIKIPEDIA_FOLDER_ID = 'folder-wikipedia';
export const DOCS_FOLDER_ID = 'folder-docs';
export const INBOX_DECOY_FOLDER_ID = 'folder-inbox-decoy';

export const ROOT_BOOKMARK_IDS = ['bm-root-a', 'bm-root-b'] as const;

export const HOST_ALIGN_GITHUB_IDS = ['bm-gh-a', 'bm-gh-b', 'bm-gh-c'] as const;
export const HOST_ALIGN_WIKIPEDIA_IDS = ['bm-wiki-a', 'bm-wiki-b'] as const;
export const NEW_THEME_IDS = ['bm-arxiv-a', 'bm-arxiv-b', 'bm-arxiv-c', 'bm-arxiv-d'] as const;
export const NOISE_IDS = [
  'bm-noise-alpha',
  'bm-noise-bravo',
  'bm-noise-charlie',
  'bm-noise-delta',
  'bm-noise-echo',
] as const;
export const GUARD_GITHUB_IDS = ['bm-guard-gh-a', 'bm-guard-gh-b'] as const;

export type GoldStayTarget = { readonly type: 'stay' };
export type GoldExistingTarget = {
  readonly type: 'existing';
  readonly folderId: string;
  readonly title: string;
};
export type GoldCreateFolderTarget = {
  readonly type: 'create_folder';
  readonly title?: string;
};
export type GoldNodeTarget = GoldStayTarget | GoldExistingTarget | GoldCreateFolderTarget;

export interface BakeoffGoldCluster {
  readonly id: string;
  readonly nodeIds: readonly string[];
  readonly target: GoldExistingTarget | GoldCreateFolderTarget;
}

export interface BakeoffScene {
  readonly name: string;
  readonly input: OrganizePlannerInput;
  readonly goldByNodeId: Readonly<Record<string, GoldNodeTarget>>;
  readonly goldClusters: readonly BakeoffGoldCluster[];
  readonly rootBookmarkIds: readonly string[];
  readonly inboxDecoyFolderIds: readonly string[];
}

function folder(id: string, title: string, parentId = ROOT_ID): OrganizePlannerFolder {
  return { id, parentId, title };
}

function bookmark(
  id: string,
  parentId: string,
  title: string,
  url: string,
): OrganizePlannerBookmark {
  return { id, parentId, title, url };
}

const SHARED_NON_INBOX_FOLDERS: readonly OrganizePlannerFolder[] = [
  folder(GITHUB_FOLDER_ID, 'GitHub'),
  folder(WIKIPEDIA_FOLDER_ID, 'Wikipedia'),
  folder(DOCS_FOLDER_ID, 'Documentation'),
  folder(INBOX_DECOY_FOLDER_ID, 'Inbox'),
];

const ROOT_BOOKMARKS: readonly OrganizePlannerBookmark[] = [
  bookmark(ROOT_BOOKMARK_IDS[0], ROOT_ID, 'GitHub', 'https://github.com/root/should-not-appear-a'),
  bookmark(ROOT_BOOKMARK_IDS[1], ROOT_ID, 'Wikipedia', 'https://wikipedia.org/wiki/RootShouldNotAppear'),
];

function goldExisting(folderId: string, title: string): GoldExistingTarget {
  return { type: 'existing', folderId, title };
}

function goldCreateFolder(): GoldCreateFolderTarget {
  return { type: 'create_folder' };
}

function goldStay(): GoldStayTarget {
  return { type: 'stay' };
}

const hostAlignGoldGithub = goldExisting(GITHUB_FOLDER_ID, 'GitHub');
const hostAlignGoldWikipedia = goldExisting(WIKIPEDIA_FOLDER_ID, 'Wikipedia');

export const hostAlignScene: BakeoffScene = {
  name: 'host-align',
  input: {
    rootId: ROOT_ID,
    folders: [
      folder(UNSORTED_ID, 'Unsorted'),
      ...SHARED_NON_INBOX_FOLDERS,
    ],
    bookmarks: [
      bookmark(HOST_ALIGN_GITHUB_IDS[0], UNSORTED_ID, 'GitHub', 'https://github.com/org/one'),
      bookmark(HOST_ALIGN_GITHUB_IDS[1], UNSORTED_ID, 'GitHub', 'https://github.com/org/two'),
      bookmark(HOST_ALIGN_GITHUB_IDS[2], UNSORTED_ID, 'GitHub', 'https://github.com/org/three'),
      bookmark(HOST_ALIGN_WIKIPEDIA_IDS[0], UNSORTED_ID, 'Wikipedia', 'https://wikipedia.org/wiki/Alpha'),
      bookmark(HOST_ALIGN_WIKIPEDIA_IDS[1], UNSORTED_ID, 'Wikipedia', 'https://wikipedia.org/wiki/Beta'),
      ...ROOT_BOOKMARKS,
    ],
    inboxFolderIds: [UNSORTED_ID],
  },
  goldByNodeId: {
    [HOST_ALIGN_GITHUB_IDS[0]]: hostAlignGoldGithub,
    [HOST_ALIGN_GITHUB_IDS[1]]: hostAlignGoldGithub,
    [HOST_ALIGN_GITHUB_IDS[2]]: hostAlignGoldGithub,
    [HOST_ALIGN_WIKIPEDIA_IDS[0]]: hostAlignGoldWikipedia,
    [HOST_ALIGN_WIKIPEDIA_IDS[1]]: hostAlignGoldWikipedia,
    [ROOT_BOOKMARK_IDS[0]]: goldStay(),
    [ROOT_BOOKMARK_IDS[1]]: goldStay(),
  },
  goldClusters: [
    {
      id: 'host-align-github',
      nodeIds: HOST_ALIGN_GITHUB_IDS,
      target: hostAlignGoldGithub,
    },
    {
      id: 'host-align-wikipedia',
      nodeIds: HOST_ALIGN_WIKIPEDIA_IDS,
      target: hostAlignGoldWikipedia,
    },
  ],
  rootBookmarkIds: ROOT_BOOKMARK_IDS,
  inboxDecoyFolderIds: [INBOX_DECOY_FOLDER_ID],
};

export const newThemeScene: BakeoffScene = {
  name: 'new-theme',
  input: {
    rootId: ROOT_ID,
    folders: [
      folder(READING_LATER_ID, 'Reading later'),
      ...SHARED_NON_INBOX_FOLDERS,
    ],
    bookmarks: [
      bookmark(NEW_THEME_IDS[0], READING_LATER_ID, 'Paper one', 'https://arxiv.org/abs/1001'),
      bookmark(NEW_THEME_IDS[1], READING_LATER_ID, 'Paper two', 'https://arxiv.org/abs/1002'),
      bookmark(NEW_THEME_IDS[2], READING_LATER_ID, 'Paper three', 'https://arxiv.org/abs/1003'),
      bookmark(NEW_THEME_IDS[3], READING_LATER_ID, 'Paper four', 'https://arxiv.org/abs/1004'),
      ...ROOT_BOOKMARKS,
    ],
    inboxFolderIds: [READING_LATER_ID],
  },
  goldByNodeId: {
    [NEW_THEME_IDS[0]]: goldCreateFolder(),
    [NEW_THEME_IDS[1]]: goldCreateFolder(),
    [NEW_THEME_IDS[2]]: goldCreateFolder(),
    [NEW_THEME_IDS[3]]: goldCreateFolder(),
    [ROOT_BOOKMARK_IDS[0]]: goldStay(),
    [ROOT_BOOKMARK_IDS[1]]: goldStay(),
  },
  goldClusters: [
    {
      id: 'new-theme-arxiv',
      nodeIds: NEW_THEME_IDS,
      target: goldCreateFolder(),
    },
  ],
  rootBookmarkIds: ROOT_BOOKMARK_IDS,
  inboxDecoyFolderIds: [INBOX_DECOY_FOLDER_ID],
};

export const noiseScene: BakeoffScene = {
  name: 'noise',
  input: {
    rootId: ROOT_ID,
    folders: [
      folder(UNSORTED_ID, 'Unsorted'),
      ...SHARED_NON_INBOX_FOLDERS,
    ],
    bookmarks: [
      bookmark(NOISE_IDS[0], UNSORTED_ID, 'Alpha recipes', 'https://alpha.test/1'),
      bookmark(NOISE_IDS[1], UNSORTED_ID, 'Bravo music', 'https://bravo.dev/1'),
      bookmark(NOISE_IDS[2], UNSORTED_ID, 'Charlie photos', 'https://charlie.io/1'),
      bookmark(NOISE_IDS[3], UNSORTED_ID, 'Delta travel', 'https://delta.biz/1'),
      bookmark(NOISE_IDS[4], UNSORTED_ID, 'Echo sports', 'https://echo.club/1'),
      ...ROOT_BOOKMARKS,
    ],
    inboxFolderIds: [UNSORTED_ID],
  },
  goldByNodeId: {
    [NOISE_IDS[0]]: goldStay(),
    [NOISE_IDS[1]]: goldStay(),
    [NOISE_IDS[2]]: goldStay(),
    [NOISE_IDS[3]]: goldStay(),
    [NOISE_IDS[4]]: goldStay(),
    [ROOT_BOOKMARK_IDS[0]]: goldStay(),
    [ROOT_BOOKMARK_IDS[1]]: goldStay(),
  },
  goldClusters: [],
  rootBookmarkIds: ROOT_BOOKMARK_IDS,
  inboxDecoyFolderIds: [INBOX_DECOY_FOLDER_ID],
};

export const rootAndInboxGuardsScene: BakeoffScene = {
  name: 'root-and-inbox-guards',
  input: {
    rootId: ROOT_ID,
    folders: [
      folder(UNSORTED_ID, 'Unsorted'),
      ...SHARED_NON_INBOX_FOLDERS,
    ],
    bookmarks: [
      bookmark(GUARD_GITHUB_IDS[0], UNSORTED_ID, 'GitHub', 'https://github.com/guard/one'),
      bookmark(GUARD_GITHUB_IDS[1], UNSORTED_ID, 'GitHub', 'https://github.com/guard/two'),
      ...ROOT_BOOKMARKS,
    ],
    inboxFolderIds: [UNSORTED_ID],
  },
  goldByNodeId: {
    [GUARD_GITHUB_IDS[0]]: hostAlignGoldGithub,
    [GUARD_GITHUB_IDS[1]]: hostAlignGoldGithub,
    [ROOT_BOOKMARK_IDS[0]]: goldStay(),
    [ROOT_BOOKMARK_IDS[1]]: goldStay(),
  },
  goldClusters: [
    {
      id: 'guard-github',
      nodeIds: GUARD_GITHUB_IDS,
      target: hostAlignGoldGithub,
    },
  ],
  rootBookmarkIds: ROOT_BOOKMARK_IDS,
  inboxDecoyFolderIds: [INBOX_DECOY_FOLDER_ID],
};

export const BAKEOFF_SCENES: readonly BakeoffScene[] = [
  hostAlignScene,
  newThemeScene,
  noiseScene,
  rootAndInboxGuardsScene,
];
