import { loadConfig } from './config.js';
import {
  composeAuthEmailAdapter,
  createInProcessMailboxSink,
  type AuthEmailComposition,
  type InProcessMailboxSink,
} from '../infrastructure/email/index.js';
import type { DatabaseRuntime } from '../infrastructure/database/index.js';
import { createLogger, type Metrics } from '../infrastructure/telemetry/index.js';

export interface ApiEmailComposition {
  readonly authMailboxSink: InProcessMailboxSink | undefined;
  readonly authEmailComposition: AuthEmailComposition;
  readonly emailProvider: undefined;
  readonly emailCallbackRateLimiter: undefined;
}

export function composeApiEmail(input: {
  readonly config: ReturnType<typeof loadConfig>;
  readonly database: DatabaseRuntime;
  readonly metrics: Metrics;
  readonly metricsLogger: ReturnType<typeof createLogger>;
}): ApiEmailComposition {
  const { config, metricsLogger } = input;
  const authMailboxSink: InProcessMailboxSink | undefined = config.testAuthMailboxHttp.enabled
    ? createInProcessMailboxSink()
    : undefined;
  const authEmailComposition: AuthEmailComposition = composeAuthEmailAdapter({
    enabled: config.authEmail.enabled,
    nodeEnv: config.nodeEnv,
    directMail: config.authEmail,
    ...(authMailboxSink === undefined ? {} : { inProcessSink: authMailboxSink }),
    resolveCredentials: () => {
      const accessKeyId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID?.trim();
      const accessKeySecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET?.trim();
      if (!accessKeyId || !accessKeySecret) {
        throw new Error(
          'API composition refused: AUTH_EMAIL_ENABLED requires '
          + 'ALIBABA_CLOUD_ACCESS_KEY_ID/ALIBABA_CLOUD_ACCESS_KEY_SECRET',
        );
      }
      return { accessKeyId, accessKeySecret };
    },
    logger: metricsLogger,
    emailSkins: config.emailSkins,
  });

  return {
    authMailboxSink,
    authEmailComposition,
    emailProvider: undefined,
    emailCallbackRateLimiter: undefined,
  };
}
