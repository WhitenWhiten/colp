export interface OrganizePlannerFolder {
  readonly id: string;
  readonly parentId: string;
  readonly title: string;
}

export interface OrganizePlannerBookmark {
  readonly id: string;
  readonly parentId: string;
  readonly title: string;
  readonly url: string;
}

export interface OrganizePlannerInput {
  readonly rootId: string;
  readonly folders: readonly OrganizePlannerFolder[];
  readonly bookmarks: readonly OrganizePlannerBookmark[];
  readonly inboxFolderIds: readonly string[];
}

export type OrganizePlanTarget =
  | { readonly type: 'existing'; readonly folderId: string; readonly title: string }
  | { readonly type: 'create_folder'; readonly parentId: string; readonly title: string };

export interface OrganizePlanAction {
  readonly id: string;
  readonly sourceFolderId: string;
  readonly sourceFolderTitle: string;
  readonly target: OrganizePlanTarget;
  readonly nodeIds: readonly string[];
  /** Must equal `nodeIds.length` (documented; not enforced here). */
  readonly count: number;
  readonly reason: string;
  /** Integer 0–100. */
  readonly confidence: number;
}

export interface OrganizePlannerOutput {
  readonly plannerId: string;
  readonly truncated: boolean;
  readonly actions: readonly OrganizePlanAction[];
}

export interface OrganizePlanner {
  /** heuristic.v1.* */
  readonly id: string;
  plan(input: OrganizePlannerInput): Promise<OrganizePlannerOutput>;
}
