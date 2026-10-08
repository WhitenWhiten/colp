// Generated from openapi/product-v1.yaml. Do not edit.
import type { operations } from './product-v1.js';
export type AccountCredential = operations['getChildWithParentKey']['responses'][200]['content']['application/json'];
export type AccountCredentialIssued = operations['issueChildWithParentKey']['responses'][201]['content']['application/json'];
export type AccountCredentialPage = operations['listChildrenWithParentKey']['responses'][200]['content']['application/json'];
export type CreateAccountCredentialChildRequest = operations['issueChildWithParentKey']['requestBody']['content']['application/json'];
export type AccountKeyTokenRequest = operations['exchangeAccountKey']['requestBody']['content']['application/json'];
export type AccountKeyTokenResponse = operations['exchangeAccountKey']['responses'][200]['content']['application/json'];
export type AccountKeyTokenError = operations['exchangeAccountKey']['responses'][429]['content']['application/json'];
export type AccountCredentialIdentity = operations['getCredentialIdentity']['responses'][200]['content']['application/json'];
export type FollowRelation = operations['followProfile']['responses'][200]['content']['application/json'];
export type UnfollowRelation = operations['unfollowProfile']['responses'][200]['content']['application/json'];
export type CollectionFollowState = operations['getCollectionFollowState']['responses'][200]['content']['application/json'];
export type FollowedCollectionPage = operations['listFollowedCollections']['responses'][200]['content']['application/json'];
export type LibraryOrderView = operations['getMyLibraryOrder']['responses'][200]['content']['application/json'];
export type ReportSeries = operations['getReport']['responses'][200]['content']['application/json'];
export type ReportSeriesCreate = operations['createReport']['requestBody']['content']['application/json'];
export type ReportSeriesPatch = operations['updateReport']['requestBody']['content']['application/merge-patch+json'];
export type ReportEdition = operations['getReportIssue']['responses'][200]['content']['application/json'];
export type ReportEditionPage = operations['listReportIssues']['responses'][200]['content']['application/json'];
export type ReportEditionAttach = operations['attachReportIssue']['requestBody']['content']['application/json'];
export type ReportEditionPatch = operations['updateReportIssue']['requestBody']['content']['application/merge-patch+json'];
export type ReportMemberPage = operations['listReportMembers']['responses'][200]['content']['application/json'];
export type ReportMember = operations['updateReportMember']['responses'][200]['content']['application/json'];
export type ReportMemberMutation = operations['updateReportMember']['requestBody']['content']['application/json'];
export type ReportScheduleInput = operations['putReportSchedule']['requestBody']['content']['application/json'];
export type ReportFollowState = operations['getReportFollowState']['responses'][200]['content']['application/json'];
export type ReportSeriesPage = operations['listMyReports']['responses'][200]['content']['application/json'];
export type ReportIssueTimelinePage = operations['listFollowedReportIssues']['responses'][200]['content']['application/json'];
export type ReportTimelineSeries = ReportIssueTimelinePage['items'][number]['series'];
export type ReportSchedule = operations['putReportSchedule']['responses'][200]['content']['application/json'];
export type ReportScheduleEnvelope = operations['getReportSchedule']['responses'][200]['content']['application/json'];
export type PublicReportPage = operations['listPublicReports']['responses'][200]['content']['application/json'];
export type PublicReportSeries = operations['getPublicReport']['responses'][200]['content']['application/json'];
export type PublicReportIssuePage = operations['listPublicReportIssues']['responses'][200]['content']['application/json'];
export type PublicReportIssue = operations['getPublicReportIssue']['responses'][200]['content']['application/json'];
export type LibraryOrderSectionView = operations['updateMyLibraryOrder']['responses'][200]['content']['application/json'];
export type LibraryOrderUpdateRequest = operations['updateMyLibraryOrder']['requestBody']['content']['application/json'];
export type LibraryOrderSectionName = LibraryOrderSectionView['section'];
export type GovernanceCatalog = operations['getCollectionCatalog']['responses'][200]['content']['application/json'];
export type GovernanceCatalogPatch = operations['updateCollectionCatalog']['requestBody']['content']['application/merge-patch+json'];
export type GovernanceCatalogPreferences = operations['getMyCatalogPreferences']['responses'][200]['content']['application/json'];
export type GovernanceCatalogPreferencesPatch = operations['updateMyCatalogPreferences']['requestBody']['content']['application/json'];
export type GovernanceReportInput = operations['submitModerationReport']['requestBody']['content']['application/json'];
export type GovernanceTarget = GovernanceReportInput['target'];
export type GovernanceMyCase = operations['submitModerationReport']['responses'][201]['content']['application/json'];
export type GovernanceMyCasePage = operations['listMyModerationReports']['responses'][200]['content']['application/json'];
export type GovernanceOfficialCase = operations['getModerationCase']['responses'][200]['content']['application/json'];
export type GovernanceOfficialCasePage = operations['listModerationCases']['responses'][200]['content']['application/json'];
export type GovernanceEvidence = operations['getModerationEvidence']['responses'][200]['content']['application/json'];
export type GovernanceCasePatch = operations['updateModerationCase']['requestBody']['content']['application/json'];
export type GovernanceActionInput = operations['createModerationAction']['requestBody']['content']['application/json'];
export type GovernanceAction = operations['createModerationAction']['responses'][201]['content']['application/json'];
export type GovernanceMyActionPage = operations['listActionsAffectingMe']['responses'][200]['content']['application/json'];
export type GovernanceMyAction = GovernanceMyActionPage['items'][number];
export type GovernanceAppealInput = operations['createModerationAppeal']['requestBody']['content']['application/json'];
export type GovernanceAppeal = operations['createModerationAppeal']['responses'][201]['content']['application/json'];
export type GovernanceAppealPage = operations['listMyModerationAppeals']['responses'][200]['content']['application/json'];
export type GovernanceAppealDecision = operations['decideModerationAppeal']['requestBody']['content']['application/json'];
export type FollowPage = operations['listProfileFollowers']['responses'][200]['content']['application/json'];
export type FollowingPage = operations['listProfileFollowing']['responses'][200]['content']['application/json'];
export type ProductFeedPage = operations['getProductFeed']['responses'][200]['content']['application/json'];
export type WriteApprovalPage = operations['listWriteApprovals']['responses'][200]['content']['application/json'];
export type WriteApprovalView = operations['getWriteApproval']['responses'][200]['content']['application/json'];
export type WriteApprovalDecisionResult = operations['decideWriteApproval']['responses'][200]['content']['application/json'];
export type NotificationInboxPage = operations['listNotifications']['responses'][200]['content']['application/json'];
export type NotificationReadResult = operations['markNotificationRead']['responses'][200]['content']['application/json'];
export type NotificationBulkReadResult = operations['markNotificationsRead']['responses'][200]['content']['application/json'];
export type NotificationPreference = operations['getNotificationPreferences']['responses'][200]['content']['application/json'];
export type NotificationPreferenceUpdateResult = operations['updateNotificationPreference']['responses'][200]['content']['application/json'];
export type MyFeedPage = operations['listMyFeed']['responses'][200]['content']['application/json'];
export type MyNotificationPage = operations['listMyNotifications']['responses'][200]['content']['application/json'];
export type MyMarkNotificationsReadResult = operations['markMyNotificationsRead']['responses'][200]['content']['application/json'];
export type MyNotificationPreferences = operations['getMyNotificationPreferences']['responses'][200]['content']['application/json'];
export type MyNotificationPreferenceUpdateResult = operations['updateMyNotificationPreferences']['responses'][200]['content']['application/json'];
export type CommunityTarget = operations['resolveCommunityTarget']['responses'][200]['content']['application/json']['target'];
export type CommunityTargetView = operations['resolveCommunityTarget']['responses'][200]['content']['application/json'];
export type CommunityVoteState = operations['setCommunityVote']['responses'][200]['content']['application/json'];
export type CommunityVoteRequest = operations['setCommunityVote']['requestBody']['content']['application/json'];
export type CommunityRankingPage = operations['listCommunityRanking']['responses'][200]['content']['application/json'];
export type CommunityRankingItem = CommunityRankingPage['items'][number];
export type CommunityRankingQuery = NonNullable<operations['listCommunityRanking']['parameters']['query']>;
export type CommunityCommentPage = operations['listCommunityComments']['responses'][200]['content']['application/json'];
export type CommunityComment = CommunityCommentPage['items'][number];
export type CommunityCreateComment = operations['createCommunityComment']['requestBody']['content']['application/json'];
export type CommunityEditComment = operations['editCommunityComment']['requestBody']['content']['application/json'];
export type CommunityCuration = operations['getCommentCuration']['responses'][200]['content']['application/json'];
export type CommunityPutCuration = operations['setCommentCuration']['requestBody']['content']['application/json'];
export type CommunityCommentSettings = operations['getCommunityCommentSettings']['responses'][200]['content']['application/json'];
export type CommunityPutCommentSettings = operations['setCommunityCommentSettings']['requestBody']['content']['application/json'];
export type CommunityCommentsQuery = NonNullable<operations['listCommunityComments']['parameters']['query']>;
export type CommunityCommentRepliesQuery = NonNullable<operations['listCommunityCommentReplies']['parameters']['query']>;
export type CommunityCommentSettingsQuery = NonNullable<operations['getCommunityCommentSettings']['parameters']['query']>;
/** CS-04 mutations return the representation plus its fresh ETag for If-Match chaining. */
export interface CommunityEntityResult<T> { readonly data: T; readonly etag: string | null }
export type CommunityNotificationInbox = operations['listMyCommunityNotifications']['responses'][200]['content']['application/json'];
export type CommunityNotification = CommunityNotificationInbox['items'][number];
export type CommunityNotificationsQuery = NonNullable<operations['listMyCommunityNotifications']['parameters']['query']>;
export type CommunityReadNotifications = operations['markMyCommunityNotificationsRead']['requestBody']['content']['application/json'];
export type CommunityReadNotificationsResult = operations['markMyCommunityNotificationsRead']['responses'][200]['content']['application/json'];
export type CommunityNotificationPreference = operations['getMyCommunityNotificationPreference']['responses'][200]['content']['application/json'];
export type CommunityPutNotificationPreference = operations['putMyCommunityNotificationPreference']['requestBody']['content']['application/json'];
export interface ProductFollowClientOptions { readonly origin: string; readonly csrfToken: string; readonly sessionCookie?: string; readonly originHeader?: string; readonly fetch?: typeof globalThis.fetch; }
export function createProductFollowClient(options: ProductFollowClientOptions) {
  const transport = options.fetch ?? globalThis.fetch;
  const request = async <T>(path: string, init: RequestInit): Promise<T> => {
    const response = await transport(new URL(path, options.origin), init);
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error('Product Follow request failed'), { status: response.status, problem: body, headers: response.headers });
    return body as T;
  };
  const sessionHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {};
    if (options.sessionCookie !== undefined) headers.Cookie = options.sessionCookie;
    return headers;
  };
  const mutationHeaders = (commandId: string): Record<string, string> => {
    const headers: Record<string, string> = { ...sessionHeaders(), 'X-CSRF-Token': options.csrfToken, 'Known-Command-Id': commandId };
    if (options.originHeader !== undefined) headers.Origin = options.originHeader;
    return headers;
  };
  const mutation = <Result extends FollowRelation | UnfollowRelation>(profileId: string, method: 'PUT'|'DELETE', commandId: string) => request<Result>(`/api/v1/profiles/${encodeURIComponent(profileId)}/follow`, { method, credentials: 'include', headers: mutationHeaders(commandId) });
  const page = <Result extends FollowPage | FollowingPage>(profileId: string, direction: 'followers'|'following', query: { cursor?: string; limit?: number } = {}) => {
    const params = new URLSearchParams(); if (query.cursor !== undefined) params.set('cursor', query.cursor); if (query.limit !== undefined) params.set('limit', String(query.limit));
    return request<Result>(`/api/v1/profiles/${encodeURIComponent(profileId)}/${direction}${params.size ? `?${params}` : ''}`, { credentials: 'include', headers: sessionHeaders() });
  };
  return Object.freeze({ follow: (profileId: string, commandId: string) => mutation<FollowRelation>(profileId, 'PUT', commandId), unfollow: (profileId: string, commandId: string) => mutation<UnfollowRelation>(profileId, 'DELETE', commandId), followers: (profileId: string, query?: { cursor?: string; limit?: number }) => page<FollowPage>(profileId, 'followers', query), following: (profileId: string, query?: { cursor?: string; limit?: number }) => page<FollowingPage>(profileId, 'following', query) });
}
export function createProductCollectionFollowClient(options: ProductFollowClientOptions) {
  const transport = options.fetch ?? globalThis.fetch;
  const request = async <T>(path: string, init: RequestInit): Promise<T> => {
    const response = await transport(new URL(path, options.origin), init);
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error('Product Collection Follow request failed'), { status: response.status, problem: body, headers: response.headers });
    return body as T;
  };
  const sessionHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {};
    if (options.sessionCookie !== undefined) headers.Cookie = options.sessionCookie;
    return headers;
  };
  const mutationHeaders = (commandId: string): Record<string, string> => {
    const headers: Record<string, string> = { ...sessionHeaders(), 'X-CSRF-Token': options.csrfToken, 'Known-Command-Id': commandId };
    if (options.originHeader !== undefined) headers.Origin = options.originHeader;
    return headers;
  };
  const collectionPath = (collectionId: string) => `/api/v1/collections/${encodeURIComponent(collectionId)}/follow`;
  const list = (query: { cursor?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    else if (query.limit !== undefined) params.set('limit', String(query.limit));
    return request<FollowedCollectionPage>(`/api/v1/me/followed-collections${params.size ? `?${params}` : ''}`, { credentials: 'include', headers: sessionHeaders() });
  };
  return Object.freeze({
    follow: (collectionId: string, commandId: string) => request<CollectionFollowState>(collectionPath(collectionId), { method: 'PUT', credentials: 'include', headers: mutationHeaders(commandId) }),
    unfollow: (collectionId: string, commandId: string) => request<CollectionFollowState>(collectionPath(collectionId), { method: 'DELETE', credentials: 'include', headers: mutationHeaders(commandId) }),
    state: (collectionId: string) => request<CollectionFollowState>(collectionPath(collectionId), { credentials: 'include', headers: sessionHeaders() }),
    list,
  });
}
export type CreditOverview = operations['getMyCredits']['responses'][200]['content']['application/json'];
export type CreditLedgerPage = operations['listMyCreditLedger']['responses'][200]['content']['application/json'];
export type CreditLedgerEntryResponse = operations['getMyCreditLedgerEntry']['responses'][200]['content']['application/json'];
export type CreditLedgerQuery = NonNullable<operations['listMyCreditLedger']['parameters']['query']>;
export function createProductCreditsClient(options: Pick<ProductFollowClientOptions, 'origin' | 'fetch' | 'sessionCookie'>) {
  const transport = options.fetch ?? globalThis.fetch;
  const request = async <T>(path: string, signal?: AbortSignal): Promise<T> => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.sessionCookie !== undefined) headers.Cookie = options.sessionCookie;
    const response = await transport(new URL(path, options.origin), { method: 'GET', headers, credentials: 'include', cache: 'no-store', signal });
    const body: unknown = await response.json();
    if (!response.ok) throw Object.assign(new Error('Credit request failed'), {status: response.status, problem: body, headers: response.headers});
    return body as T;
  };
  return Object.freeze({
    overview: (signal?: AbortSignal, query: NonNullable<operations['getMyCredits']['parameters']['query']> = {}) =>
      request<CreditOverview>('/api/v1/me/credits' + (query.includeBillingMode ? '?includeBillingMode=true' : ''), signal),
    ledger: (query: CreditLedgerQuery = {}, signal?: AbortSignal) => {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) if (value !== undefined) search.set(key, String(value));
      return request<CreditLedgerPage>('/api/v1/me/credits/ledger?' + search.toString(), signal);
    },
    entry: (entryId: string, signal?: AbortSignal) => request<CreditLedgerEntryResponse>('/api/v1/me/credits/ledger/' + encodeURIComponent(entryId), signal),
  });
}
export type ClassificationSettingsV2 = operations['getCollectionClassificationSettings']['responses'][200]['content']['application/vnd.known.classification-settings.v2+json'];
export type ClassificationSettingsPatchV2 = operations['updateCollectionClassificationSettings']['requestBody']['content']['application/vnd.known.classification-settings.v2+json'];
export type ClassificationProviderProfile = operations['createMyClassificationProviderProfile']['responses'][201]['content']['application/json'];
export type ClassificationProviderProfileCreate = operations['createMyClassificationProviderProfile']['requestBody']['content']['application/json'];
export type ClassificationProviderProfilePatch = operations['updateMyClassificationProviderProfile']['requestBody']['content']['application/json'];
export type TestClassificationProviderProfileResponse = operations['testMyClassificationProviderProfile']['responses'][200]['content']['application/json'];
export function createProductClassificationProfilesClient(options: ProductFollowClientOptions) {
  const transport = options.fetch ?? globalThis.fetch;
  const request = async <T>(method: string, suffix: string, document?: unknown, commandId?: string, ifMatch?: string): Promise<T> => {
    const headers: Record<string, string> = {};
    if (options.sessionCookie !== undefined) headers.Cookie = options.sessionCookie;
    if (method !== 'GET') {
      headers['X-CSRF-Token'] = options.csrfToken; headers['Known-Command-Id'] = commandId!;
      if (options.originHeader !== undefined) headers.Origin = options.originHeader;
      if (ifMatch !== undefined) headers['If-Match'] = ifMatch;
      if (document !== undefined) headers['Content-Type'] = 'application/json';
    }
    const response = await transport(new URL('/api/v1/me/classification-provider-profiles' + suffix, options.origin),
      {method, headers, credentials:'include', ...(document === undefined ? {} : {body:JSON.stringify(document)})});
    const body = response.status === 204 ? undefined : await response.json();
    if (!response.ok) throw Object.assign(new Error('Classification profile request failed'), {status:response.status, problem:body, headers:response.headers});
    return body as T;
  };
  return Object.freeze({
    list: () => request<{profiles:ClassificationProviderProfile[]}>('GET', ''),
    create: (document:ClassificationProviderProfileCreate, commandId:string) => request<ClassificationProviderProfile>('POST','',document,commandId),
    update: (id:string, document:ClassificationProviderProfilePatch, commandId:string, ifMatch:string) => request<ClassificationProviderProfile>('PATCH','/'+encodeURIComponent(id),document,commandId,ifMatch),
    delete: (id:string, commandId:string, ifMatch:string) => request<void>('DELETE','/'+encodeURIComponent(id),undefined,commandId,ifMatch),
    test: (id:string, commandId:string) => request<TestClassificationProviderProfileResponse>('POST','/'+encodeURIComponent(id)+'/test',undefined,commandId),
  });
}
export type ClassificationSettings = operations['getCollectionClassificationSettings']['responses'][200]['content']['application/json'];
export type BookmarkPreferences = operations['getMyBookmarkPreferences']['responses'][200]['content']['application/json'];
export type BookmarkPreferencesPatch = operations['updateMyBookmarkPreferences']['requestBody']['content']['application/json'];
export function createProductBookmarkPreferencesClient(options: ProductFollowClientOptions) {
  const request = async (patch?: BookmarkPreferencesPatch, commandId?: string, ifMatch?: string) => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.sessionCookie !== undefined) headers.Cookie = options.sessionCookie;
    if (patch) {
      headers['Content-Type'] = 'application/json'; headers['X-CSRF-Token'] = options.csrfToken;
      headers['Known-Command-Id'] = commandId!; headers['If-Match'] = ifMatch!;
      if (options.originHeader !== undefined) headers.Origin = options.originHeader;
    }
    const response = await (options.fetch ?? globalThis.fetch)(new URL('/api/v1/me/bookmark-preferences', options.origin),
      { method: patch ? 'PATCH' : 'GET', headers, credentials: 'include', cache: 'no-store', redirect: 'error',
        ...(patch ? { body: JSON.stringify(patch) } : {}) });
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error('Bookmark preferences request failed'), { status: response.status, problem: body, headers: response.headers });
    return { preferences: body as BookmarkPreferences, etag: response.headers.get('etag') };
  };
  return { read: () => request(), patch: (patch: BookmarkPreferencesPatch, commandId: string, ifMatch: string) => request(patch, commandId, ifMatch) };
}

