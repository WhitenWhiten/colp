import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { EMAIL_SKIN_PURPOSES } from '../../../src/infrastructure/email/message-skins.js';
import { EMAIL_PREVIEW_SCENES } from '../../../../devops/frontend_capture/email-preview-catalog.mjs';

describe('frontend_capture email preview catalog', () => {
  test('covers every closed MAIL-01 skin purpose exactly once', () => {
    const catalog = EMAIL_PREVIEW_SCENES.map((scene) => scene.purpose);
    assert.deepEqual([...catalog].sort(), [...EMAIL_SKIN_PURPOSES].sort());
  });
});
