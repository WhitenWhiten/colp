/**
 * P5-28 email provider adapter public surface.
 *
 * Only bootstrap composition (and the P5-27/28 evidence harnesses) may reach
 * the Aliyun DirectMail adapter; the import-boundary graph allows
 * infrastructure:email -> module:notifications:facade (for the port types),
 * -> module:auth:facade (C1 auth email port types),
 * -> module:access-policy:facade (SC-04 invite email port types),
 * and -> telemetry.
 * The worker consumes the application port (EmailProviderAdapter) from the
 * notifications facade; the auth email surface (C1) is consumed by the auth
 * module port (AuthEmailSender) and bootstrap composition.
 */
export { AliyunDirectMailAdapter, validateIdempotencyKey } from './aliyun-directmail-adapter.js';
export type {
  AliyunDirectMailAdapterOptions,
  EmailAdapterTransport,
  AdapterTransportResponse,
} from './aliyun-directmail-adapter.js';
export {
  composeAuthEmailAdapter,
  createAuthEmailAdapter,
  createInProcessMailboxSink,
  createUnavailableAuthEmailSender,
} from './auth-email-adapter.js';
export type {
  AuthEmailAdapter,
  AuthEmailAdapterOptions,
  AuthEmailComposition,
  AuthEmailDirectMailSettings,
  AuthEmailLogger,
  AuthEmailMailboxEntry,
  AuthEmailProvider,
  ComposeAuthEmailAdapterOptions,
  InProcessMailboxSink,
} from './auth-email-adapter.js';
export {
  composeInviteEmailAdapter,
  createInviteEmailAdapter,
  createInviteEmailMailboxSink,
  createUnavailableInviteEmailSender,
} from './invite-email-adapter.js';
export type {
  ComposeInviteEmailAdapterOptions,
  InviteEmailAdapter,
  InviteEmailAdapterOptions,
  InviteEmailComposition,
  InviteEmailDirectMailSettings,
  InviteEmailLogger,
  InviteEmailMailboxEntry,
  InviteEmailMailboxSink,
  InviteEmailProvider,
} from './invite-email-adapter.js';
export {
  defaultEmailSkinMap,
  mailClassForPurpose,
  parseEmailSkinConfig,
  wrapEmailMessage,
  wrapEmailTemplateRenderers,
  EMAIL_SKIN_BODY_MAX_BYTES,
  EMAIL_SKIN_PURPOSES,
  EMAIL_SKIN_SUBJECT_MAX_CHARS,
} from './message-skins.js';
export type {
  EmailSkin,
  EmailSkinMap,
  EmailSkinMessage,
  EmailSkinPurpose,
  WrapEmailMessageResult,
} from './message-skins.js';
export { renderMarketingNotice } from './marketing-notice.js';
export type { MarketingNoticeInput } from './marketing-notice.js';
export {
  EMAIL_FONT_MONO,
  EMAIL_INNER_INK,
  EMAIL_INNER_P_STYLE,
  EMAIL_INNER_PAPER,
  EMAIL_INNER_WELL,
  renderEmailCtaButton,
  renderEmailFooterNote,
  renderEmailHeading,
  renderEmailInnerParagraph,
  renderEmailPreheader,
  renderOtpBlock,
  renderRecoveryCodes,
} from './email-inner-blocks.js';
export { EMAIL_FONT_SANS, EMAIL_SIGNATURE } from './email-brand.js';
export {
  UNIFIED_CHROME_MARKETING_UNSUBSCRIBE,
  UNIFIED_CHROME_TAGLINE,
  UNIFIED_EMAIL_SKIN,
  wrapUnifiedEmailChrome,
} from './unified-email-chrome.js';
export {
  createEmailDeliveryWorkerRuntime,
  createPostgresEmailDeliveryWorkerRepository,
} from './email-delivery-worker-postgres.js';
export type {
  EmailDeliveryWorkerLoopLogger,
  EmailDeliveryWorkerRuntime,
} from './email-delivery-worker-postgres.js';
export { createPostgresEmailSuppressionOpsRepository } from './email-suppression-ops-postgres.js';
