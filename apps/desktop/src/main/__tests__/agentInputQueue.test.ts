import { describe, expect, it } from 'vitest';

import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';
import {
  ANNOTATED_IMAGE_NOTE,
  buildMakerUserMessage,
  updateQueuedMessageText,
} from '../../shared/agentInputQueue.js';

function queuedMessage(files: AgentInputQueuedMessage['files']): AgentInputQueuedMessage {
  return {
    clientId: 'client-1',
    text: 'inspect attachment',
    persistedContent: 'inspect attachment',
    model: 'claude-opus-4-7',
    effort: 'medium',
    permissionMode: 'default',
    workingDir: '/repo',
    files,
    chatMessage: {
      clientId: 'client-1',
      role: 'user',
      content: 'inspect attachment',
      isStreaming: false,
      createdAt: '2026-06-18T00:00:00.000Z',
    },
    createOpts: {
      agentKind: 'claude-code',
      workingDir: '/repo',
      model: 'claude-opus-4-7',
      effort: 'medium',
      permissionMode: 'default',
      userPrompt: '',
      makerMemoryEnabled: true,
      displayReasoning: 'summarized',
    },
  };
}

describe('agentInputQueue', () => {
  it('sends queued GIF attachments as file blocks', () => {
    expect(buildMakerUserMessage(queuedMessage([
      {
        id: 'gif-1',
        name: 'clip.gif',
        path: '/repo/clip.gif',
        ext: '.gif',
        size: 128,
        category: 'image',
        mimeType: 'image/gif',
        url: 'xdt-image://session/clip.gif',
      },
    ]))).toEqual({
      type: 'user',
      content: [
        { type: 'text', text: 'inspect attachment' },
        { type: 'file', path: 'xdt-image://session/clip.gif', mimeType: 'image/gif' },
      ],
    });
  });

  it('keeps queued non-GIF image attachments as image blocks', () => {
    expect(buildMakerUserMessage(queuedMessage([
      {
        id: 'image-1',
        name: 'shot.png',
        path: '/repo/shot.png',
        ext: '.png',
        size: 128,
        category: 'image',
        mimeType: 'image/png',
        url: 'xdt-image://session/shot.png',
      },
    ]))).toEqual({
      type: 'user',
      content: [
        { type: 'text', text: 'inspect attachment' },
        { type: 'image', path: 'xdt-image://session/shot.png', mimeType: 'image/png' },
      ],
    });
  });

  it('appends the hidden annotation note once after all blocks for annotated images', () => {
    expect(buildMakerUserMessage(queuedMessage([
      {
        id: 'image-1',
        name: 'shot.png',
        path: '/repo/shot.png',
        ext: '.png',
        size: 128,
        category: 'image',
        mimeType: 'image/png',
        url: 'xdt-image://session/shot.png',
        annotated: true,
      },
      {
        id: 'image-2',
        name: 'other.png',
        path: '/repo/other.png',
        ext: '.png',
        size: 64,
        category: 'image',
        mimeType: 'image/png',
        url: 'xdt-image://session/other.png',
        annotated: true,
      },
    ]))).toEqual({
      type: 'user',
      content: [
        { type: 'text', text: 'inspect attachment' },
        { type: 'image', path: 'xdt-image://session/shot.png', mimeType: 'image/png' },
        { type: 'image', path: 'xdt-image://session/other.png', mimeType: 'image/png' },
        { type: 'text', text: ANNOTATED_IMAGE_NOTE },
      ],
    });
  });

  it('does not inject the annotation note for plain images or annotated GIF-as-file blocks', () => {
    expect(buildMakerUserMessage(queuedMessage([
      {
        id: 'image-1',
        name: 'shot.png',
        path: '/repo/shot.png',
        ext: '.png',
        size: 128,
        category: 'image',
        mimeType: 'image/png',
        url: 'xdt-image://session/shot.png',
      },
      {
        // GIF 进 file block(不做视觉标注语义),即便误带 annotated 也不注入。
        id: 'gif-1',
        name: 'clip.gif',
        path: '/repo/clip.gif',
        ext: '.gif',
        size: 128,
        category: 'image',
        mimeType: 'image/gif',
        url: 'xdt-image://session/clip.gif',
        annotated: true,
      },
    ]))).toEqual({
      type: 'user',
      content: [
        { type: 'text', text: 'inspect attachment' },
        { type: 'image', path: 'xdt-image://session/shot.png', mimeType: 'image/png' },
        { type: 'file', path: 'xdt-image://session/clip.gif', mimeType: 'image/gif' },
      ],
    });
  });

  it('clears quote metadata when a queued quoted message is rewritten without markers', () => {
    const entry = queuedMessage(undefined);
    entry.text = '> <!-- cindy-composer-quote -->\n> quoted\n\nreply';
    entry.persistedContent = JSON.stringify({
      text: entry.text,
      images: [],
      files: [],
      quotesEncoded: true,
    });
    entry.chatMessage.content = entry.text;
    entry.chatMessage.quotesEncoded = true;

    const updated = updateQueuedMessageText(entry, '> quoted\n\nrevised reply', {
      clearQuoteMetadataWhenMarkerless: true,
    });

    expect(JSON.parse(updated.persistedContent)).toEqual({
      text: '> quoted\n\nrevised reply',
      images: [],
      files: [],
    });
    expect(updated.chatMessage.quotesEncoded).toBeUndefined();
  });

  it('preserves quote metadata when a queued rewrite still contains markers', () => {
    const entry = queuedMessage(undefined);
    entry.persistedContent = JSON.stringify({
      text: entry.text,
      quotesEncoded: true,
    });
    entry.chatMessage.quotesEncoded = true;
    const rewritten = '> <!-- cindy-composer-quote -->\n> revised quote\n\nreply';

    const updated = updateQueuedMessageText(entry, rewritten, {
      clearQuoteMetadataWhenMarkerless: true,
    });

    expect(JSON.parse(updated.persistedContent)).toEqual({
      text: rewritten,
      quotesEncoded: true,
    });
    expect(updated.chatMessage.quotesEncoded).toBe(true);
  });
});
