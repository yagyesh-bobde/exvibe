/**
 * POST /feedback — append a voice-learning feedback event.
 *
 * The extension calls this after every draft interaction, including a
 * successful DOM post (`action: "post"`), so voice learning still sees the
 * posting signal even though the server has no /post endpoint.
 *
 * ../lib/feedback ports feedback.py: recordEvent appends the event (ts,
 * good/bad signal, and edited flag derived) to feedback.json and returns the
 * stored record.
 */

import { recordEvent } from '../lib/feedback';
import {
  json,
  optionalString,
  readJsonBody,
  requireDraftKind,
  requireFeedbackAction,
} from './http';

export async function postFeedback(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  const kind = requireDraftKind(body);
  const action = requireFeedbackAction(body);

  const originalText = optionalString(body, 'original_text')?.trim() ?? '';
  // Mirrors the original feedback.record_event: an absent final text means
  // the draft was acted on unedited.
  const finalText = optionalString(body, 'final_text')?.trim() || originalText;

  const event: {
    kind: typeof kind;
    action: typeof action;
    original_text: string;
    final_text: string;
    target_author?: string;
    target_text?: string;
  } = { kind, action, original_text: originalText, final_text: finalText };

  const targetAuthor = optionalString(body, 'target_author');
  if (targetAuthor !== undefined) event.target_author = targetAuthor;
  const targetText = optionalString(body, 'target_text');
  if (targetText !== undefined) event.target_text = targetText;

  const recorded = await recordEvent(event);
  return json({ ok: true, event: recorded });
}