export type ClassificationSettingsPatch = operations['updateCollectionClassificationSettings']['requestBody']['content']['application/json'];
export type ClassificationPreviewRequest = operations['previewCollectionBookmarkClassification']['requestBody']['content']['application/json'];
export type ClassificationPreviewResponse = operations['previewCollectionBookmarkClassification']['responses'][200]['content']['application/json'];
export type ClassificationConfirmationRequest = operations['confirmCollectionBookmarkClassification']['requestBody']['content']['application/json'];
export type ClassificationConfirmationResponse = operations['confirmCollectionBookmarkClassification']['responses'][200]['content']['application/json'];
export type ClassificationInboxAcceptRequest = operations['acceptMyClassifyInboxItem']['requestBody']['content']['application/json'];
export type ClassificationInboxAcceptReceipt = operations['acceptMyClassifyInboxItem']['responses'][200]['content']['application/json'];
export type ClassificationRun = operations['getCollectionClassificationRun']['responses'][200]['content']['application/json'];
export type ClassificationRunCreateRequest = operations['createCollectionClassificationRun']['requestBody']['content']['application/json'];
export type ClassificationRunApplyRequest = operations['applyCollectionClassificationRun']['requestBody']['content']['application/json'];
export type ClassificationRunApplyResponse = operations['applyCollectionClassificationRun']['responses'][200]['content']['application/json'];
export function createProductClassificationClient(options: ProductFollowClientOptions) {
  const transport = options.fetch ?? globalThis.fetch;
  const path = (collectionId: string) => '/api/v1/collections/' + encodeURIComponent(collectionId) + '/classification-settings';
  const request = async <T = ClassificationSettings>(collectionId: string, method: 'GET' | 'PATCH', patch?: ClassificationSettingsPatch | ClassificationSettingsPatchV2, commandId?: string, ifMatch?: string, v2 = false) => {
    const headers: Record<string, string> = {};
    if (options.sessionCookie !== undefined) headers.Cookie = options.sessionCookie;
    if (v2) headers.Accept = 'application/vnd.known.classification-settings.v2+json';
    if (method === 'PATCH') {
      headers['Content-Type'] = v2 ? 'application/vnd.known.classification-settings.v2+json' : 'application/json'; headers['X-CSRF-Token'] = options.csrfToken;
      headers['Known-Command-Id'] = commandId!; headers['If-Match'] = ifMatch!;
      if (options.originHeader !== undefined) headers.Origin = options.originHeader;
    }
    const response = await transport(new URL(path(collectionId), options.origin), {method, headers, credentials: 'include', ...(patch ? {body: JSON.stringify(patch)} : {})});
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error('Classification settings request failed'), {status: response.status, problem: body, headers: response.headers});
    return {settings: body as T, etag: response.headers.get('etag')};
  };
  const runRequest = async <Result = ClassificationRun>(collectionId: string, suffix: string, document?: unknown, commandId?: string, ifMatch?: string): Promise<Result> => {
    const headers: Record<string, string> = {};
    if (options.sessionCookie !== undefined) headers.Cookie = options.sessionCookie;
    if (options.originHeader !== undefined) headers.Origin = options.originHeader;
    if (document !== undefined) {
      headers['Content-Type'] = 'application/json'; headers['X-CSRF-Token'] = options.csrfToken; headers['Known-Command-Id'] = commandId!;
      if (ifMatch !== undefined) headers['If-Match'] = ifMatch;
    }
    const url = new URL('/api/v1/collections/' + encodeURIComponent(collectionId) + '/classification-runs' + suffix, options.origin);
    const response = await transport(url, {method: document === undefined ? 'GET' : 'POST', headers, credentials: 'include',
      ...(document === undefined ? {} : {body: JSON.stringify(document)})});
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error('Classification run request failed'), {status: response.status, problem: body, headers: response.headers});
    return body as Result;
  };
  return Object.freeze({
    applyRun: (collectionId: string, runId: string, document: ClassificationRunApplyRequest, commandId: string, ifMatch: string) => runRequest<ClassificationRunApplyResponse>(collectionId, '/' + encodeURIComponent(runId) + '/apply', document, commandId, ifMatch),
    createRun: (collectionId: string, document: ClassificationRunCreateRequest, commandId: string) => runRequest(collectionId, '', document, commandId),
    getRun: (collectionId: string, runId: string) => runRequest(collectionId, '/' + encodeURIComponent(runId)),
    cancelRun: (collectionId: string, runId: string, commandId: string, ifMatch: string) => runRequest(collectionId, '/' + encodeURIComponent(runId) + '/cancel', {}, commandId, ifMatch),

    preview: async (collectionId: string, document: ClassificationPreviewRequest, commandId: string): Promise<ClassificationPreviewResponse> => {
      const headers: Record<string, string> = {'Content-Type': 'application/json', 'X-CSRF-Token': options.csrfToken, 'Known-Command-Id': commandId};
      if (options.sessionCookie !== undefined) headers.Cookie = options.sessionCookie;
      if (options.originHeader !== undefined) headers.Origin = options.originHeader;
      const url = new URL('/api/v1/collections/' + encodeURIComponent(collectionId) + '/classification/preview', options.origin);
      const response = await transport(url, {method: 'POST', headers, credentials: 'include', body: JSON.stringify(document)});
      const body = await response.json();
      if (!response.ok) throw Object.assign(new Error('Classification preview failed'), {status: response.status, problem: body, headers: response.headers});
      return body as ClassificationPreviewResponse;
    },
    confirm: async (collectionId: string, nodeId: string, document: ClassificationConfirmationRequest, commandId: string, ifMatch: string): Promise<ClassificationConfirmationResponse> => {
      const headers: Record<string, string> = {'Content-Type': 'application/json', 'X-CSRF-Token': options.csrfToken, 'Known-Command-Id': commandId, 'If-Match': ifMatch};
      if (options.sessionCookie !== undefined) headers.Cookie = options.sessionCookie;
      if (options.originHeader !== undefined) headers.Origin = options.originHeader;
      const url = new URL('/api/v1/collections/' + encodeURIComponent(collectionId) + '/nodes/' + encodeURIComponent(nodeId) + '/classification-confirmations', options.origin);
      const response = await transport(url, {method: 'POST', headers, credentials: 'include', body: JSON.stringify(document)});
      const body = await response.json();
      if (!response.ok) throw Object.assign(new Error('Classification confirmation failed'), {status: response.status, problem: body, headers: response.headers});
      return body as ClassificationConfirmationResponse;
    },
    acceptInbox: async (nodeId: string, document: ClassificationInboxAcceptRequest, commandId: string, ifMatch: string): Promise<ClassificationInboxAcceptReceipt> => {
      const headers: Record<string, string> = {'Content-Type': 'application/json', 'X-CSRF-Token': options.csrfToken, 'Known-Command-Id': commandId, 'If-Match': ifMatch};
      if (options.sessionCookie !== undefined) headers.Cookie = options.sessionCookie;
      if (options.originHeader !== undefined) headers.Origin = options.originHeader;
      const response = await transport(new URL('/api/v1/me/classify-inbox/' + encodeURIComponent(nodeId) + '/accept', options.origin),
        {method: 'POST', headers, credentials: 'include', body: JSON.stringify(document)});
      const body = await response.json();
      if (!response.ok) throw Object.assign(new Error('Classification inbox accept failed'), {status: response.status, problem: body, headers: response.headers});
      return body as ClassificationInboxAcceptReceipt;
    },
    settingsV2: (collectionId: string) => request<ClassificationSettingsV2>(collectionId, 'GET', undefined, undefined, undefined, true),
    updateSettingsV2: (collectionId: string, patch: ClassificationSettingsPatchV2, commandId: string, ifMatch: string) => request<ClassificationSettingsV2>(collectionId, 'PATCH', patch, commandId, ifMatch, true),
    settings: (collectionId: string) => request(collectionId, 'GET'),
    updateSettings: (collectionId: string, patch: ClassificationSettingsPatch, commandId: string, ifMatch: string) => request(collectionId, 'PATCH', patch, commandId, ifMatch),
  });
}
export function createProductLibraryOrderClient(options: ProductFollowClientOptions) {
  const transport = options.fetch ?? globalThis.fetch;
  const request = async <T>(path: string, init: RequestInit): Promise<T> => {
    const response = await transport(new URL(path, options.origin), init);
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error('Product Library order request failed'), { status: response.status, problem: body, headers: response.headers });
    return body as T;
  };
  const sessionHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {};
    if (options.sessionCookie !== undefined) headers.Cookie = options.sessionCookie;
    return headers;
  };
  const mutationHeaders = (commandId: string): Record<string, string> => {
    const headers: Record<string, string> = { ...sessionHeaders(), 'X-CSRF-Token': options.csrfToken, 'Known-Command-Id': commandId, 'Content-Type': 'application/json' };
    if (options.originHeader !== undefined) headers.Origin = options.originHeader;
    return headers;
  };
  return Object.freeze({
    get: () => request<LibraryOrderView>('/api/v1/me/library-order', { credentials: 'include', headers: sessionHeaders() }),
    update: (section: LibraryOrderSectionName, body: LibraryOrderUpdateRequest, commandId: string) =>
      request<LibraryOrderSectionView>(`/api/v1/me/library-order/${encodeURIComponent(section)}`, { method: 'PUT', credentials: 'include', headers: mutationHeaders(commandId), body: JSON.stringify(body) }),
  });
}
export interface ProductNotificationClientOptions { readonly origin: string; readonly csrfToken: string; readonly sessionCookie?: string; readonly originHeader?: string; readonly fetch?: typeof globalThis.fetch; }
export function createProductNotificationClient(options: ProductNotificationClientOptions) {
  const transport = options.fetch ?? globalThis.fetch;
  const sessionHeaders = (): Record<string, string> => options.sessionCookie === undefined ? {} : { Cookie: options.sessionCookie };
  const mutationHeaders = (commandId: string, revision?: string): Record<string, string> => {
    const headers: Record<string, string> = { ...sessionHeaders(), 'X-CSRF-Token': options.csrfToken, 'Known-Command-Id': commandId };
    if (options.originHeader !== undefined) headers.Origin = options.originHeader;
    if (revision !== undefined) headers['If-Match'] = revision;
    return headers;
  };
  const request = async <T>(path: string, init: RequestInit): Promise<T> => {
    const response = await transport(new URL(path, options.origin), { credentials: 'include', ...init });
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error('Product Notification request failed'), { status: response.status, problem: body, headers: response.headers });
    return body as T;
  };
  return Object.freeze({
    notifications: (query: { state?: 'all'|'read'|'unread'; cursor?: string; limit?: number } = {}) => {
      const params = new URLSearchParams();
      if (query.state !== undefined) params.set('state', query.state);
      if (query.cursor !== undefined) params.set('cursor', query.cursor);
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      return request<NotificationInboxPage>('/api/v1/notifications' + (params.size ? '?' + params : ''), { headers: sessionHeaders() });
    },
    markOne: (notificationId: string, stateRevision: string, commandId: string) =>
      request<NotificationReadResult>('/api/v1/notifications/' + encodeURIComponent(notificationId) + '/read',
        { method: 'PUT', headers: mutationHeaders(commandId, '"notification:' + stateRevision + '"') }),
    markMany: (notificationIds: readonly string[], commandId: string) =>
      request<NotificationBulkReadResult>('/api/v1/notifications/read', { method: 'POST',
        headers: { ...mutationHeaders(commandId), 'Content-Type': 'application/json' }, body: JSON.stringify({ notificationIds }) }),
    preferences: () => request<NotificationPreference>('/api/v1/notification-preferences', { headers: sessionHeaders() }),
    updatePreference: (channel: 'in_app'|'email', value: { readonly mode: 'set'; readonly enabled: boolean } | { readonly mode: 'reset' },
      revision: string, commandId: string) => request<NotificationPreferenceUpdateResult>('/api/v1/notification-preferences/' + encodeURIComponent(channel),
      { method: 'PUT', headers: { ...mutationHeaders(commandId, '"notification-preference:' + channel + ':' + revision + '"'),
        'Content-Type': 'application/json' }, body: JSON.stringify(value) }),
    myNotifications: (query: { read?: boolean; cursor?: string; limit?: number } = {}) => {
      const params = new URLSearchParams();
      if (query.read !== undefined) params.set('read', String(query.read));
      if (query.cursor !== undefined) params.set('cursor', query.cursor);
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      return request<MyNotificationPage>('/api/v1/me/notifications' + (params.size ? '?' + params : ''), { headers: sessionHeaders() });
    },
    markMyNotificationsRead: (notificationIds: readonly string[], commandId: string) =>
      request<MyMarkNotificationsReadResult>('/api/v1/me/notifications/read', { method: 'POST',
        headers: { ...mutationHeaders(commandId), 'Content-Type': 'application/json' }, body: JSON.stringify({ notificationIds }) }),
    myNotificationPreferences: () => request<MyNotificationPreferences>('/api/v1/me/notification-preferences', { headers: sessionHeaders() }),
    updateMyNotificationPreferences: (value: { readonly revision: string; readonly inAppNewFollower: boolean; readonly inAppFollowedCollectionChanged: boolean },
      commandId: string) => request<MyNotificationPreferenceUpdateResult>('/api/v1/me/notification-preferences',
      { method: 'PUT', headers: { ...mutationHeaders(commandId), 'Content-Type': 'application/json' }, body: JSON.stringify(value) }),
  });
}
export interface ProductFeedClientOptions { readonly origin: string; readonly sessionCookie?: string; readonly fetch?: typeof globalThis.fetch; }
export function createProductFeedClient(options: ProductFeedClientOptions) {
  const transport = options.fetch ?? globalThis.fetch;
  return Object.freeze({ feed: async (query: { kind?: 'collection_change'|'follow_activity'; cursor?: string; limit?: number } = {}): Promise<ProductFeedPage> => {
    const params = new URLSearchParams();
    if (query.kind !== undefined) params.set('kind', query.kind);
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const headers: Record<string, string> = {};
    if (options.sessionCookie !== undefined) headers.Cookie = options.sessionCookie;
    const response = await transport(new URL(`/api/v1/feed${params.size ? `?${params}` : ''}`, options.origin),
      { credentials: 'include', headers });
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error('Product Feed request failed'),
      { status: response.status, problem: body, headers: response.headers });
    return body as ProductFeedPage;
  }, myFeed: async (query: { kind?: 'collection_change'|'follow_activity'; cursor?: string; limit?: number } = {}): Promise<MyFeedPage> => {
    const params = new URLSearchParams();
    if (query.kind !== undefined) params.set('kind', query.kind);
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const headers: Record<string, string> = {};
    if (options.sessionCookie !== undefined) headers.Cookie = options.sessionCookie;
    const response = await transport(new URL(`/api/v1/me/feed${params.size ? `?${params}` : ''}`, options.origin),
      { credentials: 'include', headers });
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error('Product Feed request failed'),
      { status: response.status, problem: body, headers: response.headers });
    return body as MyFeedPage;
  } });
}
export interface ProductWriteApprovalClientOptions { readonly origin: string; readonly csrfToken: string; readonly sessionCookie?: string; readonly originHeader?: string; readonly fetch?: typeof globalThis.fetch; }
export function createProductWriteApprovalClient(options: ProductWriteApprovalClientOptions) {
  const transport = options.fetch ?? globalThis.fetch;
  const sessionHeaders = (): Record<string, string> => options.sessionCookie === undefined ? {} : { Cookie: options.sessionCookie };
  const approvalHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = { ...sessionHeaders(), 'X-CSRF-Token': options.csrfToken };
    if (options.originHeader !== undefined) headers.Origin = options.originHeader;
    return headers;
  };
  const request = async <T>(path: string, init: RequestInit): Promise<T> => {
    const response = await transport(new URL(path, options.origin), { credentials: 'include', ...init });
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error('Product Write Approval request failed'), { status: response.status, problem: body, headers: response.headers });
    return body as T;
  };
  return Object.freeze({
    approvals: async (query: { limit?: number } = {}): Promise<WriteApprovalPage> => {
      const params = new URLSearchParams(); if (query.limit !== undefined) params.set('limit', String(query.limit));
      return request<WriteApprovalPage>('/api/v1/mcp/approvals' + (params.size ? '?' + params : ''), { headers: sessionHeaders() });
    },
    approval: (planId: string) => request<WriteApprovalView>(`/api/v1/mcp/approvals/${encodeURIComponent(planId)}`, { headers: sessionHeaders() }),
    decide: (planId: string, decision: 'approve'|'deny', etag: string, commandId: string) =>
      request<WriteApprovalDecisionResult>(`/api/v1/mcp/approvals/${encodeURIComponent(planId)}/decision`,
        { method: 'POST', headers: { ...approvalHeaders(), 'Known-Command-Id': commandId, 'If-Match': etag, 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }) }),
  });
}
export type AttachmentIssueResult = operations['issueAttachmentUpload']['responses'][201]['content']['application/json'];
export type AttachmentCompleteResult = operations['completeAttachmentUpload']['responses'][200]['content']['application/json'];
export type AttachmentStatus = operations['getAttachmentStatus']['responses'][200]['content']['application/json'];
export type AttachmentFinalizeResult = operations['finalizeAttachment']['responses'][200]['content']['application/json'];
export type AttachmentRetireResult = operations['retireAttachment']['responses'][200]['content']['application/json'];
export type AttachmentDownloadAdmission = operations['admitAttachmentDownload']['responses'][200]['content']['application/json'];
export type AttachmentProblem = operations['issueAttachmentUpload']['responses'][503]['content']['application/json'];
export interface ProductAttachmentClientOptions { readonly origin: string; readonly csrfToken: string; readonly sessionCookie?: string; readonly originHeader?: string; readonly fetch?: typeof globalThis.fetch; }
export function createProductAttachmentClient(options: ProductAttachmentClientOptions) {
  const transport = options.fetch ?? globalThis.fetch;
  const request = async <T>(path: string, init: RequestInit): Promise<T> => {
    const response = await transport(new URL(path, options.origin), { credentials: 'include', ...init });
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error('Product Attachment request failed'), { status: response.status, problem: body, headers: response.headers });
    return body as T;
  };
  const sessionHeaders = (): Record<string, string> => options.sessionCookie === undefined ? {} : { Cookie: options.sessionCookie };
  const csrfHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = { ...sessionHeaders(), 'X-CSRF-Token': options.csrfToken };
    if (options.originHeader !== undefined) headers.Origin = options.originHeader;
    return headers;
  };
  const mutationHeaders = (commandId: string): Record<string, string> => ({ ...csrfHeaders(), 'Known-Command-Id': commandId });
  const jsonMutation = <T>(path: string, headers: Record<string, string>, body?: unknown) =>
    request<T>(path, { method: 'POST', headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return Object.freeze({
    issue: (requestBody: operations['issueAttachmentUpload']['requestBody']['content']['application/json'], commandId: string) =>
      jsonMutation<AttachmentIssueResult>('/api/v1/attachments/issue', mutationHeaders(commandId), requestBody),
    complete: (requestBody: operations['completeAttachmentUpload']['requestBody']['content']['application/json'], commandId: string) =>
      jsonMutation<AttachmentCompleteResult>('/api/v1/attachments/complete', mutationHeaders(commandId), requestBody),
    status: (blobId: string) =>
      request<AttachmentStatus>(`/api/v1/attachments/${encodeURIComponent(blobId)}`, { headers: sessionHeaders() }),
    finalize: (blobId: string, commandId: string) =>
      jsonMutation<AttachmentFinalizeResult>(`/api/v1/attachments/${encodeURIComponent(blobId)}/finalize`, mutationHeaders(commandId)),
    replace: (blobId: string, requestBody: operations['issueAttachmentReplacement']['requestBody']['content']['application/json'], commandId: string) =>
      jsonMutation<AttachmentIssueResult>(`/api/v1/attachments/${encodeURIComponent(blobId)}/replacement`, mutationHeaders(commandId), requestBody),
    retire: (blobId: string, commandId: string) =>
      jsonMutation<AttachmentRetireResult>(`/api/v1/attachments/${encodeURIComponent(blobId)}/retire`, mutationHeaders(commandId)),
    download: (blobId: string) =>
      jsonMutation<AttachmentDownloadAdmission>(`/api/v1/attachments/${encodeURIComponent(blobId)}/download`, csrfHeaders()),
  });
}
export type RecordInsightEventRequest = operations['recordPublicCollectionInsightEvent']['requestBody']['content']['application/json'];
export type PublishingInsights = operations['getMyPublishingInsights']['responses'][200]['content']['application/json'];
export interface ProductPublishingInsightsClientOptions {
  readonly origin: string;
  readonly csrfToken?: string;
  readonly sessionCookie?: string;
  readonly originHeader?: string;
  readonly fetch?: typeof globalThis.fetch;
}
export function createProductPublishingInsightsClient(options: ProductPublishingInsightsClientOptions) {
  const transport = options.fetch ?? globalThis.fetch;
  return Object.freeze({
    recordPublicCollectionInsightEvent: async (slug: string, body: RecordInsightEventRequest): Promise<void> => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (options.sessionCookie !== undefined) headers.Cookie = options.sessionCookie;
      if (options.csrfToken !== undefined) headers['X-CSRF-Token'] = options.csrfToken;
      if (options.originHeader !== undefined) headers.Origin = options.originHeader;
      const response = await transport(new URL(
        '/api/v1/public-collections/' + encodeURIComponent(slug) + '/insight-events',
        options.origin,
      ), { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) });
      if (response.status === 204) return;
      const problem = await response.json();
      throw Object.assign(new Error('Product Publishing Insights request failed'), {
        status: response.status, problem, headers: response.headers,
      });
    },
    getMyPublishingInsights: async (): Promise<PublishingInsights> => {
      const headers: Record<string, string> = {};
      if (options.sessionCookie !== undefined) headers.Cookie = options.sessionCookie;
      const response = await transport(new URL('/api/v1/me/publishing-insights', options.origin), {
        method: 'GET', credentials: 'include', headers,
      });
      const body = await response.json();
      if (!response.ok) {
        throw Object.assign(new Error('Product Publishing Insights request failed'), {
          status: response.status, problem: body, headers: response.headers,
        });
      }
      return body as PublishingInsights;
    },
  });
}
export type CollectionMembersPage = operations['listCollectionMembers']['responses'][200]['content']['application/json'];
export type CollectionInviteCreated = operations['inviteCollectionMember']['responses'][201]['content']['application/json'];
export type CollaborationMembershipResult = operations['acceptCollaborationInvite']['responses'][200]['content']['application/json'];
export type MyCollaborationInvitesPage = operations['listMyCollaborationInvites']['responses'][200]['content']['application/json'];
export type SharedCollectionPage = operations['listSharedCollections']['responses'][200]['content']['application/json'];
export type InviteCollectionMemberRequest = operations['inviteCollectionMember']['requestBody']['content']['application/json'];
export type CollectionMemberRoleMergePatch = operations['updateCollectionMemberRole']['requestBody']['content']['application/merge-patch+json'];
export interface ProductCollaborationClientOptions {
  readonly origin: string;
  readonly csrfToken: string;
  readonly sessionCookie?: string;
  readonly originHeader?: string;
  readonly fetch?: typeof globalThis.fetch;
}
export function createProductCollaborationClient(options: ProductCollaborationClientOptions) {
  const transport = options.fetch ?? globalThis.fetch;
  const sessionHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {};
    if (options.sessionCookie !== undefined) headers.Cookie = options.sessionCookie;
    return headers;
  };
  const writeHeaders = (commandId: string, ifMatch?: string, contentType?: string): Record<string, string> => {
    const headers: Record<string, string> = { ...sessionHeaders(), 'X-CSRF-Token': options.csrfToken, 'Known-Command-Id': commandId };
    if (options.originHeader !== undefined) headers.Origin = options.originHeader;
    if (ifMatch !== undefined) headers['If-Match'] = ifMatch;
    if (contentType !== undefined) headers['Content-Type'] = contentType;
    return headers;
  };
  const json = async <T>(path: string, init: RequestInit): Promise<T> => {
    const response = await transport(new URL(path, options.origin), { credentials: 'include', ...init });
    if (response.status === 204) return undefined as T;
    const body = await response.json();
    if (!response.ok) {
      throw Object.assign(new Error('Product Collaboration request failed'), {
        status: response.status, problem: body, headers: response.headers,
      });
    }
    return body as T;
  };
  return Object.freeze({
    listCollectionMembers: (collectionId: string, query: { cursor?: string } = {}) =>
      json<CollectionMembersPage>('/api/v1/collections/' + encodeURIComponent(collectionId) + '/members' + (query.cursor !== undefined ? '?cursor=' + encodeURIComponent(query.cursor) : ''), { headers: sessionHeaders() }),
    inviteCollectionMember: (collectionId: string, body: InviteCollectionMemberRequest, commandId: string, ifMatch: string) =>
      json<CollectionInviteCreated>('/api/v1/collections/' + encodeURIComponent(collectionId) + '/members/invites', {
        method: 'POST', headers: writeHeaders(commandId, ifMatch, 'application/json'), body: JSON.stringify(body),
      }),
    revokeCollectionInvite: (collectionId: string, inviteId: string, commandId: string, ifMatch: string) =>
      json<void>('/api/v1/collections/' + encodeURIComponent(collectionId) + '/members/invites/' + encodeURIComponent(inviteId), {
        method: 'DELETE', headers: writeHeaders(commandId, ifMatch),
      }),
    updateCollectionMemberRole: (collectionId: string, subjectId: string, body: CollectionMemberRoleMergePatch, commandId: string, ifMatch: string) =>
      json<CollaborationMembershipResult>('/api/v1/collections/' + encodeURIComponent(collectionId) + '/members/' + encodeURIComponent(subjectId), {
        method: 'PATCH', headers: writeHeaders(commandId, ifMatch, 'application/merge-patch+json'), body: JSON.stringify(body),
      }),
    removeCollectionMember: (collectionId: string, subjectId: string, commandId: string, ifMatch: string) =>
      json<void>('/api/v1/collections/' + encodeURIComponent(collectionId) + '/members/' + encodeURIComponent(subjectId), {
        method: 'DELETE', headers: writeHeaders(commandId, ifMatch),
      }),
    listMyCollaborationInvites: (query: { cursor?: string } = {}) =>
      json<MyCollaborationInvitesPage>('/api/v1/me/collaboration-invites' + (query.cursor !== undefined ? '?cursor=' + encodeURIComponent(query.cursor) : ''), { headers: sessionHeaders() }),
    listSharedCollections: (query: { kind?: string; visibility?: string; limit?: number; cursor?: string } = {}) => {
      const params = new URLSearchParams();
      if (query.cursor !== undefined) params.set('cursor', query.cursor);
      else {
        if (query.kind !== undefined) params.set('kind', query.kind);
        if (query.visibility !== undefined) params.set('visibility', query.visibility);
        if (query.limit !== undefined) params.set('limit', String(query.limit));
      }
      return json<SharedCollectionPage>('/api/v1/me/shared-collections' + (params.size ? '?' + params : ''), { headers: sessionHeaders() });
    },
    acceptCollaborationInvite: (inviteId: string, commandId: string) =>
      json<CollaborationMembershipResult>('/api/v1/me/collaboration-invites/' + encodeURIComponent(inviteId) + '/accept', {
        method: 'POST', headers: writeHeaders(commandId),
      }),
    declineCollaborationInvite: (inviteId: string, commandId: string) =>
      json<void>('/api/v1/me/collaboration-invites/' + encodeURIComponent(inviteId) + '/decline', {
        method: 'POST', headers: writeHeaders(commandId),
      }),
  });
}
export interface ProductReportsClientOptions { readonly origin: string; readonly csrfToken: string; readonly sessionCookie?: string; readonly originHeader?: string; readonly fetch?: typeof globalThis.fetch; }
export function createProductReportsClient(options: ProductReportsClientOptions) {
  const transport = options.fetch ?? globalThis.fetch;
  const sessionHeaders = (): Record<string, string> => options.sessionCookie === undefined ? {} : { Cookie: options.sessionCookie };
  const writeHeaders = (commandId: string, ifMatch?: string, contentType?: string): Record<string, string> => {
    const value: Record<string, string> = { ...sessionHeaders(), 'X-CSRF-Token': options.csrfToken, 'Known-Command-Id': commandId };
    if (options.originHeader !== undefined) value.Origin = options.originHeader;
    if (ifMatch !== undefined) value['If-Match'] = ifMatch;
    if (contentType !== undefined) value['Content-Type'] = contentType;
    return value;
  };
  const request = async <T>(path: string, init: RequestInit = {}, publicRead = false): Promise<T> => {
    const response = await transport(new URL(path, options.origin), { credentials: publicRead ? 'omit' : 'include', ...init });
    const body = response.status === 204 ? undefined : await response.json().catch(() => undefined);
    if (!response.ok) throw Object.assign(new Error('Product Reports request failed'), { status: response.status, problem: body, headers: response.headers });
    return body as T;
  };
  const page = (path: string, query: { limit?: number; cursor?: string; language?: string } = {}) => {
    const params = new URLSearchParams();
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    else if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.language !== undefined) params.set('language', query.language);
    return path + (params.size ? '?' + params : '');
  };
  const reportPath = (reportId: string) => '/api/v1/reports/' + encodeURIComponent(reportId);
  const issuePath = (reportId: string, editionId: string) => reportPath(reportId) + '/issues/' + encodeURIComponent(editionId);
  const publicPath = (slug: string) => '/api/v1/public-reports/' + encodeURIComponent(slug);
  const mutation = <T>(path: string, method: string, commandId: string, ifMatch?: string, body?: unknown, contentType?: string) => request<T>(path, {
    method, headers: writeHeaders(commandId, ifMatch, contentType), ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return Object.freeze({
    create: (body: ReportSeriesCreate, commandId: string) => mutation<ReportSeries>('/api/v1/reports', 'POST', commandId, undefined, body, 'application/json'),
    get: (reportId: string) => request<ReportSeries>(reportPath(reportId), { headers: sessionHeaders() }),
    update: (reportId: string, body: ReportSeriesPatch, commandId: string, ifMatch: string) => mutation<ReportSeries>(reportPath(reportId), 'PATCH', commandId, ifMatch, body, 'application/merge-patch+json'),
    archive: (reportId: string, commandId: string, ifMatch: string) => mutation<void>(reportPath(reportId), 'DELETE', commandId, ifMatch),
    issues: (reportId: string, query?: { limit?: number; cursor?: string }) => request<ReportEditionPage>(page(reportPath(reportId) + '/issues', query), { headers: sessionHeaders() }),
    attach: (reportId: string, body: ReportEditionAttach, commandId: string) => mutation<ReportEdition>(reportPath(reportId) + '/issues', 'POST', commandId, undefined, body, 'application/json'),
    issue: (reportId: string, editionId: string) => request<ReportEdition>(issuePath(reportId, editionId), { headers: sessionHeaders() }),
    updateIssue: (reportId: string, editionId: string, body: ReportEditionPatch, commandId: string, ifMatch: string) => mutation<ReportEdition>(issuePath(reportId, editionId), 'PATCH', commandId, ifMatch, body, 'application/merge-patch+json'),
    detach: (reportId: string, editionId: string, commandId: string, ifMatch: string) => mutation<void>(issuePath(reportId, editionId), 'DELETE', commandId, ifMatch),
    publish: (reportId: string, editionId: string, commandId: string, ifMatch: string) => mutation<ReportEdition>(issuePath(reportId, editionId) + '/publish', 'POST', commandId, ifMatch),
    withdraw: (reportId: string, editionId: string, commandId: string, ifMatch: string) => mutation<ReportEdition>(issuePath(reportId, editionId) + '/withdraw', 'POST', commandId, ifMatch),
    members: (reportId: string) => request<ReportMemberPage>(reportPath(reportId) + '/members', { headers: sessionHeaders() }),
    updateMember: (reportId: string, subjectId: string, body: ReportMemberMutation, commandId: string, ifMatch: string) => mutation<ReportMember>(reportPath(reportId) + '/members/' + encodeURIComponent(subjectId), 'PUT', commandId, ifMatch, body, 'application/json'),
    removeMember: (reportId: string, subjectId: string, commandId: string, ifMatch: string) => mutation<void>(reportPath(reportId) + '/members/' + encodeURIComponent(subjectId), 'DELETE', commandId, ifMatch),
    followState: (reportId: string) => request<ReportFollowState>(reportPath(reportId) + '/follow', { headers: sessionHeaders() }),
    follow: (reportId: string, commandId: string) => mutation<ReportFollowState>(reportPath(reportId) + '/follow', 'PUT', commandId),
    unfollow: (reportId: string, commandId: string) => mutation<ReportFollowState>(reportPath(reportId) + '/follow', 'DELETE', commandId),
    schedule: (reportId: string) => request<ReportScheduleEnvelope>(reportPath(reportId) + '/schedule', { headers: sessionHeaders() }),
    putSchedule: (reportId: string, body: ReportScheduleInput, commandId: string, ifMatch: string) => mutation<ReportSchedule>(reportPath(reportId) + '/schedule', 'PUT', commandId, ifMatch, body, 'application/json'),
    deleteSchedule: (reportId: string, commandId: string, ifMatch: string) => mutation<void>(reportPath(reportId) + '/schedule', 'DELETE', commandId, ifMatch),
    mine: (query?: { limit?: number; cursor?: string }) => request<ReportSeriesPage>(page('/api/v1/me/reports', query), { headers: sessionHeaders() }),
    followed: (query?: { limit?: number; cursor?: string }) => request<ReportSeriesPage>(page('/api/v1/me/followed-reports', query), { headers: sessionHeaders() }),
    timeline: (query?: { limit?: number; cursor?: string }) => request<ReportIssueTimelinePage>(page('/api/v1/me/followed-reports/issues', query), { headers: sessionHeaders() }),
    publicDirectory: (query?: { limit?: number; cursor?: string; language?: string }) => request<PublicReportPage>(page('/api/v1/public-reports', query), {}, true),
    publicSeries: (slug: string) => request<PublicReportSeries>(publicPath(slug), {}, true),
    publicIssues: (slug: string, query?: { limit?: number; cursor?: string }) => request<PublicReportIssuePage>(page(publicPath(slug) + '/issues', query), {}, true),
    publicIssue: (slug: string, editionId: string) => request<PublicReportIssue>(publicPath(slug) + '/issues/' + encodeURIComponent(editionId), {}, true),
  });
}
export function createProductCommunityClient(options: ProductFollowClientOptions) {
  const transport = options.fetch ?? globalThis.fetch;
  const request = async <T>(path: string, init: RequestInit): Promise<T> => {
    const response = await transport(new URL(path, options.origin), init);
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error('Product Community request failed'), { status: response.status, problem: body, headers: response.headers });
    return body as T;
  };
  const sessionHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {};
    if (options.sessionCookie !== undefined) headers.Cookie = options.sessionCookie;
    return headers;
  };
  const mutationHeaders = (commandId: string): Record<string, string> => {
    const headers: Record<string, string> = { ...sessionHeaders(), 'X-CSRF-Token': options.csrfToken, 'Known-Command-Id': commandId };
    if (options.originHeader !== undefined) headers.Origin = options.originHeader;
    return headers;
  };
  /* Content-Type belongs only on calls that actually send a JSON body; a
     bodyless mutation (DELETE) with a json Content-Type is rejected as
     invalid_json by the product parser. */
  const jsonMutationHeaders = (commandId: string): Record<string, string> =>
    ({ ...mutationHeaders(commandId), 'Content-Type': 'application/json' });
  const targetPath = (query: { kind: string; id: string; collectionId?: string; seriesId?: string }) => {
    const params = new URLSearchParams();
    params.set('kind', query.kind);
    params.set('id', query.id);
    if (query.collectionId !== undefined) params.set('collectionId', query.collectionId);
    if (query.seriesId !== undefined) params.set('seriesId', query.seriesId);
    return `/api/v1/community/target?${params}`;
  };
  const rankingPath = (query: CommunityRankingQuery) => {
    const params = new URLSearchParams();
    if (query.kind !== undefined) params.set('kind', query.kind);
    if (query.collectionId !== undefined) params.set('collectionId', query.collectionId);
    if (query.q !== undefined) params.set('q', query.q);
    if (query.tag !== undefined) params.set('tag', query.tag);
    if (query.language !== undefined) params.set('language', query.language);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    const suffix = params.size > 0 ? `?${params}` : '';
    return `/api/v1/community/ranking${suffix}`;
  };
  const commentsPath = (query: CommunityCommentsQuery) => {
    const params = new URLSearchParams();
    params.set('kind', query.kind);
    params.set('id', query.id);
    if (query.collectionId !== undefined) params.set('collectionId', query.collectionId);
    if (query.seriesId !== undefined) params.set('seriesId', query.seriesId);
    params.set('generation', query.generation);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    return `/api/v1/community/comments?${params}`;
  };
  const repliesPath = (commentId: string, query: CommunityCommentRepliesQuery) => {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    const suffix = params.size > 0 ? `?${params}` : '';
    return `/api/v1/community/comments/${encodeURIComponent(commentId)}/replies${suffix}`;
  };
  const commentSettingsPath = (query: CommunityCommentSettingsQuery) => {
    const params = new URLSearchParams();
    params.set('kind', query.kind);
    params.set('id', query.id);
    if (query.collectionId !== undefined) params.set('collectionId', query.collectionId);
    if (query.seriesId !== undefined) params.set('seriesId', query.seriesId);
    params.set('generation', query.generation);
    return `/api/v1/community/comment-settings?${params}`;
  };
  /* CS-04 mutations are conditional on If-Match; the response ETag chains
     the next write, so it must be surfaced alongside the body. */
  const conditionalHeaders = (commandId: string, ifMatch: string): Record<string, string> =>
    ({ ...mutationHeaders(commandId), 'If-Match': ifMatch });
  const jsonConditionalHeaders = (commandId: string, ifMatch: string): Record<string, string> =>
    ({ ...conditionalHeaders(commandId, ifMatch), 'Content-Type': 'application/json' });
  const requestWithEtag = async <T>(path: string, init: RequestInit): Promise<CommunityEntityResult<T>> => {
    const response = await transport(new URL(path, options.origin), init);
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error('Product Community request failed'), { status: response.status, problem: body, headers: response.headers });
    return { data: body as T, etag: response.headers.get('etag') };
  };
  return Object.freeze({
    resolveTarget: (query: { kind: string; id: string; collectionId?: string; seriesId?: string }) =>
      request<CommunityTargetView>(targetPath(query), { credentials: 'include', headers: sessionHeaders() }),
    setVote: (body: CommunityVoteRequest, commandId: string) =>
      request<CommunityVoteState>('/api/v1/community/vote', { method: 'PUT', credentials: 'include', headers: jsonMutationHeaders(commandId), body: JSON.stringify(body) }),
    listRanking: (query: CommunityRankingQuery = {}) =>
      request<CommunityRankingPage>(rankingPath(query), { credentials: 'include', headers: sessionHeaders() }),
    listComments: (query: CommunityCommentsQuery) =>
      request<CommunityCommentPage>(commentsPath(query), { credentials: 'include', headers: sessionHeaders() }),
    createComment: (body: CommunityCreateComment, commandId: string) =>
      request<CommunityComment>('/api/v1/community/comments', { method: 'POST', credentials: 'include', headers: jsonMutationHeaders(commandId), body: JSON.stringify(body) }),
    getComment: (commentId: string) =>
      request<CommunityComment>(`/api/v1/community/comments/${encodeURIComponent(commentId)}`, { credentials: 'include', headers: sessionHeaders() }),
    /* CS-04: author edit/delete are conditional on the comment's own ETag,
       which is only ever minted server-side — the fresh-read response ETag
       is the If-Match the caller must send. */
    getCommentWithEtag: (commentId: string) =>
      requestWithEtag<CommunityComment>(`/api/v1/community/comments/${encodeURIComponent(commentId)}`, { credentials: 'include', headers: sessionHeaders() }),
    listReplies: (commentId: string, query: CommunityCommentRepliesQuery = {}) =>
      request<CommunityCommentPage>(repliesPath(commentId, query), { credentials: 'include', headers: sessionHeaders() }),
    editComment: (commentId: string, body: CommunityEditComment, ifMatch: string, commandId: string) =>
      requestWithEtag<CommunityComment>(`/api/v1/community/comments/${encodeURIComponent(commentId)}`, { method: 'PATCH', credentials: 'include', headers: jsonConditionalHeaders(commandId, ifMatch), body: JSON.stringify(body) }),
    deleteComment: (commentId: string, ifMatch: string, commandId: string) =>
      requestWithEtag<CommunityComment>(`/api/v1/community/comments/${encodeURIComponent(commentId)}`, { method: 'DELETE', credentials: 'include', headers: conditionalHeaders(commandId, ifMatch) }),
    getCuration: (commentId: string) =>
      requestWithEtag<CommunityCuration>(`/api/v1/community/comments/${encodeURIComponent(commentId)}/curation`, { credentials: 'include', headers: sessionHeaders() }),
    setCuration: (commentId: string, body: CommunityPutCuration, ifMatch: string, commandId: string) =>
      requestWithEtag<CommunityCuration>(`/api/v1/community/comments/${encodeURIComponent(commentId)}/curation`, { method: 'PUT', credentials: 'include', headers: jsonConditionalHeaders(commandId, ifMatch), body: JSON.stringify(body) }),
    getCommentSettings: (query: CommunityCommentSettingsQuery) =>
      requestWithEtag<CommunityCommentSettings>(commentSettingsPath(query), { credentials: 'include', headers: sessionHeaders() }),
    setCommentSettings: (body: CommunityPutCommentSettings, ifMatch: string, commandId: string) =>
      requestWithEtag<CommunityCommentSettings>('/api/v1/community/comment-settings', { method: 'PUT', credentials: 'include', headers: jsonConditionalHeaders(commandId, ifMatch), body: JSON.stringify(body) }),
    /* CS-05: the private reply-notification inbox and the community
       channel preference — session reads, receipt mutations. */
    listNotifications: (query: CommunityNotificationsQuery = {}) => {
      const params = new URLSearchParams();
      if (query.read !== undefined) params.set('read', query.read);
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      if (query.cursor !== undefined) params.set('cursor', query.cursor);
      const suffix = params.size > 0 ? `?${params}` : '';
      return request<CommunityNotificationInbox>(`/api/v1/me/community-notifications${suffix}`, { credentials: 'include', headers: sessionHeaders() });
    },
    markNotificationsRead: (body: CommunityReadNotifications, commandId: string) =>
      request<CommunityReadNotificationsResult>('/api/v1/me/community-notifications/read', { method: 'POST', credentials: 'include', headers: jsonMutationHeaders(commandId), body: JSON.stringify(body) }),
    getNotificationPreference: () =>
      requestWithEtag<CommunityNotificationPreference>('/api/v1/me/community-notification-preferences', { credentials: 'include', headers: sessionHeaders() }),
    putNotificationPreference: (body: CommunityPutNotificationPreference, ifMatch: string, commandId: string) =>
      requestWithEtag<CommunityNotificationPreference>('/api/v1/me/community-notification-preferences', { method: 'PUT', credentials: 'include', headers: jsonConditionalHeaders(commandId, ifMatch), body: JSON.stringify(body) }),
  });
}
export interface ProductGovernanceClientOptions { readonly origin: string; readonly csrfToken: string; readonly sessionCookie?: string; readonly originHeader?: string; readonly fetch?: typeof globalThis.fetch; }
export function createProductGovernanceClient(options: ProductGovernanceClientOptions) {
  const transport = options.fetch ?? globalThis.fetch;
  const sessionHeaders = (): Record<string, string> => options.sessionCookie === undefined ? {} : { Cookie: options.sessionCookie };
  const writeHeaders = (commandId: string, ifMatch: string, contentType: string): Record<string, string> => {
    const value: Record<string, string> = { ...sessionHeaders(), 'X-CSRF-Token': options.csrfToken, 'Known-Command-Id': commandId, 'If-Match': ifMatch, 'Content-Type': contentType };
    if (options.originHeader !== undefined) value.Origin = options.originHeader;
    return value;
  };
  const commandHeaders = (commandId: string, contentType: string): Record<string, string> => {
    const value: Record<string, string> = { ...sessionHeaders(), 'X-CSRF-Token': options.csrfToken, 'Known-Command-Id': commandId, 'Content-Type': contentType };
    if (options.originHeader !== undefined) value.Origin = options.originHeader;
    return value;
  };
  const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await transport(new URL(path, options.origin), { credentials: 'include', ...init });
    const body = await response.json().catch(() => undefined);
    if (!response.ok) throw Object.assign(new Error('Product governance request failed'), { status: response.status, problem: body, headers: response.headers });
    return body as T;
  };
  const collectionPath = (id: string) => '/api/v1/collections/' + encodeURIComponent(id) + '/catalog';
  const reportPath = (id: string) => '/api/v1/reports/' + encodeURIComponent(id) + '/catalog';
  const page = (path: string, query: { status?: string; assignee?: string; limit?: number; cursor?: string } = {}) => {
    const params = new URLSearchParams();
    if (query.status !== undefined) params.set('status', query.status);
    if (query.assignee !== undefined) params.set('assignee', query.assignee);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    return path + (params.size ? '?' + params.toString() : '');
  };
  return Object.freeze({
    getCollectionCatalog: (collectionId: string) => request<GovernanceCatalog>(collectionPath(collectionId), { headers: sessionHeaders() }),
    updateCollectionCatalog: (collectionId: string, body: GovernanceCatalogPatch, commandId: string, ifMatch: string) =>
      request<GovernanceCatalog>(collectionPath(collectionId), { method: 'PATCH', headers: writeHeaders(commandId, ifMatch, 'application/merge-patch+json'), body: JSON.stringify(body) }),
    getReportCatalog: (reportId: string) => request<GovernanceCatalog>(reportPath(reportId), { headers: sessionHeaders() }),
    updateReportCatalog: (reportId: string, body: GovernanceCatalogPatch, commandId: string, ifMatch: string) =>
      request<GovernanceCatalog>(reportPath(reportId), { method: 'PATCH', headers: writeHeaders(commandId, ifMatch, 'application/merge-patch+json'), body: JSON.stringify(body) }),
    getMyCatalogPreferences: () => request<GovernanceCatalogPreferences>('/api/v1/me/catalog-preferences', { headers: sessionHeaders() }),
    updateMyCatalogPreferences: (body: GovernanceCatalogPreferencesPatch, commandId: string, ifMatch: string) =>
      request<GovernanceCatalogPreferences>('/api/v1/me/catalog-preferences', { method: 'PATCH', headers: writeHeaders(commandId, ifMatch, 'application/json'), body: JSON.stringify(body) }),
    submitModerationReport: (body: GovernanceReportInput, commandId: string) =>
      request<GovernanceMyCase>('/api/v1/moderation/reports', { method: 'POST', headers: commandHeaders(commandId, 'application/json'), body: JSON.stringify(body) }),
    listMyModerationReports: (query?: { status?: string; limit?: number; cursor?: string }) =>
      request<GovernanceMyCasePage>(page('/api/v1/me/moderation-reports', query), { headers: sessionHeaders() }),
    getMyModerationReport: (caseId: string) =>
      request<GovernanceMyCase>('/api/v1/me/moderation-reports/' + encodeURIComponent(caseId), { headers: sessionHeaders() }),
    listModerationCases: (query?: { status?: string; assignee?: string; limit?: number; cursor?: string }) =>
      request<GovernanceOfficialCasePage>(page('/api/v1/moderation/cases', query), { headers: sessionHeaders() }),
    getModerationCase: (caseId: string) =>
      request<GovernanceOfficialCase>('/api/v1/moderation/cases/' + encodeURIComponent(caseId), { headers: sessionHeaders() }),
    getModerationEvidence: (caseId: string, evidenceId: string) =>
      request<GovernanceEvidence>('/api/v1/moderation/cases/' + encodeURIComponent(caseId) + '/evidence/' + encodeURIComponent(evidenceId), { headers: sessionHeaders() }),
    updateModerationCase: (caseId: string, body: GovernanceCasePatch, commandId: string, ifMatch: string) =>
      request<GovernanceOfficialCase>('/api/v1/moderation/cases/' + encodeURIComponent(caseId), { method: 'PATCH', headers: writeHeaders(commandId, ifMatch, 'application/json'), body: JSON.stringify(body) }),
    createModerationAction: (body: GovernanceActionInput, commandId: string) =>
      request<GovernanceAction>('/api/v1/moderation/actions', { method: 'POST', headers: commandHeaders(commandId, 'application/json'), body: JSON.stringify(body) }),
    getModerationAction: (actionId: string) =>
      request<GovernanceAction>('/api/v1/moderation/actions/' + encodeURIComponent(actionId), { headers: sessionHeaders() }),
    revokeModerationAction: (actionId: string, body: { reason: string }, commandId: string, ifMatch: string) =>
      request<GovernanceAction>('/api/v1/moderation/actions/' + encodeURIComponent(actionId) + '/revoke', { method: 'POST', headers: writeHeaders(commandId, ifMatch, 'application/json'), body: JSON.stringify(body) }),
    listActionsAffectingMe: (query?: { limit?: number; cursor?: string }) =>
      request<GovernanceMyActionPage>(page('/api/v1/me/moderation-actions', query), { headers: sessionHeaders() }),
    createModerationAppeal: (body: GovernanceAppealInput, commandId: string) =>
      request<GovernanceAppeal>('/api/v1/moderation/appeals', { method: 'POST', headers: commandHeaders(commandId, 'application/json'), body: JSON.stringify(body) }),
    listModerationAppeals: (query?: { status?: string; limit?: number; cursor?: string }) =>
      request<GovernanceAppealPage>(page('/api/v1/moderation/appeals', query), { headers: sessionHeaders() }),
    listMyModerationAppeals: (query?: { limit?: number; cursor?: string }) =>
      request<GovernanceAppealPage>(page('/api/v1/me/moderation-appeals', query), { headers: sessionHeaders() }),
    getModerationAppeal: (appealId: string) =>
      request<GovernanceAppeal>('/api/v1/moderation/appeals/' + encodeURIComponent(appealId), { headers: sessionHeaders() }),
    decideModerationAppeal: (appealId: string, body: GovernanceAppealDecision, commandId: string, ifMatch: string) =>
      request<GovernanceAppeal>('/api/v1/moderation/appeals/' + encodeURIComponent(appealId) + '/decision', { method: 'POST', headers: writeHeaders(commandId, ifMatch, 'application/json'), body: JSON.stringify(body) }),
  });
}
